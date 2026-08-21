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

// 公式は選手名にニックネームを前置きすることがある（DDT は頻繁）。
// alias を 1 件ずつ足すと追いつかないので、装飾として落とす。
test('ニックネームの前置きを落として解決する', () => {
  const { index } = buildIndex([{ slug: 'kazuma-sumi', name: '須見和馬', aliases: [] }]);
  assert.equal(resolve('“天翔ける天空聖者”須見和馬', index), 'kazuma-sumi');
  assert.equal(resolve('"Mr.ハイドロポンプ"須見和馬', index), 'kazuma-sumi', '半角引用符も同じ');
});

test('名前の途中の引用符は落とさない', () => {
  assert.equal(normalize('架空“太郎”次郎'), normalize('架空“太郎”次郎'));
  const { index } = buildIndex([{ slug: 'x', name: '架空“太郎”次郎', aliases: [] }]);
  assert.equal(resolve('架空“太郎”次郎', index), 'x');
});

// スターダムは他団体からの参戦を「稲葉あずさ（JTO）」と所属つきで書く。
// 参戦のたびに alias を足しても追いつかないので、装飾として落とす。
test('末尾の所属のカッコ書きを落として解決する', () => {
  const { index } = buildIndex([{ slug: 'azusa-inaba', name: '稲葉あずさ', aliases: [] }]);
  assert.equal(resolve('稲葉あずさ（JTO）', index), 'azusa-inaba');
  assert.equal(resolve('稲葉あずさ(JTO)', index), 'azusa-inaba', '半角カッコも同じ');
});

test('名前の途中のカッコは落とさない', () => {
  const { index } = buildIndex([{ slug: 'x', name: '架空（仮）太郎', aliases: [] }]);
  assert.equal(resolve('架空（仮）太郎', index), 'x');
});

// ニックネームの前置きと所属の後置きが同時に付くこともある。
test('前置きと後置きを両方落とす', () => {
  const { index } = buildIndex([{ slug: 'y', name: '架空次郎', aliases: [] }]);
  assert.equal(resolve('“異名”架空次郎（サンプル団体）', index), 'y');
});
