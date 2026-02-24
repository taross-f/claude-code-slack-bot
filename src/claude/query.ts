import { query } from '@anthropic-ai/claude-code';
import type { McpServerConfig } from '@anthropic-ai/claude-code';
import type { ClaudeMessage, ClaudeQueryFn, PermissionResult } from '../utils/types';

type PermissionRequestMessage = {
  type: 'system';
  subtype: 'permission_request';
  tool_name: string;
  tool_input: unknown;
  respond?: (result: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void;
};

function toPermissionMode(mode?: string): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' {
  if (mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === 'plan') return mode;
  return 'default';
}

export const claudeQuery: ClaudeQueryFn = async function* ({ prompt, abortController, options }) {
  const { cwd, resume, maxTurns, mcpServers, allowedTools, canUseTool, permissionMode } = options;

  const sdkOptions: Parameters<typeof query>[0] = {
    prompt,
    abortController,
    options: {
      cwd,
      resume,
      maxTurns,
      mcpServers: mcpServers as Record<string, McpServerConfig>,
      allowedTools,
      permissionMode: toPermissionMode(permissionMode),
    },
  };

  for await (const msg of query(sdkOptions)) {
    // Intercept permission_request messages if a canUseTool hook is provided
    const m = msg as unknown as PermissionRequestMessage;
    if (m.type === 'system' && m.subtype === 'permission_request' && canUseTool) {
      const result: PermissionResult = await canUseTool(m.tool_name, m.tool_input);
      if (m.respond) {
        if (result.behavior === 'allow') {
          m.respond({ behavior: 'allow' });
        } else {
          m.respond({ behavior: 'deny', message: result.message });
        }
      }
      continue;
    }
    yield msg as unknown as ClaudeMessage;
  }
};
