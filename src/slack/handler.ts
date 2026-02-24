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

/** Download a Slack file and return its Buffer (or null on failure). */
async function downloadFile(file: SlackFile, botToken: string): Promise<Buffer | null> {
  try {
    const response = await fetch(file.urlPrivate, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!response.ok) {
      logger.warn('Failed to download file', { name: file.name, status: response.status });
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logger.warn('Error downloading file', { name: file.name, err });
    return null;
  }
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
    const buffer = await downloadFile(file, botToken);
    if (!buffer) continue;

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
      await say({
        text: `✅ Working directory set to \`${resolved}\``,
        thread_ts: threadTs ?? ts,
      });
      return;
    }

    // MCP reload
    if (isMcpReload(cleanText)) {
      mcpManager.reload();
      const names = mcpManager.getServerNames();
      const list = names.length > 0 ? names.map((n) => `• ${n}`).join('\n') : '_none_';
      await say({
        text: `✅ MCP configuration reloaded successfully.\n\nServers:\n${list}`,
        thread_ts: threadTs ?? ts,
      });
      return;
    }

    // MCP status
    if (isMcpStatus(cleanText)) {
      const names = mcpManager.getServerNames();
      const list = names.length > 0 ? names.map((n) => `• ${n}`).join('\n') : '_none_';
      await say({
        text: `🔧 *MCP Servers Configured:*\n${list}`,
        thread_ts: threadTs ?? ts,
      });
      return;
    }

    // Regular message — delegate to MessageProcessor
    const slackOps = buildSlackOps(client, channelId);

    // Process attached files if any
    const slackFiles = normaliseFiles(event.files);

    let prompt = cleanText;
    let tempFiles: string[] = [];

    if (slackFiles.length > 0) {
      const { extra, tempFiles: tmp } = await processFiles(slackFiles, config.slack.botToken);
      prompt += extra;
      tempFiles = tmp;
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
      claudeQuery: wrappedClaudeQuery,
      slackOps,
      maxBudgetUsd: config.claude.maxBudgetUsd,
      maxTurns: config.claude.maxTurns,
    });

    try {
      await processor.process(incomingMessage);
    } catch (err) {
      logger.error('Error processing app_mention', err);
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
  });

  // -------------------------------------------------------------------------
  // message (im subtype) — direct messages
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: Bolt event callback types are complex generics
  app.message(async ({ event, client, say }: any) => {
    // Ignore bot messages and subtypes like message_changed / message_deleted
    if (event.bot_id || event.subtype === 'bot_message' || event.subtype) {
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

    // CWD command
    const cwdPath = parseCwdCommand(cleanText);
    if (cwdPath !== null) {
      const resolved = resolveCwd(cwdPath, config.baseDirectory);
      workingDirRepo.set({
        dirKey: channelId,
        channelId,
        threadTs: null,
        userId,
        directory: resolved,
        setAt: Date.now(),
      });
      await say({
        text: `✅ Working directory set to \`${resolved}\``,
        thread_ts: threadTs,
      });
      return;
    }

    // MCP reload
    if (isMcpReload(cleanText)) {
      mcpManager.reload();
      const names = mcpManager.getServerNames();
      const list = names.length > 0 ? names.map((n) => `• ${n}`).join('\n') : '_none_';
      await say({
        text: `✅ MCP configuration reloaded successfully.\n\nServers:\n${list}`,
        thread_ts: threadTs,
      });
      return;
    }

    // MCP status
    if (isMcpStatus(cleanText)) {
      const names = mcpManager.getServerNames();
      const list = names.length > 0 ? names.map((n) => `• ${n}`).join('\n') : '_none_';
      await say({
        text: `🔧 *MCP Servers Configured:*\n${list}`,
        thread_ts: threadTs,
      });
      return;
    }

    // Regular DM — delegate to MessageProcessor
    const slackOps = buildSlackOps(client, channelId);

    const slackFiles = normaliseFiles(event.files);

    let prompt = cleanText;
    let tempFiles: string[] = [];

    if (slackFiles.length > 0) {
      const { extra, tempFiles: tmp } = await processFiles(slackFiles, config.slack.botToken);
      prompt += extra;
      tempFiles = tmp;
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
      claudeQuery: wrappedClaudeQuery,
      slackOps,
      maxBudgetUsd: config.claude.maxBudgetUsd,
      maxTurns: config.claude.maxTurns,
    });

    try {
      await processor.process(incomingMessage);
    } catch (err) {
      logger.error('Error processing DM', err);
      try {
        await say({
          text: `❌ An error occurred: ${err instanceof Error ? err.message : String(err)}`,
          thread_ts: threadTs,
        });
      } catch {
        // Best-effort error reporting
      }
    } finally {
      for (const tmpPath of tempFiles) {
        cleanupTempFile(tmpPath);
      }
    }
  });

  // -------------------------------------------------------------------------
  // member_joined_channel — bot added to a channel
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: Bolt event callback types are complex generics
  app.event('member_joined_channel', async ({ event, client }: any) => {
    const memberId: string = event.user as string;
    const channelId: string = event.channel as string;

    // Only act when the bot itself joins the channel
    let botUserId: string;
    try {
      const authResult = await client.auth.test();
      botUserId = authResult.user_id as string;
    } catch (err) {
      logger.warn('Failed to get bot user ID in member_joined_channel', err);
      return;
    }

    if (memberId !== botUserId) {
      return;
    }

    logger.info('Bot joined channel', { channelId });

    try {
      await client.chat.postMessage({
        channel: channelId,
        text:
          "👋 Hi! I'm Claude Code Bot. Before we get started, please set a working directory:\n\n" +
          '`@ClaudeBot cwd /absolute/path/to/project`\n' +
          'or, if a base directory is configured:\n' +
          '`@ClaudeBot cwd project-name`\n\n' +
          'Once set, just mention me with any coding question or task!',
      });
    } catch (err) {
      logger.warn('Failed to send welcome message', { channelId, err });
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
