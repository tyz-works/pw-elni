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

// 時間切れ引き分けは「15分」と秒なしで書かれる。秒は 0 とみなす（推測ではなく
// 制限時間ちょうどという意味）。
const DURATION_RE = /^(\d+)分(?:(\d+)秒)?$/;
const EVENT_ID_RE = /\/event\/([^/]+)\/?$/;

// 今後の興行を何か月ぶん見るか。スターダムは直前まで発表しないので、
// 増やしても取れる件数はほとんど変わらない。取得ページ数だけが増える。
const SCHEDULE_MONTHS = 3;

/** 当月から n か月ぶんの YYYYMM。基準日は listTargets から渡す（テストのため） */
function scheduleMonths(n, today) {
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 + i, 1);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

// slug は日付で始まる（20260906_korakuen）。過去の興行をここで落とさないと、
// 結果一覧の 1 ページ目から溢れた古い興行のページを毎日取りに行くことになる。
// 日付で始まらない slug は判断できないので残す（黙って落とさない）。
const SLUG_DATE_RE = /^(\d{4})(\d{2})(\d{2})_/;

function isPast(id, today) {
  const m = SLUG_DATE_RE.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}` < today : false;
}

/** @returns {Promise<Target[]>} */
export async function listTargets(fetcher, today = new Date().toISOString().slice(0, 10)) {
  const idsFrom = (links) => [...new Set(links.flatMap((href) => EVENT_ID_RE.exec(href)?.[1] ?? []))];

  const resultIds = idsFrom(await fetcher.fetchLinks(`${BASE}/results/`));
  const results = resultIds.map((id) => ({ id, url: `${BASE}/event/${id}/`, kind: 'result' }));

  // 開催前と開催後で URL が同じなので、結果一覧に出ているものは result、
  // 出ていないものが今後の興行になる。
  // /schedule/ は既定だと当月しか返さないが、?ym=YYYYMM で月を送れる。
  const seen = new Set(resultIds);
  const schedules = [];
  for (const ym of scheduleMonths(SCHEDULE_MONTHS, today)) {
    for (const id of idsFrom(await fetcher.fetchLinks(`${BASE}/schedule/?ym=${ym}`))) {
      if (seen.has(id) || isPast(id, today)) continue;
      seen.add(id);
      schedules.push({ id, url: `${BASE}/event/${id}/`, kind: 'schedule' });
    }
  }

  return [...results, ...schedules];
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
  const parsed = parseResult(raw, target);
  if (target.kind !== 'schedule') return parsed;

  // 開催前。日時・会場・大会名は同じ書式で載る。カードは第N試合の番号を
  // 持たないので、ページに載っている順に番号を振る。番号が結果ページと
  // ずれても、暫定カードは結果が入る時点で丸ごと差し替わる（merge.mjs）。
  return {
    event: { ...parsed.event, matches: parseAnnouncedCard(lines(raw)), attendance: null },
    unparsed: [],
  };
}

const lines = (raw) => raw.split('\n').map((s) => s.trim());

// 開催前の対戦カード。「チケット詳細はこちら」と「VIEW ALL」の間に並ぶ。
const CARD_START = 'チケット詳細はこちら';
const CARD_END = 'VIEW ALL';

// 陣営の区切り。
const CARD_VS = 'VS';

// 見出し。「シングルマッチ」「◯◯選手権試合」。試合名の語彙は興行ごとに
// 増えるので列挙せず、行末が試合形式の書き方であることで判定する
// （DDT の見出し判定と同じ考え方）。
const CARD_HEAD_RE = /(?:マッチ|試合)$/;

// 王座戦の見出しだけ titleName にする。
const TITLE_RE = /選手権試合$/;

// 「≪王者≫」「≪王者組≫」「挑戦者組」。実データでは挑戦者側だけ ≪≫ が
// 付いていないことがあり、括弧の有無が揺れる。選手名ではないので落とす。
// 想定外のラベルが来ても選手名として alias 解決に失敗し unresolved に出る。
const CARD_LABEL_RE = /^[≪《<＜]?(?:王者|挑戦者)組?[≫》>＞]?$/;

const MATCH_TYPE_BY_SIZE = { 1: 'singles', 2: 'tag', 3: 'six-man-tag', 4: 'eight-man-tag' };

function parseAnnouncedCard(all) {
  const from = all.indexOf(CARD_START);
  const to = all.indexOf(CARD_END);
  if (from === -1 || to === -1 || to <= from) return [];

  const body = all.slice(from + 1, to).filter(Boolean);
  const matches = [];
  let head = null;
  let block = [];

  const flush = () => {
    if (head === null) return;
    const match = buildAnnouncedMatch(head, block, matches.length + 1);
    if (match) matches.push(match);
    block = [];
  };

  for (const l of body) {
    if (CARD_HEAD_RE.test(l)) { flush(); head = l; continue; }
    block.push(l);
  }
  flush();
  return matches;
}

function buildAnnouncedMatch(head, block, order) {
  const sides = [];
  let current = [];
  for (const l of block) {
    if (l === CARD_VS) { sides.push(current); current = []; continue; }
    if (CARD_LABEL_RE.test(l)) continue;
    current.push(l);
  }
  sides.push(current);

  const named = sides.filter((s) => s.length);
  if (named.length < 2) return null;

  const size = named[0].length;
  const matchType = named.length > 2
    ? 'multi-man'
    : (MATCH_TYPE_BY_SIZE[size] ?? 'multi-man');

  return {
    order,
    segment: 'card',
    matchType,
    sides: named.map((names) => ({ names, teamName: null })),
    titleName: TITLE_RE.test(head) ? head : null,
    timeLimitMinutes: null,   // 開催前のページには載らない
    result: null,             // 試合前。スキーマ上も null
    confirmed: true,          // カードは公式発表済み
    notes: null,
  };
}

function parseResult(raw, target) {
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
  const durationSeconds = Number(dm[1]) * 60 + Number(dm[2] ?? 0);

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
