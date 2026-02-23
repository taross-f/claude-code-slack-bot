import type { Database } from 'bun:sqlite';
import type { WorkingDirectory } from '../utils/types';

type WorkingDirRow = {
  dir_key: string;
  channel_id: string;
  thread_ts: string | null;
  user_id: string | null;
  directory: string;
  set_at: number;
};

function rowToDir(row: WorkingDirRow): WorkingDirectory {
  return {
    dirKey: row.dir_key,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    userId: row.user_id,
    directory: row.directory,
    setAt: row.set_at,
  };
}

export class WorkingDirectoryRepository {
  constructor(private readonly db: Database) {}

  find(key: string): WorkingDirectory | null {
    const row = this.db
      .prepare<WorkingDirRow, [string]>('SELECT * FROM working_directories WHERE dir_key = ?')
      .get(key);
    return row ? rowToDir(row) : null;
  }

  /** Thread-specific overrides channel default. */
  findForMessage(channelId: string, threadTs?: string): WorkingDirectory | null {
    if (threadTs) {
      const threadDir = this.find(`${channelId}-${threadTs}`);
      if (threadDir) return threadDir;
    }
    return this.find(channelId);
  }

  set(dir: WorkingDirectory): void {
    this.db
      .prepare(
        `INSERT INTO working_directories
           (dir_key, channel_id, thread_ts, user_id, directory, set_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(dir_key) DO UPDATE SET
           directory = excluded.directory,
           set_at    = excluded.set_at`
      )
      .run(
        dir.dirKey,
        dir.channelId,
        dir.threadTs ?? null,
        dir.userId ?? null,
        dir.directory,
        dir.setAt
      );
  }

  remove(key: string): boolean {
    const result = this.db.prepare('DELETE FROM working_directories WHERE dir_key = ?').run(key);
    return result.changes > 0;
  }
}
