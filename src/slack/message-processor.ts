import { PermissionGate } from '../claude/permissions';
import type { SessionRepository } from '../db/sessions';
import type { WorkingDirectoryRepository } from '../db/working-dirs';
import { Logger } from '../utils/logger';
import type { ClaudeQueryFn, IncomingMessage, SlackOps } from '../utils/types';
import { formatToolDescription, toSlackMarkdown } from './formatter';

export interface MessageProcessorDeps {
  sessionRepo: SessionRepository;
  workingDirRepo: WorkingDirectoryRepository;
  claudeQuery: ClaudeQueryFn;
  slackOps: SlackOps;
  maxBudgetUsd?: number;
  maxTurns?: number;
}

export class MessageProcessor {
  private readonly logger = new Logger('MessageProcessor');
  private readonly permissionGate = new PermissionGate();

  constructor(private readonly deps: MessageProcessorDeps) {}

  private sessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs ?? 'direct'}`;
  }

  private isDM(channelId: string): boolean {
    return channelId.startsWith('D');
  }

  async process(event: IncomingMessage): Promise<void> {
    const { userId, channelId, ts, threadTs, text } = event;
    const replyThreadTs = threadTs ?? ts;

    // Channels require a working directory; DMs do not.
    let workingDirectory: string | undefined;
    if (!this.isDM(channelId)) {
      const dir = this.deps.workingDirRepo.findForMessage(channelId, threadTs);
      if (!dir) {
        await this.deps.slackOps.say({
          text: '⚠️ No working directory set. Use `cwd /path/to/project` to set one.',
          thread_ts: replyThreadTs,
        });
        return;
      }
      workingDirectory = dir.directory;
    }

    const key = this.sessionKey(userId, channelId, threadTs);
    const existing = this.deps.sessionRepo.find(key);

    const statusResult = await this.deps.slackOps.say({
      text: '🤔 *Thinking...*',
      thread_ts: replyThreadTs,
    });
    const statusTs = statusResult.ts;

    await this.deps.slackOps.addReaction(channelId, ts, 'thinking_face');

    const abortController = new AbortController();

    try {
      this.deps.sessionRepo.upsert({
        sessionKey: key,
        claudeSessionId: existing?.claudeSessionId ?? null,
        userId,
        channelId,
        threadTs: threadTs ?? null,
        workingDirectory: workingDirectory ?? null,
        isActive: true,
        lastActivityAt: Date.now(),
      });

      for await (const message of this.deps.claudeQuery({
        prompt: text ?? '',
        abortController,
        options: {
          outputFormat: 'stream-json',
          permissionMode: 'default',
          cwd: workingDirectory,
          resume: existing?.claudeSessionId ?? undefined,
          maxBudgetUsd: this.deps.maxBudgetUsd ?? 1.0,
          maxTurns: this.deps.maxTurns ?? 50,
          canUseTool: (tool, input) =>
            this.permissionGate.request(tool, input, channelId, replyThreadTs, this.deps.slackOps),
        },
      })) {
        if (abortController.signal.aborted) break;

        if (message.type === 'system' && message.subtype === 'init') {
          this.deps.sessionRepo.updateClaudeSessionId(key, message.session_id);
        } else if (message.type === 'assistant') {
          for (const part of message.message.content) {
            if (part.type === 'text' && part.text.trim()) {
              await this.deps.slackOps.say({
                text: toSlackMarkdown(part.text),
                thread_ts: replyThreadTs,
              });
            } else if (part.type === 'tool_use') {
              await this.deps.slackOps.updateMessage(
                channelId,
                statusTs,
                `⚙️ *Working...* ${formatToolDescription(part.name, part.input)}`
              );
            }
          }
        } else if (message.type === 'result') {
          const cost = message.total_cost_usd
            ? ` _(${message.total_cost_usd.toFixed(4)} USD)_`
            : '';
          await this.deps.slackOps.updateMessage(channelId, statusTs, `✅ *Completed*${cost}`);
        }
      }

      await this.deps.slackOps.removeReaction(channelId, ts, 'thinking_face');
      await this.deps.slackOps.addReaction(channelId, ts, 'white_check_mark');

      this.logger.info('Message processed', { key });
    } catch (error) {
      await this.deps.slackOps.updateMessage(channelId, statusTs, '❌ *Error occurred*');
      await this.deps.slackOps.removeReaction(channelId, ts, 'thinking_face');
      await this.deps.slackOps.addReaction(channelId, ts, 'x');
      throw error;
    }
  }
}
