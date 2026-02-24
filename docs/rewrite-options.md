# リライトオプション比較

## 選択肢

3つのアプローチを検討する。

---

## Option A: インクリメンタルマイグレーション

**現在のリポジトリを段階的に改善する。**

### 進め方

```
Phase 1 (1-2日): ツールチェーン移行
  npm → Bun
  なし → Biome
  tsconfig build 設定 → Bun ネイティブ実行

Phase 2 (2-3日): 永続化
  in-memory Map → SQLite (bun:sqlite)
  SessionRepository, WorkingDirectoryRepository を新設

Phase 3 (2-3日): Claude Agent SDK 更新
  permission-mcp-server.ts を削除
  canUseTool コールバックに移行
  includePartialMessages でストリーミング改善
  maxBudgetUsd / maxTurns 追加

Phase 4 (3-5日): 新機能追加
  Subagents 設定
  Hooks 実装
  Skills レジストリ
  Block Kit 対応
```

### メリット

- git 履歴が保たれる
- 段階的にテストしながら進められる
- 各 Phase を独立して PR 化できる
- 既存の動作を壊さない安全なアプローチ

### デメリット

- `slack-handler.ts` の巨大なコードを抱えたまま改修が必要
- 古い設計の制約を引きずる（クラス設計、命名など）
- 途中で設計上の矛盾が出やすい
- 完了まで時間がかかる

### 向いているケース

- 本番稼働中で止められない
- 既存の git 履歴・issue が重要
- チームで段階的レビューしたい

---

## Option B: ゼロベース新規作成（推奨）

**同一リポジトリに `v2/` ブランチを作り、完全に作り直す。**

### 進め方

```
Week 1:
  新しいディレクトリ構成でゼロから実装
  Bun + Biome + SQLite で基盤構築
  ClaudeHandler (canUseTool 方式) 実装
  SessionRepository, WorkingDirectoryRepository 実装

Week 2:
  SlackHandler (イベントルーティング)
  メッセージフォーマット (Block Kit)
  Subagents 対応
  Hooks 実装

Week 3:
  Skills レジストリ
  2フェーズ実行 (plan → execute)
  コスト追跡
  テスト・デプロイ検証
```

### ディレクトリ戦略

```
リポジトリルートに v2/ ディレクトリを作るか、
master/main ブランチを v2 として完全に置き換える。

推奨: feature/v2 ブランチで開発 → master に向けて PR
```

### メリット

- 設計上の負債を完全にゼロリセット
- 最初から正しい構造で設計できる
- コードが整理されてテストしやすい
- Bun + SQLite + Biome を前提とした最適な設計が可能
- `slack-handler.ts` の 780 行問題が解消される

### デメリット

- 開発期間が長い（2〜3週間）
- 既存の動作を再現するまで本番で使えない
- 機能漏れのリスク

### 向いているケース

- まだ小規模で本番依存度が低い（このプロジェクトはまさにここ）
- ツールスタックを大きく変える（npm → Bun など）
- アーキテクチャを根本から変える

---

## Option C: フォーク + モジュール差し替え

**現在の `src/` を保持しつつ、問題のあるモジュールだけを差し替える。**

### 差し替え対象

```
src/permission-mcp-server.ts  → src/claude/permissions.ts (canUseTool)
src/working-directory-manager.ts → src/db/working-dirs.ts (SQLite)
src/claude-handler.ts         → src/claude/handler.ts (更新版)
```

### メリット

- 最小限の変更
- リスクが低い
- 短期間（1週間以内）

### デメリット

- 根本的な問題（`slack-handler.ts` の肥大化など）は解消されない
- Bun + Biome への移行は別途必要
- 「ツールだけ変えた」中途半端な状態になりやすい

---

## 推奨: Option B（ゼロベース）

このプロジェクトは現在 Initial commit の1コミットしかなく、本番稼働中でもないため、
**ゼロベースで作り直すコストが最も低く、品質の向上が最大になる。**

### 推奨フロー

```bash
# 1. 新ブランチで作業
git checkout -b feature/v2-rewrite

# 2. 既存ファイルを archive/ に退避（参照用）
mkdir archive && mv src/ archive/src/

# 3. 新 src/ を作成
mkdir src src/db src/claude src/slack src/skills src/mcp src/utils

# 4. Bun + Biome 初期化
bun init
bunx biome init

# 5. 依存関係インストール
bun add @anthropic-ai/claude-code @slack/bolt
bun add -d @biomejs/biome @types/bun typescript

# 6. 実装
```

---

## 実装ロードマップ（Option B 詳細）

### Step 1: 基盤 (Day 1-2)

```
src/
├── index.ts           # App 初期化
├── config.ts          # Zod でのバリデーション付き環境変数
└── utils/
    ├── logger.ts
    └── types.ts
```

### Step 2: データ層 (Day 2-3)

```
src/db/
├── database.ts        # SQLite 接続・WAL モード・マイグレーション
├── sessions.ts        # SessionRepository
└── working-dirs.ts    # WorkingDirectoryRepository
```

### Step 3: Claude 統合 (Day 3-5)

```
src/claude/
├── handler.ts         # streamQuery() - canUseTool, hooks, subagents
├── permissions.ts     # PermissionGate クラス
├── hooks.ts           # HookBuilder
└── subagents.ts       # SUBAGENT_CONFIG
```

### Step 4: Slack 統合 (Day 5-7)

```
src/slack/
├── handler.ts         # イベントルーティング (薄く保つ)
├── formatter.ts       # テキスト→Slack mrkdwn 変換
├── blocks.ts          # Block Kit ビルダー
└── reactions.ts       # リアクション管理
```

### Step 5: 拡張機能 (Day 7-10)

```
src/skills/
└── registry.ts        # SKILL.md ローダー

src/mcp/
└── manager.ts         # MCP 管理（既存を踏襲）
```

### Step 6: 検証・移行 (Day 10-14)

- 既存機能の動作確認
- Slack での E2E テスト
- デプロイ設定更新

---

## 判断マトリクス

| 観点 | Option A | Option B | Option C |
|------|----------|----------|----------|
| 開発期間 | 中 (2週間) | 長 (3週間) | 短 (1週間) |
| 設計品質 | 中 | 高 | 低 |
| リスク | 低 | 低〜中 | 低 |
| 移行コスト | 中 | 低 (新規なので) | 最小 |
| 将来の保守性 | 中 | 高 | 中 |
| 推奨度 | ◯ | ◎ | △ |

**結論: このプロジェクトの状況（Initial commit 1つ、本番未稼働）では Option B を推奨。**
