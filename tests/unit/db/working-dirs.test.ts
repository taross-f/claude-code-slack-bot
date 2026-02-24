import { beforeEach, describe, expect, test } from 'bun:test';
import { WorkingDirectoryRepository } from '../../../src/db/working-dirs';
import { createTestDb } from '../../fixtures/db';

const NOW = Date.now();

describe('WorkingDirectoryRepository', () => {
  let repo: WorkingDirectoryRepository;

  beforeEach(() => {
    repo = new WorkingDirectoryRepository(createTestDb());
  });

  test('find returns null for non-existent key', () => {
    expect(repo.find('non-existent')).toBeNull();
  });

  test('set then find returns directory', () => {
    repo.set({
      dirKey: 'C1',
      channelId: 'C1',
      threadTs: null,
      userId: null,
      directory: '/proj',
      setAt: NOW,
    });
    const dir = repo.find('C1');

    expect(dir).not.toBeNull();
    expect(dir?.directory).toBe('/proj');
    expect(dir?.channelId).toBe('C1');
  });

  test('second set updates directory', () => {
    repo.set({
      dirKey: 'C1',
      channelId: 'C1',
      threadTs: null,
      userId: null,
      directory: '/old',
      setAt: NOW,
    });
    repo.set({
      dirKey: 'C1',
      channelId: 'C1',
      threadTs: null,
      userId: null,
      directory: '/new',
      setAt: NOW,
    });

    expect(repo.find('C1')?.directory).toBe('/new');
  });

  test('remove deletes the entry and returns true', () => {
    repo.set({
      dirKey: 'C2',
      channelId: 'C2',
      threadTs: null,
      userId: null,
      directory: '/x',
      setAt: NOW,
    });
    expect(repo.remove('C2')).toBe(true);
    expect(repo.find('C2')).toBeNull();
  });

  test('remove on non-existent key returns false', () => {
    expect(repo.remove('non-existent')).toBe(false);
  });

  describe('findForMessage', () => {
    test('returns null when neither thread nor channel dir is set', () => {
      expect(repo.findForMessage('C3', 'thread1')).toBeNull();
    });

    test('returns channel default when no thread override', () => {
      repo.set({
        dirKey: 'C4',
        channelId: 'C4',
        threadTs: null,
        userId: null,
        directory: '/channel',
        setAt: NOW,
      });

      const dir = repo.findForMessage('C4');
      expect(dir?.directory).toBe('/channel');
    });

    test('thread-specific override takes precedence over channel default', () => {
      repo.set({
        dirKey: 'C5',
        channelId: 'C5',
        threadTs: null,
        userId: null,
        directory: '/channel',
        setAt: NOW,
      });
      repo.set({
        dirKey: 'C5-thread1',
        channelId: 'C5',
        threadTs: 'thread1',
        userId: null,
        directory: '/thread',
        setAt: NOW,
      });

      expect(repo.findForMessage('C5', 'thread1')?.directory).toBe('/thread');
    });

    test('falls back to channel default when thread has no override', () => {
      repo.set({
        dirKey: 'C6',
        channelId: 'C6',
        threadTs: null,
        userId: null,
        directory: '/channel',
        setAt: NOW,
      });

      expect(repo.findForMessage('C6', 'thread-with-no-override')?.directory).toBe('/channel');
    });
  });
});
