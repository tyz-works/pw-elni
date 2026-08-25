// 決まり手の文字列 -> schema の decision。団体をまたいで同じ語彙を使うので
// アダプタから切り出してある。判断できないものは 'unknown'。
// 推測で埋めるより unknown のまま人間に回すほうがよい。
// 決着なしのパターンを先に見る。「両者リングアウト」を「リングアウト」で
// 拾うと勝者のいない countout になり、検証器に落とされる。
const DECISION = [
  [/無効試合|ノーコンテスト/, 'no-contest'],
  [/時間切れ/, 'time-limit-draw'],
  [/両者/, 'draw'],
  [/オーバー・ザ・トップロープ/, 'over-the-top-rope'],
  [/ギブアップ|ギブ/, 'submission'],
  [/レフェリーストップ|TKO|KO/, 'knockout'],
  [/リングアウト/, 'countout'],
  [/反則/, 'disqualification'],
  [/固め|押さえ込み|丸め込み|クラッチ|フォール|ホールド/, 'pinfall'],
];

/** @param {string} text @returns {string} schema の decision */
export function decisionFrom(text) {
  return DECISION.find(([re]) => re.test(text ?? ''))?.[1] ?? 'unknown';
}
