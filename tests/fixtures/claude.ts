import type { ClaudeMessage, ClaudeQueryFn } from '../../src/utils/types';

/**
 * Creates a mock Claude query function that yields predefined text responses.
 * Mirrors the shape of real SDK messages.
 */
export function createMockClaudeQuery(responses: string[]): ClaudeQueryFn {
  return async function* (_params) {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'test-session-123',
    } as ClaudeMessage;

    for (const text of responses) {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
      } as ClaudeMessage;
    }

    yield {
      type: 'result',
      subtype: 'success',
      result: responses.at(-1) ?? '',
      total_cost_usd: 0.001,
      duration_ms: 100,
      session_id: 'test-session-123',
      is_error: false,
    } as ClaudeMessage;
  };
}

/**
 * Mock that simulates a tool use followed by a text response.
 * Calls options.canUseTool before yielding tool_use, mirroring real SDK behaviour.
 */
export function createMockClaudeQueryWithTool(
  toolName: string,
  toolInput: unknown,
  finalText: string
): ClaudeQueryFn {
  return async function* ({ options }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session-123' } as ClaudeMessage;

    // Simulate SDK checking canUseTool before executing the tool
    if (options.canUseTool) {
      const permission = await options.canUseTool(toolName, toolInput);
      if (permission.behavior === 'deny') {
        yield {
          type: 'result',
          subtype: 'success',
          result: `Tool ${toolName} was denied.`,
          total_cost_usd: 0.001,
          duration_ms: 100,
          session_id: 'test-session-123',
          is_error: false,
        } as ClaudeMessage;
        return;
      }
    }

    yield {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: toolName, input: toolInput }],
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
      session_id: 'test-session-123',
      is_error: false,
    } as ClaudeMessage;
  };
}
