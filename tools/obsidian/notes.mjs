// data/ から Obsidian のノートを組み立てる純関数。
//
// Vault には手作りのノートが 200 件以上ある。**それを壊さないことが最優先。**
// 生成した内容はマーカーで囲み、その外側には一切触れない。ユーザーが書いた
// メモも frontmatter も、こちらの再実行で消えないようにする。
export const START = '<!-- pw-elni:start -->';
export const END = '<!-- pw-elni:end -->';

/**
 * 既存のノートに生成物を差し込む。マーカーの外側は 1 文字も変えない。
 * @param {string} existing 既存のノート（無ければ空文字）
 * @param {string} generated マーカーの中に入れる内容
 * @returns {string}
 */
export function mergeGenerated(existing, generated) {
  const block = `${START}\n${generated.trim()}\n${END}`;
  const text = existing ?? '';

  const s = text.indexOf(START);
  if (s === -1) {
    // マーカーが無い＝初回。手書きの後ろに足す。
    const head = text.trim();
    return head ? `${head}\n\n${block}\n` : `${block}\n`;
  }

  const e = text.indexOf(END, s);
  // 終わりのマーカーが無い（手で壊した等）ときは、開始位置から後ろを作り直す。
  const tail = e === -1 ? '' : text.slice(e + END.length);
  return `${text.slice(0, s)}${block}${tail}`;
}

/** ファイル名に使えない文字を避ける。 */
export const safeFileName = (name) => name.replace(/[\\/:*?"<>|]/g, '-').trim();

const yamlString = (v) => JSON.stringify(String(v));

/** frontmatter を組み立てる。値が null のキーは書かない（推測で埋めない）。 */
export function frontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}:`);
      for (const v of value) lines.push(`  - ${yamlString(v)}`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// 団体 slug -> Vault のノート名。Vault 側は略称でファイルを作ってある。
const PROMOTION_NOTE = { njpw: 'NJPW', ddt: 'DDT', stardom: 'STARDOM' };

const DECISION_JA = {
  pinfall: 'フォール', submission: 'ギブアップ', knockout: 'KO',
  countout: 'リングアウト', disqualification: '反則', 'over-the-top-rope': '場外転落',
  draw: '引き分け', 'time-limit-draw': '時間切れ引き分け', 'no-contest': '無効試合',
  unknown: '不明',
};

const MATCH_TYPE_JA = {
  singles: 'シングル', tag: 'タッグ', 'six-man-tag': '6人タッグ',
  'eight-man-tag': '8人タッグ', 'multi-man': '多人数', 'battle-royal': 'バトルロイヤル',
  gauntlet: 'ガントレット', other: 'その他',
};

const link = (name) => `[[${safeFileName(name)}]]`;

function duration(sec) {
  if (sec === null || sec === undefined) return null;
  return `${Math.floor(sec / 60)}分${sec % 60}秒`;
}

function sideText(side, wrestlerNames) {
  const names = side.wrestlerIds.map((id) => link(wrestlerNames[id] ?? id));
  const team = side.teamName ? `${side.teamName}（${names.join(' & ')}）` : names.join(' & ');
  return team;
}

/** 興行ノートの本文。 */
export function renderEvent(event, { wrestlerNames = {}, venueNames = {} } = {}) {
  const out = [];
  const promo = PROMOTION_NOTE[event.promotionSlug] ?? event.promotionSlug;

  out.push(`## ${event.name}`, '');
  out.push(`- 日付: ${event.date}`);
  out.push(`- 団体: ${link(promo)}`);
  if (event.venueSlug) out.push(`- 会場: ${link(venueNames[event.venueSlug] ?? event.venueSlug)}`);
  if (event.attendance) out.push(`- 観衆: ${event.attendance.toLocaleString('ja-JP')}人`);
  if (event.officialUrl) out.push(`- 公式: ${event.officialUrl}`);
  out.push('');

  out.push('## 対戦カード', '');
  for (const m of event.matches) {
    const head = [`第${m.order}試合`];
    if (m.titleName) head.push(`${m.titleName}選手権試合`);
    if (m.matchType) head.push(MATCH_TYPE_JA[m.matchType] ?? m.matchType);
    if (m.timeLimitMinutes) head.push(`${m.timeLimitMinutes}分1本勝負`);
    out.push(`### ${head.join(' / ')}`);

    out.push(m.sides.map((s) => sideText(s, wrestlerNames)).join(' vs '));

    if (m.result) {
      const bits = [];
      const w = m.result.winnerSideIndex;
      if (w !== null && m.sides[w]) bits.push(`勝者: ${sideText(m.sides[w], wrestlerNames)}`);
      bits.push(`決着: ${DECISION_JA[m.result.decision] ?? m.result.decision}`);
      const d = duration(m.result.durationSeconds);
      if (d) bits.push(`時間: ${d}`);
      out.push('', bits.join(' / '));
    }
    if (m.notes) out.push('', `> ${m.notes}`);
    out.push('');
  }

  out.push('---', '', '非公式ファンサイト [pw.elni.net](https://pw.elni.net) のデータから生成。');
  return out.join('\n');
}

/** 選手ノートの生成部分。出場した興行を並べる。 */
export function renderWrestlerBody(slug, events, { wrestlerNames = {} } = {}) {
  const rows = [];
  for (const e of events) {
    for (const m of e.matches) {
      if (!m.sides.some((s) => s.wrestlerIds.includes(slug))) continue;
      const opponents = m.sides
        .filter((s) => !s.wrestlerIds.includes(slug))
        .map((s) => sideText(s, wrestlerNames))
        .join(' / ');
      const won = m.result?.winnerSideIndex !== null
        && m.result?.winnerSideIndex !== undefined
        && m.sides[m.result.winnerSideIndex]?.wrestlerIds.includes(slug);
      rows.push(`| ${e.date} | [[${e.eventId}]] | 第${m.order}試合 | ${opponents} | ${m.result ? (won ? '○' : '●') : '-'} |`);
    }
  }
  if (!rows.length) return '## 出場興行\n\n記録なし。';
  rows.sort().reverse();
  return ['## 出場興行', '', '| 日付 | 興行 | 試合 | 相手 | 勝敗 |', '|---|---|---|---|---|', ...rows].join('\n');
}

/** 会場ノートの生成部分。 */
export function renderVenueBody(slug, events) {
  const rows = events
    .filter((e) => e.venueSlug === slug)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => `- ${e.date} [[${e.eventId}]] ${e.name}`);
  if (!rows.length) return '## 開催興行\n\n記録なし。';
  return ['## 開催興行', '', ...rows].join('\n');
}

/** 技ノートの生成部分。 */
export function renderMoveBody(slug, wrestlers) {
  const users = wrestlers.filter((w) => w.finishingMoveSlugs.includes(slug));
  if (!users.length) return '## 使用選手\n\n記録なし。';
  return ['## 使用選手（フィニッシュ）', '', ...users.map((w) => `- ${link(w.name)}`)].join('\n');
}
