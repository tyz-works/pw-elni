import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parse, PROMOTION } from './njpw.mjs';

const RAW = readFileSync(new URL('../__fixtures__/njpw/result-sample.txt', import.meta.url), 'utf8');
const TARGET = { id: '642541', url: 'https://example.test/tournament/result/642541', kind: 'result' };

test('団体 slug', () => {
  assert.equal(PROMOTION, 'njpw');
});

// ヘッダは構造化されている。ここを LLM に渡す必要はない。
test('日時・会場・観衆を決定論的に取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.name, 'サンプル大会2026');
  assert.equal(event.date, '2026-08-16');
  assert.equal(event.eventId, 'njpw-20260816-0');
  assert.equal(event.venueName, '東京・サンプルホール');
  assert.equal(event.attendance, 7260);
});

test('開場・開始時刻を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.doorsOpen, '13:30');
  assert.equal(event.bellTime, '15:00');
});

// 試合は記事本文にしか無い。決定論的には組み立てられないので LLM に回す。
test('試合は組み立てず、記事本文を取りこぼしとして返す', () => {
  const { event, unparsed } = parse(RAW, TARGET);
  assert.deepEqual(event.matches, []);
  assert.equal(unparsed.length, 1);
  assert.match(unparsed[0], /第1試合は架空三郎/);
  assert.match(unparsed[0], /第2試合は架空太郎/);
});

// ナビ・フッタ・有料導線は試合の記述ではない。LLM に渡す量を減らす。
test('ナビとフッタと有料導線を渡さない', () => {
  const { unparsed } = parse(RAW, TARGET);
  assert.ok(!unparsed[0].includes('スケジュール/チケット'), 'ナビが入っている');
  assert.ok(!unparsed[0].includes('Copyright'), 'フッタが入っている');
  assert.ok(!unparsed[0].includes('プレミアム入会'), '有料導線が入っている');
});

test('本文が無ければ取りこぼしも出さない', () => {
  const { event, unparsed } = parse('日時\n2026年08月16日 (日)\n会場\n東京・サンプルホール\n', TARGET);
  assert.equal(event.date, '2026-08-16');
  assert.deepEqual(unparsed, []);
});
