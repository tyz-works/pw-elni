# Phase C コア + DDT アダプタ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公式サイトの生テキストから DDT の興行データを取り込み、既存 JSON に追記マージして `data/` への差分とレポートを出すパイプラインを、end-to-end で動く状態にする。

**Architecture:** 団体ごとの差は adapter の 3 関数に閉じ、コアは団体を知らない。fetch と parse の間にスナップショット（生テキストのファイル）を挟み、parse 以降をネットワーク非依存にする。マージは追記のみで、既存値は上書きせず conflict として人間に上げる。

**Tech Stack:** Node 24 / ESM (`.mjs`) / `node --test` / ajv (既存) / Playwright / `@anthropic-ai/sdk`

**Spec:** `docs/superpowers/specs/2026-08-20-phase-c-collection-pipeline-design.md`

## Global Constraints

- Node 24。バージョンの真実は `.node-version` の 1 箇所のみ
- ESM。全ファイル `.mjs`、`import`/`export` を使う（`require` は使わない）
- 改行は LF 固定、ファイル末尾に改行を 1 つ
- 純関数（`merge` / `aliases` / `report`）はファイル I/O・ネットワーク・`git` を一切呼ばない
- `run.mjs` は `git` を触らない。書くのは `data/` と `.cache/report.md` だけ
- LLM に slug を作らせない。LLM が返すのは表示名の文字列のみ
- `data/` の外にフィクスチャを置く。公式ページの原文はリポジトリに置かない
- 検証器は新しく書かない。`tools/validate.mjs --data <dir>` をサブプロセスで叩く
- コミットメッセージは日本語。末尾に `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## この計画の範囲

**含む**: `core/merge.mjs` / `core/aliases.mjs` / `core/snapshot.mjs` / `core/report.mjs` / `core/llm.mjs` / `fetch.mjs` / `adapters/ddt.mjs` / `run.mjs` / `validate.mjs` への 1 チェック追加 / `collect.yml`（`workflow_dispatch` のみ）

**含まない**: `adapters/njpw.mjs` と `adapters/stardom.mjs`。両団体のページ構造を確認してから別の計画にする。cron の有効化も別（spec §10）。

## データ型（タスク間で共有する形）

すべてのタスクがこの型を前提にする。

```js
// adapter.parse() が返す。slug ではなく「表示名」を持つのが要点
/** @typedef {{ names: string[], teamName: string | null }} RawSide */
/** @typedef {{
 *   order: number,
 *   matchType: string | null,
 *   sides: RawSide[],
 *   titleName: string | null,
 *   timeLimitMinutes: number | null,
 *   result: { winnerSideIndex: number|null, decision: string, finishText: string|null, durationSeconds: number|null } | null,
 *   notes: string | null
 * }} RawMatch */
/** @typedef {{ eventId, promotionSlug, name, date, doorsOpen, bellTime, venueSlug,
 *   attendance, confirmed, officialUrl, sources, matches: RawMatch[] }} RawEvent */

// resolve 後。RawSide.names が wrestlerIds に変わっただけ
/** @typedef {{ wrestlerIds: string[], teamName: string | null }} Side */

/** @typedef {{ id: string, url: string, kind: 'result' | 'schedule' }} Target */
/** @typedef {{ path: string, existing: any, incoming: any, sourceUrl: string|null }} Conflict */
/** @typedef {{ promotion: string, eventName: string, name: string, sourceUrl: string }} Unresolved */
```

**conflict の `path` 表記**: 配列の要素は identity を明示する。`matches[order=3].result.decision` / `matches[order=3].sides[0].wrestlerIds`。spec §4 の例は `matches[3]` と書いているが、index と order の区別がつかないため `order=` を付ける形に具体化する。

---

### Task 1: 追記マージ（`core/merge.mjs`）

**Files:**
- Create: `tools/collect/core/merge.mjs`
- Test: `tools/collect/core/merge.test.mjs`
- Modify: `package.json`（`test` スクリプトを `tools/` 全体に広げる）

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: `merge(existing, incoming, { sourceUrl }) → { merged, conflicts: Conflict[] }`

- [ ] **Step 1: `package.json` の test スクリプトを広げる**

`tools/collect/` 配下のテストが自動で拾われるようにする。`node --test <dir>` はディレクトリを再帰して `*.test.mjs` を探す。

```json
"test": "node --test tools/",
```

- [ ] **Step 2: 失敗するテストを書く**

`tools/collect/core/merge.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge } from './merge.mjs';

const SRC = { sourceUrl: 'https://example.test/e/1' };

test('空のフィールドは埋める', () => {
  const { merged, conflicts } = merge({ attendance: null }, { attendance: 1200 }, SRC);
  assert.equal(merged.attendance, 1200);
  assert.deepEqual(conflicts, []);
});

test('同じ値なら何もしない', () => {
  const { merged, conflicts } = merge({ attendance: 1200 }, { attendance: 1200 }, SRC);
  assert.equal(merged.attendance, 1200);
  assert.deepEqual(conflicts, []);
});

test('異なる値は上書きせず conflict にする', () => {
  const { merged, conflicts } = merge({ attendance: 1200 }, { attendance: 999 }, SRC);
  assert.equal(merged.attendance, 1200, '既存値が残ること');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], {
    path: 'attendance', existing: 1200, incoming: 999, sourceUrl: SRC.sourceUrl,
  });
});

test('抽出側が空なら既存値を消さない', () => {
  const { merged, conflicts } = merge({ attendance: 1200 }, { attendance: null }, SRC);
  assert.equal(merged.attendance, 1200);
  assert.deepEqual(conflicts, []);
});

test('confirmed は false から true にだけ進む', () => {
  const up = merge({ confirmed: false }, { confirmed: true }, SRC);
  assert.equal(up.merged.confirmed, true);
  assert.deepEqual(up.conflicts, []);

  const down = merge({ confirmed: true }, { confirmed: false }, SRC);
  assert.equal(down.merged.confirmed, true, '巻き戻さないこと');
  assert.equal(down.conflicts.length, 1);
});

test('matches は order を identity にする', () => {
  const existing = { matches: [{ order: 1, notes: 'あり' }] };
  const incoming = { matches: [{ order: 2, notes: '新規' }, { order: 1, notes: 'あり' }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches.map((m) => m.order), [1, 2], 'order 昇順に並ぶこと');
  assert.deepEqual(conflicts, []);
});

test('既存 match の空フィールドに結果が入る', () => {
  const existing = { matches: [{ order: 1, result: null, confirmed: true }] };
  const incoming = { matches: [{ order: 1, result: { winnerSideIndex: 0 }, confirmed: true }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches[0].result, { winnerSideIndex: 0 });
  assert.deepEqual(conflicts, []);
});

test('公式から消えた order は残す', () => {
  const existing = { matches: [{ order: 1 }, { order: 2 }] };
  const incoming = { matches: [{ order: 1 }] };
  const { merged } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches.map((m) => m.order), [1, 2]);
});

test('sides の wrestlerIds が違えば conflict', () => {
  const existing = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a'], teamName: null }] }] };
  const incoming = { matches: [{ order: 1, sides: [{ wrestlerIds: ['b'], teamName: null }] }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.deepEqual(merged.matches[0].sides[0].wrestlerIds, ['a']);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'matches[order=1].sides[0].wrestlerIds');
});

test('陣営の数が違えば conflict にして既存を据え置く', () => {
  const existing = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a'] }, { wrestlerIds: ['b'] }] }] };
  const incoming = { matches: [{ order: 1, sides: [{ wrestlerIds: ['a'] }, { wrestlerIds: ['b'] }, { wrestlerIds: ['c'] }] }] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.equal(merged.matches[0].sides.length, 2);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'matches[order=1].sides');
});

test('sources は URL で重複排除して追記し retrievedAt は既存のまま', () => {
  const existing = { sources: [{ url: 'u1', title: 't1', retrievedAt: '2026-08-01' }] };
  const incoming = { sources: [
    { url: 'u1', title: 't1', retrievedAt: '2026-08-20' },
    { url: 'u2', title: 't2', retrievedAt: '2026-08-20' },
  ] };
  const { merged, conflicts } = merge(existing, incoming, SRC);
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.sources[0].retrievedAt, '2026-08-01');
  assert.deepEqual(conflicts, []);
});

test('入力を書き換えない', () => {
  const existing = { matches: [{ order: 1, notes: null }] };
  const frozen = JSON.stringify(existing);
  merge(existing, { matches: [{ order: 1, notes: 'x' }] }, SRC);
  assert.equal(JSON.stringify(existing), frozen);
});
```

- [ ] **Step 3: テストを走らせて落ちることを確認**

Run: `npm test`
Expected: FAIL（`Cannot find module './merge.mjs'`）

- [ ] **Step 4: 実装する**

`tools/collect/core/merge.mjs`:

```js
// 追記マージ。既存値は上書きせず conflict として返す純関数。
// ファイル I/O・ネットワーク・git は一切呼ばない。
import { isDeepStrictEqual } from 'node:util';

const isEmpty = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} existing 既存の JSON（読み取り専用として扱う）
 * @param {object} incoming 抽出した部分 JSON
 * @param {{ sourceUrl?: string|null }} opts
 * @returns {{ merged: object, conflicts: Conflict[] }}
 */
