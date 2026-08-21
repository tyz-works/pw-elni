// 収集パイプラインのエントリ。git は触らない。
// 書くのは data/ と .cache/report.md の 2 つだけ。PR 作成は CI の仕事。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createFetcher } from './fetch.mjs';
import {
  writeSnapshot, readSnapshot, listSnapshots, writeSnapshotUrl, readSnapshotUrl,
  writeExtraction, readExtraction,
} from './core/snapshot.mjs';
import { buildIndex, resolve as resolveName } from './core/aliases.mjs';
import { merge } from './core/merge.mjs';
import { renderReport } from './core/report.mjs';
import { buildVenueIndex } from './core/venues.mjs';
import { conflictKey, filterAcknowledged } from './core/acknowledged.mjs';
import { createExtractor } from './core/llm.mjs';
import * as ddt from './adapters/ddt.mjs';
import * as stardom from './adapters/stardom.mjs';
import * as njpw from './adapters/njpw.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA = join(ROOT, 'data');
const STAGING = join(ROOT, '.cache', 'data-staging');
const REPORT = join(ROOT, '.cache', 'report.md');
// 人間が一度見た食い違いの記録。data/ ではなくツール側に置く（サイトの
// 内容ではなくパイプラインの運用情報なので）。
const ACKNOWLEDGED = join(ROOT, 'tools', 'collect', 'acknowledged-conflicts.json');
// 通知用の 1 行要約。レポート全文は長すぎて通知に載らない。
const SUMMARY = join(ROOT, '.cache', 'summary.txt');

const ADAPTERS = { ddt, stardom, njpw };

let extractor = null;

const MATCH_TYPE_BY_SIZE = { 1: 'singles', 2: 'tag', 3: 'six-man-tag', 4: 'eight-man-tag' };

function inferMatchType(sideCount, sizeOfFirstSide) {
  if (sideCount === 1) return 'battle-royal';
  if (sideCount > 2) return 'multi-man';
  return MATCH_TYPE_BY_SIZE[sizeOfFirstSide] ?? 'multi-man';
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  return {
    promotion: get('--promotion'),
    step: get('--step'),
    noLlm: argv.includes('--no-llm'),
    dryRun: argv.includes('--dry-run'),
    acknowledge: argv.includes('--acknowledge'),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function loadAcknowledged() {
  if (!existsSync(ACKNOWLEDGED)) return [];
  return JSON.parse(readFileSync(ACKNOWLEDGED, 'utf8'));
}

function loadEntities(dir) {
  return readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(DATA, dir, f), 'utf8')));
}

// 技には aliases が無い。英語表記を alias 相当として索引に入れる。
function buildMoveIndex() {
  return buildIndex(loadEntities('moves').map((m) => ({
    slug: m.slug,
    name: m.name,
    aliases: m.nameEn ? [m.nameEn] : [],
  }))).index;
}

// LLM が返す形 -> アダプタが返す形。LLM は表示名しか返さないので、
// slug への解決はこの後の resolve 段が行う。
function llmMatchToRaw(m, fallbackOrder) {
  const winner = Number.isInteger(m.winnerSideIndex) && m.winnerSideIndex >= 0
    ? m.winnerSideIndex
    : null;
  const decision = m.decision ?? 'unknown';
  // 勝者が分からない試合は結果ごと未確定にする。スキーマは「決着なし」を
  // draw 系でしか表せず、unknown + 勝者なしは検証器に落とされる。
  // 推測で勝者を作らないほうを採る。
  const drawish = ['draw', 'time-limit-draw', 'no-contest'];
  const result = winner === null && !drawish.includes(decision)
    ? null
    : { winnerSideIndex: winner, decision, finishText: null, durationSeconds: null };

  return {
    order: Number.isInteger(m.order) && m.order > 0 ? m.order : fallbackOrder,
    matchType: null,
    sides: (m.sides ?? []).map((s) => ({ names: s.names ?? [], teamName: null })),
    titleName: m.titleName || null,
    timeLimitMinutes: null,
    result,
    notes: null,
  };
}

function eventPath(base, promotion, eventId) {
  const year = eventId.split('-')[1].slice(0, 4);
  return join(base, 'events', promotion, year, `${eventId}.json`);
}

