/**
 * Types for `odds-gate.js`, written by hand.
 *
 * The logic is plain JavaScript because `node:test` in this repository has no
 * build step and cannot import a `.tsx` module, and these three states are
 * decisions worth testing by calling rather than by reading source text.
 * `tsconfig.json` has `strict: true` and no `allowJs`, so the JS needs a
 * declaration or every import of it lands as `any` under `noImplicitAny`.
 *
 * Turning on `allowJs` instead would change how the whole client compiles for
 * the sake of one module. This file is the smaller change, and it also gives
 * the gate's shape one home: `OddsGate.tsx` re-exports these rather than
 * keeping a second copy that can drift from the server's payload.
 */

export interface WeekGrade {
  /** Lower is better; 0.25 is what saying 50% to everything scores. */
  brier?: number;
  /** What the same corpus scores by telling every team its league's rate. */
  base_rate?: number;
}

export interface Calibration {
  graded_team_weeks?: number;
  corpus?: string;
  source?: string;
  /** Keyed by week number as a string, e.g. `by_week['2']`. */
  by_week?: Record<string, WeekGrade>;
  extremes?: {
    no_chance_qualify_rate?: number;
    certain_miss_rate?: number;
  };
  /** What the grading did NOT cover — this app's own configuration. */
  not_graded?: string;
}

export interface OddsGate {
  published: boolean;
  min_week: number;
  /** Results the odds stand on. `from_week` minus 1, so from_week 1 is zero. */
  weeks_played: number;
  reason: string | null;
  calibration?: Calibration | null;
}

export type GateState = 'no_results' | 'too_early' | 'published';

export declare const BRIER_IN_WORDS: string;

export declare function gateState(gate: OddsGate | null | undefined): GateState;

export declare function gradedSentence(gate: OddsGate | null | undefined): string;

export declare function withheldReason(state: GateState, minWeek: number): string;