export function merge(existing, incoming, { sourceUrl = null } = {}) {
  const conflicts = [];
  const merged = mergeValue(existing, incoming, '', conflicts, sourceUrl, null);
  return { merged, conflicts };
}

function mergeValue(existing, incoming, path, conflicts, sourceUrl, key) {
  if (isEmpty(incoming)) return existing;
  if (isEmpty(existing)) return incoming;

  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const out = { ...existing };
    for (const k of Object.keys(incoming)) {
      out[k] = mergeValue(existing[k], incoming[k], path ? `${path}.${k}` : k, conflicts, sourceUrl, k);
    }
    return out;
  }

  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return mergeArray(existing, incoming, path, conflicts, sourceUrl, key);
  }

  if (isDeepStrictEqual(existing, incoming)) return existing;

  // 唯一の特別扱い: 未発表 → 発表済みの単調な遷移だけ許可する
  if (key === 'confirmed' && existing === false && incoming === true) return true;

  conflicts.push({ path, existing, incoming, sourceUrl });
  return existing;
}

function mergeArray(existing, incoming, path, conflicts, sourceUrl, key) {
  // sources: URL で重複排除して追記。既存エントリには触らない
  if (key === 'sources') {
    const out = existing.slice();
    const seen = new Set(out.map((s) => s.url));
    for (const s of incoming) {
      if (!seen.has(s.url)) { out.push(s); seen.add(s.url); }
    }
    return out;
  }

  // matches: order を identity にする
  if (key === 'matches') {
    const out = existing.slice();
    const indexByOrder = new Map(out.map((m, i) => [m.order, i]));
    for (const m of incoming) {
      const i = indexByOrder.get(m.order);
      if (i === undefined) { out.push(m); continue; }
      out[i] = mergeValue(out[i], m, `${path}[order=${m.order}]`, conflicts, sourceUrl, null);
    }
    return out.sort((a, b) => a.order - b.order);
  }

  // sides: 位置を identity にする。要素数が違えば conflict
  if (key === 'sides') {
    if (existing.length !== incoming.length) {
      conflicts.push({ path, existing, incoming, sourceUrl });
      return existing;
    }
    return existing.map((s, i) =>
      mergeValue(s, incoming[i], `${path}[${i}]`, conflicts, sourceUrl, null));
  }

  // スカラー配列（wrestlerIds など）は全体で比較する
  if (isDeepStrictEqual(existing, incoming)) return existing;
  conflicts.push({ path, existing, incoming, sourceUrl });
  return existing;
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS（既存の validate のテスト 21 件も引き続き通ること）

- [ ] **Step 6: コミット**

```bash
git add tools/collect/core/merge.mjs tools/collect/core/merge.test.mjs package.json
git commit -m "$(cat <<'EOF'
収集パイプラインの追記マージを追加

既存値を上書きせず conflict として返す純関数。confirmed の false→true
だけを単調な遷移として許可する。test スクリプトを tools/ 全体に広げた。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: alias 解決（`core/aliases.mjs`）

**Files:**
- Create: `tools/collect/core/aliases.mjs`
- Test: `tools/collect/core/aliases.test.mjs`

**Interfaces:**
- Consumes: なし
- Produces:
  - `normalize(name: string) → string`
  - `buildIndex(wrestlers: {slug,name,aliases}[]) → { index: Map<string,string>, collisions: {key,slugs}[] }`
  - `resolve(name: string, index: Map) → string | null`

- [ ] **Step 1: 失敗するテストを書く**

`tools/collect/core/aliases.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildIndex, resolve } from './aliases.mjs';

test('中黒とスペースを落とす', () => {
  assert.equal(normalize('ヤス・ウラノ'), normalize('ヤスウラノ'));
  assert.equal(normalize('正田 壮史'), normalize('正田壮史'));
  assert.equal(normalize('オカダ　カズチカ'), normalize('オカダカズチカ'));
});

test('英字は大文字小文字を無視する', () => {
  assert.equal(normalize('KONOSUKE TAKESHITA'), normalize('Konosuke Takeshita'));
});

test('全角英数を半角に寄せる', () => {
  assert.equal(normalize('ＭＡＯ'), normalize('MAO'));
});

test('異体字を寄せる', () => {
  assert.equal(normalize('髙木三四郎'), normalize('高木三四郎'));
  assert.equal(normalize('宮﨑'), normalize('宮崎'));
});

test('別人は別のキーになる', () => {
  assert.notEqual(normalize('葛西純'), normalize('葛西陽向'));
});

const WRESTLERS = [
  { slug: 'harashima', name: 'HARASHIMA', aliases: ['Harashima', 'ハラシマ'] },
  { slug: 'sanshiro-takagi', name: '髙木三四郎', aliases: ['高木三四郎'] },
];

test('name と aliases の両方から引ける', () => {
  const { index } = buildIndex(WRESTLERS);
  assert.equal(resolve('HARASHIMA', index), 'harashima');
  assert.equal(resolve('ハラシマ', index), 'harashima');
  assert.equal(resolve('高木三四郎', index), 'sanshiro-takagi');
});

test('解決できない名前は null', () => {
  const { index } = buildIndex(WRESTLERS);
  assert.equal(resolve('存在しない選手', index), null);
});

test('同一選手内で正規化キーが重なっても衝突にしない', () => {
  const { collisions } = buildIndex(WRESTLERS);
  assert.deepEqual(collisions, [], 'HARASHIMA と Harashima は同じ slug なので衝突ではない');
});

test('別の選手が同じ正規化キーを持てば衝突として報告する', () => {
  const { collisions } = buildIndex([
    { slug: 'a', name: '高木三四郎', aliases: [] },
    { slug: 'b', name: '髙木三四郎', aliases: [] },
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].slugs.sort(), ['a', 'b']);
});

