// 試合を指す鍵・並び順・人間向けラベル。
//
// `order` は segment ごとの連番なので、**order だけでは試合を特定できない**。
// ダークマッチの 1 と本戦の第 1 試合は別の試合。突き合わせは必ず matchKey で行う。
// 3 箇所（merge の identity / 消えた試合の検知 / レポートの表記）が同じ規則を
// 持つ必要があるので、ここに集約する。

const segmentOf = (m) => m.segment ?? 'card';

/** 突き合わせ用の鍵。 */
export function matchKey(m) {
  return `${segmentOf(m)}:${m.order}`;
}

/** 並び順の基準。ダークマッチは本戦の前に行われる。 */
export function matchRank(m) {
  return (segmentOf(m) === 'dark' ? 0 : 1000) + m.order;
}

/** レポートに出す人間向けの表記。 */
export function matchLabel(m) {
  return segmentOf(m) === 'dark' ? `第 ${m.order} ダークマッチ` : `第 ${m.order} 試合`;
}
