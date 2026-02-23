export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  claude: {
    useBedrock: boolean;
    useVertex: boolean;
    maxBudgetUsd: number;
    maxTurns: number;
  };
  baseDirectory: string;
  dbPath: string;
  debug: boolean;
}

export function loadConfig(): Config {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN as string,
      appToken: process.env.SLACK_APP_TOKEN as string,
      signingSecret: process.env.SLACK_SIGNING_SECRET as string,
    },
    claude: {
      useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
      useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
      maxBudgetUsd: Number(process.env.CLAUDE_MAX_BUDGET_USD ?? '1.0'),
      maxTurns: Number(process.env.CLAUDE_MAX_TURNS ?? '50'),
    },
    baseDirectory: process.env.BASE_DIRECTORY ?? '',
    dbPath: process.env.DB_PATH ?? 'bot.db',
    debug: process.env.DEBUG === 'true',
  };
}
