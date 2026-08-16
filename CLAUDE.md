# pw.elni.net — プロレス情報サイト

非公式ファンサイト。データはリポジトリ内 JSON が single source of truth。
サイトは Astro による静的ビルド。Cloudflare Workers（静的アセット配信）にデプロイ。

## 最重要原則

1. **LLM に HTML を書かせない。** LLM の担当は「非構造テキスト → スキーマ準拠 JSON」の変換のみ。
   HTML は Astro が決定論的に生成する。
2. **検証は非 LLM。** JSON Schema + CI で機械的に落とす。LLM に「正しいか確認して」はやらせない。
3. **部分失敗を許容。** 1 団体の抽出が壊れても他は止めない。壊れた団体だけ隔離して通知。
4. **フェーズを飛ばさない。** 現在 Phase B。収集の自動化は Phase C 以降。

## 現在のフェーズ: Phase B（骨組み）

### やること
- `data/schema/` に JSON Schema (draft 2020-12) を 7 エンティティ分定義
- 新日本プロレス / スターダム / DDT の 3 団体ぶん、興行データを手動で各 3 件投入
- Astro でビルド、Cloudflare Workers にデプロイ
- CI で JSON Schema 検証を必須化

### やらないこと（Phase B では禁止）
- スクレイピング / fetch 層の実装
- LLM による抽出パイプライン
- 検索・フィルタ等の動的機能
- 画像の取り込み

### 完了条件
- `pw.elni.net` が表示される
- スキーマ違反の JSON を含む PR が CI で落ちる

## リポジトリ構成

```
/
├── CLAUDE.md
├── README.md
├── .node-version        # Node のバージョンはここが唯一の真実
├── data/
│   ├── README.md        # 配置規約・データ品質ルール・検証内容
│   ├── schema/          # JSON Schema 定義
│   │   ├── common.schema.json   # 共有 $defs（slug/date/sources 等）。エンティティではない
│   │   ├── promotion.schema.json
│   │   ├── wrestler.schema.json
│   │   ├── event.schema.json
│   │   ├── match.schema.json    # event.matches[] の要素。単体ファイルにはしない
│   │   ├── move.schema.json
│   │   ├── venue.schema.json
│   │   └── news.schema.json
│   ├── promotions/      # {slug}.json
│   ├── wrestlers/       # {slug}.json
│   ├── events/          # {promotion}/{YYYY}/{eventId}.json
│   ├── moves/           # {slug}.json
│   ├── venues/          # {slug}.json
│   └── news/            # {YYYY-MM}/{id}.json
├── site/                # Astro プロジェクト
│   ├── src/
│   │   ├── content.config.ts  # data/ を content collections として読む
│   │   ├── lib/         # 型と表示用ヘルパ
│   │   ├── components/
│   │   ├── layouts/
│   │   ├── styles/
│   │   └── pages/
│   └── astro.config.mjs
├── tools/
│   ├── validate.mjs      # ajv によるスキーマ検証 + 整合チェック
│   └── validate.test.mjs # 上の検証器が壊れたデータを落とすかのテスト
└── .github/workflows/
    └── validate.yml
```

データとサイトを 1 リポにまとめる。PR 単位が「データ更新 = サイト更新」で揃うのが目的。

## ID / slug 規約

- slug は小文字英数とハイフンのみ。`^[a-z0-9-]+$`
- 団体: 英字略称。`njpw` / `stardom` / `ddt`
- 選手: ローマ字リングネーム。`kazuchika-okada` / `mayu-iwatani`
- 興行: `{promotion}-{YYYYMMDD}-{seq}`。seq は同日複数興行の連番（0 始まり）。例 `njpw-20260104-0`
- 会場: `{都市}-{施設}`。例 `tokyo-korakuen-hall`
- 技: 英語表記のローマ字。`rainmaker` / `moonsault-press`

## 名寄せ（aliases）

**設計上いちばん壊れるポイント。最初から作る。**

各 wrestler は `aliases[]` を必ず持つ。表記ゆれ・改名・マスク時代・英語表記をすべてここに入れる。

```json
{
  "slug": "kazuchika-okada",
  "name": "オカダ・カズチカ",
  "aliases": ["岡田かずちか", "Kazuchika Okada", "オカダ カズチカ"]
}
```

Phase C 以降の抽出パイプラインは、まず alias 解決を通してから ID を確定する。
解決できない名前は新規作成せず、`unresolved` として人間に上げる（勝手に新規選手を作らない）。

## データ品質ルール

- **本名・生年月日は公式プロフィールで公表されているもののみ。** 出典 URL 必須。
  出典がないフィールドは `null` にする。推測で埋めない。
- **ニュースは自前要約 + 出典リンクのみ。** 原文の表現を再利用しない。転載は明確にアウト。
- **写真は使わない。** 自前撮影以外は載せない。選手ページはテキストで組む。
- 各ページに出典リンクと「非公式ファンサイト」表記を入れる。
- 未確定情報には `confirmed: false` を持たせ、UI 上で「未発表」と明示する。
  対戦カード未発表の興行は日時・会場だけで公開してよい。

## 整合チェック（tools/validate.mjs）

スキーマ検証に加えて以下を機械的に検査。1 件でも違反したら CI 失敗。

- 孤立参照: `match.sides[].wrestlerIds` が存在しない wrestler を指していないか。
  会場・団体・技への参照も同様
