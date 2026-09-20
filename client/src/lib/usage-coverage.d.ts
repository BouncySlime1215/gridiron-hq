export interface UsageCoverage {
  /** One of 'healthy' | 'never_run' | 'stale' | 'ok_no_rows'; anything else reads as unrecognised. */
  state: string;
  /** The season being played, as the server understands it. */
  season?: number | null;
  /** Rows held for that season. */
  rows?: number | null;
  /** The last week that has rows. */
  latest_week?: number | null;
  /** The week the league is on. */
  league_week?: number | null;
  /** Seasons that do have rows, for the sentence that says where the numbers are coming from. */
  seasons_with_rows?: number[] | null;
  /** What the source registry last recorded. */
  source_status?: string | null;
  last_run_at?: string | null;
}

export type CoverageState = 'healthy' | 'never_run' | 'stale' | 'ok_no_rows' | 'unrecognised';

export function coverageState(coverage: UsageCoverage | null | undefined): CoverageState | null;
export function canRetry(state: CoverageState | null): boolean;
export function coverageHeadline(state: CoverageState | null, coverage: UsageCoverage | null | undefined): string | null;
export function coverageDetail(state: CoverageState | null, coverage: UsageCoverage | null | undefined): string | null;
