// DDT アダプタ。ddtpro.com は ddtpro.jp にリダイレクトするので .jp を直に使う。
// 結果ページ 1 枚に全試合の WIN/LOSE・決まり手・時間が載る。
// 開場/開始時刻だけは結果ページに無く、スケジュールページ側にある。

export const PROMOTION = 'ddt';

const BASE = 'https://www.ddtpro.jp';

// 決まり手の文字列 -> schema の decision。判断できないものは 'unknown' にする。
const DECISION = [
  [/オーバー・ザ・トップロープ/, 'over-the-top-rope'],
  [/ギブアップ|ギブ/, 'submission'],
  [/レフェリーストップ|TKO|KO/, 'knockout'],
  [/リングアウト/, 'countout'],
  [/反則/, 'disqualification'],
  [/時間切れ/, 'time-limit-draw'],
  [/両者/, 'draw'],
  [/固め|押さえ込み|丸め込み|クラッチ|フォール/, 'pinfall'],
];

// 選手名ではない行。陣営の組み立て時に落とす。
// 入場順のマーカーは全角 ＜9＞ と半角 <19> の両方が使われている。
const LABEL = /^(WIN|LOSE|DRAW|VS|＜.*＞|<\d+>|with .*|※.*)$/;

const RESULT_ID_RE = /\/results\/([0-9a-f]{24})(?:[/?#]|$)/;

// 見出しは「<試合名>　<制限時間>分一本勝負」の形。試合名の語彙は興行ごとに
// 増える（ダークマッチ・再試合・緊急決定試合…）ので列挙せず、行全体が
// 「勝負」で終わることで判定する。列挙にすると取りこぼした試合の中身が
// 手前の試合に混ざる。
const HEAD_RE = /^(.{0,24}?)[\s　]*(?:(\d+)分)?(?:時間無制限)?(?:一本|\d+本)?勝負$/;
const DURATION_RE = /^(\d+)分(\d+)秒$/;

// 公式は一部の試合時間を「19時27分」と誤記する（正しくは 19 分 27 秒）。
// 値は信用できないので採らないが、選手が並ぶ範囲の終わりを示す位置としては
// 使える。認識しないとそこで試合が切れず、次の試合の中身が混ざる。
const TIME_LINE_RE = /^(?:\d+分\d+秒|\d+時\d+分)$/;

// 選手名・ラベルはどれも短い。これより長い行が選手の並びに混じっていたら、
// それは記事本文であってブロックの切り方を間違えている。
const NARRATIVE_MIN_LENGTH = 30;

// 結果一覧に載っている分をすべて返す。マージが冪等なので取りすぎても
// 2 回目以降は差分ゼロになる。「直近 N 日」の絞り込みは spec §10 の保留事項。
/** @returns {Promise<Target[]>} */
export async function listTargets(fetcher) {
  const links = await fetcher.fetchLinks(`${BASE}/results`);
  const ids = links.flatMap((href) => RESULT_ID_RE.exec(href)?.[1] ?? []);
  return [...new Set(ids)].map((id) => ({ id, url: `${BASE}/results/${id}`, kind: 'result' }));
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
  const name = parseName(lines);
  const venueName = parseVenue(lines);

  const matches = [];
  for (const block of splitMatches(lines)) {
    // ページ冒頭の目次にも見出しだけが並ぶ。試合の中身が無いブロックは
    // 失われた試合ではないので unparsed に入れない。
    if (!looksLikeMatch(block)) continue;
    const parsed = parseMatch(block, matches.length + 1);
    if (!parsed) {
      unparsed.push(block.join('\n'));
      continue;
    }
    matches.push(parsed.match);

    // 見出しの語彙は列挙しきれない（「リング撤収デスマッチ」は「勝負」で
    // 終わらない）。取りこぼした見出しの試合は 1 つ前のブロックの末尾に
    // 残るので、黙って落とさず unparsed に上げる。
    const rest = block.slice(parsed.endIdx);
    if (looksLikeMatch(rest)) unparsed.push(rest.join('\n'));
  }

  const event = {
    eventId: date ? `ddt-${date.replaceAll('-', '')}-0` : null,
    promotionSlug: PROMOTION,
    name,
    series: null,
    date,
    doorsOpen: null,   // 結果ページには無い。スケジュール側で埋める
    bellTime: null,
    venueName,         // 表示名のまま渡す
    venueSlug: null,   // 会場名 -> slug の解決は resolve 段の仕事
    attendance: null,
    confirmed: true,
    officialUrl: target.url,
    sources: [],       // run.mjs が retrievedAt 付きで足す
    matches,
  };
  return { event, unparsed };
}

function parseDate(lines) {
  for (const l of lines) {
    const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(l);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return null;
}

// 「会場」ラベルの次の非空行。「東京・両国国技館」のような都市つき表記で返る。
function parseVenue(lines) {
  const i = lines.indexOf('会場');
  if (i === -1) return null;
  return lines.slice(i + 1, i + 4).find(Boolean) ?? null;
}

function parseName(lines) {
  const i = lines.findIndex((l) => l === '日時');
  // 「日時」の直前に興行名が 2 回続く（見出しとタイトル）。後ろ側を採る。
  for (let j = i - 1; j >= 0 && j > i - 5; j--) if (lines[j]) return lines[j];
  return null;
}

function splitMatches(lines) {
  const starts = [];
  for (const [i, l] of lines.entries()) if (HEAD_RE.test(l)) starts.push(i);
  return starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length));
}

// 試合の中身（時間か勝敗ラベル）を含むか。目次の見出しだけの行と区別する。
function looksLikeMatch(block) {
  return block.some((l) => TIME_LINE_RE.test(l) || l === 'VS' || l === 'WIN' || l === 'LOSE');
}

function parseMatch(block, order) {
  const head = block[0];
  const hm = HEAD_RE.exec(head);
  if (!hm) return null;
  const timeLimitMinutes = hm[2] ? Number(hm[2]) : null;

  // 選手名やラベルは前後を空行で挟まれる。見出しの直後に空行なしで続く行は
  // 副題（「スペシャルタッグマッチ」「〜選手権試合」）であって選手名ではない。
  // ただし副題が無く WIN が直に続く興行もあるので、ラベル行は副題にしない。
  const subtitle = block[1] && !LABEL.test(block[1]) ? block[1] : null;
  const titleName = subtitle && /選手権試合/.test(subtitle)
    ? subtitle.replace(/選手権試合.*$/, '選手権')
    : null;

  const durIdx = block.findIndex((l) => TIME_LINE_RE.test(l));
  if (durIdx === -1) return null;
  const dm = DURATION_RE.exec(block[durIdx]);
  const durationSeconds = dm ? Number(dm[1]) * 60 + Number(dm[2]) : null;

  const decisionText = block.slice(durIdx + 1).find(Boolean) ?? '';
  const decision = DECISION.find(([re]) => re.test(decisionText))?.[1] ?? 'unknown';

  const noteIdx = block.findIndex((l) => l.startsWith('※'));
  const noteLine = noteIdx === -1 ? null : block[noteIdx];
  const finishText = noteLine ? (/^※([^。]+)。/.exec(noteLine)?.[1] ?? null) : null;

  // 見出し行と副題行は陣営の組み立てに渡さない。渡すと選手名として拾われる。
  const body = block.slice(subtitle ? 2 : 1, durIdx);

  // 選手の並びに記事本文が混じるのは、見出しを取りこぼしてブロックが
  // 大きくなりすぎたとき。中身を推測で切り出さず、丸ごと取りこぼしに回す。
  if (body.some((l) => l.length > NARRATIVE_MIN_LENGTH)) return null;

  const { sides, winnerSideIndex } = parseSides(body);
  if (sides.length < 1) return null;

  return {
    match: {
      order,
      matchType: null, // sides の人数から run.mjs 側で決める
      sides,
      titleName,
      timeLimitMinutes,
      result: { winnerSideIndex, decision, finishText, durationSeconds },
      notes: noteLine ?? null,
    },
    // この試合が消費した範囲の終わり。以降に中身が残っていれば別の試合。
    endIdx: Math.max(durIdx + 1, noteIdx + 1),
  };
}

// WIN/LOSE は名前の前にも後ろにも出る。直近に出た勝敗ラベルを
// 「今の陣営」に紐づけ、VS で陣営を切り替える。
// 見出し行を含まない、選手が並ぶ範囲だけを渡すこと。
function parseSides(lines) {
  const sides = [{ names: [], teamName: null }];
  const outcome = [null];
  let cur = 0;
  let pending = null;

  for (const l of lines) {
    if (!l) continue;
    if (l === 'VS') {
      sides.push({ names: [], teamName: null });
      outcome.push(null);
      cur = sides.length - 1;
      pending = null;
      continue;
    }
    if (l === 'WIN' || l === 'LOSE' || l === 'DRAW') {
      pending = l;
      outcome[cur] ??= l;
      continue;
    }
    if (LABEL.test(l)) continue;
    if (/^\d/.test(l)) continue;
    sides[cur].names.push(l);
    if (pending) {
      outcome[cur] = pending;
      pending = null;
    }
  }

  const winnerSideIndex = outcome.indexOf('WIN');
  return {
    sides: sides.filter((s) => s.names.length > 0),
    winnerSideIndex: winnerSideIndex === -1 ? null : winnerSideIndex,
  };
}
