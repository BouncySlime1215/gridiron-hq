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
  // 'unknown' is not a weak 'unproven': it means the career layer could not be
  // read at all, so nothing about this player's record can be claimed either way
  // (trade-engine.js playerRiskProfile, via playerEvidence's evidence_unreadable).
  profile: 'proven floor' | 'steady' | 'spike' | 'volatile' | 'unproven' | 'unknown';
}

export interface PackageRisk {
  players: PlayerRisk[];
  seasons: number; top24_seasons: number; top12_seasons: number;
  min_games: number | null; swing_pct: number | null; band_pct: number | null;
  points: number | null; p20: number | null; p80: number | null;
  headline_profile: PlayerRisk['profile'] | null;
  headline_read: string | null;
  /** How many of `players` had an unreadable career layer. The sums above are
   *  taken over the rest, so a non-zero count means they cover only part of
   *  the package — see RiskStrip's Floor cell. */
  unreadable: number;
}

export interface SideRisk { out: PackageRisk; in: PackageRisk; read: string | null }

/** True when a player carries anything worth a line under his pill. */
export function hasEvidence(p: TradePlayer | null | undefined): boolean {
  return !!(p?.career?.seasons?.length || p?.career?.headline || p?.preseason?.points != null || p?.offseason);
}

/* ------------------------------------------------------------ manager read */

/**
 * The counterparty read on one deal (server/services/counterparty-pricing.js,
 * `readDeal()` + `serializeManagerRead()`, merged onto every idea at
 * trade-engine.js's `counterparty:` block).
 *
 * Every field is optional, and `counterparty_data` is the one that says whether
 * there is a read at all: four of the five leagues have no chat corpus, and for
 * those the engine ships a declared no-information block rather than nothing, so
 * a page can say WHY it is quiet instead of looking broken.
 */

/** One named, capped contribution to receptiveness, with the sample behind it. */
export interface ReceptivenessFactor {
  source: string;
  label: string;
  /** null when the source was read but never reduced to a number. Never render as measured. */
  effect?: number | null;
  /** The sample. 0 means "no observations" — not "an effect of zero". */
  n?: number | null;
  cap?: number | null;
  /** true only for terms whose size comes from a fit (the activity terms, RL-11-1). */
  fitted?: boolean;
  /** A default-off term's size had it been applied (RL-11-1); `effect` is null then. */
  would_effect?: number | null;
  why?: string | null;
}

/** How this manager has talked about one player in this deal. */
export interface ManagerPlayerRead {
  player: string | null;
  owns?: boolean | null;
  mentions?: number | null;
  sentiment?: number | null;
  verdict?: string | null;
  confidence?: string | null;
  why?: string | null;
  action?: string | null;
  /** He called the player untouchable: 'held' if his word has held, 'not_held' if it has not. */
  declared?: 'held' | 'not_held' | null;
}

/** The model's whole-corpus read, cut to what a card shows. */
export interface NegotiationRead {
  headline?: string | null;
  how_to_approach?: string | null;
  best_bait?: string | null;
  confidence?: string | null;
  no_holds?: string | null;
  praise_means?: string | null;
  inflation?: string | null;
  what_moves_him?: string[];
  what_shuts_him_down?: string[];
}

export interface Counterparty {
  counterparty_data?: boolean;
  receptiveness?: number | null;
  tier?: string | null;
  chat_msgs?: number | null;
  chat_weight?: number | null;
  open_to_trade_pct?: number | null;
  trade_talk_pct?: number | null;
  accept_rate?: number | null;
  accept_rate_n?: number | null;
  perception_informed?: boolean;
  perception_delta?: number | null;
  priors?: Record<string, number> | null;
  untouchable_rate?: number | null;
  needs?: string[] | null;
  surplus?: string[] | null;
  window?: { label?: string | null; stance?: string | null } | null;
  luck?: { value: number; n: number } | null;
  negotiation?: NegotiationRead | null;
  negotiation_n?: number | null;
  receptiveness_factors?: ReceptivenessFactor[];
  asking_for_declared?: string[];
  word_stance?: string | null;
  word_note?: string | null;
  word_stance_note?: string | null;
  word_credibility?: number | null;
  player_reads?: ManagerPlayerRead[];
}

/** P(accept) as a band, never a point (server/services/trade-acceptance.js). */
export interface Acceptance {
  band: { low: number; mid: number; high: number } | null;
  basis?: string | null;
  why?: string | null;
  /** true only for terms whose size comes from a fit (the activity terms, RL-11-1). */
  fitted?: boolean;
  anchor?: { accept_rate: number | null; n: number; usable: boolean; why?: string | null } | null;
  factors?: { source: string; label: string; effect: number; why?: string | null }[];
  inert?: { source: string; reason: string }[];
}

/** One suggested approach (server/services/trade-tactics.js). */
export interface Tactic {
  key: string;
  label: string;
  effect?: number | null;
  effect_net?: number | null;
  n?: number | null;
  why?: string | null;
  numbers?: Record<string, number | null> | null;
  players?: { player?: string; centrepiece?: boolean }[];
}

/** A tactic that did NOT fire, with the reason — reported, never hidden. */
export interface TacticAbsent { key: string; reason: string }

/** The slice of a scored deal the manager panel reads. */
export interface ManagerReadDeal {
  counterparty?: Counterparty | null;
  acceptance?: Acceptance | null;
  tactics?: Tactic[] | null;
  tactics_absent?: TacticAbsent[] | null;
  /** The hand-set tradeability tier. Reported as an override signal, not derived. */
  manager_tradeability?: string | null;
}

/** True when the engine actually had a counterparty read for this manager. */
export function hasManagerData(cp: Counterparty | null | undefined): boolean {
  return cp?.counterparty_data === true;
}

/** True when the panel has anything at all to say — a read, a band, or a tactic. */
export function hasManagerRead(deal: ManagerReadDeal | null | undefined): boolean {
  return !!(deal?.counterparty || deal?.acceptance || deal?.tactics?.length
    || deal?.tactics_absent?.length || deal?.manager_tradeability);
}
