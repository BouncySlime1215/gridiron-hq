/**
 * The one answer to "can a league-scoped page render yet?" (UX-11).
 *
 * `leagues.length === 0` alone can't tell "still fetching" or "fetch failed"
 * apart from "genuinely no league connected" — the reason `error` exists on
 * the league context (see state/league.tsx). League Hub and My team both gate
 * on this so neither shows the "Connect a league" empty state while
 * `/leagues` is loading or after it failed.
 */
export type LeagueGate = 'loading' | 'error' | 'empty' | 'ready';

export function leagueGate({ loading, error, leagues }: { loading: boolean; error: string | null; leagues: readonly unknown[] }): LeagueGate {
  if (leagues.length) return 'ready';
  if (loading) return 'loading';
  if (error) return 'error';
  return 'empty';
}
