import type { Database } from 'bun:sqlite';
import type { Session } from '../utils/types';

type SessionRow = {
  session_key: string;
  claude_session_id: string | null;
  user_id: string;
  channel_id: string;
  thread_ts: string | null;
  working_directory: string | null;
  is_active: number;
  last_activity_at: number;
  created_at: number;
};

function rowToSession(row: SessionRow): Session {
  return {
    sessionKey: row.session_key,
    claudeSessionId: row.claude_session_id,
    userId: row.user_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    workingDirectory: row.working_directory,
    isActive: row.is_active === 1,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
  };
}

export class SessionRepository {
  constructor(private readonly db: Database) {}

  find(sessionKey: string): Session | null {
    const row = this.db
      .prepare<SessionRow, [string]>('SELECT * FROM sessions WHERE session_key = ?')
      .get(sessionKey);
    return row ? rowToSession(row) : null;
  }

  upsert(session: Omit<Session, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (session_key, claude_session_id, user_id, channel_id, thread_ts,
            working_directory, is_active, last_activity_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           claude_session_id = excluded.claude_session_id,
           working_directory  = excluded.working_directory,
           is_active          = excluded.is_active,
           last_activity_at   = excluded.last_activity_at`
      )
      .run(
        session.sessionKey,
        session.claudeSessionId,
        session.userId,
        session.channelId,
        session.threadTs ?? null,
        session.workingDirectory ?? null,
        session.isActive ? 1 : 0,
        session.lastActivityAt,
        Date.now()
      );
  }

  updateClaudeSessionId(sessionKey: string, claudeSessionId: string): void {
    this.db
      .prepare(
        'UPDATE sessions SET claude_session_id = ?, last_activity_at = ? WHERE session_key = ?'
      )
      .run(claudeSessionId, Date.now(), sessionKey);
  }

  updateLastActivity(sessionKey: string): void {
    this.db
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE session_key = ?')
      .run(Date.now(), sessionKey);
  }

  cleanup(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db.prepare('DELETE FROM sessions WHERE last_activity_at < ?').run(cutoff);
    return result.changes;
  }
}
