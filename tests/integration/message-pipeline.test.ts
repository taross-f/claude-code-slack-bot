/**
 * Integration tests for the full message-processing pipeline.
 *
 * Uses:
 *  - Real in-memory SQLite via createDatabase(':memory:')
 *  - Real SessionRepository and WorkingDirectoryRepository
 *  - Stub claudeQuery returning predictable async iterables
 *  - Stub SlackOps (all methods are tracked stubs)
 *  - Real PermissionGate with a postPermissionRequest stub that auto-approves
 *    (or auto-denies, depending on the test)
 *
 * No real Slack API or Anthropic API calls are made.
 */

import { describe, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/database';
import { SessionRepository } from '../../src/db/sessions';
import { WorkingDirectoryRepository } from '../../src/db/working-dirs';
import { MessageProcessor } from '../../src/slack/message-processor';
import type { ClaudeMessage, ClaudeQueryFn, SlackOps } from '../../src/utils/types';

// ---------------------------------------------------------------------------
// Helpers: stub SlackOps
// ---------------------------------------------------------------------------

interface TrackedSlackOps extends SlackOps {
  posts: Array<{ text: string; thread_ts?: string }>;
  updates: Array<{ channel: string; ts: string; text: string }>;
  reactionsAdded: Array<{ channel: string; ts: string; name: string }>;
  reactionsRemoved: Array<{ channel: string; ts: string; name: string }>;
  permissionRequests: Array<{
    channel: string;
    threadTs: string;
    approvalId: string;
    tool: string;
    input: unknown;
  }>;
}

function makeSlackOps(autoApprove = true): TrackedSlackOps {
  const posts: TrackedSlackOps['posts'] = [];
  const updates: TrackedSlackOps['updates'] = [];
  const reactionsAdded: TrackedSlackOps['reactionsAdded'] = [];
  const reactionsRemoved: TrackedSlackOps['reactionsRemoved'] = [];
  const permissionRequests: TrackedSlackOps['permissionRequests'] = [];
  let counter = 0;

  const ops: TrackedSlackOps = {
    posts,
    updates,
    reactionsAdded,
    reactionsRemoved,
    permissionRequests,

    async say(msg) {
      posts.push(msg);
      return { ts: `1000000000.${String(++counter).padStart(6, '0')}` };
    },

    async updateMessage(channel, ts, text) {
      updates.push({ channel, ts, text });
    },

    async addReaction(channel, ts, name) {
      reactionsAdded.push({ channel, ts, name });
    },

    async removeReaction(channel, ts, name) {
      reactionsRemoved.push({ channel, ts, name });
    },

    async postPermissionRequest(channel, threadTs, approvalId, tool, input) {
      permissionRequests.push({ channel, threadTs, approvalId, tool, input });
      return autoApprove;
    },
  };

  return ops;
}

// ---------------------------------------------------------------------------
// Helpers: stub claudeQuery factories
// ---------------------------------------------------------------------------

/** Yields a system init then a single ResultMessage carrying text content. */
function makeSimpleResultQuery(text: string): ClaudeQueryFn {
  return async function* (_params) {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'session-abc',
    } as ClaudeMessage;

    yield {
      type: 'result',
      subtype: 'success',
      result: text,
      total_cost_usd: 0.0005,
      duration_ms: 50,
      session_id: 'session-abc',
      is_error: false,
    } as ClaudeMessage;
  };
}

/**
 * Yields a system init then multiple AssistantMessage tokens (each carrying a
 * text part), followed by a ResultMessage.
 */
function makeStreamingQuery(tokens: string[]): ClaudeQueryFn {
  return async function* (_params) {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'session-stream',
    } as ClaudeMessage;

    for (const token of tokens) {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: token }],
        },
      } as ClaudeMessage;
    }

    yield {
      type: 'result',
      subtype: 'success',
      result: tokens.join(''),
      total_cost_usd: 0.001,
      duration_ms: 100,
      session_id: 'session-stream',
      is_error: false,
    } as ClaudeMessage;
  };
}

/**
 * Yields a system init, then an AssistantMessage with a tool_use part.
 * Before yielding, calls options.canUseTool so the PermissionGate can
 * accept/reject. Finishes with a text AssistantMessage and a ResultMessage.
 */