// RawEvent（表示名）→ PartialEvent（slug）。解決できない選手名があれば
// その興行は書かない（spec §5）。
// 出力はスキーマの形ちょうどにする。アダプタ由来の余分なキー（finishText）を
// そのまま流すと additionalProperties で検証に落ちる。
function resolveEvent(rawEvent, index, moveIndex, venueIndex, promotion, sourceUrl) {
  const unresolved = [];

  // 会場はスキーマ上必須。解決できない会場を勝手に作らないので、
  // 解決できなければこの興行は書かない（選手名と同じ扱い）。
  const venueSlug = rawEvent.venueName ? resolveName(rawEvent.venueName, venueIndex) : null;
  if (!venueSlug) {
    unresolved.push({
      promotion,
      eventName: rawEvent.name,
      name: `会場: ${rawEvent.venueName ?? '(取得できず)'}`,
      sourceUrl,
    });
  }

  const matches = rawEvent.matches.map((m) => {
    const sides = m.sides.map((s) => {
      const wrestlerIds = s.names.map((n) => {
        const slug = resolveName(n, index);
        if (!slug) unresolved.push({ promotion, eventName: rawEvent.name, name: n, sourceUrl });
        return slug;
      });
      return { wrestlerIds, teamName: s.teamName };
    });
    // 陣営が 3 つ以上なら人数に関係なく multi-man。1 人ずつの 3 way を
    // singles にすると検証器に落とされる。
    const size = sides[0]?.wrestlerIds.length ?? 0;
    const matchType = m.matchType ?? inferMatchType(sides.length, size);

    // 技名は完全一致だけで解決する。解決できなければ null。
    // 未登録の技を勝手に作らないのは選手と同じ方針（CLAUDE.md）。
    // ただし技は興行の書き出しを止めない（止めると 1 件も書けない）。
    const finishMoveSlug = m.result?.finishText
      ? resolveName(m.result.finishText, moveIndex)
      : null;

    return {
      order: m.order,
      matchType,
      sides,
      titleName: m.titleName,
      timeLimitMinutes: m.timeLimitMinutes,
      result: m.result
        ? {
          winnerSideIndex: m.result.winnerSideIndex,
          decision: m.result.decision,
          finishMoveSlug,
          durationSeconds: m.result.durationSeconds,
        }
        : null,
      confirmed: true,
      notes: m.notes,
    };
  });
  // スキーマのキーだけを持つ形に組み直す。rawEvent を展開すると
  // アダプタ由来の venueName が混ざって additionalProperties で落ちる。
  const event = {
    eventId: rawEvent.eventId,
    promotionSlug: rawEvent.promotionSlug,
    name: rawEvent.name,
    series: rawEvent.series,
    date: rawEvent.date,
    doorsOpen: rawEvent.doorsOpen,
    bellTime: rawEvent.bellTime,
    venueSlug,
    attendance: rawEvent.attendance,
    confirmed: rawEvent.confirmed,
    matches,
    officialUrl: rawEvent.officialUrl,
    sources: rawEvent.sources,
  };
  return { event, unresolved };
}

