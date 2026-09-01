// 新日本アダプタ。結果ページに構造化された対戦カードは無く、記事本文だけが
// 載る（構造化された試合詳細は有料会員向け）。
//
// そこで役割を分ける。日時・会場・観衆・開場開始時刻はヘッダに構造化されて
// いるので決定論的に取り、試合の記述だけを取りこぼしとして返して LLM に回す。
// LLM に渡す量を減らすほど、誤りも費用も減る。

export const PROMOTION = 'njpw';

const BASE = 'https://www.njpw.co.jp';

const RESULT_ID_RE = /\/tournament\/result\/(\d+)/;

// 今後の興行。/schedule は 1 ページに複数の興行が並ぶので、このパイプラインの
// 「1 スナップショット = 1 興行」には乗らない。そこから貼られている対戦カードの
// ページが興行ごとに 1 枚あり、日時・会場・開場/開始を同じ書式で持っている。
const CARD_ID_RE = /\/tournament\/card\/(\d+)/;

// 記事本文の段落。ナビやフッタの短い行と区別する。
const PROSE_MIN_LENGTH = 30;

// カードの見出し。「第1試合 20分1本勝負」
const CARD_HEAD = /^第(\d+)試合\s*(?:(\d+)分)?/;

// カードの各項目の終わり。
const CARD_END = '試合詳細を見る';

// 「12分45秒 サンプルロック」
const CARD_TIME = /^(\d+)分(\d+)秒\s*(.*)$/;

// 星取「（1勝0敗＝2点）」。選手名ではない。
// 閉じ括弧の後ろにアイコン由来の文字が付くことがある（「（3勝6敗＝6点）i」）。
// 行末で縛らず、括弧で始まることで判定する。
const CARD_RECORD = /^[（(][^）)]*[）)]/;

// 「<チャンピオン>」のようなラベル。選手名ではない。
const CARD_LABEL = /^[<＜].*[>＞]$/;

// 試合の副題。『G1 CLIMAX 36』Bブロック公式戦 / 2vs1 変則マッチ /
// 真壁刀義相模原凱旋試合 のように、必ず「マッチ」「試合」「戦」で終わるか
// 『』で囲まれる。選手名がこの形になることは無い。
// 取りこぼしても、LLM の出力とカードの突き合わせで検出できる（そこで
// 「カードに無い選手名」として弾かれ、レポートに出る）。
// 「タイガーマスク引退試合Ⅱ」のように通し番号が付くことがある。
const CARD_SUBTITLE = /^『.*』|(?:マッチ|試合|戦)[ⅠⅡⅢⅣⅤⅥ0-9０-９]*$/;

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
  const results = [...new Set(ids)].map((id) => ({
    id, url: `${BASE}/tournament/result/${id}`, kind: 'result',
  }));

  const schedLinks = await fetcher.fetchLinks(`${BASE}/schedule`);
  const cardIds = [...new Set(schedLinks.flatMap((href) => CARD_ID_RE.exec(href)?.[1] ?? []))];
  // 結果とカードの id はどちらも数字で、同じ番号がありうる。スナップショットの
  // ファイル名がぶつからないよう接頭辞を付ける。
  const schedules = cardIds.map((id) => ({
    id: `card-${id}`, url: `${BASE}/tournament/card/${id}`, kind: 'schedule',
  }));

  return [...results, ...schedules];
}

// 陣営は innerText には出ない。名前が縦に並ぶだけで、どちらのチームかが
// 落ちてしまう（結果ページのカードも同じ）。DOM では 2 カラムに分かれて
// いるので、そこだけ構造を読み出して本文の後ろに決定論的な書式で足す。
// スナップショットから先はこれまでどおりテキストの解析で完結する。
const CARD_SECTION = '=== pw-elni: 対戦カード（DOM から） ===';

