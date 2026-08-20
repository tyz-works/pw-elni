# data/

このディレクトリの JSON が single source of truth。サイトはここから決定論的に生成される。

## ⚠ 現在のデータについて

**団体ごとに実データとサンプルが混在している。取り違えないこと。**

### スターダム / 新日本プロレス: 実データ（出典あり）

- 興行・選手は公式サイト（スターダムは `wwr-stardom.com`、新日本プロレスは `njpw.co.jp`）を
  出典とする実データ。`sources[]` に URL と取得日を持つ
- スターダムの公式プロフィールは誕生日を月日までしか公表していないため `birthDate` は全員 `null`。
  本名も非公表のため `null`。新日本プロレスは生年月日を公表しているので埋めているが、本名は
  公表されていないため全員 `null`
- 公式プロフィールがデビュー日を年月までしか公表していない選手は `debutDate` を `null` にする。
  月日を推測して補完してはいけない
- 決まり手のうち英語表記が一意に定まらない固有名（黒虎脚殺・タイガーリリー等）は `moves/` に起こさない。
  `result.finishMoveSlug` は `null` にして、原文の技名を試合の `notes` に残す
- 決着の種類が公式発表から判断できない試合は `result.decision` に `"unknown"` を入れる。
  勝敗そのものは発表されているので `winnerSideIndex` は埋める
- **大会結果一覧の要約は誤っていることがある。** 勝敗と決まり手は必ず
  `card-result/{id}` の試合詳細ページ本文で裏を取る（2026-08-16 の第3試合で一覧の記述が実際の
  勝者と食い違っていた）

### DDT: サンプル（未検証）

- 団体名・会場名・選手のリングネームは実在のものを使っているが、出典を取得していない
- 興行名・日程・対戦カードは**構造を示すためのサンプル**であり、実際の興行ではない
  - すべて `confirmed: false`（UI 上は「未発表」と表示される）
- 本名・生年月日・デビュー日・身長体重・収容人数・観衆は**すべて `null`**
  - 出典が取れていないため。推測で埋めてはいけない
- `sources[]` はすべて空

実データへの差し替えは団体ごとに順次行う。

## 配置規約

| エンティティ | パス | ファイル名 |
|---|---|---|
| 団体 | `promotions/` | `{slug}.json` |
| 選手 | `wrestlers/` | `{slug}.json` |
| 会場 | `venues/` | `{slug}.json` |
| 技 | `moves/` | `{slug}.json` |
| 興行 | `events/{promotion}/{YYYY}/` | `{eventId}.json` |
| ニュース | `news/{YYYY-MM}/` | `{id}.json` |

ファイル名は必ずキー（`slug` / `eventId` / `id`）と一致させる。`validate.mjs` が機械的に確認する。

## ID / slug 規約

- slug は小文字英数とハイフンのみ（`^[a-z0-9-]+$`）
- 団体: 英字略称 — `njpw` / `stardom` / `ddt`
- 選手: ローマ字リングネーム — `kazuchika-okada`
- 会場: `{都市}-{施設}` — `tokyo-korakuen-hall`
- 技: 英語表記のローマ字 — `rainmaker`
- 興行: `{promotion}-{YYYYMMDD}-{seq}` — `njpw-20260104-0`（seq は同日複数興行の連番、0 始まり）

`eventId` の団体部分と日付部分は、中身の `promotionSlug` / `date` と一致していなければならない。

## データ品質ルール

- **本名・生年月日は公式プロフィールで公表されているもののみ。** 出典 URL 必須。
  出典がないフィールドは `null` にする。推測で埋めない。
  → `realName` / `birthDate` に値があるのに `sources[]` が空だと CI が落ちる。
- **ニュースは自前要約 + 出典リンクのみ。** 原文の表現を再利用しない。
- **写真は使わない。**
- 未確定情報には `confirmed: false` を持たせる。UI 上で「未発表」と明示される。
  対戦カード未発表の興行は `matches: []` のまま日時・会場だけで公開してよい。

## 名寄せ（aliases）

各 wrestler は `aliases[]` を持つ。表記ゆれ・改名・マスク時代・英語表記をすべて入れる。

```json
{
  "slug": "kazuchika-okada",
  "name": "オカダ・カズチカ",
  "aliases": ["岡田かずちか", "Kazuchika Okada", "オカダ カズチカ"]
}
```

Phase C 以降の抽出パイプラインは、まず alias 解決を通してから ID を確定する。
解決できない名前は新規作成せず `unresolved` として人間に上げる。**勝手に新規選手を作らない。**

## 検証

```bash
npm run validate
```

スキーマ検証に加えて、以下を機械的に検査する。1 件でも違反すれば exit 1。

- **孤立参照** — `sides[].wrestlerIds` / `venueSlug` / `promotionSlug` / `finishMoveSlug` /
  `finishingMoveSlugs` / ニュースの関連 ID が、存在しないエンティティを指していないか
- **重複** — 同一 `eventId`、同一 `slug`
- **日付整合** — `debutDate` > `birthDate`、`doorsOpen` < `bellTime`
- **必須出典** — `realName` / `birthDate` などに値があるのに `sources[]` が空でないか
- **配置規約** — ファイル名がキーと一致するか、興行が正しいディレクトリにあるか
- **eventId 整合** — ID の団体・日付部分が中身と一致するか
- **試合の整合** — `order` の重複、同一選手が両陣営に入っていないか、
  `singles` が 2 陣営 × 各 1 名か、`winnerSideIndex` が範囲内か、
  引き分けなのに勝者がいないか、`result` があるのに `confirmed: false` でないか
- **書式** — CRLF の混入、末尾改行、JSON のパース

検証器そのもののテストは `npm test`（`tools/validate.test.mjs`）。
`data/` を一時ディレクトリに複製して 1 箇所ずつ壊し、確実に落ちることを確認している。