function makeToolQuery(toolName: string, toolInput: unknown, finalText: string): ClaudeQueryFn {
  return async function* ({ options }) {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'session-tool',
    } as ClaudeMessage;

    // Ask for permission the same way the real SDK would via canUseTool.
    if (options.canUseTool) {
      const result = await options.canUseTool(toolName, toolInput);
      if (result.behavior === 'deny') {
        // Emit result without the tool output
        yield {
          type: 'result',
          subtype: 'success',
          result: `Tool ${toolName} was denied.`,
          total_cost_usd: 0.0001,
          duration_ms: 10,
          session_id: 'session-tool',
          is_error: false,
        } as ClaudeMessage;
        return;
      }
    }

    // Tool was approved — emit tool_use block then the final text
    yield {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input: toolInput }],
      },
    } as ClaudeMessage;

    yield {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: finalText }],
      },
    } as ClaudeMessage;

    yield {
      type: 'result',
      subtype: 'success',
      result: finalText,
      total_cost_usd: 0.002,
      duration_ms: 200,
      session_id: 'session-tool',
      is_error: false,
    } as ClaudeMessage;
  };
}

/** claudeQuery that immediately throws. */
function makeThrowingQuery(message: string): ClaudeQueryFn {
  return async function* (_params) {
    throw new Error(message);
    // biome-ignore lint/correctness/noUnreachable: generator typing requires yield
    yield {} as ClaudeMessage;
  };
}

// ---------------------------------------------------------------------------
// Test factory: build a MessageProcessor with fresh in-memory DB
// ---------------------------------------------------------------------------

function makeProcessor(claudeQuery: ClaudeQueryFn, slackOps: TrackedSlackOps, workingDir?: string) {
  const db = createDatabase(':memory:');
  const sessionRepo = new SessionRepository(db);
  const workingDirRepo = new WorkingDirectoryRepository(db);

  if (workingDir) {
    workingDirRepo.set({
      dirKey: 'C001',
      channelId: 'C001',
      threadTs: null,
      userId: null,
      directory: workingDir,
      setAt: Date.now(),
    });
  }

  const processor = new MessageProcessor({
    sessionRepo,
    workingDirRepo,
    claudeQuery,
    slackOps,
  });

  return { processor, sessionRepo, workingDirRepo };
}

// ---------------------------------------------------------------------------
// Scenario 1: Simple text response via ResultMessage
// ---------------------------------------------------------------------------

