import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decisionFrom } from './decision.mjs';

test('フォール系は pinfall', () => {
  assert.equal(decisionFrom('片エビ固め'), 'pinfall');
  assert.equal(decisionFrom('ジャーマンスープレックスホールド'), 'pinfall');
});

test('ギブアップは submission', () => {
  assert.equal(decisionFrom('ギブアップ'), 'submission');
});

test('リングアウトは countout', () => {
  assert.equal(decisionFrom('リングアウト'), 'countout');
});

// 「両者リングアウト」は引き分け。先に「リングアウト」を拾うと勝者のいない
// countout になり、検証器に落とされる。
test('両者〜は決着なしとして draw', () => {
  assert.equal(decisionFrom('両者リングアウト'), 'draw');
  assert.equal(decisionFrom('両者反則'), 'draw');
});

test('時間切れ引き分けは time-limit-draw', () => {
  assert.equal(decisionFrom('15分時間切れ引き分け'), 'time-limit-draw');
});

test('判断できないものは unknown', () => {
  assert.equal(decisionFrom('タイガーリリー'), 'unknown');
  assert.equal(decisionFrom(null), 'unknown');
});
