import { describe, expect, it, beforeEach } from 'bun:test';
import { PermissionGate, SAFE_TOOLS } from '../src/claude/permissions';
import type { SlackOps } from '../src/utils/types';

// Minimal mock that auto-approves or auto-denies based on the flag
function makeMockSlackOps(autoApprove: boolean): SlackOps & {
  permissionRequests: Array<{ approvalId: string; tool: string }>;
} {
  const permissionRequests: Array<{ approvalId: string; tool: string }> = [];
  return {
    permissionRequests,
    async say(msg) {
      return { ts: '1000000000.000001' };
    },
    async updateMessage() {},
    async addReaction() {},
    async removeReaction() {},
    async postPermissionRequest(_channel, _threadTs, approvalId, tool) {
      permissionRequests.push({ approvalId, tool });
      return autoApprove;
    },
  };
}

describe('PermissionGate', () => {
  let gate: PermissionGate;

  beforeEach(() => {
    gate = new PermissionGate();
  });

  describe('isSafe', () => {
    it('returns true for Read', () => {
      expect(gate.isSafe('Read')).toBe(true);
    });

    it('returns true for all SAFE_TOOLS', () => {
      for (const tool of SAFE_TOOLS) {
        expect(gate.isSafe(tool)).toBe(true);
      }
    });

    it('returns false for Write', () => {
      expect(gate.isSafe('Write')).toBe(false);
    });

    it('returns false for Bash', () => {
      expect(gate.isSafe('Bash')).toBe(false);
    });

    it('returns false for Edit', () => {
      expect(gate.isSafe('Edit')).toBe(false);
    });

    it('returns true for any mcp__ prefixed tool', () => {
      expect(gate.isSafe('mcp__anything')).toBe(true);
      expect(gate.isSafe('mcp__github__list_issues')).toBe(true);
      expect(gate.isSafe('mcp__filesystem__read_file')).toBe(true);
    });
  });

  describe('resolve', () => {
    it('throws for an unknown approvalId', () => {
      expect(() => gate.resolve('non-existent-id', true)).toThrow(
        'No pending approval for id: non-existent-id'
      );
    });

    it('throws for an already-resolved approvalId', async () => {
      const slack = makeMockSlackOps(true);
      // Kick off a request so an approvalId gets registered
      const requestPromise = gate.request('Bash', { command: 'ls' }, 'C1', 't1', slack);
      // postPermissionRequest is called immediately and auto-approves via the .then() handler,
      // but we need to wait for the microtask queue to flush before the pending map is cleared
      await requestPromise;
      // The pending entry was deleted after resolution; resolving again should throw
      const [req] = slack.permissionRequests;
      expect(() => gate.resolve(req.approvalId, true)).toThrow();
    });
  });

  describe('request – safe tools', () => {
    it('returns allow immediately without calling postPermissionRequest', async () => {
      const slack = makeMockSlackOps(true);
      const result = await gate.request('Read', { file_path: '/foo' }, 'C1', 't1', slack);
      expect(result).toEqual({ behavior: 'allow' });
      expect(slack.permissionRequests).toHaveLength(0);
    });

    it('allows mcp__ tools without a permission request', async () => {
      const slack = makeMockSlackOps(false);
      const result = await gate.request('mcp__github__create_pr', {}, 'C1', 't1', slack);
      expect(result).toEqual({ behavior: 'allow' });
      expect(slack.permissionRequests).toHaveLength(0);
    });
  });

  describe('request – unsafe tools', () => {
    it('calls postPermissionRequest for Bash and returns allow when approved', async () => {
      const slack = makeMockSlackOps(true);
      const result = await gate.request('Bash', { command: 'echo hi' }, 'C1', 't1', slack);
      expect(result).toEqual({ behavior: 'allow' });
      expect(slack.permissionRequests).toHaveLength(1);
      expect(slack.permissionRequests[0].tool).toBe('Bash');
    });

    it('calls postPermissionRequest for Edit and returns deny when rejected', async () => {
      const slack = makeMockSlackOps(false);
      const result = await gate.request('Edit', { file_path: '/etc/passwd' }, 'C1', 't1', slack);
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('Edit');
      }
      expect(slack.permissionRequests).toHaveLength(1);
    });

    it('resolves via the resolve() method when postPermissionRequest does not auto-resolve', async () => {
      // Use a mock that never auto-resolves (returns a pending promise)
      const permissionRequests: Array<{ approvalId: string }> = [];
      let externalResolve: ((v: boolean) => void) | undefined;

      const manualSlack: SlackOps = {
        async say() { return { ts: '1000000000.000001' }; },
        async updateMessage() {},
        async addReaction() {},
        async removeReaction() {},
        async postPermissionRequest(_ch, _ts, approvalId) {
          permissionRequests.push({ approvalId });
          // Return a promise that never resolves on its own, forcing resolve() to be called
          return new Promise<boolean>((res) => {
            externalResolve = res;
          });
        },
      };

      const requestPromise = gate.request('Write', { file_path: '/tmp/x' }, 'C1', 't1', manualSlack);

      // Wait a tick for postPermissionRequest to be called and the approvalId to be registered
      await new Promise((r) => setTimeout(r, 0));
      expect(permissionRequests).toHaveLength(1);

      // Approve via the external resolve mechanism
      gate.resolve(permissionRequests[0].approvalId, true);

      const result = await requestPromise;
      expect(result).toEqual({ behavior: 'allow' });

      // Clean up the dangling promise
      externalResolve?.(false);
    });
  });
});
