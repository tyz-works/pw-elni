import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * data/ を content collections として読む。
 *
 * ここでは zod スキーマを定義しない。データの正しさの単一の門は
 * data/schema/*.json + tools/validate.mjs であり、zod で書き直すと
 * 二重定義になって必ずドリフトする。
 * `npm run build` は validate を先に通すので、壊れたデータがここへ来ることはない。
 */
const fromData = (dir: string) =>
  defineCollection({
    loader: glob({
      pattern: '**/*.json',
      base: `../data/${dir}`,
      // ファイル名 (= slug / eventId / news id) をそのまま ID にする。
      // validate.mjs が「ファイル名 == キー」を保証している。
      generateId: ({ entry }) => entry.replace(/\.json$/, '').split('/').pop()!,
    }),
  });

export const collections = {
  promotions: fromData('promotions'),
  wrestlers: fromData('wrestlers'),
  venues: fromData('venues'),
  moves: fromData('moves'),
  events: fromData('events'),
  news: fromData('news'),
};
