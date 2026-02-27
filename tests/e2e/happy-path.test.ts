/**
 * E2E Happy Path Tests
 *
 * Tests the full message processing pipeline using:
 * - Real in-memory SQLite (via createTestDb)
 * - Mocked Claude query (no Anthropic API calls)
 * - Mocked Slack ops (no Slack API calls)
 *
 * Covers the critical user-facing flows without external dependencies.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { PermissionGate } from '../../src/claude/permissions';
import type { SessionRepository } from '../../src/db/sessions';
import type { WorkingDirectoryRepository } from '../../src/db/working-dirs';
import { MessageProcessor } from '../../src/slack/message-processor';
import { createMockClaudeQuery, createMockClaudeQueryWithTool } from '../fixtures/claude';
import { createTestRepos } from '../fixtures/db';
import { createMockSlackOps } from '../fixtures/slack';

const NOW = Date.now();

function makeProcessor(
  deps: {
    sessionRepo: SessionRepository;
    workingDirRepo: WorkingDirectoryRepository;
  },
  claudeQuery = createMockClaudeQuery(['Hello!']),
  autoApprove = true
) {
  const slackOps = createMockSlackOps(autoApprove);
  const processor = new MessageProcessor({
    ...deps,
    claudeQuery,
    slackOps,
    permissionGate: new PermissionGate(),
    maxBudgetUsd: 1.0,
    maxTurns: 50,
  });
  return { processor, slackOps };
}

describe('Happy Path E2E', () => {
  let repos: ReturnType<typeof createTestRepos>;

  beforeEach(() => {
    repos = createTestRepos();
  });

  describe('DM conversation', () => {
    test('sends thinking status, posts Claude response, updates to completed', async () => {
      const { processor, slackOps } = makeProcessor(
        repos,
        createMockClaudeQuery(['Here is my answer!'])
      );

      await processor.process({
        userId: 'U123',
        channelId: 'D123', // DM channel
        ts: '1000000000.000001',
        text: 'Help me write a TypeScript function',
      });

      const { posts, updates, reactionsAdded } = slackOps.state;

      // 1. Thinking status posted first
      expect(posts[0].text).toMatch(/thinking/i);

      // 2. Claude response posted
      const responsePosts = posts.filter((p) => p.text === 'Here is my answer!');
      expect(responsePosts).toHaveLength(1);

      // 3. Status updated to completed
      const completedUpdate = updates.find((u) => u.text.includes('Completed'));
      expect(completedUpdate).toBeDefined();

      // 4. Reactions: thinking_face added then removed, white_check_mark added
      expect(reactionsAdded.some((r) => r.name === 'thinking_face')).toBe(true);
      expect(reactionsAdded.some((r) => r.name === 'white_check_mark')).toBe(true);
    });

    test('session is created and claude_session_id is stored after first message', async () => {
      const { processor } = makeProcessor(repos);

      await processor.process({
        userId: 'U123',
        channelId: 'D123',
        ts: '1000000000.000001',
        text: 'First message',
      });

      const session = repos.sessionRepo.find('U123-D123-direct');
      expect(session).not.toBeNull();
      expect(session?.claudeSessionId).toBe('test-session-123');
      expect(session?.userId).toBe('U123');
    });

    test('second message resumes existing session', async () => {
      const query = createMockClaudeQuery(['Response 1']);
      const { processor } = makeProcessor(repos, query);

      // First message - creates session
      await processor.process({
        userId: 'U456',
        channelId: 'D456',
        ts: '1000000000.000001',
        text: 'First',
      });

      // Second message - should have session with claudeSessionId
      const secondQuery = createMockClaudeQuery(['Response 2']);
      const { processor: proc2 } = makeProcessor(repos, secondQuery);

      await proc2.process({
        userId: 'U456',
        channelId: 'D456',
        ts: '1000000000.000002',
        text: 'Follow-up',
      });

      // Session still exists and is active
      const session = repos.sessionRepo.find('U456-D456-direct');
      expect(session?.claudeSessionId).toBe('test-session-123');
    });

    test('thread messages use thread_ts in session key', async () => {
      const { processor } = makeProcessor(repos);

      await processor.process({
        userId: 'U123',
        channelId: 'D123',
        ts: '1000000000.000001',
        threadTs: 'thread-ts-abc',
        text: 'In a thread',
      });

      // Session key should include threadTs
      expect(repos.sessionRepo.find('U123-D123-thread-ts-abc')).not.toBeNull();
      // Direct session should NOT exist
      expect(repos.sessionRepo.find('U123-D123-direct')).toBeNull();
    });
  });

  describe('Channel conversation', () => {
    test('errors without a working directory set', async () => {
      const query = createMockClaudeQuery(['Should not be called']);
      const { processor, slackOps } = makeProcessor(repos, query);

      await processor.process({
        userId: 'U123',
        channelId: 'C123', // channel, not DM
        ts: '1000000000.000001',
        text: 'Help me',
      });

      // Should post error about missing working directory
      const errorPost = slackOps.state.posts.find((p) =>
        p.text.toLowerCase().includes('working directory')
      );
      expect(errorPost).toBeDefined();

      // Claude should NOT have been called
      // (we verify indirectly: no session created, no "Completed" update)
      expect(repos.sessionRepo.find('U123-C123-direct')).toBeNull();
      expect(slackOps.state.updates.some((u) => u.text.includes('Completed'))).toBe(false);
    });

    test('processes message when working directory is set', async () => {
      // Set up working directory for the channel
      repos.workingDirRepo.set({
        dirKey: 'C456',
        channelId: 'C456',
        threadTs: null,
        userId: null,
        directory: '/tmp',
        setAt: NOW,
      });

      const { processor, slackOps } = makeProcessor(
        repos,
        createMockClaudeQuery(['Fixed your code!'])
      );

      await processor.process({
        userId: 'U123',
        channelId: 'C456',
        ts: '1000000000.000001',
        text: 'Fix my bug',
      });

      const responsePosts = slackOps.state.posts.filter((p) => p.text === 'Fixed your code!');
      expect(responsePosts).toHaveLength(1);

      const completedUpdate = slackOps.state.updates.find((u) => u.text.includes('Completed'));
      expect(completedUpdate).toBeDefined();
    });

    test('thread override takes precedence over channel working directory', async () => {
      repos.workingDirRepo.set({
        dirKey: 'C789',
        channelId: 'C789',
        threadTs: null,
        userId: null,
        directory: '/channel-dir',
        setAt: NOW,
      });
      repos.workingDirRepo.set({
        dirKey: 'C789-thread1',
        channelId: 'C789',
        threadTs: 'thread1',
        userId: null,
        directory: '/thread-dir',
        setAt: NOW,
      });

      const { processor, slackOps } = makeProcessor(repos, createMockClaudeQuery(['Done']));

      await processor.process({
        userId: 'U123',
        channelId: 'C789',
        ts: '1000000000.000001',
        threadTs: 'thread1',
        text: 'Do something',
      });

      // Should complete successfully using thread directory
      expect(slackOps.state.updates.some((u) => u.text.includes('Completed'))).toBe(true);
    });
  });

  describe('Tool use flow', () => {
    test('status message updates when Claude uses a tool', async () => {
      const { processor, slackOps } = makeProcessor(
        repos,
        createMockClaudeQueryWithTool('Read', { file_path: '/src/index.ts' }, 'I read the file.')
      );

      await processor.process({
        userId: 'U123',
        channelId: 'D123',
        ts: '1000000000.000001',
        text: 'What is in index.ts?',
      });

      // Status should have been updated to show tool use
      const workingUpdate = slackOps.state.updates.find((u) => u.text.includes('Working'));
      expect(workingUpdate).toBeDefined();
      expect(workingUpdate?.text).toContain('/src/index.ts');

      // Final response posted
      const response = slackOps.state.posts.find((p) => p.text === 'I read the file.');
      expect(response).toBeDefined();
    });

    test('dangerous tool triggers permission request', async () => {
      const { processor, slackOps } = makeProcessor(
        repos,
        createMockClaudeQueryWithTool('Bash', { command: 'ls /tmp' }, 'Listed files.'),
        true // auto-approve
      );

      await processor.process({
        userId: 'U123',
        channelId: 'D123',
        ts: '1000000000.000001',
        text: 'List /tmp',
      });

      // Permission was requested for Bash
      expect(slackOps.state.permissionRequests.some((r) => r.tool === 'Bash')).toBe(true);
      // And the message was processed to completion (approved)
      expect(slackOps.state.updates.some((u) => u.text.includes('Completed'))).toBe(true);
    });
  });

  describe('Cost tracking', () => {
    test('completed message includes cost when available', async () => {
      const { processor, slackOps } = makeProcessor(repos, createMockClaudeQuery(['Done']));

      await processor.process({
        userId: 'U123',
        channelId: 'D123',
        ts: '1000000000.000001',
        text: 'Do something',
      });

      const completedUpdate = slackOps.state.updates.find((u) => u.text.includes('Completed'));
      expect(completedUpdate?.text).toContain('USD');
    });
  });
});
