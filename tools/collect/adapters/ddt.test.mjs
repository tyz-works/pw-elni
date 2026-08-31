import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parse, PROMOTION } from './ddt.mjs';

const RAW = readFileSync(new URL('../__fixtures__/ddt/result-sample.txt', import.meta.url), 'utf8');
const TARGET = { id: 'sample', url: 'https://example.test/results/sample', kind: 'result' };

test('団体 slug', () => {
  assert.equal(PROMOTION, 'ddt');
});

test('興行の見出しを取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.name, 'サンプル大会2026');
  assert.equal(event.date, '2026-07-05');
  assert.equal(event.promotionSlug, 'ddt');
  assert.equal(event.officialUrl, TARGET.url);
});

// slug への解決は resolve 段の仕事なので、ここでは表示名のまま返す。
test('会場名を表示名のまま取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.venueName, '東京・サンプルホール');
  assert.equal(event.venueSlug, null);
});

// ダークマッチは公式の試合番号の外にある（「オープニングマッチ」が第 1 試合）。
// 本戦とは別の連番にするので、両方に 1 が現れるのが正しい。
test('試合を 7 つ取り segment ごとに order を振る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(
    event.matches.map((m) => `${m.segment}:${m.order}`),
    ['dark:1', 'card:1', 'card:2', 'card:3', 'card:4', 'card:5', 'card:6'],
  );
});

// 見出しの語彙（ダークマッチ・再試合など）は興行ごとに増える。列挙して
// いると取りこぼし、その試合の中身が手前の試合に混ざる。
test('見出しの語彙を列挙せず「勝負」で終わる行を見出しにする', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].sides, [
    { names: ['架空十三郎'], teamName: null },
    { names: ['架空十四郎'], teamName: null },
  ]);
  assert.equal(event.matches[0].timeLimitMinutes, 15);
});

// ページ冒頭には見出しだけを並べた目次がある。中身が無いので試合ではないが、
// 失われた試合でもない。試合にも取りこぼしにも数えないのが正しい。
test('目次の見出しは試合にも取りこぼしにも数えない', () => {
  const { event, unparsed } = parse(RAW, TARGET);
  assert.equal(event.matches.length, 7);
  // 取りこぼしは中身のあるものだけ。見出しだけの目次行は出てこない。
  assert.ok(
    unparsed.every((u) => /架空十[七九]郎/.test(u)),
    `中身の無い断片が取りこぼしとして出ている: ${JSON.stringify(unparsed)}`,
  );
});

test('メインイベントも通し番号の途中として拾う', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[3].order, 3);
  assert.equal(event.matches[3].segment, 'card');
});

// 番号は「解析できた試合の連番」ではなく「番組表に載った試合の位置」で振る。
// 連番にすると、解析に失敗した試合の後ろが 1 つずつ繰り上がって
// 別の試合の番号になる（実データで 4 興行が該当した）。
test('解析できなかった試合のぶんも番号を消費する', () => {
  // 第一試合の中身を壊して解析できなくする。
  const broken = RAW.replace('架空太郎', 'あ'.repeat(40));
  const { event } = parse(broken, TARGET);
  const orders = event.matches.filter((m) => m.segment === 'card').map((m) => m.order);
  assert.ok(!orders.includes(1), '解析できなかった第一試合の番号が使われている');
  assert.deepEqual(orders, [2, 3, 4, 5, 6], '後ろの試合が繰り上がっている');
});

// 番組表には試合以外も並ぶ（前説・ライブ・オープニング）。試合として
// 数えると以降の番号が 1 つずつずれる。
test('番組表の非試合項目は番号を消費しない', () => {
  const { event, unparsed } = parse(RAW, TARGET);
  assert.equal(event.matches[1].order, 1, 'オープニングが第 1 試合を消費している');
  assert.ok(
    unparsed.some((u) => u.includes('架空十九郎')),
    'オープニング内の番号なしの試合が取りこぼしとして出ていない',
  );
});

test('陣営を VS で割り、名前だけを持つ', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[1].sides, [
    { names: ['架空太郎', '架空次郎'], teamName: null },
    { names: ['架空三郎', '架空四郎'], teamName: null },
  ]);
});

