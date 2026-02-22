# To-Be アーキテクチャ設計

## コンセプト

**Claude Agent SDK の最新機能を最大活用し、Cowork に近い体験を Slack 上で実現する。**

- Subagents による並列・分業タスク処理
- SQLite による永続化（セッション・作業ディレクトリ）
- `canUseTool` コールバックによるインプロセス権限制御
- Biome + Bun による高速・シンプルなツールチェーン

---

## 技術スタック（To-Be）

| 用途 | 採用技術 | 理由 |
|------|----------|------|
| Runtime | Bun | Node.js 互換、高速起動、TypeScript ネイティブ |
| Package Manager | Bun | `bun install` は npm の 10〜30x 高速 |
| Lint/Format | Biome | ESLint + Prettier を単一ツールで代替。設定ほぼ不要 |
| Database | SQLite (`bun:sqlite`) | Bun 組み込み。依存ゼロで永続化 |
| SDK | `@anthropic-ai/claude-code` (latest) | Claude Agent SDK |
| Slack | `@slack/bolt` | 変更なし |

---

## ディレクトリ構成（To-Be）

```
claude-code-slack-bot/
├── src/
│   ├── index.ts                    # 起動・初期化
│   ├── config.ts                   # 環境変数 + バリデーション
│   │
│   ├── db/
│   │   ├── database.ts             # SQLite 接続・マイグレーション
│   │   ├── sessions.ts             # SessionRepository
│   │   └── working-dirs.ts         # WorkingDirectoryRepository
│   │
│   ├── claude/
│   │   ├── handler.ts              # Claude Agent SDK 呼び出し
│   │   ├── permissions.ts          # canUseTool コールバック実装
│   │   ├── hooks.ts                # Hook handlers (PreToolUse 等)
│   │   └── subagents.ts            # Subagent 定義・設定
│   │
│   ├── slack/
│   │   ├── handler.ts              # Slack イベントルーティング
│   │   ├── formatter.ts            # メッセージフォーマット
│   │   ├── blocks.ts               # Block Kit ビルダー
│   │   └── reactions.ts            # リアクション管理
│   │
│   ├── skills/
│   │   └── registry.ts             # SKILL.md ローダー・Slack コマンドマッピング
│   │
│   ├── mcp/
│   │   └── manager.ts              # MCP サーバー管理
│   │
│   └── utils/
│       ├── logger.ts
│       └── types.ts
│
├── .claude/
│   └── skills/                     # Bot 自身のスキル定義
│       ├── review-pr/
│       │   └── SKILL.md
│       ├── deploy/
│       │   └── SKILL.md
│       └── standup/
│           └── SKILL.md
│
├── docs/                           # このディレクトリ
├── biome.json                      # Biome 設定
├── bunfig.toml                     # Bun 設定
├── mcp-servers.json
└── .env.example
```

---

## SQLite スキーマ

```sql
-- セッション（Claude 会話の永続化）
CREATE TABLE sessions (
  session_key       TEXT PRIMARY KEY,  -- "{userId}-{channelId}-{threadTs}"
  claude_session_id TEXT,              -- SDK resume 用 session_id
  user_id           TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  thread_ts         TEXT,
  working_directory TEXT,
  is_active         INTEGER DEFAULT 1,
  last_activity_at  INTEGER NOT NULL,  -- Unix ms
  created_at        INTEGER NOT NULL
);

-- 作業ディレクトリ設定（チャンネル・スレッドごと）
CREATE TABLE working_directories (
  dir_key     TEXT PRIMARY KEY,  -- "{channelId}" or "{channelId}-{threadTs}"
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT,
  user_id     TEXT,
  directory   TEXT NOT NULL,
  set_at      INTEGER NOT NULL   -- Unix ms
);

-- 実行コスト追跡（オプション）
CREATE TABLE usage_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  cost_usd     REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_sessions_channel ON sessions(channel_id, thread_ts);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at);
CREATE INDEX idx_working_dirs_channel ON working_directories(channel_id);
CREATE INDEX idx_usage_user ON usage_logs(user_id, created_at);
```

### Repository 設計

```typescript
// src/db/sessions.ts
export class SessionRepository {
  find(sessionKey: string): Session | null
  upsert(session: Session): void
  updateClaudeSessionId(sessionKey: string, claudeSessionId: string): void
  updateLastActivity(sessionKey: string): void
  cleanup(olderThanMs: number): number  // 古いセッションを削除
  findByChannel(channelId: string): Session[]
}

// src/db/working-dirs.ts
export class WorkingDirectoryRepository {
  find(key: string): WorkingDirectory | null
  set(dir: WorkingDirectory): void
  remove(key: string): void
  listByChannel(channelId: string): WorkingDirectory[]
}
```