// ページの中で動く。外側の変数は参照できない。HTML は返さない。
const EXTRACT_CARD = () => {
  const links = (el) => [...el.querySelectorAll('a[href^="/profile/"]')];

  // 試合ブロック: テキストが「第N試合」で始まり選手リンクを含む、最も内側の要素。
  let blocks = [...document.querySelectorAll('*')].filter(
    (el) => /^第\d+試合/.test(el.textContent.trim()) && links(el).length > 0);
  blocks = blocks.filter((b) => !blocks.some((o) => o !== b && b.contains(o)));

  return blocks.map((block) => {
    const total = links(block).length;
    // 陣営の分割点: 選手リンクを持つ子が 2 つ以上あり、それでブロック内の
    // 全リンクを尽くす最も外側の要素。グリッドには空の子要素も混じるので、
    // 子の総数では判定しない。クラス名にも依存しない（作り直しで変わる）。
    let sides = null;
    for (const el of block.querySelectorAll('*')) {
      const withLinks = [...el.children].filter((k) => links(k).length > 0);
      if (withLinks.length < 2) continue;
      if (withLinks.reduce((n, k) => n + links(k).length, 0) !== total) continue;
      sides = withLinks.map((k) => links(k).map((a) => a.textContent.trim()));
      break;
    }
    const lines = block.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
    return { head: lines[0] ?? '', sides, text: lines.slice(1).join('\n') };
  });
};

// 陣営に割れなかったブロックも節に残す。黙って消すと、発表済みの試合が
// 消えたことに気付けない（選手ページのリンクが無い若手が含まれる回がある）。
// 割れたものだけが VS を持つので、解析側はそれで見分けられる。
function renderCardSection(matches) {
  return (matches ?? [])
    .map((m) => (m.sides && m.sides.length >= 2
      ? [m.head, m.sides.map((s) => s.join('\n')).join('\nVS\n')].join('\n')
      : [m.head, m.text].filter(Boolean).join('\n')))
    .join('\n\n');
}

/** @returns {Promise<string>} */
export async function fetchRaw(fetcher, target) {
  if (target.kind !== 'schedule') return fetcher.fetchText(target.url);
  const { text, data } = await fetcher.fetchWithDom(target.url, EXTRACT_CARD);
  return `${text}\n\n${CARD_SECTION}\n${renderCardSection(data)}\n`;
}

/**
 * @param {string} raw スナップショットの生テキスト
 * @param {Target} target
 * @returns {{ event: RawEvent, unparsed: string[] }}
 */
export function parse(raw, target) {
  const parsed = parseResult(raw, target);
  if (target.kind !== 'schedule') return parsed;

  // 開催前。日時・会場・シリーズ名は結果ページと同じ書式で載る。
  // カードは fetchRaw が足した構造の節から読む。節が無い＝DOM の読み出しに
  // 失敗した回なので、推測で陣営を作らず試合ゼロで書く。
  // cardMatches は渡さない。LLM の検算材料は記事本文とセットで意味を持つが、
  // 開催前には記事が無い。
  const { matches, unparsed } = parseAnnouncedCard(raw);
  return {
    event: { ...parsed.event, matches, cardMatches: [], attendance: null },
    unparsed,
  };
}

// 見出し「第1試合 15分1本勝負」。制限時間は無いこともある（時間無制限）。
const ANNOUNCED_HEAD_RE = /^第(\d+)試合\s*(?:(\d+)分)?/;
const ANNOUNCED_VS = 'VS';
const MATCH_TYPE_BY_SIZE = { 1: 'singles', 2: 'tag', 3: 'six-man-tag', 4: 'eight-man-tag' };

function parseAnnouncedCard(raw) {
  const at = raw.indexOf(CARD_SECTION);
  if (at === -1) return { matches: [], unparsed: [] };

  const body = raw.slice(at + CARD_SECTION.length).split('\n').map((l) => l.trim());
  const matches = [];
  const unparsed = [];
  let head = null;
  let sides = [];

  // 「第0試合」は前座。スキーマの order は 1 以上なので、番号の外の試合として
  // dark に振る（DDT のダークマッチと同じ扱い）。本戦の番号は公式のまま使う。
  let darkOrder = 0;

  const flush = () => {
    if (!head) return;
    const named = sides.filter((s) => s.length);
    // 陣営に割れたものだけが VS を持つ。割れなかったブロックは黙って
    // 捨てず取りこぼしに上げる（選手ページのリンクが無い選手がいる回）。
    if (named.length >= 2) {
      const num = Number(head[1]);
      const segment = num === 0 ? 'dark' : 'card';
      const order = num === 0 ? (darkOrder += 1) : num;
      matches.push(buildAnnouncedMatch(head, named, segment, order));
    }
    else unparsed.push([head.input, ...named.flat()].join('\n'));
    head = null;
    sides = [];
  };

  for (const l of body) {
    const m = ANNOUNCED_HEAD_RE.exec(l);
    if (m) { flush(); head = m; sides = [[]]; continue; }
    if (!head || !l) continue;
    if (l === ANNOUNCED_VS) { sides.push([]); continue; }
    sides[sides.length - 1].push(l);
  }
  flush();
  return { matches, unparsed };
}

