// DDT アダプタ。ddtpro.com は ddtpro.jp にリダイレクトするので .jp を直に使う。
// 結果ページ 1 枚に全試合の WIN/LOSE・決まり手・時間が載る。
// 開場/開始時刻だけは結果ページに無く、スケジュールページ側にある。

import { decisionFrom } from '../core/decision.mjs';

export const PROMOTION = 'ddt';

const BASE = 'https://www.ddtpro.jp';

// 選手名ではない行。陣営の組み立て時に落とす。
// 入場順のマーカーは全角 ＜9＞ と半角 <19> の両方が使われている。
const LABEL = /^(WIN|LOSE|DRAW|VS|＜.*＞|<\d+>|with .*|※.*)$/;

const RESULT_ID_RE = /\/results\/([0-9a-f]{24})(?:[/?#]|$)/;
const SCHEDULE_ID_RE = /\/schedules\/([0-9a-f]{24})(?:[/?#]|$)/;

// スケジュール詳細ページの目印。日付は「2026/10/01」の 1 行で載る。
const SCHED_DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;

// 「2026年10月01日(木) 開場 17:30 開始 18:30」。時刻が載らない回もある。
const SCHED_TIME_RE = /開場\s*(\d{1,2}:\d{2})[\s\S]*?開始\s*(\d{1,2}:\d{2})/;

// 公式が付けるカテゴリ。興行なのは「大会」だけ。
// 「イベント」「誕生日」は興行ではないので取り込まない。列挙に無い語が来たら
// 黙って 0 件になるのではなく、判別できないものとして上に返す。
const EVENT_CATEGORY = '大会';
const NON_EVENT_CATEGORIES = ['イベント', '誕生日'];

// 見出しは「<試合名>　<制限時間>分一本勝負」の形。試合名の語彙は興行ごとに
// 増える（ダークマッチ・再試合・緊急決定試合…）ので列挙せず、行全体が
// 「勝負」で終わることで判定する。列挙にすると取りこぼした試合の中身が
// 手前の試合に混ざる。
const HEAD_RE = /^(.{0,24}?)[\s　]*(?:(\d+)分)?(?:時間無制限)?(?:一本|\d+本)?勝負$/;

// ダークマッチは公式の試合番号の外にある（「オープニングマッチ」が第 1 試合）。
// 本戦とは別の連番にするので、見出しで見分ける。
const DARK_RE = /^ダークマッチ/;

// 番組表には試合以外も並ぶ（前説・公開調印式・ライブ・オープニング）。
// 試合の見出しだけが試合形式の表記で終わる。「オープニングマッチ」のような
// 見出しの語彙ではなく、この末尾で見分ける。語彙は興行ごとに増えるが、
// 形式の書き方は団体をまたいで安定している。
//
// 前説や公開調印式の中でアイアンマン級王座が動くことがあり、それを番号付きの
// 試合として数えると以降の番号が 1 つずつずれる。公式が番号を振っていない
// 試合は収録しない（data/README.md）。
const PROGRAM_MATCH_RE = /(?:勝負|ラウンド制)$/;
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
//
// 今後の興行はトップページからしか辿れない。/schedules は当月のカレンダーだけを
// 返し、月送りは JS で動くので ?year= や /2026/10 のようなパラメータでは動かせない
// （どれも当月と同じ 9 件を返す）。トップは 3 か月ぶんが並ぶ。
/** @returns {Promise<Target[]>} */
export async function listTargets(fetcher) {
  const idsFrom = (links, re) => [...new Set(links.flatMap((href) => re.exec(href)?.[1] ?? []))];

  const results = idsFrom(await fetcher.fetchLinks(`${BASE}/results`), RESULT_ID_RE)
    .map((id) => ({ id, url: `${BASE}/results/${id}`, kind: 'result' }));
  const schedules = idsFrom(await fetcher.fetchLinks(`${BASE}/`), SCHEDULE_ID_RE)
    .map((id) => ({ id, url: `${BASE}/schedules/${id}`, kind: 'schedule' }));

  return [...results, ...schedules];
}

/** @returns {Promise<string>} */
export function fetchRaw(fetcher, target) {
  return fetcher.fetchText(target.url);
}

/**
 * @param {string} raw スナップショットの生テキスト
 * @param {Target} target
 * @returns {{ event: RawEvent | null, unparsed: string[], unknownCategory?: string }}
 */
export function parse(raw, target) {
  return target.kind === 'schedule' ? parseSchedule(raw, target) : parseResult(raw, target);
}

// 開催前の興行。対戦カードは載らないので matches は空のまま返す。
// 「■出演予定選手」は出場予定の一覧であって対戦カードではないので使わない
// （ここから試合を作ると公式が発表していないカードを捏造することになる）。
function parseSchedule(raw, target) {
  const lines = raw.split('\n').map((s) => s.trim());

  const di = lines.findIndex((l) => SCHED_DATE_RE.test(l));
  if (di === -1) return { event: null, unparsed: [] };
  const [, y, m, d] = SCHED_DATE_RE.exec(lines[di]);
  const date = `${y}-${m}-${d}`;

  const category = lines.slice(di + 1).find(Boolean) ?? null;
  if (category !== EVENT_CATEGORY) {
    if (NON_EVENT_CATEGORIES.includes(category)) return { event: null, unparsed: [] };
    return { event: null, unparsed: [], unknownCategory: category };
  }

  // 見出しは「会場「大会名」」の形で、その次に大会名だけの行が来る。
  // 「日時」ラベルの直前の非空行を取れば、見出しの形が変わっても大会名になる。
  const li = lines.indexOf('日時');
  const name = li === -1 ? null : (lines.slice(0, li).reverse().find(Boolean) ?? null);
  const timeLine = li === -1 ? '' : (lines.slice(li + 1, li + 4).find(Boolean) ?? '');
  const time = SCHED_TIME_RE.exec(timeLine);

  const event = {
    eventId: `ddt-${date.replaceAll('-', '')}-0`,
    promotionSlug: PROMOTION,
    name,
    series: null,
    date,
    doorsOpen: time?.[1] ?? null,
    bellTime: time?.[2] ?? null,
    venueName: parseVenue(lines),
    venueSlug: null,
    attendance: null,
    confirmed: true,   // 興行そのものは公式発表済み。未発表なのはカード
    officialUrl: target.url,
    sources: [],       // run.mjs が retrievedAt 付きで足す
    matches: [],       // 対戦カード未発表。スキーマ上は空配列でよい
  };
  return { event, unparsed: [] };
}

function parseResult(raw, target) {
  const lines = raw.split('\n').map((s) => s.trim());
  const unparsed = [];

  const date = parseDate(lines);
  const name = parseName(lines);
  const venueName = parseVenue(lines);

  const matches = [];
  const nextOrder = { card: 0, dark: 0 };
  for (const { heading, block } of splitBlocks(lines)) {
    // 試合の中身が無いブロックは失われた試合ではない（見出しだけの目次、
    // 前説・ライブ・公開調印式）。unparsed に入れない。
    if (!looksLikeMatch(block)) continue;

    // 番号の付かない試合。収録はしないが、黙って落とさず取りこぼしに上げる。
    if (!PROGRAM_MATCH_RE.test(heading)) {
      unparsed.push(block.join('\n'));
      continue;
    }

    // 番号は「解析できた試合の連番」ではなく「番組表に載った試合の位置」で
    // 振る。解析に失敗した試合のぶんも番号を消費させないと、以降の試合が
    // 1 つずつ繰り上がって別の試合の番号になる。
    const segment = DARK_RE.test(heading) ? 'dark' : 'card';
    nextOrder[segment] += 1;
    const order = nextOrder[segment];

    const parsed = parseMatch(block, order, segment);
    if (!parsed) {
      unparsed.push(block.join('\n'));
      continue;
    }
    matches.push(parsed.match);

    // 番組表に無い試合（アイアンマン級王座の移動など）はブロックの末尾に
    // 残る。公式が番号を振っていないので番号は与えないが、黙って落とさず
    // unparsed に上げる。
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

// 結果ページの冒頭には「★大会ハイライト★」に挟まれた番組表がある。公式が
// その日の進行をそのまま並べたもので、試合以外（前説・ライブ・公開調印式）も
// 含む。本文はこの項目名を見出しとして繰り返す。
//
// 見出しを正規表現で拾うより番組表を使うほうが取りこぼさない。「第二試合
// 3分5ラウンド制」のように「勝負」で終わらない見出しが実在し、HEAD_RE では
// 切れずに手前の試合へ混ざる。番組表には並んで載っている。
const PROGRAM_MARKER = '★大会ハイライト★';

/** @returns {{items: string[], bodyStart: number} | null} */
function parseProgram(lines) {
  const first = lines.indexOf(PROGRAM_MARKER);
  if (first === -1) return null;
  const second = lines.indexOf(PROGRAM_MARKER, first + 1);
  if (second === -1) return null;
  const items = lines.slice(first + 1, second).filter(Boolean);
  return items.length ? { items, bodyStart: second + 1 } : null;
}

// 本文を見出しで区切る。番組表があればその項目名で、無ければ HEAD_RE で。
// 番組表が無い興行が実在する（試合が 1〜2 件の小規模大会）。
/** @returns {{heading: string, block: string[]}[]} */
function splitBlocks(lines) {
  const program = parseProgram(lines);
  if (!program) {
    const starts = [];
    for (const [i, l] of lines.entries()) if (HEAD_RE.test(l)) starts.push(i);
    return starts.map((s, k) => ({ heading: lines[s], block: lines.slice(s, starts[k + 1] ?? lines.length) }));
  }

  // 項目は番組表の順に本文へ現れる。前から順に探し、見つかった位置で切る。
  // 同じ文字列の項目が 2 つあっても手前から順に消費するので取り違えない。
  const found = [];
  let from = program.bodyStart;
  for (const item of program.items) {
    const at = lines.indexOf(item, from);
    if (at === -1) continue;
    found.push({ heading: item, at });
    from = at + 1;
  }
  return found.map((f, k) => ({
    heading: f.heading,
    block: lines.slice(f.at, found[k + 1]?.at ?? lines.length),
  }));
}

// 試合の中身（時間か勝敗ラベル）を含むか。目次の見出しだけの行と区別する。
function looksLikeMatch(block) {
  return block.some((l) => TIME_LINE_RE.test(l) || l === 'VS' || l === 'WIN' || l === 'LOSE');
}

function parseMatch(block, order, segment) {
  const head = block[0];
  // 制限時間は「N 分一本勝負」の形のときだけ採る。「3分5ラウンド制」の 3 は
  // 1 ラウンドの長さであって制限時間ではない。読めなければ null で通す。
  const timeLimitMinutes = HEAD_RE.exec(head)?.[2] ? Number(HEAD_RE.exec(head)[2]) : null;

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
  const decision = decisionFrom(decisionText);

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
      segment,
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
