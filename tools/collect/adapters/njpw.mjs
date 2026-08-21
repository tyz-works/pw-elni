// 新日本アダプタ。結果ページに構造化された対戦カードは無く、記事本文だけが
// 載る（構造化された試合詳細は有料会員向け）。
//
// そこで役割を分ける。日時・会場・観衆・開場開始時刻はヘッダに構造化されて
// いるので決定論的に取り、試合の記述だけを取りこぼしとして返して LLM に回す。
// LLM に渡す量を減らすほど、誤りも費用も減る。

export const PROMOTION = 'njpw';

const BASE = 'https://www.njpw.co.jp';

const RESULT_ID_RE = /\/tournament\/result\/(\d+)/;

// 記事本文の段落。ナビやフッタの短い行と区別する。
const PROSE_MIN_LENGTH = 30;

// 試合の記述ではない行。LLM に渡さない。
const NOT_PROSE = [
  /プレミアム入会/,
  /Copyright/,
  /無断で使用/,
  /cannot be used without permission/,
];

/** @returns {Promise<Target[]>} */
export async function listTargets(fetcher) {
  const links = await fetcher.fetchLinks(`${BASE}/result`);
  const ids = links.flatMap((href) => RESULT_ID_RE.exec(href)?.[1] ?? []);
  return [...new Set(ids)].map((id) => ({
    id, url: `${BASE}/tournament/result/${id}`, kind: 'result',
  }));
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

  const date = parseDate(lines);
  const { doorsOpen, bellTime } = parseTimes(lines);
  const prose = parseProse(lines);

  const event = {
    eventId: date ? `njpw-${date.replaceAll('-', '')}-0` : null,
    promotionSlug: PROMOTION,
    name: parseName(lines),
    series: null,
    date,
    doorsOpen,
    bellTime,
    venueName: afterLabel(lines, '会場'),
    venueSlug: null,   // 会場名 -> slug の解決は resolve 段の仕事
    attendance: parseAttendance(lines),
    confirmed: true,
    officialUrl: target.url,
    sources: [],       // run.mjs が retrievedAt 付きで足す
    matches: [],       // 記事本文からの組み立ては LLM の仕事
  };
  return { event, unparsed: prose ? [prose] : [] };
}

const afterLabel = (lines, label) => {
  const i = lines.indexOf(label);
  return i === -1 ? null : (lines.slice(i + 1, i + 4).find(Boolean) ?? null);
};

// 「2026年08月16日 (日) 13:30開場15:00開始」
function parseDate(lines) {
  for (const l of lines) {
    const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(l);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return null;
}

function parseTimes(lines) {
  const l = afterLabel(lines, '日時') ?? '';
  const doors = /(\d{1,2}):(\d{2})開場/.exec(l);
  const bell = /(\d{1,2}):(\d{2})開始/.exec(l);
  const fmt = (m) => (m ? `${m[1].padStart(2, '0')}:${m[2]}` : null);
  return { doorsOpen: fmt(doors), bellTime: fmt(bell) };
}

function parseName(lines) {
  const i = lines.findIndex((l) => l === '日時');
  for (let j = i - 1; j >= 0 && j > i - 5; j--) if (lines[j]) return lines[j];
  return null;
}

// 「7,260人」
function parseAttendance(lines) {
  const l = afterLabel(lines, '観衆');
  const m = l && /^([\d,]+)\s*人/.exec(l);
  return m ? Number(m[1].replaceAll(',', '')) : null;
}

// 記事本文だけを集める。ナビ・フッタ・有料導線は落とす。
function parseProse(lines) {
  const start = lines.indexOf('MATCH REPORT');
  const body = start === -1 ? lines : lines.slice(start + 1);
  const prose = body.filter((l) => l.length >= PROSE_MIN_LENGTH && !NOT_PROSE.some((re) => re.test(l)));
  return prose.length ? prose.join('\n') : null;
}
