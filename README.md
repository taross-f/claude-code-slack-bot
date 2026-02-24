# Claude Code Slack Bot

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)
![Bun](https://img.shields.io/badge/Bun-1.x-black?logo=bun)
![License](https://img.shields.io/badge/License-MIT-green)

A Slack bot that brings the Claude Code SDK into your Slack workspace. Ask coding questions, set a working directory, upload files for analysis, and let Claude plan and execute multi-step tasks — all without leaving Slack.

## Features

- **Streaming responses** — messages update in real time as Claude generates output
- **Session continuity** — conversation context is preserved across messages within a thread using SQLite-backed sessions
- **Working directory management** — per-channel defaults and per-thread overrides let each conversation target the right codebase
- **Real-time task tracking** — Claude's todo list is displayed as a live Slack message with status updates and priority indicators
- **File uploads** — text files are embedded in the prompt; images are written to a temp path for Claude to read with the Read tool; 50 MB size limit with automatic cleanup
- **Permission gates** — destructive tool calls (Write, Bash, Edit, etc.) require user approval via interactive Slack buttons; safe read-only tools are allowed automatically
- **MCP server support** — extend Claude with any stdio, SSE, or HTTP MCP server by editing `mcp-servers.json`
- **Socket Mode** — no public HTTP endpoint required; the bot connects outbound via WebSocket

## Architecture

```
src/
├── index.ts                  # Entry point: wires up DB, Slack app, and handlers
├── config.ts                 # Loads and validates environment variables
├── claude/
│   ├── query.ts              # Thin wrapper around the @anthropic-ai/claude-code SDK query()
│   └── permissions.ts        # PermissionGate: approves safe tools, posts Slack prompts for others
├── db/
│   ├── database.ts           # SQLite setup and migrations via bun:sqlite
│   ├── sessions.ts           # SessionRepository: read/write Claude session state
│   └── working-dirs.ts       # WorkingDirectoryRepository: persist per-channel/thread cwds
├── mcp/
│   └── manager.ts            # Loads mcp-servers.json; supports runtime reload
├── slack/
│   ├── handler.ts            # Registers Slack event listeners; routes commands and messages
│   ├── message-processor.ts  # Processes Claude SDK events into formatted Slack messages
│   ├── formatter.ts          # Converts Claude markdown/tool output to Slack mrkdwn
│   ├── blocks.ts             # Slack Block Kit builders (permission request UI, etc.)
│   └── file-upload.ts        # Downloads and classifies Slack file attachments
└── utils/
    ├── logger.ts             # Structured JSON logger
    └── types.ts              # Shared TypeScript type definitions
```

## Prerequisites

- **Bun 1.x** — the project runs natively on Bun and uses `bun:sqlite`
- A **Slack workspace** where you can install custom apps
- An **Anthropic API key** (or AWS Bedrock / Google Vertex credentials)

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo>
cd claude-code-slack-bot
bun install
```

### 2. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From an app manifest** and select your workspace.
3. Paste the contents of `slack-app-manifest.json` from this repo.
4. Review and create the app.
5. Under **OAuth & Permissions**, install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
6. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope and copy it (`xapp-…`).
7. Copy the **Signing Secret** from **Basic Information**.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret
ANTHROPIC_API_KEY=your-anthropic-api-key

# Optional — see Environment Variables table below
BASE_DIRECTORY=/Users/username/Code/
DB_PATH=bot.db
CLAUDE_MAX_BUDGET_USD=1.0
CLAUDE_MAX_TURNS=50
DEBUG=true
# CLAUDE_CODE_USE_BEDROCK=1
# CLAUDE_CODE_USE_VERTEX=1
```

### 4. Configure MCP servers (optional)

```bash
cp mcp-servers.example.json mcp-servers.json
# Edit mcp-servers.json and remove or adjust server entries as needed
```

### 5. Start the bot

```bash
# Development with hot reload
bun run dev

# Production (no reload)
bun run start
```

## Environment Variables

| Name | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | — | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | Yes | — | App-Level Token for Socket Mode (`xapp-…`) |
| `SLACK_SIGNING_SECRET` | Yes | — | Signing secret from Slack Basic Information |
| `ANTHROPIC_API_KEY` | Yes* | — | Anthropic API key. Not required if using Bedrock or Vertex |
| `BASE_DIRECTORY` | No | `""` | Root directory for relative `cwd` paths, e.g. `/Users/me/Code/` |
| `DB_PATH` | No | `bot.db` | Path to the SQLite database file |
| `CLAUDE_MAX_BUDGET_USD` | No | `1.0` | Maximum spend per query in USD |
| `CLAUDE_MAX_TURNS` | No | `50` | Maximum agentic turns per query |
| `CLAUDE_CODE_USE_BEDROCK` | No | `""` | Set to `1` to use AWS Bedrock instead of the Anthropic API |
| `CLAUDE_CODE_USE_VERTEX` | No | `""` | Set to `1` to use Google Vertex AI instead of the Anthropic API |
| `DEBUG` | No | `false` | Set to `true` to enable verbose debug logging |

## Slack App Setup

### Required OAuth scopes (bot)

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Receive `@mention` events in channels |
| `channels:history` | Read messages in public channels |
| `chat:write` | Post messages and reply in threads |
| `chat:write.public` | Post in public channels without being invited |
| `im:history` | Read direct messages sent to the bot |
| `im:read` | Receive DM metadata |
| `im:write` | Open and post to DM conversations |
| `users:read` | Look up user info |
| `reactions:read` | Read emoji reactions |
| `reactions:write` | Add/remove emoji reactions on messages |

### Required event subscriptions

| Event | Trigger |
|---|---|
| `app_mention` | Bot is @mentioned in a channel |
| `message.im` | User sends a direct message to the bot |
| `member_joined_channel` | Bot is invited to a channel (triggers welcome + cwd setup) |

Socket Mode must be enabled. An app-level token with the `connections:write` scope is required.

## Usage

### Setting a working directory

The bot needs to know which directory to operate in. In a DM or after being added to a channel:

```
cwd /absolute/path/to/project
```

If `BASE_DIRECTORY` is set you can use a short name:

```
cwd my-project
# resolves to $BASE_DIRECTORY/my-project
```

Override the directory for a single thread only:

```
@ClaudeBot cwd other-project
@ClaudeBot Now review the auth module in this other project
```

Check the current working directory:

```
cwd
```

### Asking coding questions

In a channel (after setting a working directory):

```
@ClaudeBot Explain the session management in this codebase
```

In a direct message:

```
Can you write a pytest fixture for a PostgreSQL test database?
```

### Uploading files

Drag and drop or attach a file with an optional description. Text files (code, JSON, markdown, etc.) are embedded directly in the prompt. Images are analyzed via the Read tool.

```
[attach screenshot.png]
What layout issues do you see in this UI?
```

### Viewing and reloading MCP servers

```
mcp
```

```
mcp reload
```

## MCP Servers

MCP (Model Context Protocol) servers extend what Claude can do — filesystem access, GitHub API calls, database queries, web search, and more.

Copy the example configuration and edit it:

```bash
cp mcp-servers.example.json mcp-servers.json
```

`mcp-servers.json` supports three server types:

```json
{
  "mcpServers": {
    "my-stdio-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
    },
    "my-sse-server": {
      "type": "sse",
      "url": "http://localhost:3001/sse",
      "headers": { "Authorization": "Bearer token" }
    },
    "my-http-server": {
      "type": "http",
      "url": "http://localhost:3002/mcp",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

See `mcp-servers.example.json` for annotated examples including `filesystem`, `github`, `postgres`, `sqlite`, `brave-search`, and `puppeteer`.

All MCP tools are automatically allowed; they appear to Claude under the naming pattern `mcp__serverName__toolName`.

## Development

```bash
# Run tests
bun test

# Run only unit tests
bun test tests/unit

# Run only e2e tests
bun test tests/e2e

# Lint and auto-fix
bun run lint

# Lint in CI mode (no writes)
bun run lint:ci

# Type-check without emitting
bun run typecheck
```

## License

MIT
