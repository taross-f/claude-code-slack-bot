import { join } from 'node:path';
import type { App } from '@slack/bolt';
import { PermissionGate } from '../claude/permissions';
import type { Config } from '../config';
import type { SessionRepository } from '../db/sessions';
import type { WorkingDirectoryRepository } from '../db/working-dirs';
import type { McpManager } from '../mcp/manager';
import { Logger } from '../utils/logger';
import type { ClaudeQueryFn, IncomingMessage, SlackFile, SlackOps } from '../utils/types';
import { buildPermissionBlock } from './blocks';
import { cleanupTempFile, processUploadedFile } from './file-upload';
import { MessageProcessor } from './message-processor';

export interface HandlerDeps {
  app: App;
  config: Config;
  sessionRepo: SessionRepository;
  workingDirRepo: WorkingDirectoryRepository;
  mcpManager: McpManager;
  claudeQuery: ClaudeQueryFn;
}

const logger = new Logger('SlackHandler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip the leading <@BOTID> mention from a string and trim the result. */
function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
}

/** Resolve a path argument against the base directory when appropriate. */
function resolveCwd(rawPath: string, baseDirectory: string): string {
  if (rawPath.startsWith('/')) {
    return rawPath;
  }
  if (baseDirectory) {
    return join(baseDirectory, rawPath);
  }
  return rawPath;
}

/** Parse `cwd <path>` from cleaned text. Returns null if not a cwd command. */
function parseCwdCommand(text: string): string | null {
  const match = text.match(/^cwd\s+(\S+)/i);
  return match ? match[1] : null;
}

/** Return true when text is a bare `mcp` status command. */
function isMcpStatus(text: string): boolean {
  return /^mcp\s*$/i.test(text);
}

/** Return true when text is a `mcp reload` command. */
function isMcpReload(text: string): boolean {
  return /^mcp\s+reload\s*$/i.test(text);
}

/** Download a Slack file and return its Buffer. Throws on failure. */
async function downloadFile(file: SlackFile, botToken: string): Promise<Buffer> {
  const response = await fetch(file.urlPrivate, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to download file "${file.name}": HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Process attached Slack files using the file-upload module.
 * Returns:
 *  - `extra`: text to append to the user prompt (file contents / paths)
 *  - `tempFiles`: paths of temp files to clean up after processing
 */
async function processFiles(
  files: SlackFile[],
  botToken: string
): Promise<{ extra: string; tempFiles: string[] }> {
  const parts: string[] = [];
  const tempFiles: string[] = [];

  for (const file of files) {
    let buffer: Buffer;
    try {
      buffer = await downloadFile(file, botToken);
    } catch (err) {
      logger.warn('Skipping file due to download error', { name: file.name, err });
      continue;
    }

    const result = await processUploadedFile(file, buffer);

    if (result.kind === 'image') {
      tempFiles.push(result.tempPath);
      parts.push(`\n\n[Image saved to ${result.tempPath} - use Read tool to analyze it]`);
    } else if (result.kind === 'text') {
      parts.push(`\n\n--- File: ${file.name} ---\n${result.content}\n`);
    }
    // 'skipped' results are silently ignored (already logged in processUploadedFile)
  }

  return { extra: parts.join(''), tempFiles };
}

/** Normalise raw file objects from Slack events into SlackFile structs. */
function normaliseFiles(raw: unknown): SlackFile[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).map((item) => {
    const f = item as Record<string, unknown>;
    return {
      id: f.id as string,
      name: f.name as string,
      mimetype: f.mimetype as string,
      size: f.size as number,
      urlPrivate: (f.url_private ?? f.urlPrivate) as string,
    };
  });
}

// ---------------------------------------------------------------------------
// buildSlackOps
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: Bolt passes a WebClient subtype that differs from @slack/web-api's Block types
function buildSlackOps(client: any, channelId: string): SlackOps {
  return {
    async say({ text, thread_ts }) {
      const result = await client.chat.postMessage({
        channel: channelId,
        text,
        thread_ts,
      });
      return { ts: result.ts as string };
    },

    async updateMessage(channel, ts, text) {
      await client.chat.update({ channel, ts, text });
    },

    async addReaction(channel, ts, name) {
      try {
        await client.reactions.add({ channel, timestamp: ts, name });
      } catch {
        // Ignore duplicate-reaction and other non-fatal errors
      }
    },

    async removeReaction(channel, ts, name) {
      try {
        await client.reactions.remove({ channel, timestamp: ts, name });
      } catch {
        // Ignore no-reaction and other non-fatal errors
      }
    },

    async postPermissionRequest(channel, threadTs, approvalId, tool, input) {
      const blocks = buildPermissionBlock(approvalId, tool, input);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Permission required for tool: ${tool}`,
        blocks,
      });
      // Actual resolution comes asynchronously via block_actions
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Meta-command handling (shared between app_mention and DM)
// ---------------------------------------------------------------------------

interface MetaCommandContext {
  cleanText: string;
  channelId: string;
  threadTs: string | undefined;
  ts: string;
  userId: string;
  say: (opts: { text: string; thread_ts?: string }) => Promise<unknown>;
  config: Config;
  workingDirRepo: WorkingDirectoryRepository;
  mcpManager: McpManager;
}

/** Handle cwd/mcp commands. Returns true if a command was handled. */
async function handleMetaCommand(ctx: MetaCommandContext): Promise<boolean> {
  const { cleanText, channelId, threadTs, ts, userId, say, config, workingDirRepo, mcpManager } =
    ctx;
  const replyTs = threadTs ?? ts;

  // CWD command
  const cwdPath = parseCwdCommand(cleanText);
  if (cwdPath !== null) {
    const resolved = resolveCwd(cwdPath, config.baseDirectory);
    const dirKey = threadTs ? `${channelId}-${threadTs}` : channelId;
    workingDirRepo.set({
      dirKey,
      channelId,
      threadTs: threadTs ?? null,
      userId,
      directory: resolved,
      setAt: Date.now(),
    });
    await say({ text: `✅ Working directory set to \`${resolved}\``, thread_ts: replyTs });
    return true;
  }

  // MCP reload
  if (isMcpReload(cleanText)) {
    mcpManager.load();
    const list = formatMcpList(mcpManager);
    await say({
      text: `✅ MCP configuration reloaded successfully.\n\nServers:\n${list}`,
      thread_ts: replyTs,
    });
    return true;
  }

  // MCP status
  if (isMcpStatus(cleanText)) {
    const list = formatMcpList(mcpManager);
    await say({ text: `🔧 *MCP Servers Configured:*\n${list}`, thread_ts: replyTs });
    return true;
  }

  return false;
}

