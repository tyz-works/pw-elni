import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest, parseResponse, createExtractor, MATCH_SCHEMA, PROMPT_VERSION } from './llm.mjs';

const PROSE = '第1試合はAとBが対戦。最後はAがフォール勝ちを収めた。';

test('リクエストは JSON 出力を強制する', () => {
  const r = buildRequest(PROSE, 'gemini-3.7-flash');
  assert.equal(r.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(r.generationConfig.responseSchema, MATCH_SCHEMA);
});

// LLM に slug を作らせない。返させるのは表示名の文字列だけ（spec の原則）。
test('スキーマは slug ではなく表示名を要求する', () => {
  const side = MATCH_SCHEMA.items.properties.sides.items;
  assert.ok(side.properties.names, 'names を要求していない');
  assert.ok(!side.properties.wrestlerIds, 'LLM に slug を作らせてはいけない');
});

test('本文をそのままプロンプトに入れる', () => {
  const r = buildRequest(PROSE, 'm');
  assert.ok(JSON.stringify(r.contents).includes(PROSE));
});

test('返ってきた JSON から試合を取り出す', () => {
  const body = {
    candidates: [{ content: { parts: [{ text: JSON.stringify([
      { order: 1, sides: [{ names: ['A'] }, { names: ['B'] }], winnerSideIndex: 0, decision: 'pinfall' },
    ]) }] } }],
  };
  const matches = parseResponse(body);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].sides[0].names, ['A']);
});

test('候補が無ければ空配列', () => {
  assert.deepEqual(parseResponse({ candidates: [] }), []);
  assert.deepEqual(parseResponse({}), []);
});

test('JSON として壊れていれば例外にせず空配列', () => {
  const body = { candidates: [{ content: { parts: [{ text: '{ 壊れた' }] } }] };
  assert.deepEqual(parseResponse(body), []);
});

test('配列でないものが返ったら空配列', () => {
  const body = { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] };
  assert.deepEqual(parseResponse(body), []);
});

test('呼び出し上限を超えたら呼ばずに null を返す', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) };
  };
  const ex = createExtractor({ apiKey: 'k', fetchImpl: fakeFetch, maxCalls: 1 });
  assert.ok(await ex.extract(PROSE));
  assert.equal(await ex.extract(PROSE), null, '上限超過では呼ばない');
  assert.equal(calls, 1);
});

test('API が失敗しても例外を投げず null を返す', async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const ex = createExtractor({ apiKey: 'k', fetchImpl: fakeFetch });
  assert.equal(await ex.extract(PROSE), null);
});

// 握り潰すと「補えなかった」と「呼べていない」が見分けられない。
test('失敗の理由を記録して読み出せる', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'model not found' });
  const ex = createExtractor({ apiKey: 'k', fetchImpl: fakeFetch });
  await ex.extract(PROSE);
  assert.equal(ex.errors().length, 1);
  assert.match(ex.errors()[0], /404/);
  assert.match(ex.errors()[0], /model not found/);
});

test('例外も理由として記録する', async () => {
  const fakeFetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const ex = createExtractor({ apiKey: 'k', fetchImpl: fakeFetch });
  await ex.extract(PROSE);
  assert.match(ex.errors()[0], /ENOTFOUND/);
});

test('記録に API キーを含めない', async () => {
  const fakeFetch = async () => { throw new Error('failed to fetch https://x/?key=SUPERSECRET'); };
  const ex = createExtractor({ apiKey: 'SUPERSECRET', fetchImpl: fakeFetch });
  await ex.extract(PROSE);
  assert.ok(!ex.errors()[0].includes('SUPERSECRET'), `鍵が漏れている: ${ex.errors()[0]}`);
});

test('空の返答も理由として記録する', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ candidates: [] }) });
  const ex = createExtractor({ apiKey: 'k', fetchImpl: fakeFetch });
  assert.deepEqual(await ex.extract(PROSE), []);
  assert.match(ex.errors()[0], /試合を 1 つも返さなかった/);
});

test('API キーが無ければ抽出器を作らない', () => {
  assert.equal(createExtractor({ apiKey: '' }), null);
});

// プロンプトを変えたら古い抽出結果は当てにならない。キャッシュを
// 黙って使い続けないよう、版を持たせて突き合わせる。
test('プロンプトの版を持つ', () => {
  assert.equal(typeof PROMPT_VERSION, 'number');
  assert.ok(PROMPT_VERSION >= 1);
});
