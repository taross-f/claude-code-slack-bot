# ツールチェーン移行ガイド: Bun + Biome

## 現状 → To-Be

| 用途 | 現状 | To-Be |
|------|------|-------|
| Runtime | Node.js | Bun |
| Package Manager | npm | Bun |
| Dev 実行 | `tsx watch` | `bun --watch` |
| Prod 実行 | `tsc` → `node dist/` | `bun src/index.ts` |
| Lint | なし | Biome |
| Format | なし | Biome |
| DB | なし | SQLite (`bun:sqlite`) |

---

## Bun

### なぜ Bun か

- TypeScript をネイティブで実行（tsc/tsx 不要）
- `bun --watch` で開発時のホットリロード
- `bun:sqlite` が組み込み（`better-sqlite3` 不要）
- インストールが npm の 10〜30x 速い
- Node.js API 互換なので `@slack/bolt` 等はそのまま動く

### 移行コマンド

```bash
# Bun のインストール（まだなければ）
curl -fsSL https://bun.sh/install | bash

# npm → bun に移行
rm package-lock.json
bun install        # bun.lock が生成される

# 動作確認
bun src/index.ts
```

### `package.json` スクリプト変更

```json
{
  "scripts": {
    "dev":       "bun --watch src/index.ts",
    "start":     "bun src/index.ts",
    "check":     "biome check --write src/",
    "typecheck": "tsc --noEmit"
  }
}
```

### `tsconfig.json` 変更点

Bun ネイティブ実行では `outDir` / `rootDir` が不要になる。
型チェック専用の最小構成にする。

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### `bun:sqlite` の使用例

```typescript
import { Database } from 'bun:sqlite';

const db = new Database('bot.db', { create: true });

// WAL モードで書き込み性能向上
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

// プリペアドステートメント（型安全）
const getSession = db.prepare<Session, [string]>(
  'SELECT * FROM sessions WHERE session_key = ?'
);

const session = getSession.get(sessionKey);
```

### Docker / デプロイでの Bun 実行

```dockerfile
FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
CMD ["bun", "src/index.ts"]
```

---

## Biome

### なぜ Biome か

- ESLint + Prettier を **単一バイナリ** で代替
- 設定ほぼ不要（`biome init` でデフォルト生成）
- 圧倒的に高速（Rust 実装）
- `biome check --write` 1コマンドで lint + format + import sort

### セットアップ

```bash
# インストール
bun add -d @biomejs/biome

# 設定ファイル生成
bunx biome init
```

### `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignore": ["node_modules", "dist", "*.d.ts"]
  },
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "es5",
      "semicolons": "always"
    }
  }
}
```

### 使い方

```bash
# チェック（エラー表示のみ）
bunx biome check src/

# 自動修正（lint + format を同時に適用）
bunx biome check --write src/

# CI（--write なし + エラーで終了）
bunx biome ci src/
```

### VSCode 連携

`.vscode/settings.json` を追加すると、保存時に自動フォーマットされる。

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "[typescript]": {
    "editor.defaultFormatter": "biomejs.biome"
  }
}
```

---

## SQLite (`bun:sqlite`)

### なぜ SQLite か

- Bun 組み込みなのでインストール不要
- 単一ファイル (`.db`) なのでバックアップ・移植が容易
- WAL モードで並行書き込みに対応
- 本プロジェクトのスケール（チャンネル数十〜数百）には十分すぎるスペック

### 他の選択肢との比較

| DB | メリット | デメリット |
|-----|---------|-----------|
| SQLite (`bun:sqlite`) | 組み込み・ゼロ依存・シンプル | 単一サーバー前提 |
| Redis | 高速・TTL サポート | 別プロセス必要 |
| PostgreSQL | スケーラブル | 別プロセス・設定複雑 |
| Turso (SQLite over HTTP) | 分散・クラウド対応 | 外部サービス依存 |

→ まず `bun:sqlite` で始め、スケールアウトが必要になったら Turso に移行可能。

### マイグレーション管理

シンプルなバージョン管理方式を採用。

```typescript
// src/db/database.ts
const MIGRATIONS: string[] = [
  // v1
  `CREATE TABLE IF NOT EXISTS sessions (
    session_key       TEXT PRIMARY KEY,
    claude_session_id TEXT,
    user_id           TEXT NOT NULL,
    channel_id        TEXT NOT NULL,
    thread_ts         TEXT,
    working_directory TEXT,
    is_active         INTEGER DEFAULT 1,
    last_activity_at  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS working_directories (
    dir_key    TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    thread_ts  TEXT,
    user_id    TEXT,
    directory  TEXT NOT NULL,
    set_at     INTEGER NOT NULL
  )`,
  // v2 以降は配列に追加
];

export function initDatabase(path = 'bot.db'): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');

  // バージョン管理
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)');
  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = current?.v ?? -1;

  for (let i = currentVersion + 1; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare('INSERT INTO schema_version VALUES (?)').run(i);
  }

  return db;
}
```

---

## CI/CD（GitHub Actions）

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Type check
        run: bun tsc --noEmit

      - name: Lint & Format
        run: bunx biome ci src/
```

---

## 移行チェックリスト

### npm → Bun

- [ ] `bun install` を実行し `bun.lock` 生成
- [ ] `package-lock.json` を削除・`.gitignore` に追加
- [ ] `package.json` scripts を `bun` 系コマンドに変更
- [ ] `tsconfig.json` を Bun 向けに更新
- [ ] `Dockerfile` を `oven/bun` ベースに更新

### Biome 導入

- [ ] `@biomejs/biome` を devDependency に追加
- [ ] `biome.json` を作成
- [ ] `.vscode/settings.json` を追加
- [ ] 既存コードに `biome check --write src/` を実行
- [ ] CI に Biome チェックを追加

### SQLite 移行

- [ ] `src/db/database.ts` を作成（initDatabase 関数）
- [ ] `src/db/sessions.ts` を作成（SessionRepository）
- [ ] `src/db/working-dirs.ts` を作成（WorkingDirectoryRepository）
- [ ] `working-directory-manager.ts` を Repository を使うように更新
- [ ] `claude-handler.ts` のセッション管理を Repository 経由に更新
- [ ] `.gitignore` に `*.db` と `*.db-wal` を追加