function formatMcpList(mcpManager: McpManager): string {
  const names = mcpManager.getServerNames();
  return names.length > 0 ? names.map((n) => `• ${n}`).join('\n') : '_none_';
}

// ---------------------------------------------------------------------------
// Thread context fetching
// ---------------------------------------------------------------------------

const THREAD_CONTEXT_MAX_MESSAGES = 30;

/**
 * Fetch the conversation history from a Slack thread and format it as context
 * for Claude. This allows the bot to understand what was discussed before it
 * was mentioned mid-thread.
 */
async function fetchThreadContext(
  // biome-ignore lint/suspicious/noExplicitAny: Bolt client type
  client: any,
  channelId: string,
  threadTs: string,
  currentMessageTs: string
): Promise<string> {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 200,
    });

    const messages = (result.messages ?? []) as Array<{
      user?: string;
      bot_id?: string;
      text?: string;
      ts: string;
    }>;

    // Exclude the current message from context
    const contextMessages = messages.filter((m) => m.ts !== currentMessageTs);
    if (contextMessages.length === 0) return '';

    // Take the last N messages to keep context manageable
    const trimmed =
      contextMessages.length > THREAD_CONTEXT_MAX_MESSAGES
        ? contextMessages.slice(-THREAD_CONTEXT_MAX_MESSAGES)
        : contextMessages;

    const lines = trimmed.map((m) => {
      const sender = m.bot_id ? '[Bot]' : `<@${m.user}>`;
      return `${sender}: ${(m.text ?? '').trim()}`;
    });

    return `[Thread Context - Previous messages in this thread]\n${lines.join('\n')}\n[End of Thread Context]\n\n`;
  } catch (err) {
    logger.warn('Failed to fetch thread context', { channelId, threadTs, err });
    return '';
  }
}

// ---------------------------------------------------------------------------
// Message dispatch (shared between app_mention and DM)
// ---------------------------------------------------------------------------

