// 表示名 → wrestler slug の解決。正規化後の完全一致のみで、曖昧一致はしない。
// 誤爆は静かに嘘になるが、取りこぼしは人間に上がれば直るため、取りこぼす側に倒す。

// 公式表記と記事本文で揺れる異体字だけを対象にする。増やすときはテストも足すこと。
const VARIANTS = new Map([['髙', '高'], ['﨑', '崎']]);

/** @param {string} name */
export function normalize(name) {
  const nfkc = name.normalize('NFKC');
  let out = '';
  for (const ch of nfkc) out += VARIANTS.get(ch) ?? ch;
  return out.replace(/[・\s]/g, '').toLowerCase();
}

/**
 * @param {{slug: string, name: string, aliases: string[]}[]} wrestlers
 * @returns {{ index: Map<string,string>, collisions: {key: string, slugs: string[]}[] }}
 */
export function buildIndex(wrestlers) {
  const index = new Map();
  const collisions = [];
  for (const w of wrestlers) {
    for (const label of [w.name, ...w.aliases]) {
      const key = normalize(label);
      const prev = index.get(key);
      if (prev === undefined) { index.set(key, w.slug); continue; }
      if (prev !== w.slug) collisions.push({ key, slugs: [prev, w.slug] });
    }
  }
  return { index, collisions };
}

/** @returns {string | null} */
export function resolve(name, index) {
  return index.get(normalize(name)) ?? null;
}
