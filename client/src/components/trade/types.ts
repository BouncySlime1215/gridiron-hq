/**
 * Evidence shapes on a trade-evaluation response (server/services/trade-engine.js,
 * `playerEvidence()` / `packageRisk()`). Every field is optional at the call sites:
 * a league with no play-by-play history or no fitted model simply has no `career`
 * / `preseason` / `offseason` on its players, and the cards read as they did before.
 */
import type { Career, Preseason } from '../draft/types';

export type { Career, Preseason };

export interface TradeCareer extends Career {
  seasons_on_record?: number | null;
  consistency?: (Career['consistency'] & { seasons_counted?: number | null; max_games?: number | null }) | null;
  trend?: { points_yoy_pct?: number | null; ppg_yoy_pct?: number | null; role_yoy?: string | null } | null;
}

export interface Offseason {
  opportunity_multiplier: number;
  ppg_multiplier?: number | null;
  confidence?: string | null;
  drivers?: string[];
  direction?: 'upside' | 'risk' | 'neutral';
  applied_to_value?: false;
}

export interface TradePlayer {
  id: number;
  name: string;
  position: string;
  value?: number | null;
  career?: TradeCareer | null;
  preseason?: Preseason | null;
  offseason?: Offseason | null;
}

export interface PlayerRisk {
  id: number; name: string; value: number;
  seasons: number; top24: number; top12: number;
  min_games: number | null; swing_pct: number | null; band_pct: number | null;
  points: number | null; p20: number | null; p80: number | null;
  profile: 'proven floor' | 'steady' | 'spike' | 'volatile' | 'unproven';
}

export interface PackageRisk {
  players: PlayerRisk[];
  seasons: number; top24_seasons: number; top12_seasons: number;
  min_games: number | null; swing_pct: number | null; band_pct: number | null;
  points: number | null; p20: number | null; p80: number | null;
  headline_profile: PlayerRisk['profile'] | null;
  headline_read: string | null;
}

export interface SideRisk { out: PackageRisk; in: PackageRisk; read: string | null }

/** True when a player carries anything worth a line under his pill. */
export function hasEvidence(p: TradePlayer | null | undefined): boolean {
  return !!(p?.career?.seasons?.length || p?.career?.headline || p?.preseason?.points != null || p?.offseason);
}
