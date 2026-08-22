import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVenueIndex } from './venues.mjs';
import { resolve } from './aliases.mjs';

const VENUES = [
  { slug: 'tokyo-korakuen-hall', name: '後楽園ホール', nameEn: 'Korakuen Hall', city: '東京', prefecture: '東京都', aliases: ['東京ドームシティホール'] },
  { slug: 'nagoya-imaike-gas-hall', name: '今池ガスホール', nameEn: null, city: '名古屋', prefecture: '愛知県' },
  { slug: 'naraha-tenjinmisaki-sports-park', name: '天神岬スポーツ公園', nameEn: null, city: '楢葉町', prefecture: '福島県' },
];

const r = (name) => resolve(name, buildVenueIndex(VENUES));

test('施設名だけで解決する', () => {
  assert.equal(r('後楽園ホール'), 'tokyo-korakuen-hall');
});

test('英語表記でも解決する', () => {
  assert.equal(r('Korakuen Hall'), 'tokyo-korakuen-hall');
});

// 公式は「東京・後楽園ホール」と都市を前置きする。
test('都市を前置きした表記で解決する', () => {
  assert.equal(r('東京・後楽園ホール'), 'tokyo-korakuen-hall');
});

// 公式が前置きするのは都市とは限らない。愛知（県）＋名古屋（市）のように
// 県名で書かれることがある。
test('県名を前置きした表記で解決する', () => {
  assert.equal(r('愛知・今池ガスホール'), 'nagoya-imaike-gas-hall');
});

test('県名と市町村を両方前置きした表記で解決する', () => {
  assert.equal(r('福島・楢葉町・天神岬スポーツ公園'), 'naraha-tenjinmisaki-sports-park');
});

test('関係のない名前は解決しない', () => {
  assert.equal(r('東京・存在しないホール'), null);
});

// ネーミングライツで改称したり、部屋名つきで書かれたりする。
// venue も wrestler と同じく aliases で受ける。
test('aliases でも解決する', () => {
  assert.equal(r('東京ドームシティホール'), 'tokyo-korakuen-hall');
});

test('aliases を持たない会場でも壊れない', () => {
  const index = buildVenueIndex([{ slug: 'x', name: 'サンプル会館', city: '東京', prefecture: '東京都' }]);
  assert.equal(resolve('東京・サンプル会館', index), 'x');
});
