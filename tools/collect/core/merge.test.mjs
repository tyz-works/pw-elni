import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge } from './merge.mjs';

const SRC = { sourceUrl: 'https://example.test/e/1' };

test('空のフィールドは埋める', () => {
  const { merged, conflicts } = merge({ attendance: null }, { attendance: 1200 }, SRC);
  assert.equal(merged.attendance, 1200);
  assert.deepEqual(conflicts, []);
});

test('同じ値なら何もしない', () => {
  const { merged, conflicts } = merge({ attendance: 1200 }, { attendance: 1200 }, SRC);
  assert.equal(merged.attendance, 1200);
  assert.deepEqual(conflicts, []);
});

test('異なる値は上書きせず conflict にする', () => {
  const { merged, conflicts } = merge({ attendance: 1200 }, { attendance: 999 }, SRC);
  assert.equal(merged.attendance, 1200, '既存値が残ること');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], {
    path: 'attendance', existing: 1200, incoming: 999, sourceUrl: SRC.sourceUrl,
  });
});

test('抽出側が空なら既存値を消さない', () => {
  const { merged, conflicts } = merge({ attendance: 1200 }, { attendance: null }, SRC);
  assert.equal(merged.attendance, 1200);
  assert.deepEqual(conflicts, []);
});

test('confirmed は false から true にだけ進む', () => {
  const up = merge({ confirmed: false }, { confirmed: true }, SRC);
  assert.equal(up.merged.confirmed, true);
  assert.deepEqual(up.conflicts, []);

  const down = merge({ confirmed: true }, { confirmed: false }, SRC);
  assert.equal(down.merged.confirmed, true, '巻き戻さないこと');
  assert.equal(down.conflicts.length, 1);
});