test('曖昧一致はしない', () => {
  const { index } = buildIndex(WRESTLERS);
  assert.equal(resolve('HARASHIM', index), null, '1 文字違いは解決しない');
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npm test`
Expected: FAIL（`Cannot find module './aliases.mjs'`）

- [ ] **Step 3: 実装する**

`tools/collect/core/aliases.mjs`:

```js
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 実データに対して衝突が無いことを確認**

Run:
```bash
node --input-type=module -e "
import { readdirSync, readFileSync } from 'node:fs';
import { buildIndex } from './tools/collect/core/aliases.mjs';
const ws = readdirSync('data/wrestlers').map((f) => JSON.parse(readFileSync('data/wrestlers/' + f, 'utf8')));
const { index, collisions } = buildIndex(ws);
console.log('keys=' + index.size, 'collisions=' + collisions.length);
console.log(JSON.stringify(collisions, null, 2));
"
```
Expected: `collisions=0`。0 でなければ、その選手の `aliases` を直すのが先（Task 3 でこれを CI の門にする）。

- [ ] **Step 6: コミット**

```bash
git add tools/collect/core/aliases.mjs tools/collect/core/aliases.test.mjs
git commit -m "$(cat <<'EOF'
alias 解決を追加

正規化後の完全一致のみ。中黒・全角・大文字小文字・異体字(髙/﨑)を吸収する。
曖昧一致は誤爆が静かに嘘になるため実装しない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 検証器に正規化衝突チェックを足す

**Files:**
- Modify: `tools/validate.mjs`（`--- wrestler ---` セクション、`data/schema/` の読み込みより後）
- Modify: `tools/validate.test.mjs`（ケースを 1 つ追加）

**Interfaces:**
- Consumes: `normalize` from `tools/collect/core/aliases.mjs`（Task 2）
- Produces: なし（CI の門が 1 つ増えるだけ）

- [ ] **Step 1: 落ちるべきケースをテストに足す**

`tools/validate.test.mjs` の既存のケース配列（`{ name, expect, mutate }` の形）に追加する。既存の `pickJson` ヘルパをそのまま使う。

```js
  {
    name: 'aliases の正規化キーが他の選手と衝突',
    expect: '正規化キーが衝突',
    mutate: (d) => {
      const files = readdirSync(join(d, 'wrestlers')).filter((f) => f.endsWith('.json'));
      const [aPath, bPath] = files.slice(0, 2).map((f) => join(d, 'wrestlers', f));
      const a = readJson(aPath);
      const b = readJson(bPath);
      // b の aliases に a の name を入れて、別 slug が同じ正規化キーを持つ状態を作る
      b.aliases = [...b.aliases, a.name];
      writeJson(bPath, b);
    },
  },
```

`readdirSync` が `validate.test.mjs` で未 import なら import に足す。

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npm test`
Expected: この 1 ケースだけ FAIL（検証器がまだ衝突を検出しないため、期待するエラーが出ない）

- [ ] **Step 3: 検証器に実装する**

`tools/validate.mjs` の import に足す:

```js
import { normalize } from './collect/core/aliases.mjs';
```

`--- wrestler ---` セクションの末尾に足す:

```js
// --- alias の正規化衝突 ---
// 別々の選手が同じ正規化キーを持つと、収集パイプラインの alias 解決が
// どちらを返すか実装依存になる。パイプラインの前提条件を非 LLM の門で守る。
{
  const owner = new Map(); // 正規化キー -> slug
  for (const [slug, w] of store.wrestler) {
    for (const label of [w.data.name, ...w.data.aliases]) {
      const key = normalize(label);
      const prev = owner.get(key);
      if (prev === undefined) { owner.set(key, slug); continue; }
      if (prev !== slug) {
        fail(w.file, `alias の正規化キーが衝突している: "${label}" は ${prev} と同じキーになる`);
      }
    }
  }
}
```

> **注意:** `store.wrestler` の実際の形（`Map<slug, {file, data}>` か `Map<slug, data>` か）は `tools/validate.mjs` の既存コードを読んで合わせること。`--- wrestler ---` セクションの既存ループが同じ store を舐めているので、そのループの書き方をそのまま真似る。

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（22 ケース）

- [ ] **Step 5: 本番データが通ることを確認**

Run: `npm run validate`
Expected: `検証 OK` と出る。落ちたら実データに衝突があるので、その選手の `aliases` を直す。

- [ ] **Step 6: コミット**

```bash
git add tools/validate.mjs tools/validate.test.mjs
git commit -m "$(cat <<'EOF'
alias の正規化キー衝突を検証器で落とす

別々の選手が同じ正規化キーを持つと収集パイプラインの alias 解決が
実装依存になる。パイプラインの前提条件を非 LLM の門で守る。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: スナップショット（`core/snapshot.mjs`）

**Files:**
- Create: `tools/collect/core/snapshot.mjs`
- Test: `tools/collect/core/snapshot.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: なし
- Produces:
  - `snapshotPath(promotion, id) → string`（絶対パス）
  - `writeSnapshot(promotion, id, text) → void`
  - `readSnapshot(promotion, id) → string | null`
  - `listSnapshots(promotion) → string[]`（id の配列。無ければ `[]`）
  - `writeSnapshotUrl(promotion, id, url) → void`
  - `readSnapshotUrl(promotion, id) → string | null`

生テキストだけでなく取得元 URL も保存する。parse 段は id しか持たないので、URL を id から組み立てようとすると団体ごとの URL 規約をコアが知ることになってしまう。

- [ ] **Step 1: `.gitignore` に `.cache/` を足す**

`.gitignore` の `.wrangler/` の隣に追加する:

```
.cache/
```

- [ ] **Step 2: 失敗するテストを書く**

`tools/collect/core/snapshot.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  snapshotPath, writeSnapshot, readSnapshot, listSnapshots, writeSnapshotUrl, readSnapshotUrl,
} from './snapshot.mjs';

const P = 'test-promotion';
test.after(() => rmSync(snapshotPath(P, 'x').replace(/\/x\.txt$/, ''), { recursive: true, force: true }));

test('書いたものが読める', () => {
  writeSnapshot(P, 'e1', 'ほんぶん');
  assert.equal(readSnapshot(P, 'e1'), 'ほんぶん');
});

test('無いものは null', () => {
  assert.equal(readSnapshot(P, 'missing'), null);
});

test('上書きできる', () => {
  writeSnapshot(P, 'e2', 'ふるい');
  writeSnapshot(P, 'e2', 'あたらしい');
  assert.equal(readSnapshot(P, 'e2'), 'あたらしい');
});

test('id の一覧が取れる', () => {
  writeSnapshot(P, 'e1', 'a');
  writeSnapshot(P, 'e2', 'b');
  assert.deepEqual(listSnapshots(P).sort(), ['e1', 'e2']);
});

test('団体のディレクトリが無ければ空配列', () => {
  assert.deepEqual(listSnapshots('no-such-promotion'), []);
});

test('URL を保存して読み出せる', () => {
  writeSnapshotUrl(P, 'e1', 'https://example.test/a');
  assert.equal(readSnapshotUrl(P, 'e1'), 'https://example.test/a');
});

test('URL が無ければ null', () => {
  assert.equal(readSnapshotUrl(P, 'no-url'), null);
});
```

- [ ] **Step 3: テストを走らせて落ちることを確認**

Run: `npm test`
Expected: FAIL（`Cannot find module './snapshot.mjs'`）

- [ ] **Step 4: 実装する**

`tools/collect/core/snapshot.mjs`:

```js
// 生テキストの永続化。fetch と parse の間に挟むことで、parse 以降を
// ネットワーク非依存にする。gitignore 済みの .cache/ に置く。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = join(ROOT, '.cache', 'snapshots');

export function snapshotPath(promotion, id) {
  return join(BASE, promotion, `${id}.txt`);
}

export function writeSnapshot(promotion, id, text) {
  const p = snapshotPath(promotion, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

/** @returns {string | null} */
export function readSnapshot(promotion, id) {
  const p = snapshotPath(promotion, id);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/** @returns {string[]} */
export function listSnapshots(promotion) {
  const dir = join(BASE, promotion);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4));
}

// 取得元 URL も一緒に置く。parse 段は id しか持たないので、
// URL を id から組み立てるとコアが団体ごとの URL 規約を知ることになる。
const urlPath = (promotion, id) => snapshotPath(promotion, id).replace(/\.txt$/, '.url');

export function writeSnapshotUrl(promotion, id, url) {
  const p = urlPath(promotion, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${url}\n`, 'utf8');
}

/** @returns {string | null} */
export function readSnapshotUrl(promotion, id) {
  const p = urlPath(promotion, id);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}
