import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parse, PROMOTION } from './stardom.mjs';

const RAW = readFileSync(new URL('../__fixtures__/stardom/result-sample.txt', import.meta.url), 'utf8');
const TARGET = { id: 'sample', url: 'https://example.test/event/sample/', kind: 'result' };

test('団体 slug', () => {
  assert.equal(PROMOTION, 'stardom');
});

test('興行の見出しを取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.name, 'サンプル大会2026 in KORAKUEN');
  assert.equal(event.date, '2026-08-18');
  assert.equal(event.eventId, 'stardom-20260818-0');
  assert.equal(event.venueName, '東京・サンプルホール');
  assert.equal(event.officialUrl, TARGET.url);
});

// 公式は観衆を「1610人　超満員札止め」と注記つきで書く。数字だけを採る。
test('観衆を数字として取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.attendance, 1610);
});

test('試合を 3 つ取り order を振る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches.map((m) => m.order), [1, 2, 3]);
});

test('陣営を VS で割り、試合名を選手にしない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].sides, [
    { names: ['架空はな', '架空ゆき'], teamName: null },
    { names: ['架空そら', '架空うみ'], teamName: null },
  ]);
});

// 【王者】【挑戦者】やトーナメントの枠説明は選手名ではない。
test('角括弧のラベルと枠の説明を選手名にしない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[1].sides, [
    { names: ['架空きど'], teamName: null },
    { names: ['架空すず'], teamName: null },
  ]);
  assert.deepEqual(event.matches[2].sides[1].names, ['架空りな']);
});

test('勝者・時間・決まり手を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].result, {
    winnerSideIndex: 0, decision: 'pinfall', finishText: 'サンプルスープレックスホールド', durationSeconds: 570,
  });
  assert.equal(event.matches[1].result.winnerSideIndex, 1);
  assert.equal(event.matches[1].result.durationSeconds, 838);
});

test('選手権試合から王座名を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[1].titleName, 'サンプル王座');
  assert.equal(event.matches[0].titleName, null);
});

test('フィクスチャでは取りこぼしが出ない', () => {
  const { unparsed } = parse(RAW, TARGET);
  assert.deepEqual(unparsed, []);
});