async function runPromotion(promotion, opts, result) {
  const adapter = ADAPTERS[promotion];
  const wrestlerIndex = buildIndex(loadEntities('wrestlers')).index;
  const moveIndex = buildMoveIndex();
  const venueIndex = buildVenueIndex(loadEntities('venues'));

  // --- fetch ---
  if (!opts.step || opts.step === 'fetch') {
    let fetcher;
    try {
      fetcher = await createFetcher();
      const targets = await adapter.listTargets(fetcher);
      for (const t of targets) {
        const raw = await adapter.fetchRaw(fetcher, t);
        writeSnapshot(promotion, t.id, raw);
        writeSnapshotUrl(promotion, t.id, t.url);
      }
    } catch (e) {
      result.failures.push({ promotion, step: 'fetch', message: e.message });
      return;
    } finally {
      await fetcher?.close();
    }
  }
  if (opts.step === 'fetch') return;

  // --- parse -> resolve -> merge ---
  // 同じ日に 2 興行あると eventId の連番を決められない。黙って 1 件目に
  // マージすると別興行の試合が混ざるので、2 件目以降は失敗として上げる。
  const seenEventIds = new Set();

  for (const id of listSnapshots(promotion)) {
    const url = readSnapshotUrl(promotion, id);
    // 出典 URL が無いスナップショットからは書けない（sources[] が埋まらない）。
    // 黙って飛ばさず失敗として上げる。
    if (!url) {
      result.failures.push({ promotion, step: 'parse', message: `${id}: 取得元 URL が記録されていない` });
      continue;
    }
    try {
      const raw = readSnapshot(promotion, id);
      const target = { id, url, kind: 'result' };
      const { event: rawEvent, unparsed } = adapter.parse(raw, target);

      // 抽出結果を先に見る。記事は公開後に変わらないので、呼び直しても
      // 同じ結果に金を払うだけになる。取り込めたかどうかとは無関係に残す
      // （未解決の名前があって書けない興行こそ、毎日呼び直してしまう）。
      const cached = opts.noLlm ? null : readExtraction(promotion, id);
      if (cached?.matches?.length) {
        for (const m of cached.matches) rawEvent.matches.push(llmMatchToRaw(m, rawEvent.matches.length + 1));
        result.llmFilled.push({
          promotion, eventId: rawEvent.eventId,
          order: cached.matches.length, model: `${cached.model} (キャッシュ)`,
        });
      } else {
        for (const fragment of unparsed) {
          if (!opts.noLlm && extractor) {
            const filled = await extractor.extract(fragment);
            if (filled?.length) {
              writeExtraction(promotion, id, { model: extractor.model, matches: filled });
              for (const m of filled) rawEvent.matches.push(llmMatchToRaw(m, rawEvent.matches.length + 1));
              result.llmFilled.push({
                promotion, eventId: rawEvent.eventId,
                order: filled.length, model: extractor.model,
              });
              continue;
            }
          }
          // LLM が無い / 補えなかった断片は人間に上げる。黙って捨てない。
          result.unparsed.push({ promotion, eventId: rawEvent.eventId, text: fragment });
        }
      }

      if (!rawEvent.eventId) {
        result.failures.push({ promotion, step: 'parse', message: `${id}: 日付が取れず eventId を決められない` });
        continue;
      }

      if (seenEventIds.has(rawEvent.eventId)) {
        result.failures.push({
          promotion, step: 'parse',
          message: `${id}: eventId ${rawEvent.eventId} が同じ興行が既にある（同日複数興行の連番は未対応）`,
        });
        continue;
      }
      seenEventIds.add(rawEvent.eventId);

      const { event, unresolved } = resolveEvent(rawEvent, wrestlerIndex, moveIndex, venueIndex, promotion, url);
      result.unresolved.push(...unresolved);

      event.sources = [{ url, title: `${event.name} | ${promotion}`, retrievedAt: today() }];

      const p = eventPath(DATA, promotion, event.eventId);
      const existing = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
      if (!existing) {
        // 未解決の名前を含む興行は書かない（spec §5）
        if (!unresolved.length) stage(promotion, event, null, result);
        continue;
      }

      // unresolved があっても merge は走らせる。conflict も併せてレポートに出すため（spec §4）。
      // 止めるのは書き出しだけ。
      const { merged, conflicts } = merge(existing, event, { sourceUrl: url });
      result.conflicts.push(...conflicts.map((c) => ({ ...c, promotion, eventId: event.eventId })));

      // 抽出側が 1 試合も取れていないときは「消えた」の判定をしない。
      // LLM が動かなかった等でカードが空になっただけで、既存の全試合が
      // 消えたと報告してしまう。
      if (event.matches.length) {
        const incomingOrders = new Set(event.matches.map((m) => m.order));
        const dropped = existing.matches.map((m) => m.order).filter((o) => !incomingOrders.has(o));
        if (dropped.length) result.droppedOrders.push({ promotion, eventId: event.eventId, orders: dropped });
      }

      if (!unresolved.length) stage(promotion, merged, existing, result);
    } catch (e) {
      result.failures.push({ promotion, step: 'parse', message: `${id}: ${e.message}` });
    }
  }
}