test('ラベル行は名前として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[2].sides, [
    { names: ['架空五郎'], teamName: null },
    { names: ['架空六郎'], teamName: null },
  ]);
});

test('勝者側・決まり手・時間を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[1].result, {
    winnerSideIndex: 0, decision: 'pinfall', finishText: 'サンプルボム', durationSeconds: 432,
  });
  assert.equal(event.matches[2].result.winnerSideIndex, 1);
  assert.equal(event.matches[2].result.durationSeconds, 900);
});

test('ギブアップは submission', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[3].result.decision, 'submission');
});

// 決まり手の欄に技名だけが入る試合が実在する。推測で pinfall を入れず
// unknown のまま人間（または Task 9 の LLM）に回す。
test('決まり手が技名なら decision は unknown', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[4].result.decision, 'unknown');
  assert.equal(event.matches[4].result.durationSeconds, 340);
});

// 見出しの直後に空行なしで続く行は副題であって選手名ではない。
test('副題行は選手名として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[1].sides[0].names, ['架空太郎', '架空次郎']);
  assert.deepEqual(event.matches[4].sides, [
    { names: ['架空九郎'], teamName: null },
    { names: ['架空十郎'], teamName: null },
  ]);
});

// 副題が無く、見出しの直後に空行なしで WIN が来る興行が実在する。
// これを副題として捨てると勝者が取れなくなる。
test('見出しの直後の WIN を副題と誤判定しない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[5].sides, [
    { names: ['架空十一郎'], teamName: null },
    { names: ['架空十二郎'], teamName: null },
  ]);
  assert.equal(event.matches[5].result.winnerSideIndex, 0);
});

test('with 行（セコンド）は選手名として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[3].sides[0].names, ['架空七郎']);
});

test('制限時間と王座名を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[1].timeLimitMinutes, 30);
  assert.equal(event.matches[1].titleName, null);
  assert.equal(event.matches[2].timeLimitMinutes, 60);
  assert.equal(event.matches[2].titleName, 'サンプル選手権');
});

test('補足行を notes に残す', () => {
  const { event } = parse(RAW, TARGET);
  assert.match(event.matches[2].notes, /架空五郎が防衛に失敗/);
});

// 見出しを取りこぼした試合は 1 つ前のブロックの末尾に残る。混ざらないだけでは
// 足りず、黙って消えてもいけない。
test('取りこぼした試合を unparsed に上げる', () => {
  const { unparsed } = parse(RAW, TARGET);
  assert.equal(unparsed.length, 2);
  const leftover = unparsed.find((u) => u.includes('リング撤収デスマッチ'));
  assert.ok(leftover, '見出しを取りこぼした試合が出ていない');
  assert.match(leftover, /架空十七郎/);
});

// 公式は一部の試合時間を「19時27分」と誤記する（正しくは 19 分 27 秒）。
// 時間の行として認識しないと、そこで試合が切れず次の試合の見出しや
// 決まり手が選手名として拾われる。値は推測せず null にする。
test('「N時M分」の行も試合時間の位置として扱い、値は null にする', () => {
  const { event } = parse(RAW, TARGET);
  const m = event.matches.find((x) => x.sides[0].names.includes('架空十五郎'));
  assert.ok(m, '「N時M分」で終わる試合が取れていない');
  assert.deepEqual(m.sides, [
    { names: ['架空十五郎'], teamName: null },
    { names: ['架空十六郎'], teamName: null },
  ]);
  assert.equal(m.result.durationSeconds, null, '誤記の時間を推測で埋めない');
  assert.equal(m.result.decision, 'pinfall');
});

// 入場順のマーカーは全角 ＜9＞ と半角 <19> の両方が使われている。
test('半角の入場順マーカーを選手名として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  const names = event.matches.flatMap((m) => m.sides.flatMap((s) => s.names));
  assert.ok(!names.some((n) => /^<\d+>$/.test(n)), `入場順マーカーが混ざっている: ${names}`);
});

