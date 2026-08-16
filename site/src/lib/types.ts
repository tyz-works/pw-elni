/**
 * 表示側の型。検証の権威ではない（それは data/schema/*.json）。
 * スキーマを変えたらここも合わせる。ズレたら `astro check` が拾う。
 */

export interface Source {
  url: string;
  title: string;
  retrievedAt: string;
}

export interface Promotion {
  slug: string;
  name: string;
  nameEn: string | null;
  shortName: string | null;
  foundedDate: string | null;
  officialUrl: string | null;
  description: string | null;
  sources: Source[];
}

export interface Wrestler {
  slug: string;
  name: string;
  nameEn: string | null;
  aliases: string[];
  realName: string | null;
  birthDate: string | null;
  birthplace: string | null;
  debutDate: string | null;
  heightCm: number | null;
  weightKg: number | null;
  status: 'active' | 'inactive' | 'retired' | 'freelance' | 'unknown';
  promotionSlugs: string[];
  finishingMoveSlugs: string[];
  sources: Source[];
}

export interface Venue {
  slug: string;
  name: string;
  nameEn: string | null;
  city: string;
  prefecture: string;
  capacity: number | null;
  sources: Source[];
}

export interface Move {
  slug: string;
  name: string;
  nameEn: string | null;
  category: 'strike' | 'throw' | 'submission' | 'aerial' | 'pin' | 'other';
  description: string | null;
  sources: Source[];
}

export interface MatchSide {
  wrestlerIds: string[];
  teamName: string | null;
}

export interface MatchResult {
  winnerSideIndex: number | null;
  decision:
    | 'pinfall'
    | 'submission'
    | 'knockout'
    | 'countout'
    | 'disqualification'
    | 'draw'
    | 'time-limit-draw'
    | 'no-contest';
  finishMoveSlug: string | null;
  durationSeconds: number | null;
}

export interface Match {
  order: number;
  matchType:
    | 'singles'
    | 'tag'
    | 'six-man-tag'
    | 'eight-man-tag'
    | 'multi-man'
    | 'battle-royal'
    | 'gauntlet'
    | 'other';
  sides: MatchSide[];
  titleName: string | null;
  timeLimitMinutes: number | null;
  result: MatchResult | null;
  confirmed: boolean;
  notes: string | null;
}

export interface PWEvent {
  eventId: string;
  promotionSlug: string;
  name: string;
  series: string | null;
  date: string;
  doorsOpen: string | null;
  bellTime: string | null;
  venueSlug: string;
  attendance: number | null;
  confirmed: boolean;
  matches: Match[];
  officialUrl: string | null;
  sources: Source[];
}

export interface News {
  id: string;
  title: string;
  publishedDate: string;
  summary: string;
  sourceUrl: string;
  sourceName: string;
  relatedPromotionSlugs: string[];
  relatedWrestlerSlugs: string[];
  relatedEventIds: string[];
}
