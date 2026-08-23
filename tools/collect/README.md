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

WSL の cron は WSL が起きていないと動かない。**Windows のタスクスケジューラから
WSL を叩く**のが確実。

1. タスクスケジューラで「基本タスクの作成」
2. トリガー: 毎日 8:00
3. 操作: プログラムの開始
   - プログラム: `wsl.exe`
   - 引数: `-d Ubuntu -- bash -lc 'cd ~/workspace/pw-elni && GEMINI_API_KEY="$(cat ~/.gemini-key)" tools/collect/daily.sh >> /tmp/pw-elni-daily.log 2>&1'`
4. 「最上位の特権で実行する」は不要
5. 「タスクを実行するためにスリープを解除する」を有効にしておくと取りこぼしが減る

WSL 側で完結させたい場合は cron でもよい（WSL が常時起きている前提）。

```
0 8 * * * cd ~/workspace/pw-elni && GEMINI_API_KEY="$(cat ~/.gemini-key)" tools/collect/daily.sh >> /tmp/pw-elni-daily.log 2>&1
```

どちらの場合も、鍵はファイルから読む。`crontab -e` に直接書かないこと。

## Obsidian への書き出し

```bash
npm run obsidian                              # 既定は ~/obsidian/ProWrestling
OBSIDIAN_VAULT=/path/to/vault npm run obsidian  # 差し替え
```

Vault には手作りのノートがある。**生成分はマーカーで囲み、その外側には触れない。**
既存の選手ノートは正規化した名前で突き合わせ、無いものだけ新規作成する。