- 重複: 同一 eventId、同一 slug の重複
- 日付整合: `debutDate` > `birthDate`、興行の `doorsOpen` < `bellTime`
- 必須出典: `realName` / `birthDate` があるのに `sources[]` が空でないか
- 配置規約: ファイル名がキーと一致するか、興行が `events/{promotion}/{YYYY}/` にあるか
- eventId 整合: ID の団体部分・日付部分が中身の `promotionSlug` / `date` と一致するか
- 試合の整合: `order` の重複、同一選手が両陣営に含まれていないか、
  `singles` が 2 陣営 × 各 1 名か、`winnerSideIndex` が範囲内か、
  引き分けなのに勝者がいないか、`result` があるのに `confirmed: false` でないか
- 書式: CRLF の混入、末尾改行、JSON のパース

**試合の参加者は `match.sides[].wrestlerIds` に持つ**（当初案の平坦な `match.wrestlerIds`
から変更）。タッグの陣営分けと勝敗（`result.winnerSideIndex`）を表現するために必要。

検証器そのものが壊れると CI がザルになるので、`tools/validate.test.mjs` で
「壊したデータが確実に落ちる」ことをテストし、これも CI で回す。

## 技術スタック

- Astro（static output。SSR アダプタは入れない）
- ajv（JSON Schema draft 2020-12）
- Cloudflare Workers の静的アセット配信（build: `npm run build` / assets: `site/dist`）
  - 設定は `wrangler.jsonc`。`main` を書かず assets のみの構成にしてある。
    **Worker スクリプトは持たない**ので、Astro は static output のままでよい
  - Cloudflare は静的サイトの受け皿を Pages から Workers Static Assets に寄せている。
    当初は Pages を想定していたが、実際の接続が Workers だったため合わせた
- Node 24

Node のバージョンの真実は `.node-version` 1 箇所に集約する。CI は `setup-node` の
`node-version-file` でここを読み、Cloudflare のビルドも同じファイルを読む。
**Cloudflare 側のデフォルトは Node 22 系なので、このファイルを消すと本番だけ 22 で焼かれる。**

## 実行環境

### 開発

WSL2 (Ubuntu) または macOS。どちらでも動くこと。

- **リポジトリは WSL のファイルシステムに置く**（`~/repos/pw-elni` 等）。
  `/mnt/c/...` は 9p 越しになり Astro のビルドと file watching が著しく遅い。
- **改行は LF で固定。** JSON の差分を PR でレビューする設計なので、CRLF が混ざると
  全行差分になりレビューが機能しなくなる。リポジトリ作成時に `.gitattributes` を置く:

  ```
  * text=auto eol=lf
  *.json text eol=lf
  *.md   text eol=lf
  ```

  `core.autocrlf` は WSL 側で `false`。Windows 側の Git とリポジトリを共有しない。

### 日次バッチ（Phase C 以降）

**最終的な実行場所は GitHub Actions の scheduled workflow。**
出力が PR 作成であること、実行ログが残ること、API キーを Secrets に一本化できることが理由。
リポジトリを public にすれば Actions の実行時間は無制限。

ただし **Phase C の開発中はローカル（WSL2）で手回しする。** GH Actions 上で試行錯誤すると
1 回の確認に数分かかる。安定してから cron に移す。

この前提のため、**スクリプトは実行環境に依存しないこと**:
- 設定・秘匿値はすべて環境変数から読む。ローカルは `.env`、CI は Secrets
- パスは絶対パス決め打ちにせずリポジトリルートからの相対で解決
- 通知（ntfy 等）は失敗してもバッチ本体を落とさない

GH Actions の cron は負荷により数分〜十数分遅れることがある。時刻厳守が必要になった場合のみ
Cloudflare Workers の Cron Triggers を検討する。

## ドメイン / サブドメイン

`elni.net` はレジストラは外部だが、ネームサーバは Cloudflare に向いておりプロキシ有効。
カスタムドメイン（Workers の Custom Domain）の追加は DNS 側の手作業なしで通る。

| ホスト | 用途 | 時期 |
|---|---|---|
| `pw.elni.net` | 本体（本番） | Phase B |
| `pw-img.elni.net` | 画像（R2） | Phase D 以降 |
| `pw-api.elni.net` | JSON API（Workers） | 将来 |

**1 階層でフラットに揃えること。** Cloudflare のユニバーサル SSL は `*.elni.net` までしかカバーせず、
`api.pw.elni.net` のような 2 階層下は Advanced Certificate が別途必要になる。

### ステージング

Phase B〜C は独立サブドメインを作らない。Workers Builds が PR ごとに作る
プレビュー URL に Cloudflare Access をかけて代用する。

カスタムドメインのステージング（`pw-stg.elni.net`）は **Phase D で自動マージを回し始める
タイミングで用意する**。その際は `staging` ブランチに紐付けた 2 つ目の Worker を作る。

> **未確認**: この節は Pages 前提で書かれていたものを Workers 向けに書き直した。
> プレビュー URL の形式と Access の掛け方は Phase D 着手時に実機で確認すること。

### 初期構築時の確認事項

- **CAA レコード**: 既存の CAA が 1 件でもある場合、`pki.goog` と `letsencrypt.org` が
  許可されているか確認する。残骸があるとユニバーサル SSL の発行が黙って失敗する。
  CAA が存在しなければ何もしなくてよい。
- **ワイルドカード**: `*.elni.net` の A/CNAME がある場合、後から追加するサブドメインが
  そちらに吸われていないか、追加後に `dig` で確認する。

## 作業スタイル

- 実装前に方針を短く提示して確認を取る。長い前置きは不要。
- スキーマ変更は必ず既存データのマイグレーションとセットで提案する。
- 「とりあえず動く」より「壊れたら止まる」を優先。