```

> **注意:** `ROOT` は `tools/collect/core/` から 3 階層上がってリポジトリルート。`snapshot.mjs` を別の深さに移動したらここも直すこと。

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 書いた末尾改行が読み出しと一致するか確認**

`writeSnapshot` は末尾改行を足すので、`readSnapshot(P,'e1')` は `'ほんぶん\n'` になる。Step 2 のテストは `'ほんぶん'` を期待しているので**ここで落ちる**。テスト側を `'ほんぶん\n'` に直す（末尾改行を足すのはリポジトリの改行規約に合わせるための意図的な挙動なので、実装ではなくテストを直す）。

Run: `npm test`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add tools/collect/core/snapshot.mjs tools/collect/core/snapshot.test.mjs .gitignore
git commit -m "$(cat <<'EOF'
生テキストのスナップショット層を追加

fetch と parse の間に挟み、parse 以降をネットワーク非依存にする。
パーサのテストが固定入力で書けるようになる。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 取得層（`fetch.mjs`）

**Files:**
- Create: `tools/collect/fetch.mjs`
- Modify: `package.json`（`playwright` を devDependencies に）

**Interfaces:**
- Consumes: なし
- Produces: `createFetcher() → Promise<{ fetchText(url) → Promise<string>, close() → Promise<void> }>`

このタスクにユニットテストは書かない。中身が Playwright の薄いラッパで、テストするとネットワークに依存するため。動作確認は Step 3 の手動実行で行う。

- [ ] **Step 1: playwright を devDependencies に足す**

Run: `npm install --save-dev playwright`

`WebFetch` / `curl` / `wget` は環境の deny リストに入っているため、取得は Playwright 経由に限られる。ブラウザ本体は `~/.cache/ms-playwright/` に導入済みのはず。無ければ `npx playwright install chromium` を実行する。

- [ ] **Step 2: 実装する**

`tools/collect/fetch.mjs`:

```js
// Playwright の薄いラッパ。HTML ではなく本文テキストだけを返す。
// LLM に HTML を渡さないという原則のため、ここで構造を落としておく。
import { chromium } from 'playwright';

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_200;

export async function createFetcher() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  return {
    /** @param {string} url @returns {Promise<string>} */
    async fetchText(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      return page.evaluate(() => {
        document.querySelectorAll('script,style,noscript').forEach((e) => e.remove());
        return document.body.innerText.replace(/\n{3,}/g, '\n\n');
      });
    },
    async close() {
      await browser.close();
    },
  };
}
```

- [ ] **Step 3: 手で動かして確認**

Run:
```bash
node --input-type=module -e "
import { createFetcher } from './tools/collect/fetch.mjs';
const f = await createFetcher();
const t = await f.fetchText('https://www.ddtpro.jp/results/6a7b05a1a862f20002deed36');
console.log('chars=' + t.length);
console.log(t.split('\n').slice(0, 12).join('\n'));
await f.close();
"
```
Expected: `chars=` に数万、続いてページ冒頭のテキストが出る。

- [ ] **Step 4: コミット**

```bash
git add tools/collect/fetch.mjs package.json package-lock.json
git commit -m "$(cat <<'EOF'
Playwright による取得層を追加

HTML ではなく本文テキストだけを返す。LLM に HTML を渡さないため、
構造をここで落としておく。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: DDT アダプタ（`adapters/ddt.mjs`）

**Files:**
- Create: `tools/collect/adapters/ddt.mjs`
- Create: `tools/collect/__fixtures__/ddt/result-sample.txt`
- Test: `tools/collect/adapters/ddt.test.mjs`

**Interfaces:**
- Consumes: `createFetcher` from `tools/collect/fetch.mjs`（Task 5）
- Produces:
  - `listTargets(fetcher) → Promise<Target[]>`
  - `fetchRaw(fetcher, target) → Promise<string>`
  - `parse(raw, target) → { event: RawEvent, unparsed: string[] }`
  - `PROMOTION = 'ddt'`

**背景（実ページの構造）**: 結果ページは 1 枚に全試合が並ぶ。`第N試合　30分一本勝負` の行で試合が始まり、次の見出しまでが 1 試合。選手名と `WIN` / `LOSE` / `VS` / `＜王者＞` などのラベルが 1 行ずつ交互に並ぶ。最後に `13分52秒`、決まり手、`※` で始まる補足が来る。

- [ ] **Step 1: フィクスチャを書く**

**公式ページの原文は置かない。** 構造だけ真似た架空の興行を手で書く。

`tools/collect/__fixtures__/ddt/result-sample.txt`:

```
TOP
試合結果
2026/07/05

試合結果

サンプル大会2026
サンプル大会2026
日時
2026年7月5日
会場
東京・サンプルホール

第一試合　30分一本勝負

架空太郎

WIN

架空次郎

VS

架空三郎

LOSE

架空四郎

7分12秒

片エビ固め

※サンプルボム。

第二試合　60分一本勝負
サンプル選手権試合
LOSE

＜王者＞

架空五郎

VS

WIN

＜挑戦者＞

架空六郎

15分0秒

回転エビ固め

※サンプルクラッチ。架空五郎が防衛に失敗。

メインイベント　60分一本勝負

架空七郎

WIN

VS

架空八郎

LOSE

22分35秒

ギブアップ

※サンプルロック。

この記事をシェアする
```

- [ ] **Step 2: 失敗するテストを書く**

`tools/collect/adapters/ddt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, PROMOTION } from './ddt.mjs';

const RAW = readFileSync(new URL('../__fixtures__/ddt/result-sample.txt', import.meta.url), 'utf8');
const TARGET = { id: 'sample', url: 'https://example.test/results/sample', kind: 'result' };

test('団体 slug', () => {
  assert.equal(PROMOTION, 'ddt');
});

test('興行の見出しを取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.name, 'サンプル大会2026');
  assert.equal(event.date, '2026-07-05');
  assert.equal(event.promotionSlug, 'ddt');
  assert.equal(event.officialUrl, TARGET.url);
});

test('試合を 3 つ取り order を振る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches.map((m) => m.order), [1, 2, 3]);
});

test('メインイベントも最後の order として拾う', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches.at(-1).order, 3);
});

test('陣営を VS で割り、名前だけを持つ', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].sides, [
    { names: ['架空太郎', '架空次郎'], teamName: null },
    { names: ['架空三郎', '架空四郎'], teamName: null },
  ]);
});

test('ラベル行は名前として拾わない', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[1].sides, [
    { names: ['架空五郎'], teamName: null },
    { names: ['架空六郎'], teamName: null },
  ]);
});

test('勝者側・決まり手・時間を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.deepEqual(event.matches[0].result, {
    winnerSideIndex: 0, decision: 'pinfall', finishText: 'サンプルボム', durationSeconds: 432,
  });
  assert.equal(event.matches[1].result.winnerSideIndex, 1);
  assert.equal(event.matches[1].result.durationSeconds, 900);
});

test('ギブアップは submission', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[2].result.decision, 'submission');
});

test('制限時間と王座名を取る', () => {
  const { event } = parse(RAW, TARGET);
  assert.equal(event.matches[0].timeLimitMinutes, 30);
  assert.equal(event.matches[0].titleName, null);
  assert.equal(event.matches[1].timeLimitMinutes, 60);
  assert.equal(event.matches[1].titleName, 'サンプル選手権');
});

test('補足行を notes に残す', () => {
  const { event } = parse(RAW, TARGET);
  assert.match(event.matches[1].notes, /架空五郎が防衛に失敗/);
});

test('フィクスチャでは取りこぼしが出ない', () => {
  const { unparsed } = parse(RAW, TARGET);
  assert.deepEqual(unparsed, []);
});
```

- [ ] **Step 3: テストを走らせて落ちることを確認**

Run: `npm test`
Expected: FAIL（`Cannot find module './ddt.mjs'`）

- [ ] **Step 4: 実装する**

`tools/collect/adapters/ddt.mjs`:

