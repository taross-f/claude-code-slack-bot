import type { PermissionResult, SlackOps } from '../utils/types';

/** Tools that never need explicit user approval. */
export const SAFE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'TodoRead',
];

export class PermissionGate {
  private readonly pending = new Map<string, (approved: boolean) => void>();

  isSafe(tool: string): boolean {
    return SAFE_TOOLS.some((safe) => tool === safe || tool.startsWith('mcp__'));
  }

  async request(
    tool: string,
    input: unknown,
    channel: string,
    threadTs: string,
    slackOps: SlackOps
  ): Promise<PermissionResult> {
    if (this.isSafe(tool)) {
      return { behavior: 'allow' };
    }

    const approvalId = crypto.randomUUID();

    const approved = await new Promise<boolean>((resolve) => {
      this.pending.set(approvalId, resolve);
      slackOps
        .postPermissionRequest(channel, threadTs, approvalId, tool, input)
        .then((directResult) => {
          // postPermissionRequest may resolve the approval immediately
          if (this.pending.has(approvalId)) {
            this.resolve(approvalId, directResult);
          }
        })
        .catch(() => this.resolve(approvalId, false));
    });

    return approved
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: `Tool "${tool}" was denied by user.` };
  }

  /** Called by the Slack action handler when user clicks Allow/Deny. */
  resolve(approvalId: string, approved: boolean): void {
    const handler = this.pending.get(approvalId);
    if (!handler) throw new Error(`No pending approval for id: ${approvalId}`);
    handler(approved);
    this.pending.delete(approvalId);
  }
}
