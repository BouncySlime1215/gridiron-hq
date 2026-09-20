/**
 * Types for `outlook.js`, written by hand for the same reason as
 * `odds-gate.d.ts`: the logic is plain JS so `node:test` can call it, and
 * `tsconfig.json` has `strict: true` with no `allowJs`.
 */

export interface OutlookFit {
  id: string | number;
  k: number;
  weeks: number;
  thresholds: unknown;
  fitted_at: string | null;
  through_season: number | null;
  /** The printable as-of sentence. Nothing is computed at request time. */
  basis: string;
}

export interface Decomposition {
  /** The same model with the result features neutral. NOT a preseason forecast. */
  no_results_yet: number | null;
  now: number | null;
  total: number | null;
  luck: number | null;
  noise: number | null;
  /** A remainder, not a measured quantity. `real_is` says so. */
  real: number | null;
  real_is: string | null;
  /** The order the three parts must be shown in. */
  order: string[];
  weight_on_results: number | null;
  noise_share: number | null;
  k: number | null;
}

export type Verdict = 'fine' | 'watch' | 'act_candidate';

export interface OutlookTeam {
  roster_id: string | number;
  /** Four decimals, never 0 and never 1. */
  probability: number;
  verdict: Verdict;
  features: Record<string, number | null>;
  decomposition: Decomposition | null;
  games: number | null;
  wins_so_far: number | null;
  games_back: number | null;
}

export interface OutlookNotReady {
  ready: false;
  /** A finished sentence. Printed as it arrives. */
  reason: string;
}

export interface OutlookReady {
  ready: true;
  season: number;
  week: number;
  weeks_played: number;
  weeks_left: number;
  regular_periods: number;
  num_teams: number;
  playoff_teams: number;
  fit: OutlookFit;
  teams: OutlookTeam[];
}

export type Outlook = OutlookReady | OutlookNotReady;

export declare function verdictOf(verdict: string): { label: string; plain: string } | null;
export declare function probabilityText(p: number | null | undefined, precision?: number): string | null;
export declare function decompositionParts(d: Decomposition | null | undefined):
  { key: string; label: string; value: number | null; note: string | null }[];
export declare function showsDecomposition(outlook: OutlookReady | null | undefined): boolean;
