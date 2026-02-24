import { beforeEach, describe, expect, test } from 'bun:test';
import { PermissionGate, SAFE_TOOLS } from '../../../src/claude/permissions';
import { createMockSlackOps } from '../../fixtures/slack';

describe('PermissionGate', () => {
  let gate: PermissionGate;

  beforeEach(() => {
    gate = new PermissionGate();
  });

  describe('isSafe', () => {
    test.each(SAFE_TOOLS)('marks %s as safe', (tool) => {
      expect(gate.isSafe(tool)).toBe(true);
    });

    test('marks Bash as not safe', () => {
      expect(gate.isSafe('Bash')).toBe(false);
    });

    test('marks Edit as not safe', () => {
      expect(gate.isSafe('Edit')).toBe(false);
    });

    test('marks Write as not safe', () => {
      expect(gate.isSafe('Write')).toBe(false);
    });

    test('marks MCP tools as safe (mcp__ prefix)', () => {
      expect(gate.isSafe('mcp__github__list_issues')).toBe(true);
    });
  });

  describe('request', () => {
    test('allows safe tools without prompting Slack', async () => {
      const slack = createMockSlackOps();
      const result = await gate.request('Read', { file_path: '/foo' }, 'C1', 't1', slack);

      expect(result).toEqual({ behavior: 'allow' });
      expect(slack.state.permissionRequests).toHaveLength(0);
    });

    test('prompts Slack and returns allow when auto-approved', async () => {
      const slack = createMockSlackOps(true); // autoApprove = true
      const result = await gate.request('Bash', { command: 'rm -rf /' }, 'C1', 't1', slack);

      expect(result).toEqual({ behavior: 'allow' });
      expect(slack.state.permissionRequests).toHaveLength(1);
      expect(slack.state.permissionRequests[0].tool).toBe('Bash');
    });

    test('prompts Slack and returns deny when rejected', async () => {
      const slack = createMockSlackOps(false); // autoApprove = false
      const result = await gate.request('Edit', { file_path: '/etc/passwd' }, 'C1', 't1', slack);

      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('Edit');
      }
    });
  });

  describe('resolve', () => {
    test('throws when resolving unknown approval ID', () => {
      expect(() => gate.resolve('unknown-id', true)).toThrow();
    });
  });
});
