// 会場名 -> venue slug の索引。venue は wrestler と違い aliases を持たないので、
// 公式が使う表記のゆれをここで組み立てる。
//
// 公式は「都道府県・[市町村・]施設」の形で書くが、前置きが都道府県か市町村かは
// 一定しない（「東京・後楽園ホール」「愛知・今池ガスホール」「福島・楢葉町・
// 天神岬スポーツ公園」）。ありうる組み合わせをすべて鍵にする。
// normalize が中黒を落とすので、連結した 1 語として一致する。
import { buildIndex } from './aliases.mjs';

/** 都道府県名から接尾辞を落とす。「東京都」->「東京」 */
const shortPrefecture = (p) => (p ? p.replace(/[都道府県]$/, '') : null);

/**
 * @param {{slug: string, name: string, nameEn?: string|null, city?: string|null, prefecture?: string|null}[]} venues
 * @returns {Map<string, string>}
 */
export function buildVenueIndex(venues) {
  return buildIndex(venues.map((v) => {
    const pref = shortPrefecture(v.prefecture);
    const aliases = [
      v.nameEn,
      v.city ? `${v.city}・${v.name}` : null,
      pref ? `${pref}・${v.name}` : null,
      pref && v.city ? `${pref}・${v.city}・${v.name}` : null,
    ];
    return { slug: v.slug, name: v.name, aliases: aliases.filter(Boolean) };
  })).index;
}
