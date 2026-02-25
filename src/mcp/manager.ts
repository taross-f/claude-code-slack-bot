import { existsSync, readFileSync } from 'node:fs';
import { Logger } from '../utils/logger';

const MCP_CONFIG_PATH = 'mcp-servers.json';

export class McpManager {
  private readonly logger = new Logger('McpManager');
  private servers: Record<string, unknown> = {};

  constructor() {
    this.load();
  }

  load(): void {
    if (!existsSync(MCP_CONFIG_PATH)) {
      this.logger.info('No mcp-servers.json found, MCP disabled');
      this.servers = {};
      return;
    }
    const text = readFileSync(MCP_CONFIG_PATH, 'utf-8');
    this.servers = JSON.parse(text) as Record<string, unknown>;
    this.logger.info('MCP servers loaded', { count: Object.keys(this.servers).length });
  }

  getServers(): Record<string, unknown> {
    return this.servers;
  }

  getServerNames(): string[] {
    return Object.keys(this.servers);
  }
}