function buildAnnouncedMatch(head, sides, segment, order) {
  const size = sides[0].length;
  const matchType = sides.length > 2
    ? 'multi-man'
    : (MATCH_TYPE_BY_SIZE[size] ?? 'multi-man');

  return {
    order,
    segment,
    matchType: sides.some((s) => s.length !== size) ? 'multi-man' : matchType,
    sides: sides.map((names) => ({ names, teamName: null })),
    titleName: null,        // 見出しには載らない。結果で置き換わるときに入る
    timeLimitMinutes: head[2] ? Number(head[2]) : null,
    result: null,           // 試合前
    confirmed: true,        // カードは公式発表済み
    notes: null,
  };
}

function parseResult(raw, target) {
  const lines = raw.split('\n').map((s) => s.trim());

  const date = parseDate(lines);
  const { doorsOpen, bellTime } = parseTimes(lines);
  const prose = parseProse(lines);
  const cardMatches = parseCard(lines);
  const cardText = renderCard(lines);

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
    matches: [],       // 陣営分けと勝敗は LLM の仕事。run.mjs が組み立てる
    cardMatches,       // カードから決定論的に取れた分。run.mjs が検算に使う
  };

  // LLM にはカードと記事本文の両方を渡す。カードで正確な表記と試合順が
  // 分かり、本文で陣営分けと勝敗が分かる。
  const fragment = [cardText, prose].filter(Boolean).join('\n\n');
  return { event, unparsed: fragment ? [fragment] : [] };
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

// RESULT セクションを「試合詳細を見る」で切る。
function cardBlocks(lines) {
  const start = lines.indexOf('RESULT');
  if (start === -1) return [];
  const blocks = [];
  let cur = [];
  for (const l of lines.slice(start + 1)) {
    if (l === CARD_END) {
      if (cur.some(Boolean)) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(l);
  }
  return blocks;
}

// カードから決定論的に取れるもの。陣営の分かれ目と勝敗は書かれていない
// （VS も ＆ も ○● も無く、選手名が平坦に並ぶだけ）。そこは LLM に回す。
function parseCard(lines) {
  const out = [];
  const used = new Set();
  for (const block of cardBlocks(lines)) {
    const head = block.find(Boolean) ?? '';
    const hm = CARD_HEAD.exec(head);
    if (!hm) continue; // セレモニーなど試合でない項目

    const body = block.slice(block.indexOf(head) + 1).filter(Boolean);
    const timeIdx = body.findIndex((l) => CARD_TIME.test(l));
    const tm = timeIdx === -1 ? null : CARD_TIME.exec(body[timeIdx]);

    const beforeTime = body.slice(0, timeIdx === -1 ? undefined : timeIdx);
    const subtitle = beforeTime.find((l) => CARD_SUBTITLE.test(l)) ?? null;

    const names = beforeTime.filter(
      (l) => !CARD_RECORD.test(l) && !CARD_LABEL.test(l) && !CARD_SUBTITLE.test(l),
    );

    // 引き分け後の延長戦は「第7試合（延長戦）」と同じ番号で載る。どちらも
    // 本物の試合だが、order が重複すると検証器に落とされる。公式の番号を
    // 使いつつ、埋まっていたら次の空き番号にずらす。
    let order = Number(hm[1]);
    while (used.has(order)) order += 1;
    used.add(order);

    out.push({
      order,
      timeLimitMinutes: hm[2] ? Number(hm[2]) : null,
      subtitle,
      names,
      durationSeconds: tm ? Number(tm[1]) * 60 + Number(tm[2]) : null,
      finishText: tm ? (tm[3] || null) : null,
    });
  }
  return out;
}

// LLM に渡すためにカードを平文へ戻す。切り出したブロックから組み直すので、
// 最後の「試合詳細を見る」より後（フッタなど）は入らない。
function renderCard(lines) {
  const blocks = cardBlocks(lines).map((b) => b.filter(Boolean).join('\n'));
  return blocks.length ? blocks.join('\n\n') : null;
}

// 記事本文だけを集める。ナビ・フッタ・有料導線は落とす。
function parseProse(lines) {
  const start = lines.indexOf('MATCH REPORT');
  const body = start === -1 ? lines : lines.slice(start + 1);
  const prose = body.filter((l) => l.length >= PROSE_MIN_LENGTH && !NOT_PROSE.some((re) => re.test(l)));
  return prose.length ? prose.join('\n') : null;
}
