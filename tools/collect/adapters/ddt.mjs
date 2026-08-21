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
const LABEL = /^(WIN|LOSE|DRAW|VS|＜.*＞|with .*|※.*)$/;

const HEAD_RE = /^(?:第(.+?)試合|オープニングマッチ|セミファイナル|メインイベント|緊急決定試合)\s*(?:(\d+)分)?/;
const DURATION_RE = /^(\d+)分(\d+)秒$/;

// 結果一覧に載っている分をすべて返す。マージが冪等なので取りすぎても
// 2 回目以降は差分ゼロになる。「直近 N 日」の絞り込みは spec §10 の保留事項。
/** @returns {Promise<Target[]>} */
export async function listTargets(fetcher) {
  const text = await fetcher.fetchText(`${BASE}/results`);
  const ids = [...text.matchAll(/\/results\/([0-9a-f]{24})/g)].map((m) => m[1]);
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

  const matches = [];
  for (const block of splitMatches(lines)) {
    // ページ冒頭の目次にも見出しだけが並ぶ。試合の中身が無いブロックは
    // 失われた試合ではないので unparsed に入れない。
    if (!looksLikeMatch(block)) continue;
    const m = parseMatch(block, matches.length + 1);
    if (m) matches.push(m);
    else unparsed.push(block.join('\n'));
  }

  const event = {
    eventId: date ? `ddt-${date.replaceAll('-', '')}-0` : null,
    promotionSlug: PROMOTION,
    name,
    series: null,
    date,
    doorsOpen: null,   // 結果ページには無い。スケジュール側で埋める
    bellTime: null,
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
  return block.some((l) => DURATION_RE.test(l) || l === 'VS' || l === 'WIN' || l === 'LOSE');
}

function parseMatch(block, order) {
  const head = block[0];
  const hm = HEAD_RE.exec(head);
  if (!hm) return null;
  const timeLimitMinutes = hm[2] ? Number(hm[2]) : null;

  // 選手名やラベルは前後を空行で挟まれる。見出しの直後に空行なしで続く行は
  // 副題（「スペシャルタッグマッチ」「〜選手権試合」）であって選手名ではない。
  const subtitle = block[1] || null;
  const titleName = subtitle && /選手権試合/.test(subtitle)
    ? subtitle.replace(/選手権試合.*$/, '選手権')
    : null;

  const durIdx = block.findIndex((l) => DURATION_RE.test(l));
  if (durIdx === -1) return null;
  const dm = DURATION_RE.exec(block[durIdx]);
  const durationSeconds = Number(dm[1]) * 60 + Number(dm[2]);

  const decisionText = block.slice(durIdx + 1).find(Boolean) ?? '';
  const decision = DECISION.find(([re]) => re.test(decisionText))?.[1] ?? 'unknown';

  const noteLine = block.find((l) => l.startsWith('※'));
  const finishText = noteLine ? (/^※([^。]+)。/.exec(noteLine)?.[1] ?? null) : null;

  // 見出し行と副題行は陣営の組み立てに渡さない。渡すと選手名として拾われる。
  const { sides, winnerSideIndex } = parseSides(block.slice(subtitle ? 2 : 1, durIdx));
  if (sides.length < 1) return null;

  return {
    order,
    matchType: null, // sides の人数から run.mjs 側で決める
    sides,
    titleName,
    timeLimitMinutes,
    result: { winnerSideIndex, decision, finishText, durationSeconds },
    notes: noteLine ?? null,
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
