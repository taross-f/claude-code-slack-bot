import { createDatabase } from '../../src/db/database';
import { SessionRepository } from '../../src/db/sessions';
import { WorkingDirectoryRepository } from '../../src/db/working-dirs';

/** Returns a fresh in-memory DB with migrations applied. */
export function createTestDb() {
  return createDatabase(':memory:');
}

export function createTestRepos() {
  const db = createTestDb();
  return {
    db,
    sessionRepo: new SessionRepository(db),
    workingDirRepo: new WorkingDirectoryRepository(db),
  };
}
