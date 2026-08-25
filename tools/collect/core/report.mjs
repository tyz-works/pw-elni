// 日次実行の結果を Markdown にする純関数。GitHub Actions が PR 本文に流し込む。
// conflict と unresolved を先頭に置く（人間が最初に見るべきものだから）。

const cell = (v) => String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderReport(result) {
  const { changed, conflicts, unresolved, unparsed = [], failures, llmFilled, droppedOrders, duplicateNames = [], silencedConflicts = 0 } = result;
  const out = ['# 収集結果', ''];

  if (failures.length) {
    out.push('## 失敗した団体', '', '| 団体 | 段 | エラー |', '|---|---|---|');
    for (const f of failures) out.push(`| ${cell(f.promotion)} | ${cell(f.step)} | ${cell(f.message)} |`);
    out.push('');
  }

  if (conflicts.length) {
    out.push('## conflict', '', '既存値と食い違ったため**上書きしていない**箇所。', '',
      '| 団体 | 興行 | パス | 既存 | 抽出 | 出典 |', '|---|---|---|---|---|---|');
    for (const c of conflicts) {
      out.push(`| ${cell(c.promotion)} | ${cell(c.eventId)} | \`${cell(c.path)}\` | ${cell(JSON.stringify(c.existing))} | ${cell(JSON.stringify(c.incoming))} | ${cell(c.sourceUrl)} |`);
    }
    out.push('');
  }

  if (unresolved.length) {
    out.push('## unresolved', '', '解決できなかった名前。**この興行は書いていない。**',
      '選手を `data/wrestlers/` に足してから再実行すると通る。', '',
      '| 団体 | 興行 | 名前 | 出典 |', '|---|---|---|---|');
    for (const u of unresolved) {
      out.push(`| ${cell(u.promotion)} | ${cell(u.eventName)} | ${cell(u.name)} | ${cell(u.sourceUrl)} |`);
    }
    out.push('');
  }

  if (unparsed.length) {
    out.push('## 取りこぼした試合', '',
      'パーサが試合として組み立てられなかった断片。**この試合は書いていない。**',
      '公式ページの構造が変わったか、見出しの書き方が新しい可能性がある。', '');
    for (const u of unparsed) {
      const head = u.text.split('\n').filter(Boolean).slice(0, 3).join(' / ');
      out.push(`- ${cell(u.promotion)} / ${cell(u.eventId)} — ${cell(head)}`);
    }
    out.push('');
  }

  if (duplicateNames.length) {
    out.push('## 同じ名前が 1 つの陣営に複数', '',
      '公式が同じリングネームを複数回並べている試合。中の人が違う（覆面・分身）',
      'のが本当なら公式どおりで正しい。こちらの取り違えなら直すこと。', '');
    for (const d of duplicateNames) {
      out.push(`- ${cell(d.promotion)} / ${cell(d.eventId)} ${cell(d.label)} — ${cell(d.names.join(', '))}`);
    }
    out.push('');
  }

  if (droppedOrders.length) {
    out.push('## 公式側から消えた試合', '', '既存データには残してある。消すかどうかは人間が判断する。', '');
    for (const d of droppedOrders) {
      out.push(`- ${cell(d.promotion)} / ${cell(d.eventId)} — ${cell(d.labels.join(' / '))}`);
    }
    out.push('');
  }

  if (llmFilled.length) {
    out.push('## LLM が埋めた箇所', '', 'パーサが取りこぼし、LLM が補った試合。レビュー時に重点的に見ること。', '');
    for (const l of llmFilled) {
      out.push(`- ${cell(l.promotion)} / ${cell(l.eventId)} 第 ${l.order} 試合（${cell(l.model)}）`);
    }
    out.push('');
  }

  // 黙らせた件数は必ず出す。何件隠したか分からないと記録機構自体が信用できない。
  if (silencedConflicts) {
    out.push(`> 既に確認済みの食い違い ${silencedConflicts} 件は省略した（\`tools/collect/acknowledged-conflicts.json\`）。`, '');
  }

  out.push('## 取り込んだ変更', '');
  if (changed.length) {
    out.push('| 団体 | 興行 | 追記したフィールド |', '|---|---|---|');
    for (const c of changed) {
      out.push(`| ${cell(c.promotion)} | ${cell(c.eventId)} ${cell(c.eventName)} | ${cell(c.fields.join(', '))} |`);
    }
  } else {
    out.push('差分はありません。');
  }
  out.push('');

  return out.join('\n');
}
