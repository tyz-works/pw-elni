# pw.elni.net

プロレス情報の非公式ファンサイト。データはリポジトリ内の JSON が single source of truth で、
サイトは Astro による静的ビルド。Cloudflare Pages にデプロイする。

設計方針と各フェーズの範囲は [CLAUDE.md](./CLAUDE.md) を参照。

## 必要環境

- Node 24（バージョンは `.node-version` に固定。CI と Cloudflare Pages が同じファイルを見る）
- リポジトリは WSL 側のファイルシステムに置く（`/mnt/c/...` は Astro のビルドと watch が遅い）

## セットアップ

```bash
npm ci
```

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run validate` | `data/` の JSON Schema 検証 + 整合チェック |
| `npm test` | 検証器が壊れたデータをちゃんと落とすかのテスト |
| `npm run check -w site` | Astro / TypeScript の型チェック |
| `npm run dev` | 開発サーバ（http://localhost:4321） |
| `npm run build` | `validate` を通してから静的ビルド。出力は `site/dist` |
| `npm run preview` | ビルド結果をローカル配信 |

`npm run build` は必ず `validate` を先に通す。スキーマ違反のデータでサイトが焼けることはない。

## ディレクトリ

```
data/schema/      JSON Schema (draft 2020-12)。データの正しさの唯一の権威
data/promotions/  {slug}.json
data/wrestlers/   {slug}.json
data/venues/      {slug}.json
data/moves/       {slug}.json
data/events/      {promotion}/{YYYY}/{eventId}.json
data/news/        {YYYY-MM}/{id}.json
tools/            validate.mjs（検証器）と validate.test.mjs（その検証器のテスト）
site/             Astro プロジェクト
```

## データを追加する

1. `data/` 配下に規約どおりのパスで JSON を置く（→ [data/README.md](./data/README.md)）
2. `npm run validate` が通ることを確認する
3. PR を出す。CI が同じ検証を回す

スキーマを変えるときは、既存データのマイグレーションを同じ PR に含めること。

## デプロイ

Cloudflare Workers の静的アセット配信（Workers Builds が GitHub 連携でビルドする）。

設定は `wrangler.jsonc`。`main`（Worker スクリプト）を持たず、`site/dist` を
アセットとして配るだけの構成にしてある。SSR アダプタは入れない。

| 設定 | 値 |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| アセットディレクトリ | `site/dist`（`wrangler.jsonc` の `assets.directory`） |

ローカルで設定を確かめるには、デプロイせずに dry-run できる:

```bash
npm run build && npx wrangler deploy --dry-run
```

Node のバージョンは `.node-version` から読まれる。Cloudflare 側のデフォルトは 22 系なので、
このファイルを消すと本番だけ Node 22 で焼かれることになる。消さないこと。

当初は Cloudflare Pages を想定していたが、実際の接続が Workers プロジェクトだったため
Workers に合わせた。Cloudflare 自体が静的サイトの受け皿を Workers Static Assets に
寄せているため、こちらが既定路線になる。

## 免責

本サイトは非公式ファンサイトであり、各団体・選手・関係者とは一切関係がない。
写真は掲載しない。ニュースは自前要約と出典リンクのみで、原文の転載は行わない。
