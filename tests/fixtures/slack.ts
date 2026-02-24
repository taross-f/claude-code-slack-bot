import type { SlackOps } from '../../src/utils/types';

export interface MockSlackState {
  posts: Array<{ text: string; thread_ts?: string }>;
  updates: Array<{ channel: string; ts: string; text: string }>;
  reactionsAdded: Array<{ channel: string; ts: string; name: string }>;
  reactionsRemoved: Array<{ channel: string; ts: string; name: string }>;
  permissionRequests: Array<{
    channel: string;
    threadTs: string;
    approvalId: string;
    tool: string;
  }>;
}

export type MockSlackOps = SlackOps & { state: MockSlackState };

/**
 * Creates a mock SlackOps implementation with state tracking.
 * @param autoApprove - if true, permission requests are auto-approved
 */
export function createMockSlackOps(autoApprove = true): MockSlackOps {
  const state: MockSlackState = {
    posts: [],
    updates: [],
    reactionsAdded: [],
    reactionsRemoved: [],
    permissionRequests: [],
  };
  let counter = 0;

  return {
    state,
    async say(msg) {
      state.posts.push(msg);
      return { ts: `1000000000.${String(++counter).padStart(6, '0')}` };
    },
    async updateMessage(channel, ts, text) {
      state.updates.push({ channel, ts, text });
    },
    async addReaction(channel, ts, name) {
      state.reactionsAdded.push({ channel, ts, name });
    },
    async removeReaction(channel, ts, name) {
      state.reactionsRemoved.push({ channel, ts, name });
    },
    async postPermissionRequest(channel, threadTs, approvalId, tool) {
      state.permissionRequests.push({ channel, threadTs, approvalId, tool });
      return autoApprove;
    },
  };
}
