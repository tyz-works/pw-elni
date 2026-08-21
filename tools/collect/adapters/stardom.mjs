// スターダムアダプタ。結果ページは DDT と同じく 1 枚に全試合が並ぶが、
// 見出しが「第N試合」形式とは限らず、試合の終わりに必ず
// 「試合レポートを見る」が入る。ブロックの切り方はこちらを使う。
import { decisionFrom } from '../core/decision.mjs';

export const PROMOTION = 'stardom';

const BASE = 'https://wwr-stardom.com';

// 試合の終わりを示す行。これでブロックを切る。
const MATCH_END = '試合レポートを見る';

// 選手名ではない行。
// 【王者】【BLUE STARS-A 2位】のような角括弧のラベルと、
// 「決勝トーナメント1回戦①の勝者」のような枠の説明を落とす。
const LABEL = /^(WIN|LOSE|DRAW|VS|【.*】|.*の勝者|※.*)$/;

const DURATION_RE = /^(\d+)分(\d+)秒$/;
const EVENT_ID_RE = /\/event\/([^/]+)\/?$/;

/** @returns {Promise<Target[]>} */
export async function listTargets(fetcher) {
  const links = await fetcher.fetchLinks(`${BASE}/results/`);
  const ids = links.flatMap((href) => EVENT_ID_RE.exec(href)?.[1] ?? []);
  return [...new Set(ids)].map((id) => ({ id, url: `${BASE}/event/${id}/`, kind: 'result' }));
}

/** @returns {Promise<string>} */
export function fetchRaw(fetcher, target) {
  return fetcher.fetchText(target.url);
}

/**
 * @param {string} raw スナップショットの生テキスト
 * @param {Target} target
 * @returns {{ event: RawEvent, unparsed: string[] }}
 */
export function parse(raw, target) {
  const lines = raw.split('\n').map((s) => s.trim());
  const unparsed = [];

  const date = parseDate(lines);

  const matches = [];
  for (const block of splitMatches(lines)) {
    const parsed = parseMatch(block, matches.length + 1);
    if (parsed) matches.push(parsed);
    else unparsed.push(block.join('\n'));
  }

  const event = {
    eventId: date ? `stardom-${date.replaceAll('-', '')}-0` : null,
    promotionSlug: PROMOTION,
    name: parseName(lines),
    series: null,
    date,
    doorsOpen: null,   // 結果ページには無い。スケジュール側で埋める
    bellTime: null,
    venueName: parseVenue(lines),
    venueSlug: null,   // 会場名 -> slug の解決は resolve 段の仕事
    attendance: parseAttendance(lines),
    confirmed: true,
    officialUrl: target.url,
    sources: [],       // run.mjs が retrievedAt 付きで足す
    matches,
  };
  return { event, unparsed };
}

// 公式は「2026年8月18日（火）」と曜日つきで書く。
function parseDate(lines) {
  for (const l of lines) {
    const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(l);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return null;
}

const afterLabel = (lines, label) => {
  const i = lines.indexOf(label);
  return i === -1 ? null : (lines.slice(i + 1, i + 4).find(Boolean) ?? null);
};

const parseVenue = (lines) => afterLabel(lines, '会場');

function parseName(lines) {
  const i = lines.findIndex((l) => l === '日時');
  for (let j = i - 1; j >= 0 && j > i - 5; j--) if (lines[j]) return lines[j];
  return null;
}

// 「1610人　超満員札止め」のように注記が付く。数字だけを採る。
function parseAttendance(lines) {
  const l = afterLabel(lines, '観衆');
  const m = l && /^([\d,]+)\s*人/.exec(l);
  return m ? Number(m[1].replaceAll(',', '')) : null;
}

// 「試合レポートを見る」で切る。最初のブロックはヘッダを含むので、
// 「チケット詳細はこちら」より後だけを対象にする。
function splitMatches(lines) {
  const start = lines.findIndex((l) => l === 'チケット詳細はこちら');
  const body = lines.slice(start === -1 ? 0 : start + 1);
  const blocks = [];
  let cur = [];
  for (const l of body) {
    if (l === MATCH_END) {
      if (cur.some(Boolean)) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(l);
  }
  return blocks;
}

function parseMatch(block, order) {
  const durIdx = block.findIndex((l) => DURATION_RE.test(l));
  if (durIdx === -1) return null;
  const dm = DURATION_RE.exec(block[durIdx]);
  const durationSeconds = Number(dm[1]) * 60 + Number(dm[2]);

  // ブロックの先頭は試合名。選手名ではない。
  const heading = block.find(Boolean) ?? '';
  const titleName = /選手権試合/.test(heading)
    ? heading.replace(/選手権試合.*$/, '').trim() || null
    : null;

  // 決まり手は「選手名：技名」の形。技名だけを採る。
  const finishLine = block.slice(durIdx + 1).find(Boolean) ?? '';
  const finishText = finishLine.includes('：')
    ? finishLine.slice(finishLine.indexOf('：') + 1).trim()
    : (finishLine || null);

  const headingIdx = block.findIndex(Boolean);
  const { sides, winnerSideIndex } = parseSides(block.slice(headingIdx + 1, durIdx));
  if (sides.length < 1) return null;

  return {
    order,
    matchType: null, // sides の人数から run.mjs 側で決める
    sides,
    titleName,
    timeLimitMinutes: null, // 結果ページには載らない
    result: { winnerSideIndex, decision: decisionFrom(finishText), finishText, durationSeconds },
    notes: null,
  };
}

// WIN/LOSE は名前の後ろに出る。VS で陣営を切り替える。
function parseSides(lines) {
  const sides = [{ names: [], teamName: null }];
  const outcome = [null];
  let cur = 0;

  for (const l of lines) {
    if (!l) continue;
    if (l === 'VS') {
      sides.push({ names: [], teamName: null });
      outcome.push(null);
      cur = sides.length - 1;
      continue;
    }
    if (l === 'WIN' || l === 'LOSE' || l === 'DRAW') {
      outcome[cur] ??= l;
      continue;
    }
    if (LABEL.test(l)) continue;
    sides[cur].names.push(l);
  }

  const winnerSideIndex = outcome.indexOf('WIN');
  return {
    sides: sides.filter((s) => s.names.length > 0),
    winnerSideIndex: winnerSideIndex === -1 ? null : winnerSideIndex,
  };
}