---

## 権限制御: `canUseTool` に移行

外部プロセス (`permission-mcp-server.ts`) を廃止し、同一プロセス内で処理。

```typescript
// src/claude/permissions.ts
export class PermissionGate {
  private pending = new Map<string, (approved: boolean) => void>();

  // Claude Agent SDK から呼ばれる canUseTool コールバック
  async canUseTool(
    tool: string,
    input: unknown,
    slackContext: SlackContext
  ): Promise<PermissionResult> {
    // 安全ツールはスキップ
    if (SAFE_TOOLS.includes(tool)) {
      return { behavior: 'allow' };
    }

    // Slack に承認 Block Kit を送信し、ユーザーの応答を待機
    const approvalId = crypto.randomUUID();
    const approved = await this.promptSlack(approvalId, tool, input, slackContext);

    return approved
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: `Tool "${tool}" was denied by user.` };
  }

  // Slack の approve/deny ボタンから呼ばれる
  resolveApproval(approvalId: string, approved: boolean): void {
    this.pending.get(approvalId)?.(approved);
    this.pending.delete(approvalId);
  }
}

// 承認不要な安全ツール
const SAFE_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite'];
```

**Block Kit での承認 UI:**

```typescript
// src/slack/blocks.ts
export function buildPermissionRequestBlock(
  approvalId: string,
  tool: string,
  input: unknown
): Block[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*Permission Required*\nTool: \`${tool}\`` } },
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${JSON.stringify(input, null, 2).slice(0, 500)}\n\`\`\`` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Allow' }, style: 'primary', action_id: 'approve_tool', value: approvalId },
        { type: 'button', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', action_id: 'deny_tool', value: approvalId },
      ],
    },
  ];
}
```

---

## Subagents による Cowork 的体験

```typescript
// src/claude/subagents.ts
export const SUBAGENT_CONFIG = {
  agents: {
    // コードベース調査専用（読み取り専用・高速）
    explore: {
      description: 'Read-only exploration of the codebase. Use for understanding structure, finding files, searching code.',
      permissionMode: 'bypassPermissions',  // 読み取りのみなので安全
      allowedTools: ['Read', 'Glob', 'Grep', 'LS'],
    },
    // 設計・計画専用（実行しない）
    plan: {
      description: 'Architecture planning and research. Use to design solutions before implementation.',
      permissionMode: 'plan',  // 読み取り専用モード
    },
  },
} as const;
```

### Slack での表示イメージ

```
@ClaudeBot このPRをレビューして認証フローを改善して

Bot: 🤔 Thinking...