interface DispatchContext {
  cleanText: string;
  channelId: string;
  userId: string;
  ts: string;
  threadTs: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: Bolt event types
  event: any;
  // biome-ignore lint/suspicious/noExplicitAny: Bolt client type
  client: any;
  say: (opts: { text: string; thread_ts?: string }) => Promise<unknown>;
  config: Config;
  sessionRepo: SessionRepository;
  workingDirRepo: WorkingDirectoryRepository;
  claudeQuery: ClaudeQueryFn;
  permissionGate: PermissionGate;
}

async function dispatchMessage(ctx: DispatchContext): Promise<void> {
  const {
    cleanText,
    channelId,
    userId,
    ts,
    threadTs,
    event,
    client,
    say,
    config,
    sessionRepo,
    workingDirRepo,
    claudeQuery,
    permissionGate,
  } = ctx;

  const slackOps = buildSlackOps(client, channelId);

  // Immediately acknowledge with 👀 reaction (Devin-style stamp)
  await slackOps.addReaction(channelId, ts, 'eyes');

  const slackFiles = normaliseFiles(event.files);

  // Fetch thread context and process files in parallel
  const [threadContext, fileResults] = await Promise.all([
    threadTs ? fetchThreadContext(client, channelId, threadTs, ts) : Promise.resolve(''),
    slackFiles.length > 0
      ? processFiles(slackFiles, config.slack.botToken)
      : Promise.resolve({ extra: '', tempFiles: [] as string[] }),
  ]);

  let prompt = threadContext ? `${threadContext}${cleanText}` : cleanText;
  const tempFiles: string[] = fileResults.tempFiles;

  if (fileResults.extra) {
    prompt += fileResults.extra;
  }

  const incomingMessage: IncomingMessage = {
    userId,
    channelId,
    ts,
    threadTs,
    text: prompt,
    files: slackFiles,
  };

  const processor = new MessageProcessor({
    sessionRepo,
    workingDirRepo,
    claudeQuery,
    slackOps,
    permissionGate,
    maxBudgetUsd: config.claude.maxBudgetUsd,
    maxTurns: config.claude.maxTurns,
  });

  try {
    await processor.process(incomingMessage);
  } catch (err) {
    logger.error('Error processing message', err);
    try {
      await say({
        text: `❌ An error occurred: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: threadTs ?? ts,
      });
    } catch {
      // Best-effort error reporting
    }
  } finally {
    for (const tmpPath of tempFiles) {
      cleanupTempFile(tmpPath);
    }
  }
}

// ---------------------------------------------------------------------------
// registerHandlers
// ---------------------------------------------------------------------------

export function registerHandlers(deps: HandlerDeps): void {
  const { app, config, sessionRepo, workingDirRepo, mcpManager } = deps;

  // One PermissionGate shared across all events so block_actions can resolve
  // approvals that were created during message processing.
  const permissionGate = new PermissionGate();

  // Wrap claudeQuery to always inject the current MCP server list.
  const wrappedClaudeQuery: ClaudeQueryFn = (params) => {
    return deps.claudeQuery({
      ...params,
      options: {
        ...params.options,
        mcpServers: mcpManager.getServers(),
      },
    });
  };

  // -------------------------------------------------------------------------
  // app_mention — bot mentioned in a channel
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: Bolt event callback types are complex generics
  app.event('app_mention', async ({ event, client, say }: any) => {
    const channelId: string = event.channel as string;
    const userId: string = event.user as string;
    const ts: string = event.ts as string;
    const threadTs: string | undefined = event.thread_ts as string | undefined;
    const rawText: string = (event.text as string) ?? '';
    const cleanText = stripMention(rawText);

    logger.debug('app_mention received', { channelId, userId, cleanText });

    const handled = await handleMetaCommand({
      cleanText,
      channelId,
      threadTs,
      ts,
      userId,
      say,
      config,
      workingDirRepo,
      mcpManager,
    });
    if (handled) return;

    await dispatchMessage({
      cleanText,
      channelId,
      userId,
      ts,
      threadTs,
      event,
      client,
      say,
      config,
      sessionRepo,
      workingDirRepo,
      claudeQuery: wrappedClaudeQuery,
      permissionGate,
    });
  });

  // -------------------------------------------------------------------------
  // message (im subtype) — direct messages
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: Bolt event callback types are complex generics
  app.message(async ({ event, client, say }: any) => {
    // Ignore bot messages and subtypes like message_changed / message_deleted
    if (event.bot_id || event.subtype) {
      return;
    }

    // Only handle DMs (channel IDs starting with 'D')
    const channelId: string = event.channel as string;
    if (!channelId.startsWith('D')) {
      return;
    }

    const userId: string = event.user as string;
    const ts: string = event.ts as string;
    const threadTs: string | undefined = event.thread_ts as string | undefined;
    const rawText: string = (event.text as string) ?? '';
    const cleanText = rawText.trim();

    logger.debug('DM received', { channelId, userId, cleanText });

    const handled = await handleMetaCommand({
      cleanText,
      channelId,
      threadTs,
      ts,
      userId,
      say,
      config,
      workingDirRepo,
      mcpManager,
    });
    if (handled) return;

    await dispatchMessage({
      cleanText,
      channelId,
      userId,
      ts,
      threadTs,
      event,
      client,
      say,
      config,
      sessionRepo,
      workingDirRepo,
      claudeQuery: wrappedClaudeQuery,
      permissionGate,
    });
  });

  // -------------------------------------------------------------------------
  // member_joined_channel — bot added to a channel
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: Bolt event callback types are complex generics
  app.event('member_joined_channel', async ({ event, client }: any) => {
    const memberId: string = event.user as string;
    const channelId: string = event.channel as string;

    // Only act when the bot itself joins the channel
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;

    if (memberId !== botUserId) {
      return;
    }

    logger.info('Bot joined channel', { channelId });

    await client.chat.postMessage({
      channel: channelId,
      text:
        "👋 Hi! I'm Claude Code Bot. Before we get started, please set a working directory:\n\n" +
        '`@ClaudeBot cwd /absolute/path/to/project`\n' +
        'or, if a base directory is configured:\n' +
        '`@ClaudeBot cwd project-name`\n\n' +
        'Once set, just mention me with any coding question or task!',
    });
  });

  // -------------------------------------------------------------------------
  // reaction_added — invoke the bot by adding a stamp to a message
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: Bolt event callback types are complex generics
  app.event('reaction_added', async ({ event, client }: any) => {
    const TRIGGER_REACTIONS = ['robot_face', 'eyes'];
    const reaction: string = event.reaction as string;

    if (!TRIGGER_REACTIONS.includes(reaction)) return;

    // Ignore reactions the bot added itself
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;
    if (event.user === botUserId) return;

    const channelId: string = event.item.channel as string;
    const messageTs: string = event.item.ts as string;

    logger.debug('Trigger reaction received', { reaction, channelId, messageTs });

    // Fetch the original message to get its text
    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: messageTs,
        limit: 1,
        inclusive: true,
      });

      const messages = (result.messages ?? []) as Array<{
        user?: string;
        bot_id?: string;
        text?: string;
        ts: string;
        thread_ts?: string;
        files?: unknown;
      }>;

      if (messages.length === 0) return;

      const msg = messages[0];
      // Don't process bot messages
      if (msg.bot_id) return;

      const rawText = (msg.text ?? '').trim();
      if (!rawText) return;

      const threadTs = msg.thread_ts;
      const cleanText = stripMention(rawText);

      const say = async (opts: { text: string; thread_ts?: string }) => {
        return client.chat.postMessage({
          channel: channelId,
          text: opts.text,
          thread_ts: opts.thread_ts,
        });
      };

      await dispatchMessage({
        cleanText: cleanText || rawText,
        channelId,
        userId: event.user as string,
        ts: messageTs,
        threadTs,
        event: { ...msg, files: msg.files },
        client,
        say,
        config,
        sessionRepo,
        workingDirRepo,
        claudeQuery: wrappedClaudeQuery,
        permissionGate,
      });
    } catch (err) {
      logger.error('Error handling reaction trigger', err);
    }
  });

  // -------------------------------------------------------------------------
  // block_actions — Allow / Deny button clicks for permission requests
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: Bolt action callback types are complex generics
  app.action('approve_tool', async ({ ack, action }: any) => {
    await ack();
    const approvalId: string = action.value as string;
    try {
      permissionGate.resolve(approvalId, true);
    } catch (err) {
      logger.warn('approve_tool: no pending approval', { approvalId, err });
    }
  });

  // biome-ignore lint/suspicious/noExplicitAny: Bolt action callback types are complex generics
  app.action('deny_tool', async ({ ack, action }: any) => {
    await ack();
    const approvalId: string = action.value as string;
    try {
      permissionGate.resolve(approvalId, false);
    } catch (err) {
      logger.warn('deny_tool: no pending approval', { approvalId, err });
    }
  });

  logger.info('Slack event handlers registered');
}
