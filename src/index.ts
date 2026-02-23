import { App } from '@slack/bolt';
import { loadConfig } from './config';
import { claudeQuery } from './claude/query';
import { createDatabase } from './db/database';
import { SessionRepository } from './db/sessions';
import { WorkingDirectoryRepository } from './db/working-dirs';
import { McpManager } from './mcp/manager';
import { registerHandlers } from './slack/handler';
import { Logger } from './utils/logger';

const logger = new Logger('Main');

async function main(): Promise<void> {
  const config = loadConfig();

  const db = createDatabase(config.dbPath);
  const sessionRepo = new SessionRepository(db);
  const workingDirRepo = new WorkingDirectoryRepository(db);
  const mcpManager = new McpManager();

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  registerHandlers({
    app,
    config,
    sessionRepo,
    workingDirRepo,
    mcpManager,
    claudeQuery,
  });

  await app.start();
  logger.info('Claude Code Slack Bot started');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await app.stop();
    db.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await app.stop();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
