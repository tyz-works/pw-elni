#!/usr/bin/env node
/**
 * data/ 配下の JSON を機械的に検証する。
 *
 * 1. JSON Schema (draft 2020-12) 検証
 * 2. 整合チェック（孤立参照 / 重複 / 日付整合 / 必須出典 / 配置規約）
 *
 * 1 件でも違反があれば exit 1。LLM に「正しいか確認して」はやらせない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ajvModule from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const Ajv2020 = ajvModule.default ?? ajvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// --data <dir> で検証対象を差し替えられる（tools/validate.test.mjs が使う）。
// スキーマは常にリポジトリ内のものを使う。
const dataArgIndex = process.argv.indexOf('--data');
const DATA = dataArgIndex !== -1 && process.argv[dataArgIndex + 1]
  ? resolve(process.cwd(), process.argv[dataArgIndex + 1])
  : join(ROOT, 'data');
const SCHEMA_DIR = join(ROOT, 'data', 'schema');

/* ------------------------------------------------------------------ */
/* エラー収集                                                          */
/* ------------------------------------------------------------------ */
const errors = [];
const rel = (p) => relative(ROOT, p);
const fail = (file, message) => errors.push({ file: typeof file === 'string' ? file : rel(file), message });

/* ------------------------------------------------------------------ */
/* ファイル走査                                                        */
/* ------------------------------------------------------------------ */
function walkJson(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkJson(p));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

