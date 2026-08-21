// 一度人間が見た「既存と抽出の食い違い」を記録し、次から黙らせる。
//
// マージは追記のみなのでデータは壊れないが、人手で書いた notes と公式の
// ※ 行のように永久に食い違うものがある。毎日同じ 16 行がレポートに出ると
// ノイズに慣れて、本当に見るべき食い違いを見落とす。
//
// 鍵には既存側と抽出側の値を両方入れる。公式の表記が変わったり、こちらが
// データを直したりしたら、鍵が変わって再び表に出る。それが狙い。

/** @param {{promotion: string, eventId: string, path: string, existing: unknown, incoming: unknown}} c */
export function conflictKey(c) {
  // 出典 URL は毎回変わりうるので含めない。
  // JSON.stringify で型の違い（1 と "1"）も区別する。
  return JSON.stringify([c.promotion, c.eventId, c.path, c.existing, c.incoming]);
}

/**
 * @param {object[]} conflicts
 * @param {string[]} acknowledgedKeys
 * @returns {{ conflicts: object[], silenced: number }}
 */
export function filterAcknowledged(conflicts, acknowledgedKeys) {
  const known = new Set(acknowledgedKeys);
  const kept = conflicts.filter((c) => !known.has(conflictKey(c)));
  return { conflicts: kept, silenced: conflicts.length - kept.length };
}
