import { query } from '@anthropic-ai/claude-code';
import type { ClaudeMessage, ClaudeQueryFn, PermissionResult } from '../utils/types';

function toPermissionMode(
  mode?: string
): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' {
  if (mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === 'plan') return mode;
  return 'default';
}

export const claudeQuery: ClaudeQueryFn = async function* ({ prompt, abortController, options }) {
  const {
    cwd,
    resume,
    maxBudgetUsd,
    maxTurns,
    mcpServers,
    allowedTools,
    canUseTool,
    permissionMode,
  } = options;

  const sdkOptions: Parameters<typeof query>[0] = {
    prompt,
    abortController,
    options: {
      cwd,
      resume,
      maxBudgetUsd,
      maxTurns,
      mcpServers: mcpServers as any,
      allowedTools,
      permissionMode: toPermissionMode(permissionMode),
    },
  };

  for await (const msg of query(sdkOptions)) {
    // Intercept permission_request messages if a canUseTool hook is provided
    const m = msg as any;
    if (m.type === 'system' && m.subtype === 'permission_request' && canUseTool) {
      const result: PermissionResult = await canUseTool(m.tool_name, m.tool_input);
      if (m.respond) {
        m.respond(
          result.behavior === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: (result as any).message }
        );
      }
      continue;
    }
    yield msg as unknown as ClaudeMessage;
  }
};