```js
// DDT アダプタ。ddtpro.com は ddtpro.jp にリダイレクトするので .jp を直に使う。
// 結果ページ 1 枚に全試合の WIN/LOSE・決まり手・時間が載る。
// 開場/開始時刻だけは結果ページに無く、スケジュールページ側にある。

export const PROMOTION = 'ddt';

const BASE = 'https://www.ddtpro.jp';

// 決まり手の文字列 -> schema の decision。判断できないものは 'unknown' にする。
const DECISION = [
  [/オーバー・ザ・トップロープ/, 'over-the-top-rope'],
  [/ギブアップ|ギブ/, 'submission'],
  [/レフェリーストップ|TKO|KO/, 'knockout'],
  [/リングアウト/, 'countout'],
  [/反則/, 'disqualification'],
  [/時間切れ/, 'time-limit-draw'],
  [/両者/, 'draw'],
  [/固め|押さえ込み|丸め込み|クラッチ|フォール/, 'pinfall'],
];

const ORDER_WORDS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

// 選手名ではない行。陣営の組み立て時に落とす。
const LABEL = /^(WIN|LOSE|DRAW|VS|＜.*＞|with .*|※.*)$/;

const HEAD_RE = /^(?:第(.+?)試合|オープニングマッチ|セミファイナル|メインイベント|緊急決定試合)\s*(?:(\d+)分)?/;
const DURATION_RE = /^(\d+)分(\d+)秒$/;

// 結果一覧に載っている分をすべて返す。マージが冪等なので取りすぎても
// 2 回目以降は差分ゼロになる。「直近 N 日」の絞り込みは spec §10 の保留事項。
/** @returns {Promise<Target[]>} */
export async function listTargets(fetcher) {
  const text = await fetcher.fetchText(`${BASE}/results`);
  const ids = [...text.matchAll(/\/results\/([0-9a-f]{24})/g)].map((m) => m[1]);
  return [...new Set(ids)].map((id) => ({ id, url: `${BASE}/results/${id}`, kind: 'result' }));
}

/** @returns {Promise<string>} */
export function fetchRaw(fetcher, target) {
  return fetcher.fetchText(target.url);
}

/**
 * @param {string} raw スナップショットの生テキスト
 * @param {Target} target
 * @returns {{ event: RawEvent, unparsed: string[] }}
 */
export function parse(raw, target) {
  const lines = raw.split('\n').map((s) => s.trim());
  const unparsed = [];

  const date = parseDate(lines);
  const name = parseName(lines);

  const blocks = splitMatches(lines);
  const matches = [];
  for (const [i, block] of blocks.entries()) {
    const m = parseMatch(block, i + 1);
    if (m) matches.push(m);
    else unparsed.push(block.join('\n'));
  }

  const event = {
    eventId: date ? `ddt-${date.replaceAll('-', '')}-0` : null,
    promotionSlug: PROMOTION,
    name,
    series: null,
    date,
    doorsOpen: null,   // 結果ページには無い。スケジュール側で埋める
    bellTime: null,
    venueSlug: null,   // 会場名 -> slug の解決は resolve 段の仕事
    attendance: null,
    confirmed: true,
    officialUrl: target.url,
    sources: [],       // run.mjs が retrievedAt 付きで足す
    matches,
  };
  return { event, unparsed };
}

function parseDate(lines) {
  for (const l of lines) {
    const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(l);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return null;
}

function parseName(lines) {
  const i = lines.findIndex((l) => l === '日時');
  // 「日時」の直前に興行名が 2 回続く（見出しとタイトル）。後ろ側を採る。
  for (let j = i - 1; j >= 0 && j > i - 5; j--) if (lines[j]) return lines[j];
  return null;
}

function splitMatches(lines) {
  const starts = [];
  for (const [i, l] of lines.entries()) if (HEAD_RE.test(l)) starts.push(i);
  return starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length));
}

function parseMatch(block, order) {
  const head = block[0];
  const hm = HEAD_RE.exec(head);
  if (!hm) return null;
  const timeLimitMinutes = hm[2] ? Number(hm[2]) : null;

  // 2 行目が「〜選手権試合」なら王座戦
  const titleLine = block[1] ?? '';
  const titleName = /選手権試合/.test(titleLine)
    ? titleLine.replace(/選手権試合.*$/, '選手権')
    : null;

  const durIdx = block.findIndex((l) => DURATION_RE.test(l));
  if (durIdx === -1) return null;
  const dm = DURATION_RE.exec(block[durIdx]);
  const durationSeconds = Number(dm[1]) * 60 + Number(dm[2]);

  const decisionText = block.slice(durIdx + 1).find(Boolean) ?? '';
  const decision = DECISION.find(([re]) => re.test(decisionText))?.[1] ?? 'unknown';

  const noteLine = block.find((l) => l.startsWith('※'));
  const finishText = noteLine ? (/^※([^。]+)。/.exec(noteLine)?.[1] ?? null) : null;

  const { sides, winnerSideIndex } = parseSides(block.slice(0, durIdx));
  if (sides.length < 1) return null;

  return {
    order,
    matchType: null, // sides の人数から run.mjs 側で決める
    sides,
    titleName,
    timeLimitMinutes,
    result: { winnerSideIndex, decision, finishText, durationSeconds },
    notes: noteLine ?? null,
  };
}

// WIN/LOSE は名前の前にも後ろにも出る。直近に出た勝敗ラベルを
// 「今の陣営」に紐づけ、VS で陣営を切り替える。
function parseSides(lines) {
  const sides = [{ names: [], teamName: null }];
  const outcome = [null];
  let cur = 0;
  let pending = null;

  for (const l of lines.slice(1)) {
    if (!l) continue;
    if (l === 'VS') { sides.push({ names: [], teamName: null }); outcome.push(null); cur = sides.length - 1; pending = null; continue; }
    if (l === 'WIN' || l === 'LOSE' || l === 'DRAW') { pending = l; outcome[cur] ??= l; continue; }
    if (LABEL.test(l)) continue;
    if (/^\d/.test(l)) continue;
    sides[cur].names.push(l);
    if (pending) { outcome[cur] = pending; pending = null; }
  }

  const winnerSideIndex = outcome.indexOf('WIN');
  return {
    sides: sides.filter((s) => s.names.length > 0),
    winnerSideIndex: winnerSideIndex === -1 ? null : winnerSideIndex,
  };
}
```

- [ ] **Step 5: テストが通るまで直す**

Run: `npm test`
Expected: PASS

落ちる場合は**フィクスチャではなくパーサを直す**。フィクスチャは実ページの構造を写したものなので、これに合わせられないパーサは実ページでも動かない。

- [ ] **Step 6: 実スナップショットに当てて取りこぼしを確認**

まず本物を 1 枚取る:

```bash
node --input-type=module -e "
import { createFetcher } from './tools/collect/fetch.mjs';
import { writeSnapshot } from './tools/collect/core/snapshot.mjs';
const f = await createFetcher();
const t = await f.fetchText('https://www.ddtpro.jp/results/6a7b05a1a862f20002deed36');
writeSnapshot('ddt', '6a7b05a1a862f20002deed36', t);
await f.close();
console.log('saved');
"
```

当てる:

```bash
node --input-type=module -e "
import { readSnapshot } from './tools/collect/core/snapshot.mjs';
import { parse } from './tools/collect/adapters/ddt.mjs';
const id = '6a7b05a1a862f20002deed36';
const { event, unparsed } = parse(readSnapshot('ddt', id), { id, url: 'https://www.ddtpro.jp/results/' + id, kind: 'result' });
console.log(event.name, event.date, 'matches=' + event.matches.length, 'unparsed=' + unparsed.length);
for (const m of event.matches) console.log(m.order, JSON.stringify(m.sides.map(s => s.names)), m.result?.decision, m.result?.durationSeconds);
"
```

Expected: `WRESTLE PETER PAN 2026 2026-08-11`。この興行は公式が「第N試合」として 12 試合を掲載している。

