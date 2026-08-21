import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildIndex, resolve } from './aliases.mjs';

test('中黒とスペースを落とす', () => {
  assert.equal(normalize('ヤス・ウラノ'), normalize('ヤスウラノ'));
  assert.equal(normalize('正田 壮史'), normalize('正田壮史'));
  assert.equal(normalize('オカダ　カズチカ'), normalize('オカダカズチカ'));
});

test('英字は大文字小文字を無視する', () => {
  assert.equal(normalize('KONOSUKE TAKESHITA'), normalize('Konosuke Takeshita'));
});

test('全角英数を半角に寄せる', () => {
  assert.equal(normalize('ＭＡＯ'), normalize('MAO'));
});

test('異体字を寄せる', () => {
  assert.equal(normalize('髙木三四郎'), normalize('高木三四郎'));
  assert.equal(normalize('宮﨑'), normalize('宮崎'));
});

test('別人は別のキーになる', () => {
  assert.notEqual(normalize('葛西純'), normalize('葛西陽向'));
});

const WRESTLERS = [
  { slug: 'harashima', name: 'HARASHIMA', aliases: ['Harashima', 'ハラシマ'] },
  { slug: 'sanshiro-takagi', name: '髙木三四郎', aliases: ['高木三四郎'] },
];

test('name と aliases の両方から引ける', () => {
  const { index } = buildIndex(WRESTLERS);
  assert.equal(resolve('HARASHIMA', index), 'harashima');
  assert.equal(resolve('ハラシマ', index), 'harashima');
  assert.equal(resolve('高木三四郎', index), 'sanshiro-takagi');
});

test('解決できない名前は null', () => {
  const { index } = buildIndex(WRESTLERS);
  assert.equal(resolve('存在しない選手', index), null);
});

test('同一選手内で正規化キーが重なっても衝突にしない', () => {
  const { collisions } = buildIndex(WRESTLERS);
  assert.deepEqual(collisions, [], 'HARASHIMA と Harashima は同じ slug なので衝突ではない');
});

test('別の選手が同じ正規化キーを持てば衝突として報告する', () => {
  const { collisions } = buildIndex([
    { slug: 'a', name: '高木三四郎', aliases: [] },
    { slug: 'b', name: '髙木三四郎', aliases: [] },
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].slugs.sort(), ['a', 'b']);
});

test('曖昧一致はしない', () => {
  const { index } = buildIndex(WRESTLERS);
  assert.equal(resolve('HARASHIM', index), null, '1 文字違いは解決しない');
});