[サブエージェント起動]
🔍 Explore: コードベース調査中... (auth/*, middleware/*)
📋 Plan: 改善案を設計中...

[メインエージェント実行]
⚙️ Working...
📝 Editing `src/auth/middleware.ts`
📝 Editing `src/auth/jwt.ts`

✅ Task completed ($0.08 used)
```

### Slack でのサブエージェント追跡

```typescript
// hooks.ts
options.hooks = {
  SubagentStart: [{
    handler: async ({ agentType }) => {
      await slack.updateStatus(`🔍 ${agentType} agent started...`);
    }
  }],
  SubagentStop: [{
    handler: async ({ agentType, result }) => {
      await slack.postProgress(`${agentType} completed`);
    }
  }],
};
```

---

## 2フェーズ実行（Plan → Execute）

```
@ClaudeBot plan: 認証システムをリファクタして

Bot:
📋 *実装計画*

1. JWT トークン検証を middleware に移動
2. refresh token の実装
3. セッション管理の改善

[Allow / Modify / Cancel ボタン]

--- ユーザーが Allow を押す ---

Bot: ⚙️ 実行中...
[実際の変更を実施]
```

```typescript
// claude/handler.ts
async streamQuery(prompt: string, options: QueryOptions) {
  // "plan:" プレフィックスで2フェーズ実行
  if (prompt.startsWith('plan:')) {
    // Phase 1: plan モードで設計のみ
    const planResult = await this.runPlanPhase(prompt.slice(5));
    await this.slack.postPlanForApproval(planResult);
    // Phase 2: ユーザー承認後に acceptEdits で実行
    // (Slack の approve ボタンで trigger)
  }
}
```

---

## Hooks による Slack 連携

```typescript
// src/claude/hooks.ts
export function buildHooks(slack: SlackContext): HookConfig {
  return {
    PreToolUse: [{
      matcher: { tool: 'Bash' },
      handler: async ({ input }) => {
        // 危険なコマンドを事前にチェック
        if (isDangerousCommand(input.command)) {
          return { decision: 'block', reason: 'Dangerous command pattern detected' };
        }
        await slack.postEphemeral(`🖥️ Running: \`${input.command}\``);
      }
    }],

    PostToolUse: [{
      matcher: { tool: 'Edit' },
      handler: async ({ input, output }) => {
        // ファイル変更をリアクションで通知
        await slack.addReaction('pencil2');
      }
    }],

    Notification: [{
      handler: async ({ message }) => {
        // Claude からの通知をそのまま Slack へ
        await slack.postMessage(`💬 ${message}`);
      }
    }],

    Stop: [{
      handler: async ({ result }) => {
        const cost = result.costUsd ? `$${result.costUsd.toFixed(4)}` : '';
        await slack.updateStatusMessage(`✅ Completed ${cost}`);
      }
    }],
  };
}
```

---

## スキル（Skills）

### ディレクトリ構造

```
.claude/skills/
├── review-pr/
│   └── SKILL.md
├── standup/
│   └── SKILL.md
└── deploy/
    └── SKILL.md
```

### SKILL.md 例

```markdown
---
name: review-pr
description: Review a GitHub Pull Request and provide detailed feedback
allowed-tools: Bash, Read, Glob, Grep
---

Review PR #$ARGUMENTS in the current repository.

Focus on:
1. Code quality and best practices
2. Security vulnerabilities
3. Performance implications
4. Test coverage

Run `gh pr diff $ARGUMENTS` to get the diff, then provide structured feedback.
```

### Slack でのスキル呼び出し

```
@ClaudeBot /review-pr 123
@ClaudeBot /standup
@ClaudeBot /deploy staging
```

```typescript
// src/skills/registry.ts
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  load(workingDirectory: string): void {
    const skillsDir = path.join(workingDirectory, '.claude', 'skills');
    // SKILL.md を再帰的に読み込み
  }

  buildPrompt(skillName: string, args: string): string | null {
    const skill = this.skills.get(skillName);
    if (!skill) return null;
    return skill.content.replace(/\$ARGUMENTS/g, args);
  }
}
```

---

## リアルタイムストリーミング改善

```typescript
// `includePartialMessages: true` でトークン単位の更新
options.includePartialMessages = true;

// デバウンスで Slack API 呼び出しを間引く
class StreamingBuffer {
  private buffer = '';
  private timer: Timer | null = null;
  private messageTs: string;

  append(delta: string) {
    this.buffer += delta;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);  // 250ms デバウンス
  }

  private async flush() {
    await slack.updateMessage(this.messageTs, this.buffer);
  }
}
```

---

## コスト・安全制御

```typescript
// 全セッション共通の制約
const DEFAULT_LIMITS = {
  maxBudgetUsd: 1.00,    // $1.00 上限
  maxTurns: 50,           // 50 ターン上限
  betas: ['context-1m-2025-08-07'],  // 1M コンテキスト
};

// 使用量の SQLite への記録
// → チャンネルごと・ユーザーごとの月次集計が可能に
```

---

## 設定ファイル

### `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  }
}
```

### `bunfig.toml`

```toml
[install]
exact = true  # 正確なバージョンで lock

[run]
bun = true
```

### `package.json`（Bun 版）

```json
{
  "name": "claude-code-slack-bot",
  "version": "2.0.0",
  "scripts": {
    "dev":   "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "check": "biome check --write src/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-code": "latest",
    "@slack/bolt": "^4.4.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "typescript": "^5.8.0",
    "@types/bun": "latest"
  }
}
```

---

## 削除されるファイル

| ファイル | 理由 |
|----------|------|
| `src/permission-mcp-server.ts` | `canUseTool` コールバックに置き換え |
| `src/permission-server-start.js` | 同上 |
| `src/working-directory-manager.ts` | SQLite Repository に統合 |
| `src/todo-manager.ts` | Hooks (`PostToolUse` で TodoWrite を捕捉) に統合 |
| `tsconfig.json` (build 設定) | Bun がネイティブで TypeScript 実行 |
| `package-lock.json` | `bun.lock` に置き換え |

---

## 改善効果サマリー

| 観点 | Before | After |
|------|--------|-------|
| 起動速度 | ~2s (Node.js + tsx) | ~200ms (Bun) |
| セッション永続性 | なし（再起動で消える）| SQLite で永続化 |
| 権限制御 | 外部プロセス (fragile) | インプロセス (robust) |
| コスト制御 | なし | `maxBudgetUsd` + 利用ログ |
| 並列処理 | なし | Subagents で並列 |
| ストリーミング | メッセージ単位 | トークン単位 |
| Slack UX | テキストのみ | Block Kit + リアルタイム更新 |
| コマンド拡張 | なし | SKILL.md で無限拡張 |
| ライフサイクル | なし | Hooks で全フェーズ制御 |
