import { Database } from 'bun:sqlite';

const MIGRATIONS: string[] = [
  // v0: sessions table
  `CREATE TABLE IF NOT EXISTS sessions (
    session_key       TEXT PRIMARY KEY,
    claude_session_id TEXT,
    user_id           TEXT NOT NULL,
    channel_id        TEXT NOT NULL,
    thread_ts         TEXT,
    working_directory TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    last_activity_at  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  )`,
  // v1: working_directories table
  `CREATE TABLE IF NOT EXISTS working_directories (
    dir_key    TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    thread_ts  TEXT,
    user_id    TEXT,
    directory  TEXT NOT NULL,
    set_at     INTEGER NOT NULL
  )`,
  // v2: indexes
  'CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at)',
  'CREATE INDEX IF NOT EXISTS idx_working_dirs_channel ON working_directories(channel_id)',
];

export function createDatabase(path = 'bot.db'): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  runMigrations(db);
  return db;
}

function runMigrations(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db
    .prepare<{ v: number | null }, []>('SELECT MAX(version) as v FROM schema_version')
    .get();
  const current = row?.v ?? -1;

  for (let i = current + 1; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare('INSERT INTO schema_version VALUES (?)').run(i);
  }
}
