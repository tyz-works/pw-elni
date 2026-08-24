import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReport } from './report.mjs';

const EMPTY = { changed: [], conflicts: [], unresolved: [], unparsed: [], failures: [], llmFilled: [], droppedOrders: [], duplicateNames: [] };

test('何も無ければ差分なしと書く', () => {
  const md = renderReport(EMPTY);
  assert.match(md, /差分はありません/);
});

test('conflict と unresolved を取り込んだ変更より先に出す', () => {
  const md = renderReport({
    ...EMPTY,
    changed: [{ promotion: 'ddt', eventId: 'ddt-20260811-0', eventName: 'X', fields: ['attendance'] }],
    conflicts: [{ promotion: 'ddt', eventId: 'ddt-20260811-0', path: 'attendance', existing: 1, incoming: 2, sourceUrl: 'u' }],
    unresolved: [{ promotion: 'ddt', eventName: 'X', name: '未知の選手', sourceUrl: 'u' }],
  });
  assert.ok(md.indexOf('## conflict') < md.indexOf('## 取り込んだ変更'));
  assert.ok(md.indexOf('## unresolved') < md.indexOf('## 取り込んだ変更'));
  assert.match(md, /未知の選手/);
});

test('失敗した団体を列挙する', () => {
  const md = renderReport({ ...EMPTY, failures: [{ promotion: 'njpw', step: 'fetch', message: 'timeout' }] });
  assert.match(md, /njpw/);
  assert.match(md, /timeout/);
});

test('LLM が埋めた箇所を明示する', () => {
  const md = renderReport({ ...EMPTY, llmFilled: [{ promotion: 'ddt', eventId: 'e', order: 3, model: 'm' }] });
  assert.match(md, /LLM/);
  assert.match(md, /第 3 試合/);
});

test('公式から消えた order を出す', () => {
  const md = renderReport({ ...EMPTY, droppedOrders: [{ promotion: 'ddt', eventId: 'e', orders: [5] }] });
  assert.match(md, /公式側から消えた/);
});

test('パイプ記号を含む値が表を壊さない', () => {
  const md = renderReport({
    ...EMPTY,
    conflicts: [{ promotion: 'ddt', eventId: 'e', path: 'p', existing: 'a|b', incoming: 'c', sourceUrl: 'u' }],
  });
  assert.match(md, /a\\\|b/);
});

// 改行がそのまま入ると 1 行 1 レコードの表が崩れる。
test('改行を含む値が表を壊さない', () => {
  const md = renderReport({
    ...EMPTY,
    failures: [{ promotion: 'ddt', step: 'parse', message: '1 行目\n2 行目' }],
  });
  const row = md.split('\n').find((l) => l.includes('1 行目'));
  assert.match(row, /1 行目 2 行目/);
});

// パーサが取りこぼした断片は人間に届かないと存在しないのと同じになる。
test('取りこぼした試合を出す', () => {
  const md = renderReport({
    ...EMPTY,
    unparsed: [{ promotion: 'ddt', eventId: 'e', text: 'アイアンマンヘビーメタル級選手権試合\nLOSE\n＜王者＞' }],
  });
  assert.match(md, /取りこぼした試合/);
  assert.match(md, /アイアンマンヘビーメタル級選手権試合/);
});

test('取りこぼしが無ければその節を出さない', () => {
  assert.ok(!renderReport(EMPTY).includes('取りこぼした試合'));
});

// 何件隠したか分からないと、黙らせる機構そのものが信用できなくなる。
test('省略した食い違いの件数を出す', () => {
  const md = renderReport({ ...EMPTY, silencedConflicts: 16 });
  assert.match(md, /確認済みの食い違い 16 件は省略/);
});

test('省略が無ければその断りを出さない', () => {
  assert.ok(!renderReport(EMPTY).includes('省略'));
});

// スキーマは 1 陣営の中の同名を許している（覆面・分身で中の人が違う）。
// 黙って通すとこちらの取り違えを見逃すので、レポートに上げる。
test('同名の複数名をレポートに出す', () => {
  const md = renderReport({
    ...EMPTY,
    duplicateNames: [{ promotion: 'ddt', eventId: 'e', label: '第 3 試合', names: ['nise-baramon-yuki'] }],
  });
  assert.match(md, /同じ名前が 1 つの陣営に複数/);
  assert.match(md, /nise-baramon-yuki/);
});