// ダークマッチは公式の試合番号の外にあり、本戦とは別の連番。order だけで
// 突き合わせると dark:1 が card:1 を上書きしてしまう。
test('matches は segment + order を identity にする', () => {
  const existing = { matches: [{ order: 1, segment: 'card', notes: '本戦' }] };
  const incoming = { matches: [{ order: 1, segment: 'dark', notes: 'ダーク' }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.equal(merged.matches.length, 2, '別の試合として並ぶこと');
  assert.deepEqual(conflicts, [], '上書きの食い違いを出さないこと');
  // ダークマッチは本戦の前に行われるので先に並ぶ。
  assert.deepEqual(merged.matches.map((m) => m.segment), ['dark', 'card']);
});

test('matches は order を identity にする', () => {
  const existing = { matches: [{ order: 1, notes: 'あり' }] };
  const incoming = { matches: [{ order: 2, notes: '新規' }, { order: 1, notes: 'あり' }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches.map((m) => m.order), [1, 2], 'order 昇順に並ぶこと');
  assert.deepEqual(conflicts, []);
});

test('既存 match の空フィールドに結果が入る', () => {
  const existing = { matches: [{ order: 1, result: null, confirmed: true }] };
  const incoming = { matches: [{ order: 1, result: { winnerSideIndex: 0 }, confirmed: true }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches[0].result, { winnerSideIndex: 0 });
  assert.deepEqual(conflicts, []);
});

test('公式から消えた order は残す', () => {
  const existing = { matches: [{ order: 1 }, { order: 2 }] };
  const incoming = { matches: [{ order: 1 }] };
  const { merged } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches.map((m) => m.order), [1, 2]);
});

test('sides の wrestlerIds が違えば conflict', () => {
  const existing = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a'], teamName: null }] }] };
  const incoming = { matches: [{ order: 1, sides: [{ wrestlerIds: ['b'], teamName: null }] }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches[0].sides[0].wrestlerIds, ['a']);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'matches[order=1].sides[0].wrestlerIds');
});

test('陣営の数が違えば conflict にして既存を据え置く', () => {
  const existing = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a'] }, { wrestlerIds: ['b'] }] }] };
  const incoming = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a'] }, { wrestlerIds: ['b'] }, { wrestlerIds: ['c'] }] }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.equal(merged.matches[0].sides.length, 2);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'matches[order=1].sides');
});

test('sources は URL で重複排除して追記し retrievedAt は既存のまま', () => {
  const existing = { sources: [{ url: 'u1', title: 't1', retrievedAt: '2026-08-01' }] };
  const incoming = { sources: [
    { url: 'u1', title: 't1', retrievedAt: '2026-08-20' },
    { url: 'u2', title: 't2', retrievedAt: '2026-08-20' },
  ] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.sources[0].retrievedAt, '2026-08-01');
  assert.deepEqual(conflicts, []);
});

test('入力を書き換えない', () => {
  const existing = { matches: [{ order: 1, notes: null }] };
  const frozen = JSON.stringify(existing);
  merge(existing, { matches: [{ order: 1, notes: 'x' }] }, SRC);
  assert.equal(JSON.stringify(existing), frozen);
});

// wrestlerIds は集合。並び順に意味は無いので、順序違いを食い違いにしない。
// 公式の並びは記事ごとに変わるため、放置すると毎回同じ conflict が出る。
test('wrestlerIds の並び順違いは食い違いにしない', () => {
  const existing = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a', 'b', 'c'], teamName: null }] }] };
  const incoming = { matches: [{ order: 1, sides: [{ wrestlerIds: ['c', 'a', 'b'], teamName: null }] }] };
  const { merged, conflicts } = merge(existing, incoming);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged.matches[0].sides[0].wrestlerIds, ['a', 'b', 'c'], '既存の並びを保つ');
});

test('顔ぶれが違えば食い違いとして報告する', () => {
  const existing = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a', 'b'], teamName: null }] }] };
  const incoming = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a', 'z'], teamName: null }] }] };
  const { conflicts } = merge(existing, incoming);
  assert.equal(conflicts.length, 1);
});

// --- 暫定カードの差し替え ---
// 開催前のカードは公式が差し替える。試合ごとに segment + order で
// 突き合わせると、番号がずれたときに古い試合が残ってしまう。
// 結果がまだ 1 つも入っていない興行の matches は丸ごと入れ替える。

const provisional = (order, name) => ({
  order, segment: 'card', matchType: 'singles',
  sides: [{ wrestlerIds: [name], teamName: null }, { wrestlerIds: ['x'], teamName: null }],
  titleName: null, timeLimitMinutes: null, result: null, confirmed: true, notes: null,
});
const decided = (order, name) => ({
  ...provisional(order, name),
  result: { winnerSideIndex: 0, decision: 'pinfall', finishMoveSlug: null, durationSeconds: 60 },
});

test('結果がまだ無い興行のカードは丸ごと差し替える', () => {
  const existing = { matches: [provisional(1, 'a'), provisional(2, 'b')] };
  const incoming = { matches: [provisional(1, 'c')] };
  const { merged, conflicts } = merge(existing, incoming);
  assert.deepEqual(merged.matches.map((m) => m.sides[0].wrestlerIds[0]), ['c']);
  assert.deepEqual(conflicts, [], '暫定同士の食い違いは報告しない');
});

// 興行後。結果ページから全試合を取り直したものが、番号のずれた暫定カードを
// 置き換える。幻の試合が残らないこと。
test('暫定カードは結果で置き換わり、番号がずれても残らない', () => {
  const existing = { matches: [provisional(1, 'a')] };
  const incoming = { matches: [decided(7, 'a')] };
  const { merged } = merge(existing, incoming);
  assert.equal(merged.matches.length, 1);
  assert.equal(merged.matches[0].order, 7);
  assert.ok(merged.matches[0].result, '結果が入っている');
});

// 結果が入ったあとは従来どおり。既存値を黙って上書きしない。
test('結果が入っている興行は従来どおり突き合わせる', () => {
  const existing = { matches: [decided(1, 'a')] };
  const incoming = { matches: [decided(1, 'b')] };
  const { merged, conflicts } = merge(existing, incoming);
  assert.equal(merged.matches[0].sides[0].wrestlerIds[0], 'a', '既存値を残す');
  assert.ok(conflicts.length, '食い違いを報告する');
});

test('取得側のカードが空なら既存を消さない', () => {
  const existing = { matches: [provisional(1, 'a')] };
  const { merged } = merge(existing, { matches: [] });
  assert.equal(merged.matches.length, 1);
});
