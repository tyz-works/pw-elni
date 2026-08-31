import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parse, listTargets, PROMOTION } from './stardom.mjs';

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

test('試合を 4 つ取り order を振る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches.map((m) => m.order), [1, 2, 3, 4]);
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

// 時間切れ引き分けは時間が「15分」と秒なしで書かれる。
test('時間切れ引き分けを取る', () => {
  const { event } = parse(RAW, TARGET);
  const m = event.matches[3];
  assert.equal(m.result.durationSeconds, 900);
  assert.equal(m.result.decision, 'time-limit-draw');
  assert.equal(m.result.winnerSideIndex, null);
  assert.deepEqual(m.sides.map((s) => s.names), [['架空はな'], ['架空すず']]);
});

// 星取表の行は決まり手の後に来る。選手名として拾ってはいけない。
test('星取表の行を選手名にしない', () => {
  const { event } = parse(RAW, TARGET);
  const names = event.matches.flatMap((m) => m.sides.flatMap((s) => s.names));
  assert.ok(!names.some((n) => n.includes('勝')), `星取表が混ざっている: ${names}`);
});

// --- スケジュール（今後の興行）---
// 開催前と開催後で URL が同じ（/event/{slug}/）。結果一覧に出ていない
// ものだけを schedule として扱う。

const SCHED = readFileSync(new URL('../__fixtures__/stardom/schedule-sample.txt', import.meta.url), 'utf8');
const SCHED_TARGET = { id: '20260906_korakuen', url: 'https://example.test/event/20260906_korakuen/', kind: 'schedule' };

test('スケジュールから日時・会場・大会名を取る', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.equal(event.eventId, 'stardom-20260906-0');
  assert.equal(event.name, 'サンプル大会 2026 Sep.');
  assert.equal(event.date, '2026-09-06');
  assert.equal(event.venueName, '東京・サンプルホール');
});

// 開場・開始はスターダムのページには無い。推測で埋めない。
test('時刻は取れないので null', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.equal(event.doorsOpen, null);
  assert.equal(event.bellTime, null);
});

// 開催前のカードは暫定。公式が差し替えたら丸ごと入れ替わる前提で、
// ページに載っている順に番号を振る（結果が入る時点で全部置き換わる）。
test('開催前のカードを載っている順に取る', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.deepEqual(event.matches.map((m) => `${m.segment}:${m.order}`), ['card:1', 'card:2', 'card:3']);
  assert.deepEqual(event.matches.map((m) => m.matchType), ['singles', 'singles', 'tag']);
});

test('VS で陣営を分ける', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.deepEqual(event.matches[0].sides, [
    { names: ['架空十三子'], teamName: null },
    { names: ['架空十四子'], teamName: null },
  ]);
  assert.deepEqual(event.matches[2].sides, [
    { names: ['架空十七子', '架空十八子'], teamName: null },
    { names: ['架空十九子', '架空二十子'], teamName: null },
  ]);
});

// ≪王者≫ ≪王者組≫ は落とす。実データでは「挑戦者組」だけ ≪≫ が付いて
// おらず、括弧の有無が揺れている。
test('王者・挑戦者のラベルは括弧の有無に関わらず落とす', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  const names = event.matches.flatMap((m) => m.sides.flatMap((s) => s.names));
  assert.ok(!names.some((n) => n.includes('王者')), `ラベルが選手名になっている: ${names}`);
  assert.ok(!names.some((n) => n.includes('挑戦者')), `ラベルが選手名になっている: ${names}`);
});

test('選手権試合の見出しを titleName にする', () => {
  const { event } = parse(SCHED, SCHED_TARGET);
  assert.deepEqual(event.matches.map((m) => m.titleName), [
    null, 'サンプル選手権試合', 'サンプル・タッグ選手権試合',
  ]);
});

// 開催前なので勝敗は無い。confirmed はカードが公式発表済みという意味。
test('結果は null、カードは発表済みとして扱う', () => {
  const { event, unparsed } = parse(SCHED, SCHED_TARGET);
  assert.deepEqual(event.matches.map((m) => m.result), [null, null, null]);
  assert.deepEqual(event.matches.map((m) => m.confirmed), [true, true, true]);
  assert.deepEqual(unparsed, [], 'カードは取りこぼしではない');
});

// listTargets は「結果一覧との突き合わせ」「月送り」「過去の切り捨て」が
// 重なる場所なので、取得をスタブして振る舞いを固定する。
function stubFetcher(byUrl) {
  return { fetchLinks: async (url) => byUrl[url] ?? [] };
}

test('結果に出ている興行は result、出ていない未来の興行は schedule', async () => {
  const f = stubFetcher({
    'https://wwr-stardom.com/results/': ['https://wwr-stardom.com/event/20260823_ryogoku/'],
    'https://wwr-stardom.com/schedule/?ym=202609': [
      'https://wwr-stardom.com/event/20260823_ryogoku/',   // 結果に出ている
      'https://wwr-stardom.com/event/20260906_korakuen/',  // 未来
    ],
  });
  const targets = await listTargets(f, '2026-09-01');
  assert.deepEqual(targets.map((t) => `${t.kind}:${t.id}`), [
    'result:20260823_ryogoku',
    'schedule:20260906_korakuen',
  ]);
});

// 結果一覧の 1 ページ目から溢れた古い興行を毎日取りに行かないこと。
test('スケジュールに残っている過去の興行は取りに行かない', async () => {
  const f = stubFetcher({
    'https://wwr-stardom.com/results/': [],
    'https://wwr-stardom.com/schedule/?ym=202609': [
      'https://wwr-stardom.com/event/20260726_joetsu/',
      'https://wwr-stardom.com/event/20260906_korakuen/',
    ],
  });
  const targets = await listTargets(f, '2026-09-01');
  assert.deepEqual(targets.map((t) => t.id), ['20260906_korakuen']);
});

// 日付で始まらない slug は判断できない。黙って落とさない。
test('日付で始まらない slug は落とさない', async () => {
  const f = stubFetcher({
    'https://wwr-stardom.com/results/': [],
    'https://wwr-stardom.com/schedule/?ym=202609': ['https://wwr-stardom.com/event/special-event/'],
  });
  const targets = await listTargets(f, '2026-09-01');
  assert.deepEqual(targets.map((t) => t.id), ['special-event']);
});
