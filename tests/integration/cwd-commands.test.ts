/**
 * Integration tests for cwd and mcp commands handled by registerHandlers.
 *
 * Instead of spinning up a real Bolt app, we build a minimal fake App that
 * captures the handler callbacks registered via app.event(), app.message(),
 * and app.action().  We then invoke those callbacks directly with crafted
 * fake payloads — no real Slack API or Anthropic API calls are made.
 *
 * Scenarios covered:
 *  1. `cwd /absolute/path` in a DM sets the working directory and replies.
 *  2. `cwd project-name` with a baseDirectory configured resolves the path.
 *  3. `mcp` status command returns a formatted server list.
 *  4. `mcp reload` triggers mcpManager.reload() and replies.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Config } from '../../src/config';
import { createDatabase } from '../../src/db/database';
import { SessionRepository } from '../../src/db/sessions';
import { WorkingDirectoryRepository } from '../../src/db/working-dirs';
import type { McpManager } from '../../src/mcp/manager';
import { registerHandlers } from '../../src/slack/handler';
import type { ClaudeMessage, ClaudeQueryFn } from '../../src/utils/types';

// ---------------------------------------------------------------------------
// Minimal fake Bolt App
// ---------------------------------------------------------------------------

type AnyHandler = (payload: Record<string, unknown>) => Promise<void>;

interface FakeApp {
  // Store registered handlers so tests can invoke them
  _eventHandlers: Map<string, AnyHandler>;
  _messageHandlers: AnyHandler[];
  _actionHandlers: Map<string, AnyHandler>;
  event(name: string, handler: AnyHandler): void;
  message(handler: AnyHandler): void;
  action(name: string, handler: AnyHandler): void;
}

function createFakeApp(): FakeApp {
  const _eventHandlers = new Map<string, AnyHandler>();
  const _messageHandlers: AnyHandler[] = [];
  const _actionHandlers = new Map<string, AnyHandler>();

  return {
    _eventHandlers,
    _messageHandlers,
    _actionHandlers,
    event(name, handler) {
      _eventHandlers.set(name, handler);
    },
    message(handler) {
      _messageHandlers.push(handler);
    },
    action(name, handler) {
      _actionHandlers.set(name, handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake McpManager
// ---------------------------------------------------------------------------

function createFakeMcpManager(serverNames: string[] = []): McpManager & { loadCallCount: number } {
  return {
    loadCallCount: 0,
    load() {
      (this as { loadCallCount: number }).loadCallCount++;
    },
    getServers() {
      return Object.fromEntries(serverNames.map((n) => [n, {}]));
    },
    getServerNames() {
      return serverNames;
    },
  } as unknown as McpManager & { loadCallCount: number };
}

// ---------------------------------------------------------------------------
// Dummy claudeQuery (never actually called in command tests)
// ---------------------------------------------------------------------------

const dummyClaudeQuery: ClaudeQueryFn = async function* (_params) {
  yield {} as ClaudeMessage;
};

// ---------------------------------------------------------------------------
// Test factory
// ---------------------------------------------------------------------------

interface TestHarness {
  app: FakeApp;
  workingDirRepo: WorkingDirectoryRepository;
  sessionRepo: SessionRepository;
  mcpManager: ReturnType<typeof createFakeMcpManager>;
  config: Config;
}

function makeHarness(overrides?: {
  baseDirectory?: string;
  serverNames?: string[];
}): TestHarness {
  const db = createDatabase(':memory:');
  const sessionRepo = new SessionRepository(db);
  const workingDirRepo = new WorkingDirectoryRepository(db);
  const mcpManager = createFakeMcpManager(overrides?.serverNames ?? []);
  const app = createFakeApp();

  const config: Config = {
    slack: {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
    },
    claude: {
      useBedrock: false,
      useVertex: false,
      maxBudgetUsd: 1.0,
      maxTurns: 10,
    },
    baseDirectory: overrides?.baseDirectory ?? '',
    dbPath: ':memory:',
    debug: false,
  };

  registerHandlers({
    app: app as unknown as Parameters<typeof registerHandlers>[0]['app'],
    config,
    sessionRepo,
    workingDirRepo,
    mcpManager,
    claudeQuery: dummyClaudeQuery,
  });

  return { app, workingDirRepo, sessionRepo, mcpManager, config };
}

// ---------------------------------------------------------------------------
// Helper: fire the registered message handler with a crafted DM event
// ---------------------------------------------------------------------------

async function sendDM(
  harness: TestHarness,
  text: string
): Promise<{ sayArgs: Array<Record<string, unknown>> }> {
  const sayArgs: Array<Record<string, unknown>> = [];

  const event = {
    channel: 'D100',
    user: 'U100',
    ts: '1000000000.000001',
    text,
  };

  const say = async (msg: Record<string, unknown>) => {
    sayArgs.push(msg);
  };

  // client for DM handler — only needed for MessageProcessor path (not command paths)
  const client = {
    chat: {
      postMessage: async () => ({ ts: '1000000000.000010' }),
      update: async () => ({}),
    },
    reactions: { add: async () => ({}), remove: async () => ({}) },
  };

  const handler = harness.app._messageHandlers[0];
  if (!handler) throw new Error('No message handler registered');

  await handler({ event, client, say } as unknown as Record<string, unknown>);

  return { sayArgs };
}

// ---------------------------------------------------------------------------
// Helper: fire the app_mention handler
// ---------------------------------------------------------------------------

async function sendMention(
  harness: TestHarness,
  text: string,
  channelId = 'C100'
): Promise<{ sayArgs: Array<Record<string, unknown>> }> {
  const sayArgs: Array<Record<string, unknown>> = [];

  const event = {
    channel: channelId,
    user: 'U100',
    ts: '1000000000.000001',
    text,
  };

  const say = async (msg: Record<string, unknown>) => {
    sayArgs.push(msg);
  };

  const client = {
    chat: {
      postMessage: async () => ({ ts: '1000000000.000010' }),
      update: async () => ({}),
    },
    reactions: { add: async () => ({}), remove: async () => ({}) },
  };

  const handler = harness.app._eventHandlers.get('app_mention');
  if (!handler) throw new Error('No app_mention handler registered');

  await handler({ event, client, say } as unknown as Record<string, unknown>);

  return { sayArgs };
}

// ---------------------------------------------------------------------------
// Scenario 1: `cwd /absolute/path` in a DM sets working directory
// ---------------------------------------------------------------------------

describe('Scenario 1 – cwd /absolute/path in a DM', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  test('stores the directory in the DB with the channel as key', async () => {
    await sendDM(harness, 'cwd /home/user/myproject');

    const stored = harness.workingDirRepo.find('D100');
    expect(stored).not.toBeNull();
    expect(stored?.directory).toBe('/home/user/myproject');
    expect(stored?.channelId).toBe('D100');
  });

  test('replies with a confirmation message containing the resolved path', async () => {
    const { sayArgs } = await sendDM(harness, 'cwd /home/user/myproject');

    expect(sayArgs).toHaveLength(1);
    const reply = sayArgs[0];
    expect(String(reply.text)).toContain('/home/user/myproject');
    expect(String(reply.text)).toContain('Working directory set');
  });

  test('absolute path is used as-is (not joined with base directory)', async () => {
    const harnessWithBase = makeHarness({ baseDirectory: '/base/dir' });
    await sendDM(harnessWithBase, 'cwd /absolute/path');

    const stored = harnessWithBase.workingDirRepo.find('D100');
    expect(stored?.directory).toBe('/absolute/path');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: `cwd project-name` with base directory resolves correctly
// ---------------------------------------------------------------------------

describe('Scenario 2 – cwd project-name with baseDirectory configured', () => {
  test('resolves relative name against baseDirectory', async () => {
    const harness = makeHarness({ baseDirectory: '/Users/alice/code' });

    await sendDM(harness, 'cwd my-project');

    const stored = harness.workingDirRepo.find('D100');
    expect(stored?.directory).toBe('/Users/alice/code/my-project');
  });

  test('reply confirms the resolved absolute path', async () => {
    const harness = makeHarness({ baseDirectory: '/Users/alice/code' });
    const { sayArgs } = await sendDM(harness, 'cwd my-project');

    expect(sayArgs).toHaveLength(1);
    expect(String(sayArgs[0].text)).toContain('/Users/alice/code/my-project');
  });

  test('without baseDirectory, relative name is stored as-is', async () => {
    const harness = makeHarness({ baseDirectory: '' });

    await sendDM(harness, 'cwd my-project');

    const stored = harness.workingDirRepo.find('D100');
    expect(stored?.directory).toBe('my-project');
  });

  test('cwd via app_mention in a channel also resolves with baseDirectory', async () => {
    const harness = makeHarness({ baseDirectory: '/repos' });

    await sendMention(harness, '<@UBOT> cwd cool-app', 'C200');

    const stored = harness.workingDirRepo.find('C200');
    expect(stored?.directory).toBe('/repos/cool-app');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: `mcp` status command returns a formatted server list
// ---------------------------------------------------------------------------

describe('Scenario 3 – mcp status command', () => {
  test('lists configured servers in the reply (DM)', async () => {
    const harness = makeHarness({ serverNames: ['filesystem', 'github', 'postgres'] });

    const { sayArgs } = await sendDM(harness, 'mcp');

    expect(sayArgs).toHaveLength(1);
    const text = String(sayArgs[0].text);
    expect(text).toContain('filesystem');
    expect(text).toContain('github');
    expect(text).toContain('postgres');
    expect(text).toContain('MCP Servers');
  });

  test('shows _none_ when no servers are configured (DM)', async () => {
    const harness = makeHarness({ serverNames: [] });

    const { sayArgs } = await sendDM(harness, 'mcp');

    expect(sayArgs).toHaveLength(1);
    expect(String(sayArgs[0].text)).toContain('_none_');
  });

  test('lists configured servers via app_mention in a channel', async () => {
    const harness = makeHarness({ serverNames: ['myserver'] });

    const { sayArgs } = await sendMention(harness, '<@UBOT> mcp', 'C300');

    expect(sayArgs).toHaveLength(1);
    expect(String(sayArgs[0].text)).toContain('myserver');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: `mcp reload` triggers mcpManager.reload()
// ---------------------------------------------------------------------------

describe('Scenario 4 – mcp reload command', () => {
  test('calls mcpManager.reload() when the DM text is "mcp reload"', async () => {
    const harness = makeHarness({ serverNames: ['srv-a'] });

    expect(harness.mcpManager.loadCallCount).toBe(0);

    await sendDM(harness, 'mcp reload');

    expect(harness.mcpManager.loadCallCount).toBe(1);
  });

  test('replies with a success confirmation after reload (DM)', async () => {
    const harness = makeHarness({ serverNames: ['srv-a'] });

    const { sayArgs } = await sendDM(harness, 'mcp reload');

    expect(sayArgs).toHaveLength(1);
    expect(String(sayArgs[0].text)).toContain('reloaded');
  });

  test('includes current server names in reload reply (DM)', async () => {
    const harness = makeHarness({ serverNames: ['srv-x', 'srv-y'] });

    const { sayArgs } = await sendDM(harness, 'mcp reload');

    const text = String(sayArgs[0].text);
    expect(text).toContain('srv-x');
    expect(text).toContain('srv-y');
  });

  test('calls mcpManager.reload() when triggered via app_mention', async () => {
    const harness = makeHarness({ serverNames: ['srv-b'] });

    await sendMention(harness, '<@UBOT> mcp reload', 'C400');

    expect(harness.mcpManager.loadCallCount).toBe(1);
  });

  test('shows _none_ in reload reply when no servers are configured', async () => {
    const harness = makeHarness({ serverNames: [] });

    const { sayArgs } = await sendDM(harness, 'mcp reload');

    expect(String(sayArgs[0].text)).toContain('_none_');
  });
});
