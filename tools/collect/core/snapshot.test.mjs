import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  snapshotPath, writeSnapshot, readSnapshot, listSnapshots, writeSnapshotUrl, readSnapshotUrl,
} from './snapshot.mjs';

// 実在の団体 slug と衝突させない。テストの後始末でこのディレクトリごと消す。
const P = 'test-promotion';

test.after(() => rmSync(dirname(snapshotPath(P, 'x')), { recursive: true, force: true }));

// 末尾改行はリポジトリの改行規約に合わせるための意図的な挙動。
// 読み出しはバイト列をそのまま返すので、書いたものより 1 文字長くなる。
test('書いたものが読める（末尾改行が付く）', () => {
  writeSnapshot(P, 'e1', 'ほんぶん');
  assert.equal(readSnapshot(P, 'e1'), 'ほんぶん\n');
});

test('既に末尾改行があれば二重に付けない', () => {
  writeSnapshot(P, 'e3', 'ほんぶん\n');
  assert.equal(readSnapshot(P, 'e3'), 'ほんぶん\n');
});

test('無いものは null', () => {
  assert.equal(readSnapshot(P, 'missing'), null);
});

test('上書きできる', () => {
  writeSnapshot(P, 'e2', 'ふるい');
  writeSnapshot(P, 'e2', 'あたらしい');
  assert.equal(readSnapshot(P, 'e2'), 'あたらしい\n');
});

test('id の一覧が取れる', () => {
  writeSnapshot(P, 'e1', 'a');
  writeSnapshot(P, 'e2', 'b');
  assert.deepEqual(listSnapshots(P).sort(), ['e1', 'e2', 'e3']);
});

test('URL のファイルは id の一覧に混ざらない', () => {
  writeSnapshot(P, 'e4', 'a');
  writeSnapshotUrl(P, 'e4', 'https://example.test/e4');
  assert.ok(listSnapshots(P).includes('e4'));
  assert.equal(listSnapshots(P).filter((id) => id === 'e4').length, 1);
});

test('団体のディレクトリが無ければ空配列', () => {
  assert.deepEqual(listSnapshots('no-such-promotion'), []);
});

test('URL を保存して読み出せる', () => {
  writeSnapshotUrl(P, 'e1', 'https://example.test/a');
  assert.equal(readSnapshotUrl(P, 'e1'), 'https://example.test/a');
});

test('URL が無ければ null', () => {
  assert.equal(readSnapshotUrl(P, 'no-url'), null);
});