// 見出しの語彙は列挙しきれない（「リング撤収デスマッチ」は「勝負」で終わらない）。
// 見出しを取りこぼしても、手前の試合に中身が混ざらないことを守る。
test('見出しを取りこぼしても手前の試合に混ざらない', () => {
  const { event } = parse(RAW, TARGET);
  const m = event.matches.find((x) => x.sides[0].names.includes('架空十五郎'));
  const names = m.sides.flatMap((s) => s.names);
  assert.ok(!names.includes('体固め'), '決まり手が選手名になっている');
  assert.ok(!names.includes('リング撤収デスマッチ'), '次の試合の見出しが選手名になっている');
  assert.ok(!names.includes('架空十七郎'), '次の試合の選手が混ざっている');
});

// 目次の直後には記事本文が続き、その中に「第N試合」として載っていない
// 王座戦が混ざる。見出しを認識できないので手前のブロックに入るが、
// 記事本文を選手名にしてはいけないし、試合として作ってもいけない
// （公式が第N試合として載せていない試合は data/ に入れない方針）。
test('記事本文を含むブロックは試合にせず取りこぼしに回す', () => {
  const { event, unparsed } = parse(RAW, TARGET);
  const names = event.matches.flatMap((m) => m.sides.flatMap((s) => s.names));
  assert.ok(!names.some((n) => n.length > 30), `記事本文が選手名になっている: ${JSON.stringify(names)}`);
  assert.ok(!names.includes('架空十九郎'), '第N試合として載っていない試合を取り込んでいる');
  assert.ok(
    unparsed.some((u) => u.includes('架空十九郎')),
    '取りこぼしとして報告されていない',
  );
});

// --- スケジュール（今後の興行）---

const SCHED = readFileSync(new URL('../__fixtures__/ddt/schedule-sample.txt', import.meta.url), 'utf8');
const SCHED_EVENT = readFileSync(new URL('../__fixtures__/ddt/schedule-event-sample.txt', import.meta.url), 'utf8');
const SCHED_TARGET = { id: 'sched', url: 'https://example.test/schedules/sched', kind: 'schedule' };

test('スケジュールから日時・会場・大会名を取る', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.equal(event.eventId, 'ddt-20261001-0');
  assert.equal(event.name, 'サンプル大会2026');
  assert.equal(event.date, '2026-10-01');
  assert.equal(event.venueName, '東京・サンプルホール');
  assert.equal(event.officialUrl, SCHED_TARGET.url);
});

// 開場・開始時刻は結果ページには無く、ここでしか取れない。
test('開場・開始時刻を取る', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.equal(event.doorsOpen, '17:30');
  assert.equal(event.bellTime, '18:30');
});

// 「■出演予定選手」は出場予定の一覧であって対戦カードではない。
// ここから試合を作ると、公式が発表していないカードを捏造することになる。
test('出演予定選手から試合を作らない', () => {
  const { event, unparsed } = parse(SCHED, SCHED_TARGET);
  assert.deepEqual(event.matches, []);
  assert.deepEqual(unparsed, [], 'カード未発表は取りこぼしではない');
});

// 公式が「イベント」「誕生日」に分類したものは興行ではない。
test('カテゴリが大会でないものは興行にしない', () => {
  const { event } = parse(SCHED_EVENT, SCHED_TARGET);
  assert.equal(event, null);
});

// カテゴリの語彙が変わったら黙って 0 件になるのではなく気付けること。
test('知らないカテゴリは判別できないものとして報告する', () => {
  const raw = SCHED.replace('\n大会\n', '\n特別興行\n');
  const { event, unknownCategory } = parse(raw, SCHED_TARGET);
  assert.equal(event, null);
  assert.equal(unknownCategory, '特別興行');
});

// 時刻が載らない回がある。取れないものを推測で埋めない。
test('時刻が無ければ null にする', () => {
  const raw = SCHED.replace(' 開場 17:30 開始 18:30', '');
  const { event } = parse(raw, SCHED_TARGET);
  assert.equal(event.doorsOpen, null);
  assert.equal(event.bellTime, null);
  assert.equal(event.date, '2026-10-01', '時刻が無くても日付は取れる');
});
