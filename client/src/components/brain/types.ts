/**
 * The three Trade Brain payloads, as the server actually serves them.
 *
 * Written from the server rather than from a wish: `managerProfiles()`
 * (server/services/league-brain.js:126) answers 200 with `{ error }` when the
 * league has never synced, and `proposalsFor()`
 * (server/services/trade-proposals.js:466) distinguishes "nothing to propose"
 * from "we could not ask" by `refused` rather than by an empty list. Both
 * distinctions are load-bearing on the page, so they are in the types.
 */

export type Tier = 'fair' | 'hard' | 'never';

/** The tier order the segmented control renders, best-case first. */
export const TIERS: readonly Tier[] = ['fair', 'hard', 'never'] as const;

export const TIER_SHORT: Record<Tier, string> = {
  fair: 'Will trade if fair',
  hard: 'Hard to deal with',
  never: 'Never trades'
};

export const TIER_STYLE: Record<Tier, string> = {
  fair: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  hard: 'bg-amber-50 text-amber-900 ring-amber-200',
  never: 'bg-rose-50 text-rose-800 ring-rose-200'
};

/* ------------------------------------------------- GET brain/managers (live) */

export interface ProfileManager {
  roster_id: string;
  owner: string | null;
  tradeability: Tier;
  notes: string | null;
  is_set: boolean;
  updated_at: string | null;
  /** TM-03 target board (server/services/target-board.js); null when it could not be built. */
  target_board?: TargetBoard | null;
}

/** One read on the target board: a value with its sample, its source, and whether it is thin. */
export interface BoardRead {
  value: number | null;
  n: number;
  thin: boolean;
  source: string | null;
  /** measured | thin | fact | not_measured | no_corpus | withheld_under_5 */
  state: string;
}

/** One talkReads verdict (server/services/talk-vs-model.js#readTalk), the trade finder's own read. */
export interface BoardPlayerRead {
  player: string;
  verdict: 'buy_low' | 'genuine_sour' | 'wants_him';
  confidence: string;
  why: string;
  sentiment: number;
  n: number;
  thin: boolean;
  source: string;
}

export interface TargetBoard {
  /** From analyzeLeague, the trade finder's needs read: lowest starter ratio (VOR vs league average). */
  roster_hole: {
    position: string | null; ratio: number | null; is_need: boolean; gap: number | null; needs: string[];
    n: number; thin: boolean; source: string; read_state: string; reason: string | null;
  };
  down_on: BoardPlayerRead[];
  rates_yours: BoardPlayerRead[];
  player_reads_state: 'present' | 'no_corpus';
  openness: BoardRead;
  untouchable: BoardRead;
  tilt: { last_week_margin: BoardRead; just_lost: boolean | null; streak: BoardRead; reacting_to_loss: BoardRead };
  active_hours: {
    night_share: BoardRead; busiest_hour_utc: number | null; actions_n: number; min_actions: number;
    thin: boolean; source: string; read_state: string; reason: string | null;
  };
  accept_rate: BoardRead;
  lineup_signals: {
    read_state: string; source: string | null; reason?: string | null;
    signals: { player: string; signal: string; week: number | null; n: number; thin: boolean; source: string }[];
  };
}

export interface ProfilesResponse {
  league?: string | null;
  my_roster_id?: string;
  tiers?: { id: Tier; label: string; responsiveness: number; plan: string }[];
  managers?: ProfileManager[];
  target_board_meta?: { thin_below?: number; neutral_sentiment?: number; lineup_signals?: string;
    rules?: string; error?: string };
  note?: string;
  /** 200-with-error: the league row has no synced payload yet. */
  error?: string;
}

/* ------------------------------------------- GET managers/signals (measured) */

/**
 * One measured number about one manager.
 *
 * `priceable` is the server saying whether the engine is willing to PRICE this,
 * which is a different question from whether a number came back. A value with
 * `priceable: false`, or one standing on a handful of observations, is rendered
 * as "not enough data yet" and never as a measured neutral — an implied zero is
 * the failure this whole surface exists to avoid.
 */
export interface ManagerSignal {
  metric: string;
  value: number | string | boolean | null;
  n: number | null;
  source: string | null;
  priceable: boolean;
  why: string | null;
}

export interface SignalManager {
  roster_id: string | number;
  owner: string | null;
  /** Whether this manager has any league-chat corpus behind them at all. */
  corpus: boolean;
  tradeability_set: Tier | null;
  archetype: Record<string, unknown> | null;
  receptiveness: Record<string, unknown> | null;
  negotiation: Record<string, unknown> | null;
  signals: ManagerSignal[];
}

export interface SignalsResponse {
  league?: { id: number; name: string | null; season: number | null; week: number | null };
  available: boolean;
  reason: string | null;
  computed_at: string | null;
  sources?: Record<string, unknown> | null;
  identity_warnings?: unknown[];
  managers?: SignalManager[];
  error?: string;
}

/* ------------------------------------------------------- GET proposals (AI) */

export interface Proposal {
  idea_ids: (string | number)[];
  package: { i_give?: string[]; i_get?: string[] } | null;
  why_they_say_yes: string;
  opener: string;
  ask: string | number | null;
  fair: string | number | null;
  floor: string | number | null;
  timing: { send?: string; reason?: string } | string | null;
  risk: string;
  data_used: unknown;
}

export interface RejectedProposal {
  proposal: Partial<Proposal> | string | null;
  violations: string[];
}

export interface ProposalsResponse {
  proposals: Proposal[];
  rejected: RejectedProposal[];
  reason: string | null;
  /** 'none' = never asked the model; 'cache' = free; 'model' = money was spent. */
  source: 'none' | 'cache' | 'model';
  /** True means "we could not ask", which is not the same as "nothing to ask about". */
  refused?: boolean;
}

/**
 * Below this many observations a measured number is reported as thin rather
 * than as a fact. Stated in the copy the user reads, not only here, so nobody
 * has to guess what "not enough data yet" was measured against.
 */
export const MIN_OBSERVATIONS = 5;

/** A signal we are willing to show as a number, versus one we are not. */
export function isThin(signal: ManagerSignal) {
  if (signal.priceable === false) return true;
  if (signal.value == null) return true;
  return signal.n != null && signal.n < MIN_OBSERVATIONS;
}

/** Render any scalar the model or engine hands us without inventing precision. */
export function asText(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(+value.toFixed(3));
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).join(' · ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k.replace(/_/g, ' ')} ${asText(v)}`).join(' · ');
  }
  return String(value);
}

/** `chat_replies_per_week` -> `Chat replies per week`. */
export function metricLabel(metric: string) {
  const spaced = String(metric).replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Signal';
}
