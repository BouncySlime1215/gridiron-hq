/**
 * The `/api/betting/wong` contract, as the client consumes it.
 *
 * Every optional field here is optional on purpose: this surface was built
 * against a written contract while the routes themselves were still being
 * written, so anything whose exact shape was not pinned down (record, pace,
 * the dollar block of the projection, the stored ticket row) is typed loosely
 * and rendered defensively rather than assumed. A missing number renders as
 * an em dash; it never blanks a panel.
 */

export interface WongLeg {
  event_id: string;
  team: string;
  line: number;
  teased_to: number;
  commence_time: string;
  spread_price: number | null;
  captured_at: string | null;
  age_minutes: number | null;
  provenance: string;
}

export interface WongProbabilities {
  win: number;
  reduced: number;
  both_push: number;
  loss: number;
}

export interface WongCandidate {
  legs: WongLeg[];
  american_price: number;
  probabilities: WongProbabilities;
  ev: number;
  ev_percent: number;
}

export interface WongBookBoard {
  book: string;
  provenance: string;
  source: string;
  captured_at: string | null;
  age_minutes: number | null;
  games_on_board: number;
  qualifying_legs: number;
  stale_legs: number;
  price: number | null;
  candidates: WongCandidate[];
  blocked_reasons: string[];
}

export interface WongComparisonQuote {
  book: string;
  line: number | null;
  side: string | null;
  price: number | null;
  qualifies: boolean;
  measured_rate: number | null;
  provenance: string;
  age_minutes: number | null;
}

export interface WongComparisonRow {
  event_id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  by_book: WongComparisonQuote[];
  /** Whichever book currently offers the best qualifying number, if any does. */
  best?: WongComparisonQuote | null;
}

export interface WongBoard {
  generated_at: string;
  books: WongBookBoard[];
  comparison: WongComparisonRow[];
}

export interface WongCapture {
  source: string;
  ok: boolean;
  rows: number;
  error?: string | null;
}

export interface WongRefresh {
  refreshed_at: string;
  duration_ms: number;
  captures: WongCapture[];
  board: WongBoard;
}

export interface WongSettings {
  unit_size_dollars: number;
  bankroll_units: number;
  books: string[];
  max_tickets_per_week: number;
  /**
   * How the book pays a ticket where one leg pushes: some void the leg and
   * reduce to a single, some refund the stake. Stored as whatever the backend
   * calls it, rendered as a label.
   */
  reduced_payout: string | number | boolean | null;
}

export interface WongTicketLeg {
  event_id?: string;
  team: string;
  opponent?: string | null;
  line?: number | null;
  teased_to?: number | null;
  commence_time?: string | null;
  spread_price?: number | null;
  provenance?: string | null;
  result?: string | null;
  team_score?: number | null;
  opponent_score?: number | null;
}

export interface WongTicket {
  id: number | string;
  book: string;
  american_price: number;
  stake_units: number;
  mode: string;
  status?: string | null;
  result?: string | null;
  season?: number | null;
  week?: number | null;
  created_at?: string | null;
  placed_at?: string | null;
  settled_at?: string | null;
  units_won?: number | null;
  profit_units?: number | null;
  legs: WongTicketLeg[];
}

export interface WongProjectionBlock {
  mean?: number | null;
  median?: number | null;
  p05?: number | null;
  p95?: number | null;
  probability_of_losing_season?: number | null;
}

/** `dollars` may mirror the two blocks, or be a single already-chosen block. */
export interface WongProjectionDollars extends WongProjectionBlock {
  point_estimate?: WongProjectionBlock;
  with_rate_uncertainty?: WongProjectionBlock;
}

export interface WongProjection {
  point_estimate?: WongProjectionBlock | null;
  with_rate_uncertainty?: WongProjectionBlock | null;
  dollars?: WongProjectionDollars | null;
}

export interface WongRecord {
  wins?: number | null;
  losses?: number | null;
  pushes?: number | null;
  open?: number | null;
  reduced?: number | null;
}

export interface WongSeason {
  season?: number;
  tickets: WongTicket[];
  record?: WongRecord | string | null;
  units_staked?: number | null;
  units_won?: number | null;
  roi?: number | null;
  pace?: Record<string, unknown> | null;
  projection?: WongProjection | null;
}

/**
 * `/combos` is documented only as "the recommended non-overlapping ticket
 * set", so the client accepts the three shapes that phrase can reasonably
 * take and normalizes them at the edge.
 */
export interface WongCombos {
  book?: string;
  tickets?: WongCandidate[];
  combos?: WongCandidate[];
  candidates?: WongCandidate[];
  note?: string;
  blocked_reasons?: string[];
  expected_profit_units?: number | null;
  probability_of_losing_week?: number | null;
}
