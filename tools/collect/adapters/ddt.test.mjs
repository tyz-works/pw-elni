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

test('試合を 7 つ取り order を振る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches.map((m) => m.order), [1, 2, 3, 4, 5, 6, 7]);
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
  assert.ok(
    unparsed.every((u) => u.includes('架空十七郎')),
    `目次が取りこぼしとして出ている: ${JSON.stringify(unparsed)}`,
  );
});

test('メインイベントも通し番号の途中として拾う', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[3].order, 4);
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
  assert.equal(unparsed.length, 1);
  assert.match(unparsed[0], /リング撤収デスマッチ/);
  assert.match(unparsed[0], /架空十七郎/);
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
