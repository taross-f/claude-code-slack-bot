# 現状アーキテクチャ分析

## 概要

TypeScript + Node.js で実装された Slack Bot。`@anthropic-ai/claude-code` SDK の `query()` を呼び出し、Claude Code CLI をサブプロセスとして動かす。

## コンポーネント構成

```
src/
├── index.ts                  # 起動・初期化
├── config.ts                 # 環境変数読み込み
├── types.ts                  # 型定義
├── logger.ts                 # ログユーティリティ
├── slack-handler.ts          # Slack イベント処理（巨大、約780行）
├── claude-handler.ts         # Claude SDK 呼び出し・セッション管理
├── working-directory-manager.ts  # 作業ディレクトリ管理
├── file-handler.ts           # ファイルアップロード処理
├── todo-manager.ts           # TodoWrite ツール追跡
├── mcp-manager.ts            # MCP サーバー設定管理
├── permission-mcp-server.ts  # パーミッション承認 MCP サーバー
├── permission-server-start.js
└── image-handler.ts
```

## データフロー

```
Slack メッセージ
    ↓ WebSocket (Socket Mode)
slack-handler.ts
    ├── cwd コマンド判定 → WorkingDirectoryManager (in-memory)
    ├── mcp コマンド判定 → McpManager
    └── Claude へ転送
         ↓
claude-handler.ts (streamQuery)
    ├── options 構築
    │   ├── permissionMode: 'default'
    │   ├── permissionPromptToolName: 'mcp__permission-prompt__permission_prompt'
    │   ├── mcpServers: { 'permission-prompt': { command: 'npx', args: ['tsx', '/hardcoded/path/...'] } }
    │   └── resume: session.sessionId
    └── query() 呼び出し (Claude Agent SDK)
         ↓
    ストリーミングイベント処理
    ├── assistant (tool_use) → フォーマット → Slack
    ├── assistant (text) → Slack
    └── result → ステータス更新
```

## 現状の問題点

### 1. パーミッション実装が脆弱

```typescript
// claude-handler.ts:62-71 - ハードコードされた絶対パス
const permissionServer = {
  'permission-prompt': {
    command: 'npx',
    args: ['tsx', '/Users/marcelpociot/Experiments/claude-code-slack/src/permission-mcp-server.ts'],
    // ↑ 開発者のローカルパス。他の環境では動かない
    env: { SLACK_BOT_TOKEN: ..., SLACK_CONTEXT: ... }
  }
};
```

- 別プロセスで毎回 `npx tsx` を起動するためオーバーヘッドが大きい
- Slack へのコールバックが MCP プロトコル経由という二重構造
- パスをハードコードしているため環境依存

### 2. 全データがメモリのみ（再起動で消える）

```typescript
// working-directory-manager.ts:8
private configs: Map<string, WorkingDirectoryConfig> = new Map();

// claude-handler.ts:7
private sessions: Map<string, ConversationSession> = new Map();
```

- 再起動するたびに全チャンネルの作業ディレクトリ設定が消える
- 進行中のセッション（Claude の会話文脈）も消える
- `session.sessionId` を保存していても復元する仕組みがない

### 3. ストリーミングが粗い

- `includePartialMessages` を使っていないため、メッセージ単位での更新
- Claude がテキストを生成中でも Slack には何も出ない
- ツール実行のたびに新しいメッセージが投稿されるため Slack がスパム状態になりやすい

### 4. マルチエージェント対応なし

- 単一 Claude セッションが全タスクを担当
- 複雑なタスクでもサブエージェントへの分岐ができない
- "cowork" 的な並列処理は不可能

### 5. スキル・コマンド拡張性がない

- `/review-pr`、`/deploy` のような Slack コマンドを SKILL.md に紐付ける仕組みがない
- ユーザーが独自のコマンドを定義する方法がない

### 6. ツールスタックが古い・非効率

| 用途 | 現状 | 問題 |
|------|------|------|
| 実行 | Node.js + tsx | tsx は dev 用ラッパー。本番は tsc でビルドが必要 |
| パッケージ管理 | npm | 遅い、`package-lock.json` が巨大 |
| Lint/Format | なし | コードスタイルが統一されていない |
| 型チェック | tsc のみ | CI での型チェックが手動 |
| DB | なし (in-memory) | 再起動耐性なし |

### 7. `slack-handler.ts` が肥大化

- 約 780 行の単一ファイル
- イベント処理、メッセージフォーマット、リアクション管理、Todo 管理、パーミッション処理が混在
- テストが書きにくい

### 8. コスト・安全制御がない

- `maxBudgetUsd` 未設定（コスト上限なし）
- `maxTurns` 未設定（無限ループのリスク）
- チャンネル・ユーザーごとのレート制限なし

## 技術スタック（現状）

```
Runtime:          Node.js
Package Manager:  npm
TypeScript:       tsc (build) / tsx (dev)
Lint/Format:      なし
Database:         なし (in-memory only)
SDK:              @anthropic-ai/claude-code ^1.0.35
Slack:            @slack/bolt ^4.4.0
```

## SDK バージョンの問題

`@anthropic-ai/claude-code` は Claude Agent SDK に改名・進化しており、以下の新機能が未利用:

- `canUseTool` コールバック（permission-mcp-server の代替）
- `includePartialMessages` （トークン単位ストリーミング）
- `agents` オプション（サブエージェント）
- `hooks` オプション（ライフサイクルフック）
- `maxBudgetUsd` / `maxTurns`
- `acceptEdits` / `plan` パーミッションモード
- `forkSession`
- In-process MCP サーバー (`type: 'sdk'`)
