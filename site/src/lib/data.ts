import { getCollection } from 'astro:content';
import type { Promotion, Wrestler, Venue, Move, PWEvent, News, Match } from './types';

type CollectionName = 'promotions' | 'wrestlers' | 'venues' | 'moves' | 'events' | 'news';

/**
 * collection から data だけを取り出す薄いラッパ。
 *
 * content.config.ts で zod スキーマを定義していない（JSON Schema と二重定義に
 * したくない）ため、Astro 側の data は型が付かない。ここで一度だけキャストし、
 * 以降は lib/types.ts の型で扱う。形の保証は tools/validate.mjs が持つ。
 */
async function load<T>(name: CollectionName): Promise<T[]> {
  const entries = (await getCollection(name as 'promotions')) as unknown as { data: T }[];
  return entries.map((e) => e.data);
}

export const getPromotions = () => load<Promotion>('promotions');
export const getWrestlers = () => load<Wrestler>('wrestlers');
export const getVenues = () => load<Venue>('venues');
export const getMoves = () => load<Move>('moves');
export const getEvents = () => load<PWEvent>('events');
export const getNews = () => load<News>('news');

export function byKey<T, K extends keyof T>(items: T[], key: K): Map<T[K], T> {
  return new Map(items.map((i) => [i[key], i]));
}

/** 全データを一度に読み、相互参照用の索引まで作る。 */
export async function loadAll() {
  const [promotions, wrestlers, venues, moves, events, news] = await Promise.all([
    getPromotions(),
    getWrestlers(),
    getVenues(),
    getMoves(),
    getEvents(),
    getNews(),
  ]);
  return {
    promotions: promotions.sort((a, b) => a.slug.localeCompare(b.slug)),
    wrestlers: wrestlers.sort((a, b) => a.slug.localeCompare(b.slug)),
    venues: venues.sort((a, b) => a.slug.localeCompare(b.slug)),
    moves: moves.sort((a, b) => a.slug.localeCompare(b.slug)),
    events: events.sort(byDateDesc),
    news: news.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate)),
    promotionBySlug: byKey(promotions, 'slug'),
    wrestlerBySlug: byKey(wrestlers, 'slug'),
    venueBySlug: byKey(venues, 'slug'),
    moveBySlug: byKey(moves, 'slug'),
    eventById: byKey(events, 'eventId'),
  };
}

export const byDateDesc = (a: PWEvent, b: PWEvent) =>
  b.date.localeCompare(a.date) || a.eventId.localeCompare(b.eventId);

export const byDateAsc = (a: PWEvent, b: PWEvent) =>
  a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId);

/* ---------------- 表示用フォーマッタ ---------------- */

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][
    new Date(`${iso}T00:00:00Z`).getUTCDay()
  ];
  return `${y}年${Number(m)}月${Number(d)}日(${weekday})`;
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

export const MATCH_TYPE_LABEL: Record<Match['matchType'], string> = {
  singles: 'シングルマッチ',
  tag: 'タッグマッチ',
  'six-man-tag': '6人タッグマッチ',
  'eight-man-tag': '8人タッグマッチ',
  'multi-man': '多人数マッチ',
  'battle-royal': 'バトルロイヤル',
  gauntlet: 'ガントレットマッチ',
  other: 'その他',
};

export const DECISION_LABEL: Record<NonNullable<Match['result']>['decision'], string> = {
  pinfall: 'フォール勝ち',
  submission: 'ギブアップ勝ち',
  knockout: 'KO勝ち',
  countout: 'リングアウト勝ち',
  disqualification: '反則勝ち',
  draw: '引き分け',
  'time-limit-draw': '時間切れ引き分け',
  'no-contest': '無効試合',
  unknown: '決まり手不明',
};

export const MOVE_CATEGORY_LABEL: Record<Move['category'], string> = {
  strike: '打撃',
  throw: '投げ',
  submission: '関節技',
  aerial: '飛び技',
  pin: '固め技',
  other: 'その他',
};

export const STATUS_LABEL: Record<Wrestler['status'], string> = {
  active: '現役',
  inactive: '休養中',
  retired: '引退',
  freelance: 'フリー',
  unknown: '不明',
};

/** 今日以降の興行か。ビルド時刻基準。 */
export function isUpcoming(event: PWEvent, today = new Date()): boolean {
  return event.date >= today.toISOString().slice(0, 10);
}
