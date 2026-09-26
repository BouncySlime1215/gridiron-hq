/** The typed news statuses (nfl-news-signal.js), in plain words. One map for Players → News and Today. */
export const SIGNAL_LABEL: Record<string, string> = {
  out_for_season: 'Out for season', out: 'Out', doubtful: 'Doubtful', questionable: 'Questionable',
  did_not_practice: 'Did not practice', limited: 'Limited practice', available_positive: 'Cleared',
  starter_confirmed: 'Starter confirmed', role_down: 'Role decreasing', role_up: 'Role increasing',
  role_limited: 'Role limited'
};
/** Chip tone per status: bad news red, a caution amber, good news green. */
export const SIGNAL_CHIP: Record<string, 'bad' | 'warn' | 'good'> = {
  out_for_season: 'bad', out: 'bad', doubtful: 'bad', role_down: 'bad',
  questionable: 'warn', did_not_practice: 'warn', limited: 'warn', role_limited: 'warn',
  available_positive: 'good', starter_confirmed: 'good', role_up: 'good'
};

export interface NewsSignal { player_name: string; team?: string | null; status: string; published_at?: string | null; evidence_span?: string | null; source?: string | null; story_headline?: string | null; story_url?: string | null }

/** Today's "your players' headlines": the freshest `n`, one per player (the route already keeps one per player + kind). */
export function freshestHeadlines<T extends NewsSignal>(signals: T[] | undefined | null, n = 3): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of [...(signals ?? [])].sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')))) {
    if (seen.has(s.player_name)) continue;
    seen.add(s.player_name); out.push(s);
    if (out.length === n) break;
  }
  return out;
}
