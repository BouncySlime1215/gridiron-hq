import { useState } from 'react';
import { useApi } from '../../api';
import { Button, Card, Chip, EmptyState, ErrorState, Skeleton, Stat } from '../ui/DesignSystem';

/**
 * My team -> ESPN vs our model (PROJ-DUEL). ESPN's weekly projection beside our shadow model's, the
 * biggest disagreements first with your starters and your plan's targets pinned on top, and after the
 * games a "closer" chip per row. Everything shown is the server's (services/proj-duel): no number is
 * computed here. Our model is in testing: none of your other numbers read it.
 */
interface DuelRow {
  player_id: string; name: string; position: string | null; espn: number | null; ours: number | null; gap: number | null;
  starter: boolean; target: boolean; actual: number | null; closer: 'ours' | 'espn' | 'tie' | null;
  why: string | null; happened: string | null;
}
interface Board { weeks: number; won: number; lost: number; tied: number; n: number; mae_ours: number | null; mae_espn: number | null; verdict_text: string }
interface Duel {
  status: 'ok' | 'empty'; reason?: string; label: string; week: number; final: boolean; weeks: number[]; current_week: number;
  rows: DuelRow[]; scoreboard: Board;
}
const FIRST = 25;
const sign = (x: number | null) => (x == null ? '' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`);
const pts = (x: number | null) => (x == null ? '—' : x.toFixed(1));

export default function ProjDuel({ leagueId }: { leagueId: number }) {
  const [week, setWeek] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const res = useApi<Duel>(`/proj-duel/${leagueId}${week != null ? `?week=${week}` : ''}`);
  const d = res.data;
  if (res.loading && !d) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-[120px] w-full !rounded-[var(--r-card)]" /><Skeleton className="h-[320px] w-full !rounded-[var(--r-card)]" /></div>;
  if (res.error && !d) return <ErrorState message={res.error} retry={() => res.refetch()} />;
  if (!d) return null;
  const b = d.scoreboard;
  const rows = all ? d.rows : d.rows.slice(0, FIRST);
  return (
    <div className="space-y-4" data-testid="proj-duel">
      <Card tone="accent"><p className="text-sm font-semibold" data-testid="proj-duel-label">{d.label}</p>
        <p className="ds-note">ESPN's projection is what your lineup and trade numbers use. Ours runs beside it every week so you can see who is closer.</p></Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Scoreboard</h3>
          <Chip tone="warn">{b.verdict_text}</Chip>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="proj-duel-board">
          <Stat label="Weeks won (ours)" value={b.weeks ? `${b.won} of ${b.weeks}` : 'None yet'} />
          <Stat label="Our average miss" value={b.mae_ours != null ? `${b.mae_ours} pts` : '—'} />
          <Stat label="ESPN's average miss" value={b.mae_espn != null ? `${b.mae_espn} pts` : '—'} />
          <Stat label="Player-weeks graded" value={b.n} />
        </div>
        <p className="ds-note mt-2">{b.weeks ? 'A week is won by the lower average miss across every graded player.' : 'No week has been graded yet: grades land the day after the last game.'}</p>
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Week {d.week}{d.final ? ', graded' : ''}</h3>
          {d.weeks.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Week">
              {d.weeks.slice(0, 6).map(w => <Chip key={w} on={w === d.week} onClick={() => setWeek(w)}>Wk {w}</Chip>)}
            </div>
          )}
        </div>
        {d.status !== 'ok'
          ? <EmptyState title="Nothing to compare yet" description={d.reason ?? 'No shadow forecast for this week.'} />
          : <>
            <p className="ds-note mb-2">Your starters and your plan's targets first, then the biggest disagreements.</p>
            <ul className="divide-y divide-[var(--c-line)]" data-testid="proj-duel-rows">
              {rows.map(r => (
                <li key={r.player_id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid="proj-duel-row">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" title={r.name}>{r.name}{r.position ? ` (${r.position})` : ''}</div>
                    <div className="flex flex-wrap gap-1">
                      {r.starter && <Chip tone="accent">Your starter</Chip>}
                      {r.target && <Chip tone="accent">Plan target</Chip>}
                      {r.closer === 'ours' && <Chip tone="good">Ours closer</Chip>}
                      {r.closer === 'espn' && <Chip tone="warn">ESPN closer</Chip>}
                      {r.closer === 'tie' && <Chip>Tie</Chip>}
                    </div>
                    {r.why && <p className="ds-note mt-1" data-testid="proj-duel-why">{r.why}</p>}
                    {r.happened && <p className="ds-note" data-testid="proj-duel-happened">What happened: {r.happened}</p>}
                  </div>
                  <div className="grid shrink-0 grid-cols-3 gap-3 text-right tabular-nums">
                    <div><div className="ds-note">ESPN</div><div className="text-sm font-semibold">{pts(r.espn)}</div></div>
                    <div><div className="ds-note">Ours</div><div className="text-sm font-semibold">{pts(r.ours)}</div></div>
                    <div><div className="ds-note">{r.actual != null ? 'Scored' : 'Gap'}</div>
                      <div className="text-sm font-semibold">{r.actual != null ? pts(r.actual) : sign(r.gap)}</div></div>
                  </div>
                </li>
              ))}
            </ul>
            {!all && d.rows.length > FIRST && (
              <div className="mt-3"><Button size="sm" onClick={() => setAll(true)}>Show all {d.rows.length}</Button></div>
            )}
          </>}
      </Card>
    </div>
  );
}
