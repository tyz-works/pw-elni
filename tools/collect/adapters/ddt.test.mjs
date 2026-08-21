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

test('試合を 4 つ取り order を振る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches.map((m) => m.order), [1, 2, 3, 4]);
});

// ページ冒頭には見出しだけを並べた目次がある。中身が無いので試合ではないが、
// 失われた試合でもない。試合にも取りこぼしにも数えないのが正しい。
test('目次の見出しは試合にも取りこぼしにも数えない', () => {
  const { event, unparsed } = parse(RAW, TARGET);
  assert.equal(event.matches.length, 4);
  assert.deepEqual(unparsed, []);
});

test('メインイベントも通し番号の途中として拾う', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[2].order, 3);
});

test('陣営を VS で割り、名前だけを持つ', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].sides, [
    { names: ['架空太郎', '架空次郎'], teamName: null },
    { names: ['架空三郎', '架空四郎'], teamName: null },
  ]);
});

test('ラベル行は名前として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[1].sides, [
    { names: ['架空五郎'], teamName: null },
    { names: ['架空六郎'], teamName: null },
  ]);
});

test('勝者側・決まり手・時間を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].result, {
    winnerSideIndex: 0, decision: 'pinfall', finishText: 'サンプルボム', durationSeconds: 432,
  });
  assert.equal(event.matches[1].result.winnerSideIndex, 1);
  assert.equal(event.matches[1].result.durationSeconds, 900);
});

test('ギブアップは submission', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[2].result.decision, 'submission');
});

// 決まり手の欄に技名だけが入る試合が実在する。推測で pinfall を入れず
// unknown のまま人間（または Task 9 の LLM）に回す。
test('決まり手が技名なら decision は unknown', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[3].result.decision, 'unknown');
  assert.equal(event.matches[3].result.durationSeconds, 340);
});

// 見出しの直後に空行なしで続く行は副題であって選手名ではない。
test('副題行は選手名として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].sides[0].names, ['架空太郎', '架空次郎']);
  assert.deepEqual(event.matches[3].sides, [
    { names: ['架空九郎'], teamName: null },
    { names: ['架空十郎'], teamName: null },
  ]);
});

test('with 行（セコンド）は選手名として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[2].sides[0].names, ['架空七郎']);
});

test('制限時間と王座名を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[0].timeLimitMinutes, 30);
  assert.equal(event.matches[0].titleName, null);
  assert.equal(event.matches[1].timeLimitMinutes, 60);
  assert.equal(event.matches[1].titleName, 'サンプル選手権');
});

test('補足行を notes に残す', () => {
  const { event } = parse(RAW, TARGET);
  assert.match(event.matches[1].notes, /架空五郎が防衛に失敗/);
});

test('フィクスチャでは取りこぼしが出ない', () => {
  const { unparsed } = parse(RAW, TARGET);
  assert.deepEqual(unparsed, []);
});