function stage(promotion, merged, existing, result) {
  if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return;
  const p = eventPath(STAGING, promotion, merged.eventId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  const fields = existing
    ? Object.keys(merged).filter((k) => JSON.stringify(merged[k]) !== JSON.stringify(existing[k]))
    : ['(新規)'];
  result.changed.push({ promotion, eventId: merged.eventId, eventName: merged.name, fields });
}

// 検証に落ちた興行を外して再検証する回数の上限。落ちるたびに 1 件ずつ
// 外れるので、無限に回らないための歯止め。
const MAX_DROP_ROUNDS = 10;

function summaryLine(result) {
  return [
    `取り込み ${result.changed.length}`,
    `conflict ${result.conflicts.length}`,
    `unresolved ${result.unresolved.length}`,
    `取りこぼし ${result.unparsed.length}`,
    `失敗 ${result.failures.length}`,
  ].join(' / ');
}

function validateStaging() {
  const v = spawnSync('node', [join(ROOT, 'tools', 'validate.mjs'), '--data', STAGING], { encoding: 'utf8' });
  return { ok: v.status === 0, out: (v.stdout ?? '') + (v.stderr ?? '') };
}

// 検証器はファイルごとに見出し行を出す。そこから落ちた興行のパスを拾う。
function failingFiles(out) {
  return out.split('\n')
    .map((l) => /^ {2}(\/.*\.json)$/.exec(l)?.[1])
    .filter(Boolean);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 鍵が無ければ LLM 段は動かない。1 回の実行で呼ぶ上限を入れて、
  // 取りこぼしが急に増えても課金が跳ねないようにする。
  extractor = createExtractor({
    apiKey: process.env.GEMINI_API_KEY ?? '',
    ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}),
    ...(process.env.LLM_MAX_CALLS ? { maxCalls: Number(process.env.LLM_MAX_CALLS) } : {}),
  });
  const result = { changed: [], conflicts: [], unresolved: [], unparsed: [], failures: [], llmFilled: [], droppedOrders: [] };

  // staging は毎回 data/ のコピーから作り直す
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(dirname(STAGING), { recursive: true });
  cpSync(DATA, STAGING, { recursive: true });

  const promotions = opts.promotion ? [opts.promotion] : Object.keys(ADAPTERS);
  for (const p of promotions) {
    if (!ADAPTERS[p]) { result.failures.push({ promotion: p, step: 'setup', message: 'アダプタが無い' }); continue; }
    await runPromotion(p, opts, result); // 1 団体が落ちても他は止めない
  }

  // staging に対して既存の検証器を掛ける。門は 1 つのまま
  if (result.changed.length) {
    let v = validateStaging();

    // 検証に落ちた興行だけを外して再検証する。1 興行の異常で他の興行まで
    // 止めない（部分失敗を許容する設計）。外した興行はレポートに載る。
    for (let i = 0; !v.ok && i < MAX_DROP_ROUNDS; i++) {
      const bad = new Set(failingFiles(v.out));
      const dropped = result.changed.filter((c) => bad.has(eventPath(STAGING, c.promotion, c.eventId)));
      // 興行と紐づかない失敗（孤立参照など）は切り分けられないので全体を止める
      if (!dropped.length) break;
      for (const c of dropped) {
        const staged = eventPath(STAGING, c.promotion, c.eventId);
        const original = eventPath(DATA, c.promotion, c.eventId);
        if (existsSync(original)) cpSync(original, staged);
        else rmSync(staged, { force: true });
        result.failures.push({
          promotion: c.promotion, step: 'validate',
          message: `${c.eventId}: 検証に落ちたので反映しない`,
        });
      }
      const droppedIds = new Set(dropped.map((c) => c.eventId));
      result.changed = result.changed.filter((c) => !droppedIds.has(c.eventId));
      v = validateStaging();
    }

    process.stdout.write(v.out);
    if (!v.ok) {
      result.failures.push({ promotion: '(all)', step: 'validate', message: '検証に失敗したため data/ に反映しない' });
      result.changed = [];
    }
  }

  // 検証を通ったときだけ data/ に反映する
  if (result.changed.length && !opts.dryRun) {
    for (const c of result.changed) {
      const from = eventPath(STAGING, c.promotion, c.eventId);
      const to = eventPath(DATA, c.promotion, c.eventId);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
  }

  // 一度見た食い違いは黙らせる。--acknowledge を付けた実行で記録する。
  const acknowledged = loadAcknowledged();
  if (opts.acknowledge) {
    const known = new Set(acknowledged.map(conflictKey));
    const added = result.conflicts.filter((c) => !known.has(conflictKey(c)));
    if (added.length) {
      const next = [...acknowledged, ...added.map((c) => ({
        promotion: c.promotion, eventId: c.eventId, path: c.path,
        existing: c.existing, incoming: c.incoming,
      }))];
      writeFileSync(ACKNOWLEDGED, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`既知の食い違いに ${added.length} 件を追記した: ${ACKNOWLEDGED}\n`);
  }
  const filtered = filterAcknowledged(result.conflicts, acknowledged.map(conflictKey));
  result.conflicts = filtered.conflicts;
  result.silencedConflicts = filtered.silenced;

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, renderReport(result), 'utf8');
  writeFileSync(SUMMARY, `${summaryLine(result)}\n`, 'utf8');
  process.stdout.write(`\nレポート: ${REPORT}\n`);
  process.exit(result.failures.length ? 1 : 0);
}

await main();
