// 生テキストの永続化。fetch と parse の間に挟むことで、parse 以降を
// ネットワーク非依存にする。gitignore 済みの .cache/ に置く。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/collect/core/ から 3 階層上がってリポジトリルート。
// このファイルを別の深さに移したらここも直すこと。
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = join(ROOT, '.cache', 'snapshots');

export function snapshotPath(promotion, id) {
  return join(BASE, promotion, `${id}.txt`);
}

export function writeSnapshot(promotion, id, text) {
  const p = snapshotPath(promotion, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

/** @returns {string | null} */
export function readSnapshot(promotion, id) {
  const p = snapshotPath(promotion, id);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** @returns {string[]} id の配列。団体のディレクトリが無ければ空配列 */
export function listSnapshots(promotion) {
  const dir = join(BASE, promotion);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4));
}

// 取得元 URL も一緒に置く。parse 段は id しか持たないので、
// URL を id から組み立てるとコアが団体ごとの URL 規約を知ることになる。
const urlPath = (promotion, id) => snapshotPath(promotion, id).replace(/\.txt$/, '.url');

export function writeSnapshotUrl(promotion, id, url) {
  const p = urlPath(promotion, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${url}\n`, 'utf8');
}

/** @returns {string | null} */
export function readSnapshotUrl(promotion, id) {
  const p = urlPath(promotion, id);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}
