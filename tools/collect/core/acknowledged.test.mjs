import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conflictKey, filterAcknowledged } from './acknowledged.mjs';

const C = {
  promotion: 'ddt', eventId: 'ddt-20260811-0', path: 'matches[order=5].titleName',
  existing: 'DDT EXTREME級選手権', incoming: 'DDT EXTREME選手権', sourceUrl: 'u',
};

test('同じ食い違いは同じ鍵になる', () => {
  assert.equal(conflictKey(C), conflictKey({ ...C, sourceUrl: '別のURL' }),
    '出典 URL は毎回変わりうるので鍵に含めない');
});

test('抽出側の値が変われば別の鍵になる', () => {
  assert.notEqual(conflictKey(C), conflictKey({ ...C, incoming: 'DDT EXTREME王座' }));
});

test('既存側の値が変われば別の鍵になる', () => {
  assert.notEqual(conflictKey(C), conflictKey({ ...C, existing: '直した値' }));
});

test('記録済みの食い違いを取り除き、件数を返す', () => {
  const other = { ...C, path: 'attendance', existing: 1, incoming: 2 };
  const { conflicts, silenced } = filterAcknowledged([C, other], [conflictKey(C)]);
  assert.deepEqual(conflicts, [other]);
  assert.equal(silenced, 1);
});

test('記録が空なら何も取り除かない', () => {
  const { conflicts, silenced } = filterAcknowledged([C], []);
  assert.deepEqual(conflicts, [C]);
  assert.equal(silenced, 0);
});

// 数値と文字列の 1 を取り違えると、直したはずの食い違いが黙る。
test('型が違えば別の鍵になる', () => {
  const a = { ...C, existing: 1, incoming: 2 };
  const b = { ...C, existing: '1', incoming: '2' };
  assert.notEqual(conflictKey(a), conflictKey(b));
});
