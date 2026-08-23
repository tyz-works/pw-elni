import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeGenerated, START, END, renderEvent, renderWrestlerBody, renderVenueBody,
} from './notes.mjs';

test('マーカーが無ければ末尾に足す', () => {
  const out = mergeGenerated('# 手書き\n\n本文\n', '生成した中身');
  assert.match(out, /# 手書き/);
  assert.match(out, /本文/);
  assert.ok(out.includes(START) && out.includes(END));
  assert.ok(out.indexOf('本文') < out.indexOf(START), '手書きより後ろに置く');
});

// ここが肝。手書きのノートを壊さないための仕組み。
test('マーカーの中だけを差し替え、外側は 1 文字も変えない', () => {
  const before = `---\ntype: wrestler\n---\n\n# 見出し\n\n${START}\n古い生成物\n${END}\n\n## メモ\n大事な手書き\n`;
  const after = mergeGenerated(before, '新しい生成物');
  assert.match(after, /type: wrestler/);
  assert.match(after, /# 見出し/);
  assert.match(after, /## メモ\n大事な手書き/);
  assert.match(after, /新しい生成物/);
  assert.ok(!after.includes('古い生成物'));
});

test('既存が空なら生成物だけになる', () => {
  const out = mergeGenerated('', '中身');
  assert.match(out, /中身/);
});

test('中身が同じなら結果も同じ（何度流しても差分が出ない）', () => {
  const once = mergeGenerated('# 見出し\n', '中身');
  assert.equal(mergeGenerated(once, '中身'), once);
});

test('終わりのマーカーが無ければ壊さず末尾に足す', () => {
  const broken = `# 見出し\n\n${START}\n途中で切れている\n`;
  const out = mergeGenerated(broken, '新しい中身');
  assert.match(out, /# 見出し/);
  assert.match(out, /新しい中身/);
});

const EVENT = {
  eventId: 'njpw-20260816-0', name: 'G1 CLIMAX 36 最終戦', date: '2026-08-16',
  promotionSlug: 'njpw', venueSlug: 'tokyo-ryogoku-kokugikan', attendance: 7260,
  officialUrl: 'https://example.test/x',
  matches: [{
    order: 1, matchType: 'tag', titleName: null, timeLimitMinutes: 30,
    sides: [{ wrestlerIds: ['a', 'b'], teamName: null }, { wrestlerIds: ['c', 'd'], teamName: null }],
    result: { winnerSideIndex: 0, decision: 'pinfall', finishMoveSlug: null, durationSeconds: 541 },
    confirmed: true, notes: null,
  }],
};
const NAMES = { a: '選手A', b: '選手B', c: '選手C', d: '選手D' };
const VENUES = { 'tokyo-ryogoku-kokugikan': '両国国技館' };

test('興行ノートに対戦カードを書く', () => {
  const md = renderEvent(EVENT, { wrestlerNames: NAMES, venueNames: VENUES });
  assert.match(md, /\[\[選手A\]\] & \[\[選手B\]\]/);
  assert.match(md, /vs/);
  assert.match(md, /\[\[両国国技館\]\]/);
  assert.match(md, /\[\[NJPW\]\]/);
  assert.match(md, /9分1秒|9:01/, '試合時間が出る');
});

test('興行ノートに出典リンクを入れる', () => {
  const md = renderEvent(EVENT, { wrestlerNames: NAMES, venueNames: VENUES });
  assert.match(md, /https:\/\/example\.test\/x/);
});

// 未発表・未確定を断定しない。
test('勝者がいない試合は勝者を書かない', () => {
  const e = { ...EVENT, matches: [{ ...EVENT.matches[0], result: null }] };
  const md = renderEvent(e, { wrestlerNames: NAMES, venueNames: VENUES });
  assert.ok(!md.includes('勝者'));
});

test('選手ノートに出場興行を並べる', () => {
  const md = renderWrestlerBody('a', [EVENT], { wrestlerNames: NAMES });
  assert.match(md, /\[\[njpw-20260816-0\]\]/);
  assert.match(md, /2026-08-16/);
});

test('会場ノートに開催興行を並べる', () => {
  const md = renderVenueBody('tokyo-ryogoku-kokugikan', [EVENT]);
  assert.match(md, /\[\[njpw-20260816-0\]\]/);
});