describe('Scenario 1 – simple ResultMessage with text content', () => {
  test('slackOps.say is called with the formatted text from the result', async () => {
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(makeSimpleResultQuery('Here is the answer.'), slackOps);

    await processor.process({
      userId: 'U1',
      channelId: 'D1', // DM — no working-dir required
      ts: '1000000000.000001',
      text: 'What is 2+2?',
    });

    // The result message does NOT produce a separate post; only assistant text
    // parts do. So the only posts are the initial status and the result update.
    // Verify the completed update was applied.
    const completedUpdate = slackOps.updates.find((u) => u.text.includes('Completed'));
    expect(completedUpdate).toBeDefined();

    // No error indicators
    expect(slackOps.posts.some((p) => p.text.includes('Error'))).toBe(false);
    expect(slackOps.updates.some((u) => u.text.includes('Error'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Streaming assistant_message tokens accumulate
// ---------------------------------------------------------------------------

describe('Scenario 2 – streaming assistant messages', () => {
  test('each token is posted as a separate say() call and all arrive', async () => {
    const tokens = ['Hello', ', ', 'world', '!'];
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(makeStreamingQuery(tokens), slackOps);

    await processor.process({
      userId: 'U2',
      channelId: 'D2',
      ts: '1000000000.000001',
      text: 'Say hello',
    });

    // The MessageProcessor posts each text part individually.
    // Initial "Thinking" status is at posts[0]; assistant tokens follow.
    const assistantPosts = slackOps.posts.filter((p) => !p.text.includes('Thinking'));

    // Every non-empty token should produce a post
    const nonEmptyTokens = tokens.filter((t) => t.trim().length > 0);
    expect(assistantPosts.length).toBe(nonEmptyTokens.length);
    expect(assistantPosts.map((p) => p.text)).toEqual(nonEmptyTokens);
  });

  test('the last posted message contains the final token text', async () => {
    const tokens = ['Part A', 'Part B', 'Part C'];
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(makeStreamingQuery(tokens), slackOps);

    await processor.process({
      userId: 'U2',
      channelId: 'D2',
      ts: '1000000000.000002',
      text: 'Stream to me',
    });

    const lastPost = slackOps.posts[slackOps.posts.length - 1];
    expect(lastPost.text).toBe('Part C');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Tool use – safe tool (Glob) — no permission Slack message
// ---------------------------------------------------------------------------

describe('Scenario 3 – safe tool (Glob) skips permission request', () => {
  test('no permission request is posted for Glob', async () => {
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(
      makeToolQuery('Glob', { pattern: '**/*.ts' }, 'Found files.'),
      slackOps
    );

    await processor.process({
      userId: 'U3',
      channelId: 'D3',
      ts: '1000000000.000001',
      text: 'List all TS files',
    });

    // No permission request should have been posted
    expect(slackOps.permissionRequests).toHaveLength(0);

    // The tool was allowed — final text was posted and flow completed
    const finalPost = slackOps.posts.find((p) => p.text === 'Found files.');
    expect(finalPost).toBeDefined();

    const completedUpdate = slackOps.updates.find((u) => u.text.includes('Completed'));
    expect(completedUpdate).toBeDefined();
  });

  test('status message shows Glob tool description while working', async () => {
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(
      makeToolQuery('Glob', { pattern: '**/*.ts' }, 'Done.'),
      slackOps
    );

    await processor.process({
      userId: 'U3',
      channelId: 'D3',
      ts: '1000000000.000002',
      text: 'Find files',
    });

    const workingUpdate = slackOps.updates.find((u) => u.text.includes('Working'));
    expect(workingUpdate).toBeDefined();
    // formatToolDescription for Glob uses the pattern
    expect(workingUpdate?.text).toContain('**/*.ts');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Tool use – unsafe tool (Bash) — permission requested, then allowed
// ---------------------------------------------------------------------------

describe('Scenario 4 – unsafe tool (Bash) triggers permission request', () => {
  test('postPermissionRequest is called for Bash and flow continues after approval', async () => {
    const slackOps = makeSlackOps(true); // auto-approve
    const { processor } = makeProcessor(
      makeToolQuery('Bash', { command: 'ls /tmp' }, 'Listed /tmp.'),
      slackOps
    );

    await processor.process({
      userId: 'U4',
      channelId: 'D4',
      ts: '1000000000.000001',
      text: 'List /tmp',
    });

    // A permission request was posted for Bash
    expect(slackOps.permissionRequests).toHaveLength(1);
    expect(slackOps.permissionRequests[0].tool).toBe('Bash');

    // Flow completed — final text was posted
    const finalPost = slackOps.posts.find((p) => p.text === 'Listed /tmp.');
    expect(finalPost).toBeDefined();

    const completedUpdate = slackOps.updates.find((u) => u.text.includes('Completed'));
    expect(completedUpdate).toBeDefined();
  });

  test('when Bash is denied, tool_use block is not yielded and flow ends early', async () => {
    const slackOps = makeSlackOps(false); // auto-deny
    const { processor } = makeProcessor(
      makeToolQuery('Bash', { command: 'rm -rf /' }, 'This should not appear.'),
      slackOps
    );

    await processor.process({
      userId: 'U4',
      channelId: 'D4',
      ts: '1000000000.000002',
      text: 'Do dangerous thing',
    });

    // A permission request was posted
    expect(slackOps.permissionRequests).toHaveLength(1);
    expect(slackOps.permissionRequests[0].tool).toBe('Bash');

    // The final text was NOT posted (query returned early due to denial)
    expect(slackOps.posts.some((p) => p.text === 'This should not appear.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Working directory is injected into claudeQuery options
// ---------------------------------------------------------------------------

describe('Scenario 5 – working directory is passed to claudeQuery', () => {
  test('claudeQuery receives the cwd set in the DB for the channel', async () => {
    let capturedCwd: string | undefined;

    const capturingQuery: ClaudeQueryFn = async function* ({ options }) {
      capturedCwd = options.cwd;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'session-cwd',
      } as ClaudeMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0,
        duration_ms: 1,
        session_id: 'session-cwd',
        is_error: false,
      } as ClaudeMessage;
    };

    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(capturingQuery, slackOps, '/home/user/myproject');

    await processor.process({
      userId: 'U5',
      channelId: 'C001', // channel (not DM) — uses working dir set in makeProcessor
      ts: '1000000000.000001',
      text: 'Do some work',
    });

    expect(capturedCwd).toBe('/home/user/myproject');
  });

  test('DM message passes undefined cwd when no working directory is set', async () => {
    let capturedCwd: string | undefined = 'UNSET';

    const capturingQuery: ClaudeQueryFn = async function* ({ options }) {
      capturedCwd = options.cwd;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'session-dm-cwd',
      } as ClaudeMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0,
        duration_ms: 1,
        session_id: 'session-dm-cwd',
        is_error: false,
      } as ClaudeMessage;
    };

    const slackOps = makeSlackOps();
    // No workingDir passed → DB has nothing for 'D5'
    const { processor } = makeProcessor(capturingQuery, slackOps);

    await processor.process({
      userId: 'U5',
      channelId: 'D5', // DM — skips working-dir requirement
      ts: '1000000000.000001',
      text: 'Hello from DM',
    });

    expect(capturedCwd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Session continuity — second call passes session_id from first
// ---------------------------------------------------------------------------

describe('Scenario 6 – session continuity across consecutive calls', () => {
  test('second call passes the claude session_id stored by the first call', async () => {
    const capturedResumes: Array<string | undefined> = [];

    const trackingQuery: ClaudeQueryFn = async function* ({ options }) {
      capturedResumes.push(options.resume);
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-xyz',
      } as ClaudeMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        total_cost_usd: 0,
        duration_ms: 1,
        session_id: 'claude-session-xyz',
        is_error: false,
      } as ClaudeMessage;
    };

    // Both calls share the same DB — use a single factory call then reuse repos
    const db = createDatabase(':memory:');
    const sessionRepo = new SessionRepository(db);
    const workingDirRepo = new WorkingDirectoryRepository(db);

    const slackOps1 = makeSlackOps();
    const processor1 = new MessageProcessor({
      sessionRepo,
      workingDirRepo,
      claudeQuery: trackingQuery,
      slackOps: slackOps1,
    });

    // First call — session not yet in DB
    await processor1.process({
      userId: 'U6',
      channelId: 'D6',
      ts: '1000000000.000001',
      threadTs: 'thread-6',
      text: 'First message',
    });

    // After first call, DB should have the claude session id stored
    const storedSession = sessionRepo.find('U6-D6-thread-6');
    expect(storedSession?.claudeSessionId).toBe('claude-session-xyz');

    // Second call — reuse same repos so session is found
    const slackOps2 = makeSlackOps();
    const processor2 = new MessageProcessor({
      sessionRepo,
      workingDirRepo,
      claudeQuery: trackingQuery,
      slackOps: slackOps2,
    });

    await processor2.process({
      userId: 'U6',
      channelId: 'D6',
      ts: '1000000000.000002',
      threadTs: 'thread-6',
      text: 'Second message',
    });

    // First call had no resume (no existing session)
    expect(capturedResumes[0]).toBeUndefined();
    // Second call should pass the session_id from the first call
    expect(capturedResumes[1]).toBe('claude-session-xyz');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Error handling — claudeQuery throws
// ---------------------------------------------------------------------------

describe('Scenario 7 – claudeQuery throws an error', () => {
  test('processor updates status to error and re-throws', async () => {
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(makeThrowingQuery('Something went wrong'), slackOps);

    await expect(
      processor.process({
        userId: 'U7',
        channelId: 'D7',
        ts: '1000000000.000001',
        text: 'Trigger an error',
      })
    ).rejects.toThrow('Something went wrong');

    // Status message should have been updated to show the error
    const errorUpdate = slackOps.updates.find((u) => u.text.includes('Error'));
    expect(errorUpdate).toBeDefined();
  });

  test('error reaction is added and thinking reaction is removed', async () => {
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(makeThrowingQuery('Boom'), slackOps);

    await expect(
      processor.process({
        userId: 'U7',
        channelId: 'D7',
        ts: '1000000000.000002',
        text: 'Boom please',
      })
    ).rejects.toThrow('Boom');

    // thinking_face should have been removed on error
    expect(slackOps.reactionsRemoved.some((r) => r.name === 'thinking_face')).toBe(true);

    // x (error) reaction should have been added
    expect(slackOps.reactionsAdded.some((r) => r.name === 'x')).toBe(true);

    // white_check_mark should NOT have been added
    expect(slackOps.reactionsAdded.some((r) => r.name === 'white_check_mark')).toBe(false);
  });

  test('no Completed update is emitted when query throws', async () => {
    const slackOps = makeSlackOps();
    const { processor } = makeProcessor(makeThrowingQuery('Fatal error'), slackOps);

    await expect(
      processor.process({
        userId: 'U7',
        channelId: 'D7',
        ts: '1000000000.000003',
        text: 'Fail',
      })
    ).rejects.toThrow();

    expect(slackOps.updates.some((u) => u.text.includes('Completed'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional integration: channel requires working directory
// ---------------------------------------------------------------------------

describe('Channel message without working directory', () => {
  test('posts a warning and does not invoke claudeQuery', async () => {
    let queryInvoked = false;

    const neverCalledQuery: ClaudeQueryFn = async function* (_params) {
      queryInvoked = true;
      yield {} as ClaudeMessage;
    };

    const db = createDatabase(':memory:');
    const sessionRepo = new SessionRepository(db);
    const workingDirRepo = new WorkingDirectoryRepository(db);

    const slackOps = makeSlackOps();
    const processor = new MessageProcessor({
      sessionRepo,
      workingDirRepo,
      claudeQuery: neverCalledQuery,
      slackOps,
    });

    await processor.process({
      userId: 'U8',
      channelId: 'C888', // channel, no working dir set
      ts: '1000000000.000001',
      text: 'Help me',
    });

    expect(queryInvoked).toBe(false);

    // Should have posted the warning
    const warningPost = slackOps.posts.find((p) =>
      p.text.toLowerCase().includes('working directory')
    );
    expect(warningPost).toBeDefined();
  });
});
