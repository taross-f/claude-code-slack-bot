import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '../src/db/database';
import { SessionRepository } from '../src/db/sessions';
import { WorkingDirectoryRepository } from '../src/db/working-dirs';

function createTestDb(): Database {
  return createDatabase(':memory:');
}

// ─── SessionRepository ────────────────────────────────────────────────────────

describe('SessionRepository', () => {
  let repo: SessionRepository;

  const BASE_SESSION = {
    sessionKey: 'sess-1',
    claudeSessionId: null,
    userId: 'U001',
    channelId: 'C001',
    threadTs: null,
    workingDirectory: null,
    isActive: true,
    lastActivityAt: Date.now(),
  } as const;

  beforeEach(() => {
    repo = new SessionRepository(createTestDb());
  });

  it('find returns null for a non-existent key', () => {
    expect(repo.find('no-such-key')).toBeNull();
  });

  it('upsert then find returns the stored session', () => {
    repo.upsert({ ...BASE_SESSION });
    const session = repo.find('sess-1');

    expect(session).not.toBeNull();
    expect(session?.sessionKey).toBe('sess-1');
    expect(session?.userId).toBe('U001');
    expect(session?.channelId).toBe('C001');
    expect(session?.claudeSessionId).toBeNull();
    expect(session?.isActive).toBe(true);
    expect(session?.threadTs).toBeNull();
    expect(session?.workingDirectory).toBeNull();
  });

  it('upsert persists workingDirectory', () => {
    repo.upsert({ ...BASE_SESSION, sessionKey: 'sess-wd', workingDirectory: '/home/user/code' });
    expect(repo.find('sess-wd')?.workingDirectory).toBe('/home/user/code');
  });

  it('upsert persists threadTs', () => {
    repo.upsert({ ...BASE_SESSION, sessionKey: 'sess-ts', threadTs: '1700000000.000001' });
    expect(repo.find('sess-ts')?.threadTs).toBe('1700000000.000001');
  });

  it('second upsert with same key updates fields without duplicating rows', () => {
    repo.upsert({ ...BASE_SESSION });
    repo.upsert({ ...BASE_SESSION, claudeSessionId: 'claude-abc', isActive: false });

    const session = repo.find('sess-1');
    expect(session?.claudeSessionId).toBe('claude-abc');
    expect(session?.isActive).toBe(false);
  });

  it('updateClaudeSessionId sets the claude session ID', () => {
    repo.upsert({ ...BASE_SESSION, sessionKey: 'sess-update' });
    repo.updateClaudeSessionId('sess-update', 'new-session-id');
    expect(repo.find('sess-update')?.claudeSessionId).toBe('new-session-id');
  });

  it('updateClaudeSessionId on a missing key is a no-op', () => {
    // SQLite UPDATE on a missing row does not throw
    repo.updateClaudeSessionId('missing-key', 'some-id');
    expect(repo.find('missing-key')).toBeNull();
  });
});

// ─── WorkingDirectoryRepository ──────────────────────────────────────────────

describe('WorkingDirectoryRepository', () => {
  let repo: WorkingDirectoryRepository;
  const NOW = Date.now();

  const channelDir = {
    dirKey: 'C100',
    channelId: 'C100',
    threadTs: null,
    userId: null,
    directory: '/project/main',
    setAt: NOW,
  };

  beforeEach(() => {
    repo = new WorkingDirectoryRepository(createTestDb());
  });

  it('find returns null for a non-existent key', () => {
    expect(repo.find('no-such-key')).toBeNull();
  });

  it('set then find returns the stored directory', () => {
    repo.set(channelDir);
    const result = repo.find('C100');

    expect(result).not.toBeNull();
    expect(result?.directory).toBe('/project/main');
    expect(result?.channelId).toBe('C100');
    expect(result?.threadTs).toBeNull();
    expect(result?.userId).toBeNull();
  });

  it('second set with the same key updates the directory', () => {
    repo.set({ ...channelDir, directory: '/old' });
    repo.set({ ...channelDir, directory: '/new' });
    expect(repo.find('C100')?.directory).toBe('/new');
  });

  describe('findForMessage', () => {
    it('returns null when neither thread nor channel directory is set', () => {
      expect(repo.findForMessage('C200', 'thread-1')).toBeNull();
    });

    it('returns null when called without threadTs and no channel dir is set', () => {
      expect(repo.findForMessage('C201')).toBeNull();
    });

    it('returns channel default when no thread override exists', () => {
      repo.set({ ...channelDir, dirKey: 'C300', channelId: 'C300', directory: '/channel' });
      const result = repo.findForMessage('C300');
      expect(result?.directory).toBe('/channel');
    });

    it('thread-specific override takes priority over channel default', () => {
      // Channel default
      repo.set({ ...channelDir, dirKey: 'C400', channelId: 'C400', directory: '/channel' });
      // Thread override
      repo.set({
        dirKey: 'C400-thread-ts1',
        channelId: 'C400',
        threadTs: 'thread-ts1',
        userId: null,
        directory: '/thread',
        setAt: NOW,
      });

      const result = repo.findForMessage('C400', 'thread-ts1');
      expect(result?.directory).toBe('/thread');
    });

    it('falls back to channel default when thread has no override', () => {
      repo.set({ ...channelDir, dirKey: 'C500', channelId: 'C500', directory: '/channel' });
      const result = repo.findForMessage('C500', 'unknown-thread');
      expect(result?.directory).toBe('/channel');
    });

    it('returns thread directory and ignores channel when only thread is set', () => {
      repo.set({
        dirKey: 'C600-thread-only',
        channelId: 'C600',
        threadTs: 'thread-only',
        userId: null,
        directory: '/thread-only',
        setAt: NOW,
      });

      const result = repo.findForMessage('C600', 'thread-only');
      expect(result?.directory).toBe('/thread-only');
    });
  });
});
