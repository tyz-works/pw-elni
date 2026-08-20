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
