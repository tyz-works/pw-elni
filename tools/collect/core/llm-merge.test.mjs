import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeLlmMatch, findCardFor, pairWithCards } from './llm-merge.mjs';

const CARD = {
  order: 1,
  timeLimitMinutes: 30,
  subtitle: null,
  names: ['ウルフアロン', 'HENARE'],
  durationSeconds: 541,
  finishText: 'リバースアングルスラム→片エビ固め',
};
const LLM = {
  order: 1,
  sides: [{ names: ['ウルフアロン'] }, { names: ['HENARE'] }],
  winnerSideIndex: 0,
  decision: 'unknown',
};

test('陣営は LLM、時間と決まり手はカードから取る', () => {
  const { match, problems } = mergeLlmMatch(LLM, CARD);
  assert.deepEqual(problems, []);
  assert.deepEqual(match.sides, [
    { names: ['ウルフアロン'], teamName: null },
    { names: ['HENARE'], teamName: null },
  ]);
  assert.equal(match.timeLimitMinutes, 30);
  assert.equal(match.result.durationSeconds, 541);
  assert.equal(match.result.finishText, 'リバースアングルスラム→片エビ固め');
  assert.equal(match.result.winnerSideIndex, 0);
});

// 決まり手はカードに書かれている。LLM の判断より公式の文字列を優先する。
test('決着はカードの決まり手から決める', () => {
  const { match } = mergeLlmMatch({ ...LLM, decision: 'submission' }, CARD);
  assert.equal(match.result.decision, 'pinfall', '片エビ固めなので pinfall');
});

test('カードの決まり手から決められなければ LLM の判断を使う', () => {
  const card = { ...CARD, finishText: 'レフェリーストップ' };
  const { match } = mergeLlmMatch({ ...LLM, decision: 'pinfall' }, card);
  assert.equal(match.result.decision, 'knockout', 'カードから決まる場合はそちら');

  const card2 = { ...CARD, finishText: null };
  const { match: m2 } = mergeLlmMatch({ ...LLM, decision: 'submission' }, card2);
  assert.equal(m2.result.decision, 'submission');
});

// ここが LLM の出力を非 LLM で検算する部分。
test('カードに無い選手名を返してきたら採らない', () => {
  const bad = { ...LLM, sides: [{ names: ['ウルフアロン'] }, { names: ['実在しない選手'] }] };
  const { match, problems } = mergeLlmMatch(bad, CARD);
  assert.equal(match, null);
  assert.match(problems[0], /実在しない選手/);
});

test('カードにいる選手を落としていたら採らない', () => {
  const missing = { ...LLM, sides: [{ names: ['ウルフアロン'] }] };
  const { match, problems } = mergeLlmMatch(missing, CARD);
  assert.equal(match, null);
  assert.match(problems[0], /HENARE/);
});

test('表記のゆれは同じ名前として扱う', () => {
  const card = { ...CARD, names: ['鷹木 信悟', 'ジェイク・リー'] };
  const llm = { ...LLM, sides: [{ names: ['鷹木信悟'] }, { names: ['ジェイクリー'] }] };
  const { match, problems } = mergeLlmMatch(llm, card);
  assert.deepEqual(problems, []);
  assert.ok(match);
});

test('カードに無い試合順は採らない', () => {
  const { match, problems } = mergeLlmMatch({ ...LLM, order: 99 }, undefined);
  assert.equal(match, null);
  assert.match(problems[0], /99/);
});

test('王座戦の副題から王座名を取る', () => {
  const card = { ...CARD, subtitle: '『サンプル王座』選手権試合' };
  const { match } = mergeLlmMatch(LLM, card);
  assert.equal(match.titleName, 'サンプル王座');
});

// 勝者が分からない試合はスキーマ上「決着なし」としか表せない。
// 推測で勝者を作らず、結果ごと未確定にする。
test('勝者が分からなければ結果を未確定にする', () => {
  const { match } = mergeLlmMatch({ ...LLM, winnerSideIndex: -1 }, { ...CARD, finishText: null });
  assert.equal(match.result, null);
});

test('引き分けは勝者なしのまま結果を残す', () => {
  const card = { ...CARD, finishText: '時間切れ引き分け' };
  const { match } = mergeLlmMatch({ ...LLM, winnerSideIndex: -1 }, card);
  assert.equal(match.result.decision, 'time-limit-draw');
  assert.equal(match.result.winnerSideIndex, null);
});

// 記事本文の数え方と公式カードの番号が一致しない興行がある
// （AEW との共催興行で LLM が 12 試合と数え、カードは 9 試合だった）。
// 番号ではなく選手名の集合で突き合わせる。
test('選手名の集合でカードを引き当てる', () => {
  const cards = [
    { ...CARD, order: 1, names: ['A', 'B'] },
    { ...CARD, order: 2, names: ['ウルフアロン', 'HENARE'] },
  ];
  const { match, problems } = mergeLlmMatch({ ...LLM, order: 99 }, findCardFor(LLM, cards));
  assert.deepEqual(problems, []);
  assert.equal(match.order, 2, 'カード側の試合順を採る');
});

test('表記のゆれがあっても引き当てる', () => {
  const cards = [{ ...CARD, order: 3, names: ['鷹木 信悟', 'ジェイク・リー'] }];
  const llm = { ...LLM, sides: [{ names: ['鷹木信悟'] }, { names: ['ジェイク・リー'] }] };
  assert.equal(findCardFor(llm, cards)?.order, 3);
});

test('どのカードとも合わなければ引き当てない', () => {
  const cards = [{ ...CARD, order: 1, names: ['A', 'B'] }];
  assert.equal(findCardFor(LLM, cards), undefined);
});

test('同じ顔合わせが 2 試合あれば引き当てない', () => {
  const cards = [{ ...CARD, order: 1 }, { ...CARD, order: 5 }];
  assert.equal(findCardFor(LLM, cards), undefined, 'どちらか決められないなら採らない');
});

// 同じ顔合わせが 2 度組まれることがある（引き分け後の延長戦など）。
// どちらも本物の試合なので、出現順で対応付ける。
test('同じ顔合わせが複数あれば出現順で対応付ける', () => {
  const cards = [
    { ...CARD, order: 7, durationSeconds: 300, finishText: '時間切れ引き分け' },
    { ...CARD, order: 7, durationSeconds: 18, finishText: 'タイガースープレックスホールド' },
  ];
  const llms = [
    { ...LLM, order: 7, winnerSideIndex: -1 },
    { ...LLM, order: 7, winnerSideIndex: 0 },
  ];
  const pairs = pairWithCards(llms, cards);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].card.durationSeconds, 300);
  assert.equal(pairs[1].card.durationSeconds, 18);
});

test('カードより多く返してきた分は対応付かない', () => {
  const pairs = pairWithCards([LLM, LLM], [CARD]);
  assert.ok(pairs[0].card);
  assert.equal(pairs[1].card, undefined);
});
