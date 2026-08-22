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

| 団体 | 取り方 | 日次 CI |
|---|---|---|
| `ddt` | 決定論的パーサ | ✅ 自動収集・自動マージ |
| `stardom` | 決定論的パーサ | ✅ 自動収集・自動マージ |
| `njpw` | 記事本文 → LLM 抽出 | ❌ **手元で回す** |

### 新日本を手元で回す理由

2 つある。

1. **GitHub Actions の IP からは一覧ページのリンクが 1 件も取れない**（手元では 27 件
   取れる）。CI に置くと毎朝 0 件で失敗するだけになる
2. 結果ページは記事本文しか無く、LLM で組み立てる。**スナップショット（記事原文）は
   リポジトリに入れられない**（転載になる）ので、`.cache/` に置いたまま手元で処理し、
   リポジトリに入れるのはスキーマ準拠の成果物だけにする

```bash
# 鍵は環境変数から読む。リポジトリにもシェル履歴にも残さないこと
GEMINI_API_KEY="$(op read 'op://Private/Gemini/credential')" \
  npm run collect -- --promotion njpw --dry-run

# 結果を確認してから反映する
GEMINI_API_KEY=... npm run collect -- --promotion njpw
```

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
