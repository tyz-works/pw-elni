// LLM が返した陣営分け・勝敗を、公式カードから決定論的に取れた分と突き合わせる。
//
// これが「LLM の出力を非 LLM で検算する」部分。カードには出場選手が平坦に
// 並んでいるので、LLM が返した名前がそこに過不足なく収まっているかを機械的に
// 確かめられる。合わなければその試合は採らない。
//
// 時間・決まり手・制限時間は公式カードの値を使う。LLM の判断より優先する。
import { normalize } from './aliases.mjs';
import { decisionFrom } from './decision.mjs';

const DRAWISH = ['draw', 'time-limit-draw', 'no-contest'];

const nameKey = (names) => [...names].map(normalize).sort().join('|');

/**
 * LLM が返した試合に対応するカードを、選手名の集合で引き当てる。
 *
 * 試合順では引き当てられない。記事本文の数え方と公式カードの番号が
 * 一致しない興行がある（共催興行など）。名前の集合なら番号のずれに
 * 影響されず、引き当てられた時点で名前の検算も済んでいる。
 *
 * 同じ顔合わせが 2 試合あるときはどちらか決められないので引き当てない。
 *
 * @param {object} llm
 * @param {object[]} cards
 * @returns {object|undefined}
 */
export function findCardFor(llm, cards) {
  const key = nameKey((llm.sides ?? []).flatMap((s) => s.names ?? []));
  const hits = cards.filter((c) => nameKey(c.names) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * LLM が返した試合の並びと、カードの並びを選手名の集合で対応付ける。
 *
 * 同じ顔合わせが 2 度組まれることがある（引き分け後の延長戦など）。
 * どちらも本物の試合なので、同じ集合が複数あれば出現順で割り当てる。
 *
 * @param {object[]} llmMatches
 * @param {object[]} cards
 * @returns {{llm: object, card: object|undefined}[]}
 */
export function pairWithCards(llmMatches, cards) {
  const byKey = new Map();
  for (const c of cards) {
    const key = nameKey(c.names);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }

  const used = new Map();
  return llmMatches.map((llm) => {
    const key = nameKey((llm.sides ?? []).flatMap((s) => s.names ?? []));
    const i = used.get(key) ?? 0;
    used.set(key, i + 1);
    return { llm, card: byKey.get(key)?.[i] };
  });
}

/**
 * @param {object} llm LLM が返した 1 試合
 * @param {object|undefined} card 同じ order のカード
 * @returns {{ match: object|null, problems: string[] }}
 */
export function mergeLlmMatch(llm, card) {
  const problems = [];

  if (!card) {
    const names = (llm.sides ?? []).flatMap((s) => s.names ?? []).join(' / ');
    problems.push(`第 ${llm.order} 試合: カードに同じ顔合わせが無い（${names}）`);
    return { match: null, problems };
  }

  const sides = (llm.sides ?? []).map((s) => ({
    names: s.names ?? [],
    teamName: null,
  }));

  const llmNames = sides.flatMap((s) => s.names);
  const cardKeys = new Set(card.names.map(normalize));
  const llmKeys = new Set(llmNames.map(normalize));

  const invented = llmNames.filter((n) => !cardKeys.has(normalize(n)));
  if (invented.length) {
    problems.push(`第 ${card.order} 試合: カードに無い選手名 ${invented.join(' / ')}`);
  }
  const missing = card.names.filter((n) => !llmKeys.has(normalize(n)));
  if (missing.length) {
    problems.push(`第 ${card.order} 試合: カードにいる選手が抜けている ${missing.join(' / ')}`);
  }
  if (problems.length) return { match: null, problems };

  // 決まり手は公式が書いている。そこから決まるならそれを使う。
  const fromCard = decisionFrom(card.finishText);
  const decision = fromCard === 'unknown' ? (llm.decision ?? 'unknown') : fromCard;

  const winner = Number.isInteger(llm.winnerSideIndex) && llm.winnerSideIndex >= 0
    ? llm.winnerSideIndex
    : null;

  // 勝者が分からない試合はスキーマ上「決着なし」としか表せない。
  // 推測で勝者を作らず、結果ごと未確定にする。
  const result = winner === null && !DRAWISH.includes(decision)
    ? null
    : {
      winnerSideIndex: winner,
      decision,
      finishText: card.finishText,
      durationSeconds: card.durationSeconds,
    };

  const title = card.subtitle && /『(.+?)』選手権試合/.exec(card.subtitle);

  return {
    match: {
      order: card.order,
      matchType: null, // sides の人数から run.mjs 側で決める
      sides,
      titleName: title ? title[1] : null,
      timeLimitMinutes: card.timeLimitMinutes,
      result,
      notes: null,
    },
    problems,
  };
}