**受け入れ基準**: 12 試合のうち 10 試合以上が sides・decision・durationSeconds まで取れていること。取れない試合は `unparsed` に入っていること（黙って欠落させない）。バトルロイヤル（第二試合）は陣営が 1 つになるはずで、これは正しい挙動。

満たせない場合はパーサを直し、**直した構造をフィクスチャにも反映してテストを足す**。実ページを見ながら直した内容は、必ず架空フィクスチャ側にも写すこと（実ページの原文はコミットしない）。

- [ ] **Step 7: コミット**

```bash
git add tools/collect/adapters/ddt.mjs tools/collect/adapters/ddt.test.mjs tools/collect/__fixtures__/ddt/result-sample.txt
git commit -m "$(cat <<'EOF'
DDT アダプタを追加

結果ページの生テキストから興行と試合を取り出す。取りこぼしは
unparsed に入れ、黙って欠落させない。フィクスチャは公式の原文では
なく構造だけ真似た架空の興行。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: レポート（`core/report.mjs`）

**Files:**
- Create: `tools/collect/core/report.mjs`
- Test: `tools/collect/core/report.test.mjs`

**Interfaces:**
- Consumes: `Conflict` / `Unresolved` 型（冒頭の定義）
- Produces: `renderReport(result) → string`（Markdown）

`result` の形:

```js
{
  changed: [{ promotion, eventId, eventName, fields: string[] }],
  conflicts: [{ promotion, eventId, path, existing, incoming, sourceUrl }],
  unresolved: [{ promotion, eventName, name, sourceUrl }],
  failures: [{ promotion, step, message }],
  llmFilled: [{ promotion, eventId, order, model }],
  droppedOrders: [{ promotion, eventId, orders: number[] }],
}
```

- [ ] **Step 1: 失敗するテストを書く**

`tools/collect/core/report.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from './report.mjs';

const EMPTY = { changed: [], conflicts: [], unresolved: [], failures: [], llmFilled: [], droppedOrders: [] };

test('何も無ければ差分なしと書く', () => {
  const md = renderReport(EMPTY);
  assert.match(md, /差分はありません/);
});

test('conflict と unresolved を取り込んだ変更より先に出す', () => {
  const md = renderReport({
    ...EMPTY,
    changed: [{ promotion: 'ddt', eventId: 'ddt-20260811-0', eventName: 'X', fields: ['attendance'] }],
    conflicts: [{ promotion: 'ddt', eventId: 'ddt-20260811-0', path: 'attendance', existing: 1, incoming: 2, sourceUrl: 'u' }],
    unresolved: [{ promotion: 'ddt', eventName: 'X', name: '未知の選手', sourceUrl: 'u' }],
  });
  assert.ok(md.indexOf('## conflict') < md.indexOf('## 取り込んだ変更'));
  assert.ok(md.indexOf('## unresolved') < md.indexOf('## 取り込んだ変更'));
  assert.match(md, /未知の選手/);
});

test('失敗した団体を列挙する', () => {
  const md = renderReport({ ...EMPTY, failures: [{ promotion: 'njpw', step: 'fetch', message: 'timeout' }] });
  assert.match(md, /njpw/);
  assert.match(md, /timeout/);
});

test('LLM が埋めた箇所を明示する', () => {
  const md = renderReport({ ...EMPTY, llmFilled: [{ promotion: 'ddt', eventId: 'e', order: 3, model: 'm' }] });
  assert.match(md, /LLM/);
  assert.match(md, /第 3 試合/);
});

test('公式から消えた order を出す', () => {
  const md = renderReport({ ...EMPTY, droppedOrders: [{ promotion: 'ddt', eventId: 'e', orders: [5] }] });
  assert.match(md, /公式側から消えた/);
});

