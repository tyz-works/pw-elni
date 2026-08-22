// 非構造テキスト -> スキーマ準拠 JSON の変換だけを LLM にやらせる。
// 新日本の結果ページは記事本文しか無く、決定論的なパーサでは試合を
// 組み立てられないため、ここだけ LLM に回す。
//
// 原則（CLAUDE.md / spec）:
// - LLM に HTML を渡さない。渡すのは本文テキストだけ
// - LLM に slug を作らせない。返させるのは表示名の文字列だけ。
//   ID の確定は alias 解決の仕事
// - 出力の正しさは LLM に確認させない。スキーマと検証器で機械的に落とす
//
// SDK ではなく REST を fetch で叩く。依存を増やさずに済み、fetch を差し替えて
// ネットワーク無しでテストできるため。
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_MODEL = 'gemini-3.7-flash';

// 1 回の実行で呼ぶ上限。取りこぼしが急に増えても課金が跳ねないための歯止め。
const DEFAULT_MAX_CALLS = 30;

const TIMEOUT_MS = 60_000;

/** 返させる形。slug ではなく表示名を要求する。 */
export const MATCH_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      order: { type: 'integer', description: '第N試合。1 始まり。' },
      sides: {
        type: 'array',
        description: '対戦する陣営。シングルなら 2 要素で各 1 名。',
        items: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              description: '選手の表示名。本文に書かれたとおりの文字列。',
              items: { type: 'string' },
            },
          },
          required: ['names'],
        },
      },
      winnerSideIndex: {
        type: 'integer',
        description: 'sides のインデックス。引き分け・不明は -1。',
      },
      decision: {
        type: 'string',
        description: '決着の種類。',
        enum: ['pinfall', 'submission', 'knockout', 'countout', 'disqualification',
          'over-the-top-rope', 'draw', 'time-limit-draw', 'no-contest', 'unknown'],
      },
      titleName: { type: 'string', description: '王座戦なら王座名。違えば空文字。' },
    },
    required: ['order', 'sides', 'winnerSideIndex', 'decision'],
  },
};

const INSTRUCTION = [
  'あなたはプロレスの試合結果を構造化するツールです。',
  '与えられた記事本文から、実際に行われた試合だけを JSON 配列で返してください。',
  '',
  '規則:',
  '- 選手名は本文に書かれたとおりの文字列をそのまま返す。ローマ字にしない。',
  '- 本文に書かれていないことを補わない。分からない決着は "unknown"。',
  '- 勝者が決まらない試合の winnerSideIndex は -1。',
  '- 記事の感想・次回予告・入場や煽りの描写は試合ではない。含めない。',
  '- 試合が 1 つも書かれていなければ空配列を返す。',
].join('\n');

/** @returns {object} generateContent のリクエストボディ */
export function buildRequest(text, model) {
  return {
    model,
    contents: [{ role: 'user', parts: [{ text: `${INSTRUCTION}\n\n---\n${text}` }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: MATCH_SCHEMA,
      temperature: 0,
    },
  };
}

/**
 * 返答から試合の配列を取り出す。壊れていても例外にしない。
 * 取り出せなければ空配列を返し、呼び出し側は「補えなかった」として扱う。
 * @returns {object[]}
 */
export function parseResponse(body) {
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {{apiKey: string, model?: string, maxCalls?: number, fetchImpl?: typeof fetch}} opts
 * @returns {{ extract: (text: string) => Promise<object[]|null>, calls: () => number, model: string } | null}
 */
export function createExtractor({ apiKey, model = DEFAULT_MODEL, maxCalls = DEFAULT_MAX_CALLS, fetchImpl = fetch } = {}) {
  if (!apiKey) return null;

  let calls = 0;

  return {
    model,
    calls: () => calls,
    /** @returns {Promise<object[]|null>} 補えなかったときは null */
    async extract(text) {
      if (calls >= maxCalls) return null;
      calls += 1;

      const url = `${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildRequest(text, model)),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // 失敗しても例外を投げない。1 団体の失敗で他を止めないため。
        if (!res.ok) return null;
        return parseResponse(await res.json());
      } catch {
        return null;
      }
    },
  };
}
