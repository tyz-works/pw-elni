#!/usr/bin/env node
// data/ から Obsidian の Vault へノートを書き出す。
//
// Vault には手作りのノートが 200 件以上ある。**壊さないことが最優先。**
// 生成分はマーカーで囲み、その外側（frontmatter・手書きのメモ）には触れない。
// 既存ノートは正規化した名前で突き合わせる（ファイル名がリングネームのため）。
//
// 書き出し先は OBSIDIAN_VAULT で差し替えられる。既定は ~/obsidian/ProWrestling。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { normalize } from '../collect/core/aliases.mjs';
import {
  mergeGenerated, frontmatter, safeFileName,
  renderEvent, renderWrestlerBody, renderVenueBody, renderMoveBody,
} from './notes.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA = join(ROOT, 'data');
const VAULT = process.env.OBSIDIAN_VAULT ?? join(homedir(), 'obsidian', 'ProWrestling');

const PROMOTION_NOTE = { njpw: 'NJPW', ddt: 'DDT', stardom: 'STARDOM' };

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function loadAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(readJson(p));
    }
  };
  walk(join(DATA, dir));
  return out;
}

/** Vault の既存ノートを正規化した名前で引けるようにする。 */
function existingNotes(dir) {
  const d = join(VAULT, dir);
  if (!existsSync(d)) return new Map();
  return new Map(
    readdirSync(d)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [normalize(basename(f, '.md')), join(d, f)]),
  );
}

const stats = { created: 0, updated: 0, skipped: 0 };

/**
 * 1 ノート書く。既存があればマーカーの中だけ差し替える。
 * @param {string} path
 * @param {string} body マーカーの中に入れる内容
 * @param {string|null} head 新規作成時だけ使う frontmatter + 見出し
 */
function writeNote(path, body, head) {
  const exists = existsSync(path);
  const before = exists ? readFileSync(path, 'utf8') : (head ?? '');
  const after = mergeGenerated(before, body);
  if (exists && after === before) {
    stats.skipped += 1;
    return;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, after, 'utf8');
  stats[exists ? 'updated' : 'created'] += 1;
}

function main() {
  if (!existsSync(VAULT)) {
    process.stderr.write(`Vault が見つからない: ${VAULT}\n`);
    process.exit(1);
  }

  const events = loadAll('events').sort((a, b) => a.date.localeCompare(b.date));
  const wrestlers = loadAll('wrestlers');
  const venues = loadAll('venues');
  const moves = loadAll('moves');

  const wrestlerNames = Object.fromEntries(wrestlers.map((w) => [w.slug, w.name]));
  const venueNames = Object.fromEntries(venues.map((v) => [v.slug, v.name]));

  // --- 興行。ファイル名は eventId（一意で、日付と団体が読める） ---
  for (const e of events) {
    const head = `${frontmatter({
      type: 'event',
      event_id: e.eventId,
      name: e.name,
      date: e.date,
      promotion: `[[${PROMOTION_NOTE[e.promotionSlug] ?? e.promotionSlug}]]`,
      venue: e.venueSlug ? `[[${safeFileName(venueNames[e.venueSlug] ?? e.venueSlug)}]]` : null,
      attendance: e.attendance,
      tags: ['pw/event', `pw/${e.promotionSlug}`],
    })}\n\n# ${e.name}\n`;
    writeNote(join(VAULT, 'Events', `${e.eventId}.md`), renderEvent(e, { wrestlerNames, venueNames }), head);
  }

  // --- 選手。既存ノートがあれば同じファイルに追記する ---
  const wrestlerNotes = existingNotes('Wrestlers');
  for (const w of wrestlers) {
    const keys = [w.name, ...w.aliases].map(normalize);
    const path = keys.map((k) => wrestlerNotes.get(k)).find(Boolean)
      ?? join(VAULT, 'Wrestlers', `${safeFileName(w.name)}.md`);
    const head = `${frontmatter({
      type: 'wrestler',
      name: w.name,
      ring_name: w.name,
      aliases: w.aliases,
      status: w.status === 'unknown' ? null : w.status,
      current_promotions: w.promotionSlugs.map((p) => `[[${PROMOTION_NOTE[p] ?? p}]]`),
      tags: ['pw/wrestler'],
    })}\n\n# ${w.name}\n`;
    writeNote(path, renderWrestlerBody(w.slug, events, { wrestlerNames }), head);
  }

  // --- 会場 ---
  for (const v of venues) {
    const head = `${frontmatter({
      type: 'venue',
      name: v.name,
      aliases: v.aliases,
      city: v.city,
      prefecture: v.prefecture,
      capacity: v.capacity,
      tags: ['pw/venue'],
    })}\n\n# ${v.name}\n\n- 所在地: ${v.prefecture} ${v.city}\n`;
    writeNote(join(VAULT, 'Venues', `${safeFileName(v.name)}.md`), renderVenueBody(v.slug, events), head);
  }

  // --- 技 ---
  for (const m of moves) {
    const head = `${frontmatter({
      type: 'move',
      name: m.name,
      name_en: m.nameEn,
      category: m.category,
      tags: ['pw/move'],
    })}\n\n# ${m.name}\n${m.description ? `\n${m.description}\n` : ''}`;
    writeNote(join(VAULT, 'Moves', `${safeFileName(m.name)}.md`), renderMoveBody(m.slug, wrestlers), head);
  }

  // --- 収集ログ。report.md があれば日付つきで残す ---
  const report = join(ROOT, '.cache', 'report.md');
  if (existsSync(report)) {
    const today = new Date().toISOString().slice(0, 10);
    const path = join(VAULT, 'Logs', `${today}.md`);
    const head = `${frontmatter({ type: 'collect-log', date: today, tags: ['pw/log'] })}\n\n# 収集ログ ${today}\n`;
    writeNote(path, readFileSync(report, 'utf8'), head);
  }

  process.stdout.write(
    `Obsidian: 新規 ${stats.created} / 更新 ${stats.updated} / 変更なし ${stats.skipped}  -> ${VAULT}\n`,
  );
}

main();