test('パイプ記号を含む値が表を壊さない', () => {
  const md = renderReport({
    ...EMPTY,
    conflicts: [{ promotion: 'ddt', eventId: 'e', path: 'p', existing: 'a|b', incoming: 'c', sourceUrl: 'u' }],
  });
  assert.match(md, /a\\\|b/);
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npm test`
Expected: FAIL（`Cannot find module './report.mjs'`）

- [ ] **Step 3: 実装する**

`tools/collect/core/report.mjs`:

```js
// 日次実行の結果を Markdown にする純関数。GitHub Actions が PR 本文に流し込む。
// conflict と unresolved を先頭に置く（人間が最初に見るべきものだから）。

const cell = (v) => String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderReport(result) {
  const { changed, conflicts, unresolved, failures, llmFilled, droppedOrders } = result;
  const out = ['# 収集結果', ''];

  if (failures.length) {
    out.push('## 失敗した団体', '', '| 団体 | 段 | エラー |', '|---|---|---|');
    for (const f of failures) out.push(`| ${cell(f.promotion)} | ${cell(f.step)} | ${cell(f.message)} |`);
    out.push('');
  }

  if (conflicts.length) {
    out.push('## conflict', '', '既存値と食い違ったため**上書きしていない**箇所。', '',
      '| 団体 | 興行 | パス | 既存 | 抽出 | 出典 |', '|---|---|---|---|---|---|');
    for (const c of conflicts) {
      out.push(`| ${cell(c.promotion)} | ${cell(c.eventId)} | \`${cell(c.path)}\` | ${cell(JSON.stringify(c.existing))} | ${cell(JSON.stringify(c.incoming))} | ${cell(c.sourceUrl)} |`);
    }
    out.push('');
  }

  if (unresolved.length) {
    out.push('## unresolved', '', '解決できなかった名前。**この興行は書いていない。**',
      '選手を `data/wrestlers/` に足してから再実行すると通る。', '',
      '| 団体 | 興行 | 名前 | 出典 |', '|---|---|---|---|');
    for (const u of unresolved) {
      out.push(`| ${cell(u.promotion)} | ${cell(u.eventName)} | ${cell(u.name)} | ${cell(u.sourceUrl)} |`);
    }
    out.push('');
  }

  if (droppedOrders.length) {
    out.push('## 公式側から消えた試合', '', '既存データには残してある。消すかどうかは人間が判断する。', '');
    for (const d of droppedOrders) {
      out.push(`- ${cell(d.promotion)} / ${cell(d.eventId)} — 第 ${d.orders.join(', ')} 試合`);
    }
    out.push('');
  }

  if (llmFilled.length) {
    out.push('## LLM が埋めた箇所', '', 'パーサが取りこぼし、LLM が補った試合。レビュー時に重点的に見ること。', '');
    for (const l of llmFilled) {
      out.push(`- ${cell(l.promotion)} / ${cell(l.eventId)} 第 ${l.order} 試合（${cell(l.model)}）`);
    }
    out.push('');
  }

  out.push('## 取り込んだ変更', '');
  if (changed.length) {
    out.push('| 団体 | 興行 | 追記したフィールド |', '|---|---|---|');
    for (const c of changed) {
      out.push(`| ${cell(c.promotion)} | ${cell(c.eventId)} ${cell(c.eventName)} | ${cell(c.fields.join(', '))} |`);
    }
  } else {
    out.push('差分はありません。');
  }
  out.push('');

  return out.join('\n');
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add tools/collect/core/report.mjs tools/collect/core/report.test.mjs
git commit -m "$(cat <<'EOF'
収集結果のレポート生成を追加

conflict と unresolved を先頭に置く。PR 本文にそのまま流し込む
Markdown を返す純関数。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: パイプラインの結線（`run.mjs`）

**Files:**
- Create: `tools/collect/run.mjs`
- Modify: `package.json`（`collect` スクリプト）

**Interfaces:**
- Consumes: Task 1〜7 のすべて
- Produces: CLI `npm run collect -- [--promotion <slug>] [--step fetch|parse] [--no-llm] [--dry-run]`

> **spec からの意図的な差**: spec §3 の CLI は `--step fetch|parse|merge` の 3 段だが、`merge` は
> 常に `parse` の直後に走り、parse 結果を中間ファイルに残さない限り単独では回せない。中間ファイルを
> 増やすとスナップショットと二重管理になるので、**`--step` は `fetch` と `parse` の 2 つに絞る**
> （`parse` は resolve → merge → validate → 反映まで通す）。spec 側もこの計画のマージ後に直す。

このタスクにユニットテストは書かない。中身が I/O の結線で、Task 1〜7 でロジックはすべてテスト済みのため。動作確認は Step 3〜4 の実行で行う。

- [ ] **Step 1: `package.json` にスクリプトを足す**

```json
"collect": "node tools/collect/run.mjs",
```

- [ ] **Step 2: 実装する**

`tools/collect/run.mjs`:

```js
// 収集パイプラインのエントリ。git は触らない。
// 書くのは data/ と .cache/report.md の 2 つだけ。PR 作成は CI の仕事。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createFetcher } from './fetch.mjs';
import {
  writeSnapshot, readSnapshot, listSnapshots, writeSnapshotUrl, readSnapshotUrl,
} from './core/snapshot.mjs';
import { buildIndex, resolve as resolveName } from './core/aliases.mjs';
import { merge } from './core/merge.mjs';
import { renderReport } from './core/report.mjs';
import { extract } from './core/llm.mjs';
import * as ddt from './adapters/ddt.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA = join(ROOT, 'data');
const STAGING = join(ROOT, '.cache', 'data-staging');
const REPORT = join(ROOT, '.cache', 'report.md');

const ADAPTERS = { ddt };

const MATCH_TYPE_BY_SIZE = { 1: 'singles', 2: 'tag', 3: 'six-man-tag', 4: 'eight-man-tag' };

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
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function loadWrestlers() {
  return readdirSync(join(DATA, 'wrestlers'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(DATA, 'wrestlers', f), 'utf8')));
}

function eventPath(base, promotion, eventId) {
  const year = eventId.split('-')[1].slice(0, 4);
  return join(base, 'events', promotion, year, `${eventId}.json`);
}

// RawEvent（表示名）→ PartialEvent（slug）。解決できない名前があれば
// その興行は書かない（spec §5）。
function resolveEvent(rawEvent, index, promotion, sourceUrl) {
  const unresolved = [];
  const matches = rawEvent.matches.map((m) => {
    const sides = m.sides.map((s) => {
      const wrestlerIds = s.names.map((n) => {
        const slug = resolveName(n, index);
        if (!slug) unresolved.push({ promotion, eventName: rawEvent.name, name: n, sourceUrl });
        return slug;
      });
      return { wrestlerIds, teamName: s.teamName };
    });
    const size = sides[0]?.wrestlerIds.length ?? 0;
    const matchType = m.matchType
      ?? (sides.length === 1 ? 'battle-royal' : (MATCH_TYPE_BY_SIZE[size] ?? 'multi-man'));
    return { ...m, sides, matchType };
  });
  return { event: { ...rawEvent, matches }, unresolved };
}

async function runPromotion(promotion, opts, result) {
  const adapter = ADAPTERS[promotion];
  const wrestlerIndex = buildIndex(loadWrestlers()).index;

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
  for (const id of listSnapshots(promotion)) {
    const url = readSnapshotUrl(promotion, id);
    try {
      const raw = readSnapshot(promotion, id);
      const target = { id, url, kind: 'result' };
      const { event: rawEvent, unparsed } = adapter.parse(raw, target);

      if (unparsed.length && !opts.noLlm) {
        for (const fragment of unparsed) {
          const filled = await extract(fragment, 'match');
          if (!filled) continue;
          rawEvent.matches.push(filled.match);
          result.llmFilled.push({ promotion, eventId: rawEvent.eventId, order: filled.match.order, model: filled.model });
        }
      }

      if (!rawEvent.eventId) {
        result.failures.push({ promotion, step: 'parse', message: `${id}: 日付が取れず eventId を決められない` });
        continue;
      }

      const { event, unresolved } = resolveEvent(rawEvent, wrestlerIndex, promotion, url);
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

      const incomingOrders = new Set(event.matches.map((m) => m.order));
      const dropped = existing.matches.map((m) => m.order).filter((o) => !incomingOrders.has(o));
      if (dropped.length) result.droppedOrders.push({ promotion, eventId: event.eventId, orders: dropped });

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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = { changed: [], conflicts: [], unresolved: [], failures: [], llmFilled: [], droppedOrders: [] };

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
    const v = spawnSync('node', [join(ROOT, 'tools', 'validate.mjs'), '--data', STAGING], { encoding: 'utf8' });
    process.stdout.write(v.stdout ?? '');
    process.stderr.write(v.stderr ?? '');
    if (v.status !== 0) {
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

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, renderReport(result), 'utf8');
  process.stdout.write(`\nレポート: ${REPORT}\n`);
  process.exit(result.failures.length ? 1 : 0);
}

await main();
```

- [ ] **Step 3: dry-run で通しで動かす**

Run: `npm run collect -- --promotion ddt --dry-run`
Expected: `検証 OK` が出て、`.cache/report.md` が生成される。`data/` に差分が出ていないこと（`git status` で確認）。

Run: `cat .cache/report.md`
Expected: unresolved に外国人選手など未登録の名前が並ぶ可能性がある。これは想定内の挙動。

- [ ] **Step 5: 本番反映で動かす**

Run: `npm run collect -- --promotion ddt`
Run: `git status --short && git diff --stat`
Expected: `data/events/ddt/` 配下にのみ差分が出る。既存の値が書き換わっていないこと（`git diff` を目で見て、削除行が `null` からの置換だけであることを確認）。

削除行に人間が書いた `notes` の変更が含まれていたら**マージが壊れている**。Task 1 に戻る。

- [ ] **Step 6: 差分を戻してコミット**

```bash
git checkout -- data/
git add tools/collect/run.mjs tools/collect/core/snapshot.mjs tools/collect/core/snapshot.test.mjs package.json
git commit -m "$(cat <<'EOF'
収集パイプラインを結線する

fetch -> snapshot -> parse -> resolve -> merge -> validate -> report。
staging に書いて検証を通ったときだけ data/ に反映する。git は触らない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: LLM フォールバック（`core/llm.mjs`）

**Files:**
- Create: `tools/collect/core/llm.mjs`
- Test: `tools/collect/core/llm.test.mjs`
- Modify: `package.json`（`@anthropic-ai/sdk` を devDependencies に）

**Interfaces:**
- Consumes: `data/schema/match.schema.json`
- Produces: `extract(textFragment, schemaName) → Promise<{ match: RawMatch, model: string } | null>`

- [ ] **Step 1: `@anthropic-ai/sdk` を足す**

Run: `npm install --save-dev @anthropic-ai/sdk`

- [ ] **Step 2: 失敗するテストを書く**

ネットワークを叩かない範囲だけテストする。鍵が無いときの挙動が最重要。

`tools/collect/core/llm.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, isEnabled } from './llm.mjs';

test('鍵が無ければ無効', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(isEnabled(), false);
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

test('無効なら null を返しパイプラインを止めない', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await extract('なんらかのテキスト', 'match'), null);
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

test('空の断片は API を呼ばずに null', async () => {
  assert.equal(await extract('   ', 'match'), null);
});
```

- [ ] **Step 3: テストを走らせて落ちることを確認**

Run: `npm test`
Expected: FAIL（`Cannot find module './llm.mjs'`）

- [ ] **Step 4: 実装する**

`tools/collect/core/llm.mjs`:

```js
// パーサが取りこぼした断片にだけ効かせるフォールバック抽出。
//
// 契約（spec §6）:
//   1. 呼ばれるのは adapter.parse が返した unparsed[] だけ。ページ全体は投げない
//   2. 出力はスキーマで縛る
//   3. 返ってきた JSON は必ず ajv で再検証する。落ちたら 1 回だけ再試行
//   4. slug は作らせない。返させるのは表示名の文字列だけ
//   5. 鍵が無ければ黙って無効になる。パイプラインは止まらない
//   6. 使ったことをレポートに残す（model を返す）
//
// モデルとプロバイダの選定は保留。差し替えるときはこのファイルの中だけを直す。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import ajvModule from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const Ajv2020 = ajvModule.default ?? ajvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODEL = 'claude-opus-5';

const SYSTEM = [
  'あなたはプロレスの大会結果テキストから 1 試合ぶんの情報を抜き出す変換器です。',
  '出力はスキーマに従った JSON だけにしてください。',
  '選手は必ず「テキストに書かれている表示名の文字列」で返してください。',
  'ID や slug を作ってはいけません。',
  'テキストに書かれていない情報は推測せず null にしてください。',
].join('\n');

export function isEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// LLM に返させる形。match.schema.json から wrestlerIds を names に差し替えたもの。
function outputSchema() {
  const match = JSON.parse(readFileSync(join(ROOT, 'data', 'schema', 'match.schema.json'), 'utf8'));
  const side = {
    type: 'object',
    properties: {
      names: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      teamName: { type: ['string', 'null'] },
    },
    required: ['names', 'teamName'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      order: match.properties.order,
      matchType: { type: ['string', 'null'] },
      sides: { type: 'array', items: side, minItems: 1 },
      titleName: { type: ['string', 'null'] },
      timeLimitMinutes: { type: ['integer', 'null'] },
      result: {
        type: ['object', 'null'],
        properties: {
          winnerSideIndex: { type: ['integer', 'null'] },
          decision: match.properties.result.oneOf[1].properties.decision,
          finishText: { type: ['string', 'null'] },
          durationSeconds: { type: ['integer', 'null'] },
        },
        required: ['winnerSideIndex', 'decision', 'finishText', 'durationSeconds'],
        additionalProperties: false,
      },
      notes: { type: ['string', 'null'] },
    },
    required: ['order', 'matchType', 'sides', 'titleName', 'timeLimitMinutes', 'result', 'notes'],
    additionalProperties: false,
  };
}

let validator = null;
function getValidator() {
  if (validator) return validator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  validator = ajv.compile(outputSchema());
  return validator;
}

/**
 * @param {string} textFragment パーサが取りこぼした 1 試合ぶんのテキスト
 * @param {'match'} schemaName
 * @returns {Promise<{ match: object, model: string } | null>}
 */
export async function extract(textFragment, schemaName) {
  if (schemaName !== 'match') return null;
  if (!textFragment || !textFragment.trim()) return null;
  if (!isEnabled()) return null;

  const client = new Anthropic();
  const validate = getValidator();

  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed;
    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: outputSchema() } },
        messages: [{ role: 'user', content: textFragment }],
      });
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      parsed = JSON.parse(text);
    } catch {
      continue; // 通信・パース失敗は再試行の対象
    }
    // structured outputs が通っても信用しない
    if (validate(parsed)) return { match: parsed, model: MODEL };
  }
  return null;
}
```

> **注意:** `output_config.format` の正確な形（`json_schema` のキー名など）は SDK のバージョンによって変わる。Step 6 で実際に 1 回叩き、400 が返るならエラーメッセージに従って直すこと。**`temperature` は付けない**（Opus 5 系では廃止されており、送ると 400 になる）。

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 鍵がある環境で 1 回だけ実際に叩く**

鍵が無ければこの Step は飛ばしてよい（`--no-llm` 相当で動くことが Step 5 で確認できている）。

Run:
```bash
node --input-type=module -e "
import { extract } from './tools/collect/core/llm.mjs';
const r = await extract('第九試合　30分一本勝負\n架空一郎\nWIN\nVS\n架空二郎\nLOSE\n9分9秒\n片エビ固め\n※サンプル技。', 'match');
console.log(JSON.stringify(r, null, 2));
"
```
Expected: `sides[].names` に `架空一郎` / `架空二郎` が文字列で入り、slug は出てこない。400 が返る場合は `output_config` の形をエラーメッセージに合わせて直す。

- [ ] **Step 7: コミット**

```bash
git add tools/collect/core/llm.mjs tools/collect/core/llm.test.mjs package.json package-lock.json
git commit -m "$(cat <<'EOF'
LLM フォールバック抽出を追加

