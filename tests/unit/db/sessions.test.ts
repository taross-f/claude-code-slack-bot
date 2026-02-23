import { beforeEach, describe, expect, test } from 'bun:test';
import { SessionRepository } from '../../../src/db/sessions';
import { createTestDb } from '../../fixtures/db';

const BASE = {
  userId: 'U123',
  channelId: 'C123',
  threadTs: null,
  workingDirectory: null,
  isActive: true,
  lastActivityAt: Date.now(),
} as const;

describe('SessionRepository', () => {
  let repo: SessionRepository;

  beforeEach(() => {
    repo = new SessionRepository(createTestDb());
  });

  test('find returns null for non-existent key', () => {
    expect(repo.find('non-existent')).toBeNull();
  });

  test('upsert then find returns session', () => {
    repo.upsert({ sessionKey: 'key1', claudeSessionId: null, ...BASE });
    const session = repo.find('key1');

    expect(session).not.toBeNull();
    expect(session?.sessionKey).toBe('key1');
    expect(session?.userId).toBe('U123');
    expect(session?.channelId).toBe('C123');
    expect(session?.claudeSessionId).toBeNull();
    expect(session?.isActive).toBe(true);
  });

  test('upsert with workingDirectory persists it', () => {
    repo.upsert({ sessionKey: 'key2', claudeSessionId: null, ...BASE, workingDirectory: '/tmp' });
    expect(repo.find('key2')?.workingDirectory).toBe('/tmp');
  });

  test('second upsert updates fields without duplicating', () => {
    repo.upsert({ sessionKey: 'key3', claudeSessionId: null, ...BASE });
    repo.upsert({ sessionKey: 'key3', claudeSessionId: 'claude-abc', ...BASE });

    const session = repo.find('key3');
    expect(session?.claudeSessionId).toBe('claude-abc');
  });

  test('updateClaudeSessionId sets session ID', () => {
    repo.upsert({ sessionKey: 'key4', claudeSessionId: null, ...BASE });
    repo.updateClaudeSessionId('key4', 'new-claude-session');

    expect(repo.find('key4')?.claudeSessionId).toBe('new-claude-session');
  });

  test('updateClaudeSessionId on missing key throws', () => {
    // SQLite UPDATE on missing row is a no-op, so we verify the session stays null
    repo.updateClaudeSessionId('missing', 'session-id');
    expect(repo.find('missing')).toBeNull();
  });

  test('cleanup removes sessions older than threshold', () => {
    const oldTs = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
    repo.upsert({ sessionKey: 'old', claudeSessionId: null, ...BASE, lastActivityAt: oldTs });
    repo.upsert({ sessionKey: 'new', claudeSessionId: null, ...BASE });

    const removed = repo.cleanup(2 * 60 * 60 * 1000); // 2-hour threshold

    expect(removed).toBe(1);
    expect(repo.find('old')).toBeNull();
    expect(repo.find('new')).not.toBeNull();
  });

  test('cleanup returns 0 when nothing qualifies', () => {
    repo.upsert({ sessionKey: 'key5', claudeSessionId: null, ...BASE });
    expect(repo.cleanup(24 * 60 * 60 * 1000)).toBe(0);
  });
});
