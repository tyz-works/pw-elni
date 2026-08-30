# tools/collect — 収集パイプライン

公式サイトの生テキストから興行データを取り出し、既存 JSON に追記マージして
`data/` への差分とレポートを出す。

```
fetch → snapshot → parse → resolve → merge → validate → report
```

## 使い方

```bash
npm run collect                              # 決定論的な団体すべて
npm run collect -- --promotion ddt           # 団体を絞る（カンマ区切り可）
npm run collect -- --dry-run                 # data/ に書かない
npm run collect -- --step fetch              # 取得だけ
npm run collect -- --step parse              # 取得済みスナップショットから
npm run collect -- --no-llm                  # LLM 段を使わない
npm run collect -- --acknowledge             # 出た conflict を既知として記録
```

書くのは `data/` と `.cache/report.md` の 2 つだけ。`git` は触らない。

## 団体ごとの状況

| 団体 | 取り方 |
|---|---|
| `ddt` | 決定論的パーサ |
| `stardom` | 決定論的パーサ |
| `njpw` | 公式カード（決定論的）+ 記事本文からの LLM 抽出 |

## 日次の運用

**すべて手元で回す。GitHub Actions は使わない。**

```bash
GEMINI_API_KEY=... tools/collect/daily.sh            # 収集 → 検証 → Obsidian
DRY_RUN=1 GEMINI_API_KEY=... tools/collect/daily.sh  # data/ に書かず確認だけ
```

### どのブランチの上で走るか

`daily.sh` は **収集を始める前に** `collect/auto` へ切り替える。main の上で収集すると、
まだマージされていない前回の結果を毎回「新規」として作り直してしまい、その未追跡
ファイルが `collect/auto` 側の同名ファイルとぶつかって切り替えが中断する
（そして main に直接コミットされる）。

- 開いた PR があればそのブランチに積む。無ければ main から切り直す
  （PR の無い残骸ブランチは消す）
- 積む前に `origin/main` を取り込む。ツールも `data/wrestlers/` もブランチ側の
  ものが使われるので、取り込まないと古いコードと古い名寄せ表で収集することになる
- main 以外に居る / 作業ツリーが汚れているときは PR を作らず、差分を手元に残す

**PR がマージされないまま放置されても収集は止まらない。** そこが以前の壊れ方だった。

### なぜ CI ではなく手元なのか

1. **新日本は GitHub Actions の IP からは一覧ページのリンクが 1 件も取れない**
   （手元では 27 件取れる）。CI に置くと毎朝 0 件で失敗するだけになる
2. 新日本の結果ページは記事本文を含み、**スナップショットはリポジトリに入れられない**
   （転載になる）。`.cache/` に置いたまま手元で処理し、リポジトリに入れるのは
   スキーマ準拠の成果物だけにする
3. **Obsidian の Vault には CI から書けない**

抽出結果は `.cache/snapshots/njpw/<id>.llm.json` に残るので、同じ記事に二度課金しない。

## conflict の記録

既存の人手データと公式の表記が永久に食い違うものがある（`notes` など）。毎回レポートに
出ると本当に見るべきものを見落とすので、`--acknowledge` で
`acknowledged-conflicts.json` に記録して黙らせる。

鍵に既存側と抽出側の値を両方入れているので、**どちらかが変われば再び表に出る**。
黙らせた件数はレポートに必ず出る。

## 設計上の約束

- LLM に HTML を渡さない。渡すのは本文テキストだけ
- **LLM に slug を作らせない。**返させるのは表示名の文字列だけで、ID の確定は alias 解決の仕事
- 出力の正しさを LLM に確認させない。スキーマと検証器で機械的に落とす
- 解決できない名前がある興行は書かない。勝手に新規エンティティを作らない
- 既存値は上書きしない。食い違いは conflict として報告する
- 1 団体・1 興行が落ちても他は止めない

## 自動実行の登録

このマシンは WSL で systemd が有効、`cron.service` も稼働している。crontab に足すだけでよい。

```
30 8 * * * GEMINI_API_KEY="$(cat $HOME/.gemini-key)" bash $HOME/workspace/pw-elni/tools/collect/daily.sh >> /tmp/pw-elni-daily.log 2>&1
```

**8:30 にしている理由**: 8:00 は別プロジェクトの cron と重なる。両方が Playwright と
Node を同時に起動するとメモリを食う（このマシンは 6GB）。

**cron の PATH は `/usr/bin:/bin` しかなく、nvm 配下の node が見つからない。**
`daily.sh` の側で nvm を読むようにしてあるので、crontab に PATH を書く必要はない。

鍵はファイルから読む。`crontab -e` に直接書かないこと。

動作確認は cron と同じ最小環境で試すのが確実:

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin DRY_RUN=1 \
  sh -c 'bash $HOME/workspace/pw-elni/tools/collect/daily.sh'
```

## Obsidian への書き出し

```bash
npm run obsidian                              # 既定は ~/obsidian/ProWrestling
OBSIDIAN_VAULT=/path/to/vault npm run obsidian  # 差し替え
```

Vault には手作りのノートがある。**生成分はマーカーで囲み、その外側には触れない。**
既存の選手ノートは正規化した名前で突き合わせ、無いものだけ新規作成する。