function readJson(p) {
  const raw = readFileSync(p, 'utf8');
  if (raw.includes('\r')) fail(p, 'CRLF が混入している。LF で保存すること。');
  if (!raw.endsWith('\n')) fail(p, '末尾に改行がない。');
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(p, `JSON パース失敗: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* ajv セットアップ                                                    */
/* ------------------------------------------------------------------ */
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const SCHEMA_FILES = ['common', 'promotion', 'wrestler', 'venue', 'move', 'match', 'event', 'news'];
const validators = {};
for (const name of SCHEMA_FILES) {
  const p = join(SCHEMA_DIR, `${name}.schema.json`);
  let schema;
  try {
    schema = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`スキーマを読めない: ${rel(p)}: ${err.message}`);
    process.exit(1);
  }
  ajv.addSchema(schema, schema.$id);
}
for (const name of SCHEMA_FILES) {
  if (name === 'common') continue; // 単体検証には使わない共有 $defs
  try {
    validators[name] = ajv.getSchema(`https://pw.elni.net/schema/${name}.schema.json`);
  } catch (err) {
    console.error(`スキーマのコンパイル失敗 (${name}): ${err.message}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* エンティティ定義                                                    */
/* ------------------------------------------------------------------ */
const ENTITIES = [
  { name: 'promotion', dir: 'promotions', key: 'slug' },
  { name: 'wrestler', dir: 'wrestlers', key: 'slug' },
  { name: 'venue', dir: 'venues', key: 'slug' },
  { name: 'move', dir: 'moves', key: 'slug' },
  { name: 'event', dir: 'events', key: 'eventId' },
  { name: 'news', dir: 'news', key: 'id' },
];

/** name -> Map<key, {data, file}> */
const store = {};

for (const ent of ENTITIES) {
  const map = new Map();
  const files = walkJson(join(DATA, ent.dir));
  for (const file of files) {
    const data = readJson(file);
    if (data === null) continue;

    // 1. スキーマ検証
    const validate = validators[ent.name];
    if (!validate(data)) {
      for (const e of validate.errors) {
        fail(file, `スキーマ違反: ${e.instancePath || '/'} ${e.message}${e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : ''}`);
      }
    }

    const key = data[ent.key];
    if (typeof key !== 'string' || key.length === 0) continue; // スキーマ側で既に報告済み

    // 2. ファイル名 == キー
    if (basename(file, '.json') !== key) {
      fail(file, `ファイル名が ${ent.key} と一致しない (${ent.key}="${key}")`);
    }

    // 3. 重複
    if (map.has(key)) {
      fail(file, `${ent.key} "${key}" が重複している (既出: ${map.get(key).rel})`);
    } else {
      map.set(key, { data, file, rel: rel(file) });
    }
  }
  store[ent.name] = map;
}

const has = (entity, key) => store[entity].has(key);

/* ------------------------------------------------------------------ */
/* 整合チェック                                                        */
/* ------------------------------------------------------------------ */

// --- promotion ---
for (const { data, file } of store.promotion.values()) {
  requireSourcesFor(file, data, ['foundedDate']);
}

// --- wrestler ---
for (const { data, file } of store.wrestler.values()) {
  for (const slug of data.promotionSlugs) {
    if (!has('promotion', slug)) fail(file, `孤立参照: promotionSlugs の "${slug}" に対応する団体がない`);
  }
  for (const slug of data.finishingMoveSlugs) {
    if (!has('move', slug)) fail(file, `孤立参照: finishingMoveSlugs の "${slug}" に対応する技がない`);
  }

  // 必須出典: realName / birthDate があるのに sources[] が空
  requireSourcesFor(file, data, ['realName', 'birthDate']);

  // 日付整合: debutDate > birthDate
  if (data.birthDate && data.debutDate && data.debutDate <= data.birthDate) {
    fail(file, `日付整合: debutDate (${data.debutDate}) は birthDate (${data.birthDate}) より後でなければならない`);
  }

  // aliases に本名(name)自身が入っていても害はないが、空文字や重複は弾く
  if (data.aliases.includes(data.name)) {
    fail(file, `aliases に name と同一の文字列 "${data.name}" が入っている（冗長）`);
  }
}

// --- move / venue ---
for (const { data, file } of store.venue.values()) requireSourcesFor(file, data, ['capacity']);

// --- event ---
for (const { data, file } of store.event.values()) {
  const { eventId, promotionSlug, date, venueSlug } = data;

  if (!has('promotion', promotionSlug)) {
    fail(file, `孤立参照: promotionSlug "${promotionSlug}" に対応する団体がない`);
  }
  if (!has('venue', venueSlug)) {
    fail(file, `孤立参照: venueSlug "${venueSlug}" に対応する会場がない`);
  }

  // eventId の構成要素が中身と一致しているか
  const m = /^(.+)-(\d{8})-(\d+)$/.exec(eventId);
  if (m) {
    const [, idPromotion, idDate] = m;
    if (idPromotion !== promotionSlug) {
      fail(file, `eventId の団体部分 "${idPromotion}" が promotionSlug "${promotionSlug}" と一致しない`);
    }
    if (idDate !== date.replaceAll('-', '')) {
      fail(file, `eventId の日付部分 "${idDate}" が date "${date}" と一致しない`);
    }
  }

  // 配置規約: events/{promotion}/{YYYY}/{eventId}.json
  const expected = join(DATA, 'events', promotionSlug, date.slice(0, 4), `${eventId}.json`);
  if (file !== expected) {
    fail(file, `配置が規約と違う。期待: ${rel(expected)}`);
  }

  // 日付整合: doorsOpen < bellTime
  if (data.doorsOpen && data.bellTime && data.doorsOpen >= data.bellTime) {
    fail(file, `日付整合: doorsOpen (${data.doorsOpen}) は bellTime (${data.bellTime}) より前でなければならない`);
  }

  // 試合
  const seenOrder = new Set();
  for (const match of data.matches) {
    const label = `matches[order=${match.order}]`;

    if (seenOrder.has(match.order)) fail(file, `${label}: order が重複している`);
    seenOrder.add(match.order);

    for (const [i, s] of match.sides.entries()) {
      for (const id of s.wrestlerIds) {
        if (!has('wrestler', id)) {
          fail(file, `孤立参照: ${label} sides[${i}].wrestlerIds の "${id}" に対応する選手がない`);
        }
      }
    }

    // 同一選手が複数陣営に入っていないか
    const all = match.sides.flatMap((s) => s.wrestlerIds);
    const dupes = all.filter((v, i) => all.indexOf(v) !== i);
    if (dupes.length) {
      fail(file, `${label}: 同一選手が複数の陣営に含まれている (${[...new Set(dupes)].join(', ')})`);
    }

    // singles は 2 陣営 × 各 1 名
    if (match.matchType === 'singles') {
      if (match.sides.length !== 2 || match.sides.some((s) => s.wrestlerIds.length !== 1)) {
        fail(file, `${label}: matchType が singles だが 2 陣営 × 各 1 名になっていない`);
      }
    }

    if (match.result) {
      const { winnerSideIndex, finishMoveSlug, decision } = match.result;
      if (winnerSideIndex !== null && (winnerSideIndex < 0 || winnerSideIndex >= match.sides.length)) {
        fail(file, `${label}: result.winnerSideIndex (${winnerSideIndex}) が sides の範囲外`);
      }
      const drawish = ['draw', 'time-limit-draw', 'no-contest'];
      if (drawish.includes(decision) && winnerSideIndex !== null) {
        fail(file, `${label}: decision が "${decision}" なのに winnerSideIndex が null でない`);
      }
      if (!drawish.includes(decision) && winnerSideIndex === null) {
        fail(file, `${label}: decision が "${decision}" なのに winnerSideIndex が null`);
      }
      if (finishMoveSlug && !has('move', finishMoveSlug)) {
        fail(file, `孤立参照: ${label} result.finishMoveSlug の "${finishMoveSlug}" に対応する技がない`);
      }
      // 結果があるのに未確定カード扱いは矛盾
      if (!match.confirmed) {
        fail(file, `${label}: result があるのに confirmed が false`);
      }
    }
  }

  // 結果が入っているのに興行が未確定なのは矛盾
  if (!data.confirmed && data.attendance !== null) {
    fail(file, 'confirmed が false なのに attendance が入っている');
  }

  requireSourcesFor(file, data, ['attendance']);
}

// --- news ---
for (const { data, file } of store.news.values()) {
  const expected = join(DATA, 'news', data.publishedDate.slice(0, 7), `${data.id}.json`);
  if (file !== expected) {
    fail(file, `配置が規約と違う。期待: ${rel(expected)}`);
  }
  for (const slug of data.relatedPromotionSlugs) {
    if (!has('promotion', slug)) fail(file, `孤立参照: relatedPromotionSlugs の "${slug}" に対応する団体がない`);
  }
  for (const slug of data.relatedWrestlerSlugs) {
    if (!has('wrestler', slug)) fail(file, `孤立参照: relatedWrestlerSlugs の "${slug}" に対応する選手がない`);
  }
  for (const id of data.relatedEventIds) {
    if (!has('event', id)) fail(file, `孤立参照: relatedEventIds の "${id}" に対応する興行がない`);
  }
}

/**
 * 指定フィールドのいずれかが非 null なら sources[] が空であってはならない。
 * 「出典がないフィールドは null にする」を機械的に守らせる。
 */
function requireSourcesFor(file, data, fields) {
  const filled = fields.filter((f) => data[f] !== null && data[f] !== undefined);
  if (filled.length > 0 && (!Array.isArray(data.sources) || data.sources.length === 0)) {
    fail(file, `必須出典: ${filled.join(' / ')} に値があるのに sources[] が空`);
  }
}

/* ------------------------------------------------------------------ */
/* 結果                                                                */
/* ------------------------------------------------------------------ */
const counts = ENTITIES.map((e) => `${e.dir}=${store[e.name].size}`).join(' ');

if (errors.length > 0) {
  const byFile = new Map();
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e.message);
  }
  console.error(`\n検証失敗: ${errors.length} 件\n`);
  for (const [file, msgs] of [...byFile.entries()].sort()) {
    console.error(`  ${file}`);
    for (const m of msgs) console.error(`    - ${m}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`検証 OK  (${counts})`);
