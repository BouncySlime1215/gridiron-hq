import { useApi } from '../api';
import { useLeague } from '../state/league';
import { PageError } from './PageState';
import { Card, Chip, EmptyState, Skeleton } from './ui/DesignSystem';

/**
 * League → Standings: every team's record and points, in the platform's own seed order, read
 * from the synced league payload (GET /leagues/:id/data, the request My Team already makes).
 * Only ESPN's payload carries records; a Sleeper league says so instead of showing zeros.
 * Your team is marked; My Team → Overview has your own week-by-week results.
 */
type Row = { id: number; name: string; seed: number | null; w: number; l: number; t: number; pf: number; pa: number; streak: string | null; me: boolean };

export default function Standings() {
  const { active } = useLeague();
  const { data, loading, error, refetch } = useApi<any>(active ? `/leagues/${active.id}/data` : null);
  if (!active) return null;
  if (loading && !data) return <Card><div className="space-y-3">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-5 w-full" />)}</div></Card>;
  if (error && !data) return <PageError message={error} onRetry={refetch} />;
  if (active.platform !== 'espn') {
    return <Card><EmptyState icon="trophy" title="Standings are ESPN-only for now" description="Sleeper's synced data carries rosters but not records. Roster strength works for every league." /></Card>;
  }
  const teams: any[] = data?.payload?.teams ?? [];
  const rows: Row[] = teams.map(t => {
    const o = t.record?.overall ?? {};
    return {
      id: t.id, name: (t.name ?? `${t.location ?? ''} ${t.nickname ?? ''}`).trim() || `Team ${t.id}`,
      seed: t.playoffSeed ?? null, w: o.wins ?? 0, l: o.losses ?? 0, t: o.ties ?? 0,
      pf: o.pointsFor ?? t.points ?? 0, pa: o.pointsAgainst ?? 0,
      streak: o.streakLength ? `${o.streakType === 'WIN' ? 'W' : o.streakType === 'LOSS' ? 'L' : 'T'}${o.streakLength}` : null,
      me: String(t.id) === String(active.my_team_id)
    };
  }).sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99) || b.w - a.w || b.pf - a.pf);
  const played = rows.some(r => r.w + r.l + r.t > 0);
  if (!rows.length) return <Card><EmptyState icon="trophy" title="No standings yet" description="Sync the league to pull its teams." /></Card>;
  const fmt = (v: number) => v.toFixed(1);

  return (
    <Card pad={false} className="overflow-hidden" >
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-4 sm:px-5">
        <h2 className="ds-h">Standings</h2>
        <span className="ds-note">{played ? 'ESPN seed order' : 'No games played yet'}</span>
      </div>
      <table className="ds-table" data-testid="standings">
        <thead><tr>
          <th className="w-10 text-right">#</th><th>Team</th><th className="text-right">W-L</th>
          <th className="text-right">PF</th><th className="hidden text-right sm:table-cell">PA</th><th className="hidden text-right sm:table-cell">Streak</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} aria-current={r.me ? 'true' : undefined} className={r.me ? 'bg-[var(--c-accent-tint)]' : undefined}>
              <td className="text-right text-[var(--c-muted)]">{r.seed ?? i + 1}</td>
              <td className="max-w-0 w-full">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`truncate ${r.me ? 'font-semibold text-[var(--c-accent)]' : ''}`}>{r.name}</span>
                  {r.me && <Chip tone="accent">You</Chip>}
                </span>
              </td>
              <td className="whitespace-nowrap text-right font-semibold">{r.w}-{r.l}{r.t ? `-${r.t}` : ''}</td>
              <td className="text-right">{fmt(r.pf)}</td>
              <td className="hidden text-right sm:table-cell">{fmt(r.pa)}</td>
              <td className="hidden text-right sm:table-cell">{r.streak ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
