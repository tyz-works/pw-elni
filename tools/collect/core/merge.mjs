// 追記マージ。既存値は上書きせず conflict として返す純関数。
// ファイル I/O・ネットワーク・git は一切呼ばない。
import { isDeepStrictEqual } from 'node:util';

const isEmpty = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} existing 既存の JSON（読み取り専用として扱う）
 * @param {object} incoming 抽出した部分 JSON
 * @param {{ sourceUrl?: string|null }} opts
 * @returns {{ merged: object, conflicts: Conflict[] }}
 */
export function merge(existing, incoming, { sourceUrl = null } = {}) {
  const conflicts = [];
  const merged = mergeValue(existing, incoming, '', conflicts, sourceUrl, null);
  return { merged, conflicts };
}

function mergeValue(existing, incoming, path, conflicts, sourceUrl, key) {
  if (isEmpty(incoming)) return existing;
  if (isEmpty(existing)) return incoming;

  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const out = { ...existing };
    for (const k of Object.keys(incoming)) {
      out[k] = mergeValue(existing[k], incoming[k], path ? `${path}.${k}` : k, conflicts, sourceUrl, k);
    }
    return out;
  }

  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return mergeArray(existing, incoming, path, conflicts, sourceUrl, key);
  }

  if (isDeepStrictEqual(existing, incoming)) return existing;

  // 唯一の特別扱い: 未発表 → 発表済みの単調な遷移だけ許可する
  if (key === 'confirmed' && existing === false && incoming === true) return true;

  conflicts.push({ path, existing, incoming, sourceUrl });
  return existing;
}

function mergeArray(existing, incoming, path, conflicts, sourceUrl, key) {
  // sources: URL で重複排除して追記。既存エントリには触らない
  if (key === 'sources') {
    const out = existing.slice();
    const seen = new Set(out.map((s) => s.url));
    for (const s of incoming) {
      if (!seen.has(s.url)) { out.push(s); seen.add(s.url); }
    }
    return out;
  }

  // matches: order を identity にする
  if (key === 'matches') {
    const out = existing.slice();
    const indexByOrder = new Map(out.map((m, i) => [m.order, i]));
    for (const m of incoming) {
      const i = indexByOrder.get(m.order);
      if (i === undefined) { out.push(m); continue; }
      out[i] = mergeValue(out[i], m, `${path}[order=${m.order}]`, conflicts, sourceUrl, null);
    }
    return out.sort((a, b) => a.order - b.order);
  }

  // sides: 位置を identity にする。要素数が違えば conflict
  if (key === 'sides') {
    if (existing.length !== incoming.length) {
      conflicts.push({ path, existing, incoming, sourceUrl });
      return existing;
    }
    return existing.map((s, i) =>
      mergeValue(s, incoming[i], `${path}[${i}]`, conflicts, sourceUrl, null));
  }

  // スカラー配列（wrestlerIds など）は全体で比較する
  if (isDeepStrictEqual(existing, incoming)) return existing;
  conflicts.push({ path, existing, incoming, sourceUrl });
  return existing;
}
