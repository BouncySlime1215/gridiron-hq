/**
 * Shapes the draft-assist payload is growing (built in parallel, so every field is
 * optional at the call sites — a missing `career` must render nothing, not crash).
 */
export interface CareerSeason {
  season: number;
  games?: number | null;
  ppr_points?: number | null;
  ppg?: number | null;
  pos_rank?: number | null;
  carries?: number | null;
  rush_yds?: number | null;
  rush_td?: number | null;
  targets?: number | null;
  rec?: number | null;
  rec_yds?: number | null;
  rec_td?: number | null;
  pass_yds?: number | null;
  pass_td?: number | null;
  int?: number | null;
  pass_int?: number | null;
}

export interface Career {
  seasons?: CareerSeason[];            // newest first
  consistency?: {
    seasons_top12?: number | null;
    seasons_top24?: number | null;
    cv_points?: number | null;
    min_games?: number | null;
  } | null;
  streaks?: { stat: string; threshold: number; seasons: number; values?: number[] }[] | null;
  headline?: string | null;
}

export interface Preseason {
  points?: number | null;
  p20?: number | null;
  p80?: number | null;
  expected_games?: number | null;
  drivers?: string[] | null;
}

/** The one-line, stat-rooted reason to lead with: the server's headline, else the first driver. */
export function statHeadline(career?: Career | null, preseason?: Preseason | null): string | null {
  return career?.headline || preseason?.drivers?.[0] || null;
}

/** Newest-first season PPR totals, oldest first for a left-to-right sparkbar. */
export function pprSeries(career?: Career | null, n = 3): number[] {
  return (career?.seasons ?? [])
    .slice(0, n)
    .map(s => s.ppr_points ?? 0)
    .reverse();
}
