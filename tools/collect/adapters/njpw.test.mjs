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

// RESULT セクションには構造化された対戦カードがある。ここは LLM に
// 渡さず決定論的に取る。渡す量が減り、LLM の出力を検算する材料にもなる。
test('カードから試合順・制限時間・選手名・時間・決まり手を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.cardMatches.length, 2);
  assert.deepEqual(event.cardMatches[0], {
    order: 1,
    timeLimitMinutes: 20,
    subtitle: null,
    names: ['架空三郎', '架空四郎', '架空五郎', '架空六郎'],
    durationSeconds: 330,
    finishText: 'サンプルドライバー→体固め',
  });
});

test('星取の行を選手名にしない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.cardMatches[1].names, ['架空太郎', '架空次郎']);
});

test('王座戦の副題を拾う', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.cardMatches[1].subtitle, '『サンプル王座』選手権試合');
  assert.equal(event.cardMatches[0].subtitle, null);
});

// セレモニーなど試合でない項目も「試合詳細を見る」で終わる。
test('見出しが第N試合でないブロックはカードに数えない', () => {
  const { event } = parse(RAW, TARGET);
  assert.ok(!event.cardMatches.some((m) => m.names.includes('架空七郎')));
});

// LLM には陣営分けと勝敗だけを任せる。判断材料としてカードも渡す。
test('LLM に渡す断片にカードと記事本文の両方を入れる', () => {
  const { unparsed } = parse(RAW, TARGET);
  assert.equal(unparsed.length, 1);
  assert.match(unparsed[0], /第1試合は架空三郎/, '記事本文が入っていない');
  assert.match(unparsed[0], /5分30秒/, 'カードが入っていない');
});

// 引き分け後の延長戦は「第7試合（延長戦）」として同じ番号で載る。
// どちらも本物の試合だが、order が重複すると検証器に落とされる。
test('試合順が重複したら次の空き番号を使う', () => {
  const raw = RAW.replace(
    '会社概要',
    [
      '第2試合 60分1本勝負（延長戦）',
      '',
      '架空太郎',
      '',
      '架空次郎',
      '',
      '0分18秒 サンプルスープレックスホールド',
      '',
      '試合詳細を見る',
      '',
      '会社概要',
    ].join('\n'),
  );
  const { event } = parse(raw, TARGET);
  assert.deepEqual(event.cardMatches.map((m) => m.order), [1, 2, 3]);
  assert.equal(event.cardMatches[2].durationSeconds, 18);
});

// --- スケジュール（今後の興行）---
// 対戦カードのページを使う。/schedule は 1 ページに複数興行が並ぶので、
// 「1 スナップショット = 1 興行」の契約に乗らない。

const SCHED = readFileSync(new URL('../__fixtures__/njpw/schedule-sample.txt', import.meta.url), 'utf8');
const SCHED_TARGET = { id: 'card-1', url: 'https://example.test/tournament/card/1', kind: 'schedule' };

test('スケジュールから日時・会場・シリーズ名を取る', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.equal(event.eventId, 'njpw-20260905-0');
  assert.equal(event.name, 'サンプルシリーズ2026');
  assert.equal(event.date, '2026-09-05');
  assert.equal(event.venueName, '栃木・サンプルアリーナ');
  assert.equal(event.doorsOpen, '15:00');
  assert.equal(event.bellTime, '16:00');
});

// カードには陣営の区切りが無く、名前が平坦に並ぶだけ（parseCard の names も
// 平坦）。陣営は記事本文を読んだ LLM が組み立てる仕事で、開催前には記事が
// 無い。推測で陣営を作らないため、試合は 1 つも書かない。
test('開催前は試合を書かない', () => {
  const { event, unparsed } = parse(SCHED, SCHED_TARGET);
  assert.deepEqual(event.matches, []);
  assert.deepEqual(event.cardMatches, [], 'LLM の検算材料として渡さない');
  assert.deepEqual(unparsed, [], 'カード未反映は取りこぼしではない');
});

test('観衆は開催前には無いので null', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.equal(event.attendance, null);
});
