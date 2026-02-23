export interface Session {
  sessionKey: string;
  claudeSessionId: string | null;
  userId: string;
  channelId: string;
  threadTs: string | null;
  workingDirectory: string | null;
  isActive: boolean;
  lastActivityAt: number;
  createdAt: number;
}

export interface WorkingDirectory {
  dirKey: string;
  channelId: string;
  threadTs: string | null;
  userId: string | null;
  directory: string;
  setAt: number;
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  urlPrivate: string;
}

export interface IncomingMessage {
  userId: string;
  channelId: string;
  ts: string;
  threadTs?: string;
  text?: string;
  files?: SlackFile[];
}

// Claude SDK message shapes (subset we handle)
export interface ClaudeSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >;
  };
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
  result: string;
  total_cost_usd: number;
  duration_ms: number;
  session_id: string;
  is_error: boolean;
}

export type ClaudeMessage = ClaudeSystemInitMessage | ClaudeAssistantMessage | ClaudeResultMessage;

export type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface ClaudeQueryOptions {
  outputFormat?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  cwd?: string;
  resume?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  canUseTool?: (tool: string, input: unknown) => Promise<PermissionResult>;
}

export type ClaudeQueryFn = (params: {
  prompt: string;
  abortController: AbortController;
  options: ClaudeQueryOptions;
}) => AsyncIterable<ClaudeMessage>;

export interface SlackOps {
  say(msg: { text: string; thread_ts?: string }): Promise<{ ts: string }>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  postPermissionRequest(
    channel: string,
    threadTs: string,
    approvalId: string,
    tool: string,
    input: unknown
  ): Promise<boolean>;
}
