#!/usr/bin/env node
/**
 * validate.mjs が「壊れたデータをちゃんと落とすか」を検証する。
 *
 * data/ を一時ディレクトリに複製し、1 箇所だけ壊してから validate.mjs を回す。
 * exit 1 になり、かつ意図したルールのメッセージが出ることを確認する。
 *
 * 検証器そのものが壊れると CI がザルになるので、これも CI で回す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DATA = join(ROOT, 'data');
const VALIDATE = join(ROOT, 'tools', 'validate.mjs');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');

/** data/ を複製して mutate を適用し、validate.mjs を実行した結果を返す。 */
function runWithMutation(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-elni-test-'));
  try {
    cpSync(SRC_DATA, join(dir, 'data'), { recursive: true });
    mutate(join(dir, 'data'));
    const r = spawnSync(process.execPath, [VALIDATE, '--data', join(dir, 'data')], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 壊していない状態では通ること。ここが落ちたら他のテストは意味を持たない。 */
test('無改変の data/ は検証を通る', () => {
  const { code, out } = runWithMutation(() => {});
  assert.equal(code, 0, `想定外の失敗:\n${out}`);
});

/**
 * 条件を満たす興行 / 選手のファイルを data/ から 1 件選ぶ。
 * 特定のサンプルデータのファイル名に依存すると、データ差し替えのたびに
 * 検証器のテストが巻き添えで落ちるため、ここで動的に解決する。
 */
function pickJson(dir, pred = () => true) {
  const hit = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f))
    .find((p) => pred(readJson(p)));
  assert.ok(hit, `条件に合うファイルが ${dir} にない`);
  return hit;
}

const CASES = [
  {
    name: 'スキーマ違反: slug に大文字',
    expect: 'スキーマ違反',
    mutate: (d) => {
      const p = join(d, 'wrestlers', 'mao.json');
      const w = readJson(p);
      w.slug = 'MAO';
      writeJson(p, w);
    },
  },
  {
    name: 'スキーマ違反: 未知のフィールド',
    expect: 'スキーマ違反',
    mutate: (d) => {
      const p = join(d, 'venues', 'tokyo-korakuen-hall.json');
      const v = readJson(p);
      v.nickname = 'メッカ';
      writeJson(p, v);
    },
  },
  {
    name: 'スキーマ違反: 必須フィールド欠落',
    expect: 'スキーマ違反',
    mutate: (d) => {
      const p = join(d, 'promotions', 'ddt.json');
      const o = readJson(p);
      delete o.officialUrl;
      writeJson(p, o);
    },
  },
  {
    name: '必須出典: birthDate があるのに sources[] が空',
    expect: '必須出典',
    mutate: (d) => {
      const p = join(d, 'wrestlers', 'yuki-ueno.json');
      const w = readJson(p);
      w.birthDate = '1995-01-01';
      w.sources = [];
      writeJson(p, w);
    },
  },
  {
    name: '孤立参照: 存在しない選手を指す試合',
    expect: '孤立参照',
    mutate: (d) => {
      const p = pickJson(join(d, 'events'), (e) => e.matches.length > 0);
      const e = readJson(p);
      e.matches[0].sides[0].wrestlerIds = ['nonexistent-wrestler'];
      writeJson(p, e);
    },
  },
  {
    name: '孤立参照: 存在しない会場を指す興行',
    expect: '孤立参照',
    mutate: (d) => {
      const p = pickJson(join(d, 'events'));
      const e = readJson(p);
      e.venueSlug = 'nowhere-arena';
      writeJson(p, e);
    },
  },
  {
    name: '孤立参照: 存在しない技を finishingMoveSlugs に持つ選手',
    expect: '孤立参照',
    mutate: (d) => {
      const p = pickJson(join(d, 'wrestlers'));
      const w = readJson(p);
      w.finishingMoveSlugs = ['imaginary-move'];
      writeJson(p, w);
    },
  },
  {
    name: '重複: 同一 eventId が 2 ファイルに存在',
    expect: '重複',
    mutate: (d) => {
      const src = pickJson(join(d, 'events'));
      const year = Number(basename(dirname(src)));
      const dst = join(dirname(dirname(src)), String(year - 1), basename(src));
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
    },
  },
  {
    name: '日付整合: doorsOpen が bellTime 以降',
    expect: '日付整合',
    mutate: (d) => {
      const p = pickJson(join(d, 'events'));
      const e = readJson(p);
      e.doorsOpen = '18:00';
      e.bellTime = '17:00';
      writeJson(p, e);
    },
  },
  {
    name: '日付整合: debutDate が birthDate 以前',
    expect: '日付整合',
    mutate: (d) => {
      const p = join(d, 'wrestlers', 'mao.json');
      const w = readJson(p);
      w.birthDate = '1994-05-05';
      w.debutDate = '1990-01-01';
      w.sources = [{ url: 'https://example.com/', title: 'ダミー出典', retrievedAt: '2026-08-16' }];
      writeJson(p, w);
    },
  },
  {
    name: 'ファイル名不一致',
    expect: 'ファイル名',
    mutate: (d) => {
      renameSync(join(d, 'moves', 'destino.json'), join(d, 'moves', 'destino-x.json'));
    },
  },
  {
    name: '配置規約違反: 興行が誤った年ディレクトリにある',
    expect: '配置',
    mutate: (d) => {
      const src = pickJson(join(d, 'events'));
      const year = Number(basename(dirname(src)));
      const dst = join(dirname(dirname(src)), String(year - 1), basename(src));
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
    },
  },
  {
    name: 'eventId の日付部分が date と食い違う',
    expect: 'eventId の日付部分',
    mutate: (d) => {
      const p = pickJson(join(d, 'events'));
      const e = readJson(p);
      // 日だけ差し替える。eventId の日付部分は元のまま。
      // 年月を動かさないので events/{YYYY}/ の配置規約には引っかからない
      const [y, m, dd] = e.date.split('-');
      e.date = `${y}-${m}-${dd === '01' ? '02' : '01'}`;
      writeJson(p, e);
    },
  },
  {
    name: 'singles なのに 3 人',
    expect: 'singles',
    mutate: (d) => {
      const p = pickJson(join(d, 'events'), (e) => e.matches.some((x) => x.matchType === 'singles'));
      const e = readJson(p);
      const m = e.matches.find((x) => x.matchType === 'singles');
      // この興行に出ていない選手を足す。両陣営重複など別ルールを巻き込まないようにする。
      const used = new Set(e.matches.flatMap((x) => x.sides.flatMap((s) => s.wrestlerIds)));
      const spare = readdirSync(join(d, 'wrestlers'))
        .map((f) => basename(String(f), '.json'))
        .find((slug) => !used.has(slug));
      assert.ok(spare, '興行に出ていない選手が data/wrestlers にない');
      m.sides[0].wrestlerIds = [m.sides[0].wrestlerIds[0], spare];
      writeJson(p, e);
    },
  },
  {
    name: '同一選手が両陣営に含まれる',
    expect: '複数の陣営',
    mutate: (d) => {
      const hasTwoSides = (e) =>
        e.matches.some((m) => m.sides.length >= 2 && m.sides.every((s) => s.wrestlerIds.length > 0));
      const p = pickJson(join(d, 'events'), hasTwoSides);
      const e = readJson(p);
      const m = e.matches.find((x) => x.sides.length >= 2 && x.sides.every((s) => s.wrestlerIds.length > 0));
      m.sides[1].wrestlerIds[0] = m.sides[0].wrestlerIds[0];
      writeJson(p, e);
    },
  },
  {
    name: 'result があるのに confirmed が false',
    expect: 'confirmed が false',
    mutate: (d) => {
      const p = pickJson(join(d, 'events'), (e) => e.matches.length > 0);
      const e = readJson(p);
      e.matches[0].confirmed = false;
      e.matches[0].result = {
        winnerSideIndex: 0,
        decision: 'pinfall',
        finishMoveSlug: null,
        durationSeconds: 600,
      };
      writeJson(p, e);
    },
  },
  {
    name: '引き分けなのに勝者がいる',
    expect: 'winnerSideIndex が null でない',
    mutate: (d) => {
      const p = pickJson(join(d, 'events'), (e) => e.matches.length > 0);
      const e = readJson(p);
      e.matches[0].confirmed = true;
      e.matches[0].result = {
        winnerSideIndex: 0,
        decision: 'time-limit-draw',
        finishMoveSlug: null,
        durationSeconds: 1800,
      };
      writeJson(p, e);
    },
  },
  {
    name: 'CRLF の混入',
    expect: 'CRLF',
    mutate: (d) => {
      const p = join(d, 'promotions', 'njpw.json');
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll('\n', '\r\n'), 'utf8');
    },
  },
  {
    name: '壊れた JSON',
    expect: 'JSON パース失敗',
    mutate: (d) => {
      writeFileSync(join(d, 'moves', 'rainmaker.json'), '{ "slug": ', 'utf8');
    },
  },
  {
    name: 'ニュースが存在しない興行を参照',
    expect: '孤立参照',
    mutate: (d) => {
      const p = join(d, 'news', '2026-08', 'sample-phase-b-launch.json');
      const n = readJson(p);
      n.relatedEventIds = ['njpw-19990101-0'];
      writeJson(p, n);
    },
  },
  {
    name: 'aliases の正規化キーが他の選手と衝突',
    expect: '正規化キーが衝突',
    mutate: (d) => {
      const [aPath, bPath] = readdirSync(join(d, 'wrestlers'))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .slice(0, 2)
        .map((f) => join(d, 'wrestlers', f));
      // b の aliases に a の name を入れ、別 slug が同じ正規化キーを持つ状態を作る
      const b = readJson(bPath);
      b.aliases = [...b.aliases, readJson(aPath).name];
      writeJson(bPath, b);
    },
  },
];

for (const c of CASES) {
  test(`落ちるべき: ${c.name}`, () => {
    const { code, out } = runWithMutation(c.mutate);
    assert.equal(code, 1, `検証が通ってしまった (このデータは落ちるべき):\n${out}`);
    assert.ok(
      out.includes(c.expect),
      `期待したメッセージ "${c.expect}" が出力に無い:\n${out}`,
    );
  });
}
