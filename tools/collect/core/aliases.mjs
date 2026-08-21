// 表示名 → wrestler slug の解決。正規化後の完全一致のみで、曖昧一致はしない。
// 誤爆は静かに嘘になるが、取りこぼしは人間に上がれば直るため、取りこぼす側に倒す。

// 公式表記と記事本文で揺れる異体字だけを対象にする。増やすときはテストも足すこと。
const VARIANTS = new Map([['髙', '高'], ['﨑', '崎']]);

// 公式は選手名にニックネームを前置きすることがある（DDT は頻繁）。
// alias を 1 件ずつ足しても追いつかないので、装飾として落とす。
// 落とすのは行頭のものだけ。名前の途中の引用符には触らない。
const NICKNAME_PREFIX = /^["\u201c][^"\u201d]*["\u201d]/;

// 他団体からの参戦は所属をカッコ書きで併記する（「稲葉あずさ（JTO）」）。
// 参戦のたびに alias を足しても追いつかないので、これも装飾として落とす。
// 落とすのは末尾のものだけ。名前の途中のカッコには触らない。
// NFKC で全角カッコは半角になるので、半角だけを見ればよい。
const AFFILIATION_SUFFIX = /\([^()]*\)$/;

/** @param {string} name */
export function normalize(name) {
  const nfkc = name.normalize('NFKC')
    .replace(NICKNAME_PREFIX, '')
    .replace(AFFILIATION_SUFFIX, '');
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
