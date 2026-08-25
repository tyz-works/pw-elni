import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchKey, matchRank, matchLabel } from './match-label.mjs';

// order は segment ごとの連番。ダークマッチの 1 と本戦の第 1 試合は別の試合。
test('segment が違えば鍵が違う', () => {
  assert.notEqual(matchKey({ segment: 'dark', order: 1 }), matchKey({ segment: 'card', order: 1 }));
});

// 他団体のアダプタは segment を返さない。本戦に倒す。
test('segment が無ければ card として扱う', () => {
  assert.equal(matchKey({ order: 1 }), matchKey({ segment: 'card', order: 1 }));
  assert.equal(matchLabel({ order: 3 }), '第 3 試合');
});

test('ダークマッチは本戦より前に並ぶ', () => {
  const rank = (m) => matchRank(m);
  assert.ok(rank({ segment: 'dark', order: 9 }) < rank({ segment: 'card', order: 1 }));
});

test('ラベルは segment を反映する', () => {
  assert.equal(matchLabel({ segment: 'dark', order: 2 }), '第 2 ダークマッチ');
  assert.equal(matchLabel({ segment: 'card', order: 2 }), '第 2 試合');
});
