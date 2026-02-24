type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getCurrentLevel(): LogLevel {
  if (process.env.LOG_LEVEL && process.env.LOG_LEVEL in LEVEL_ORDER) {
    return process.env.LOG_LEVEL as LogLevel;
  }
  return process.env.DEBUG === 'true' ? 'debug' : 'info';
}

export class Logger {
  constructor(private readonly name: string) {}

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[getCurrentLevel()]) return;

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      logger: this.name,
      message,
    };
    if (data !== undefined) entry.data = data;

    const output = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') {
      console.error(output);
    } else {
      console.log(output);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }
}