パーサが取りこぼした断片にだけ効かせる。鍵が無ければ黙って無効になり
パイプラインは止まらない。出力は ajv で再検証し、slug は作らせない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: ワークフロー（`collect.yml`）

**Files:**
- Create: `.github/workflows/collect.yml`

**Interfaces:**
- Consumes: `npm run collect`（Task 8）、`.cache/report.md`
- Produces: なし

- [ ] **Step 1: ワークフローを書く**

**cron はまだ入れない**（spec §7）。GH Actions 上で試行錯誤すると 1 回の確認に数分かかるため、安定するまで手動実行だけにする。

`.github/workflows/collect.yml`:

```yaml
name: collect

# cron は Phase C が安定してから足す。今は手動実行のみ。
on:
  workflow_dispatch:
    inputs:
      promotion:
        description: 団体 slug（空なら全団体）
        required: false
        default: ''

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: collect
  cancel-in-progress: false

jobs:
  collect:
    name: 収集して PR を出す
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version-file: .node-version
          cache: npm

      - name: 依存関係をインストール
        run: npm ci

      - name: ブラウザを導入
        run: npx playwright install --with-deps chromium

      - name: 収集
        id: collect
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: npm run collect -- ${{ inputs.promotion && format('--promotion {0}', inputs.promotion) || '' }}
        continue-on-error: true

      - name: レポートを読む
        id: report
        run: |
          {
            echo 'body<<PWEOF'
            cat .cache/report.md
            echo PWEOF
          } >> "$GITHUB_OUTPUT"

      - name: PR を作る
        uses: peter-evans/create-pull-request@v7
        with:
          branch: collect/auto
          base: main
          title: "データ収集: ${{ github.run_started_at }}"
          body: ${{ steps.report.outputs.body }}
          commit-message: |
            公式サイトから興行データを取り込む

            tools/collect による自動収集。詳細は PR 本文のレポートを参照。
          add-paths: data/
          delete-branch: false
```

> **注意:** `continue-on-error: true` は意図的。`run.mjs` は失敗した団体があると exit 1 を返すが、**部分失敗を許容する**設計なので、取れた分は PR にしたい。失敗した団体はレポートに載る。

- [ ] **Step 2: コミット**

```bash
git add .github/workflows/collect.yml
git commit -m "$(cat <<'EOF'
収集ワークフローを追加（手動実行のみ）

cron は Phase C が安定してから足す。部分失敗を許容するため
continue-on-error にし、取れた分だけ PR にする。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: push してワークフローが認識されることを確認**

Run: `git push && gh workflow list`
Expected: `collect` が一覧に出る。出なければ YAML の構文エラーなので、`gh api repos/:owner/:repo/actions/workflows` でメッセージを見て直す。

- [ ] **Step 4: 手動実行して PR が立つことを確認**

Run: `gh workflow run collect.yml -f promotion=ddt`
Run: `gh run watch --exit-status`
Expected: 成功し、`collect/auto` ブランチに PR が立つ。PR 本文にレポートの表が出ている。

差分が無ければ PR は立たない（`create-pull-request` の既定挙動）。それも正しい結果。

---

## 完了の確認

すべてのタスクが終わったら:

- [ ] `npm test` — 全テストが通る
- [ ] `npm run validate` — `検証 OK`
- [ ] `npm run build` — ビルドが通る
- [ ] `npm run collect -- --promotion ddt --dry-run` — レポートが出て `data/` に差分が出ない
- [ ] `npm run collect -- --promotion ddt` を 2 回続けて実行 — **2 回目の差分がゼロ**（冪等性の確認。ここが崩れると毎日空の PR が立つ）
- [ ] `git checkout -- data/` で戻す

## 次の計画

- `adapters/njpw.mjs` と `adapters/stardom.mjs`。両団体のスナップショットを取ってから、Task 6 と同じ形で書く
- cron の有効化（spec §10）
