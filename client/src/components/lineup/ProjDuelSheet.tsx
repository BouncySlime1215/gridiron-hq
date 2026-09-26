import { api, useApi } from '../../api';
import { useCoach } from '../../state/coach';
import { Avatar, Button, Chip, EmptyState, ErrorState, Sheet, Skeleton, Stat } from '../ui/DesignSystem';

/**
 * PROJ-DUEL breakdown sheet: one player-week, from the server's one producer (services/proj-duel
 * #playerBreakdown). A side panel on desktop, a bottom sheet on a phone (the Sheet primitive).
 * Shows ESPN vs ours vs the actual, every model driver as a bar, expected vs actual usage, team
 * implied vs scored, and the last weeks of both projections vs actuals.
 */
export interface Breakdown {
  player_id: string; name: string; position: string | null; team: string | null; week: number; label: string;
  espn: number | null; ours: number | null; actual: number | null; closer: 'ours' | 'espn' | 'tie' | null;
  why: string | null; happened: string | null;
  drivers: { label: string; value: string | null; contribution: number }[]; drivers_note: string | null;
  usage: { label: string; expected: number | null; actual: number | null; unit: string }[];
  team_implied: number | null; team_scored: number | null;
  history: { week: number; espn: number | null; ours: number | null; actual: number | null }[];
}
const pts = (x: number | null) => (x == null ? '—' : x.toFixed(1));
const MAX_DRIVERS = 12;

function Bars({ drivers }: { drivers: Breakdown['drivers'] }) {
  const shown = drivers.slice(0, MAX_DRIVERS);
  const max = Math.max(...shown.map(d => Math.abs(d.contribution)), 0.01);
  return (
    <ul className="space-y-1.5" data-testid="duel-bars">
      {shown.map((d, i) => (
        <li key={`${d.label}:${i}`} className="grid grid-cols-[minmax(0,1fr)_96px_44px] items-center gap-2 text-xs">
          <span className="min-w-0 truncate" title={d.value ?? d.label}>{d.value ?? d.label}</span>
          <span className="relative h-2 rounded-full" style={{ background: 'var(--c-soft)' }} aria-hidden>
            <span className="absolute top-0 h-2 rounded-full" style={{ width: `${(Math.abs(d.contribution) / max) * 50}%`,
              left: d.contribution >= 0 ? '50%' : `${50 - (Math.abs(d.contribution) / max) * 50}%`,
              background: d.contribution >= 0 ? 'var(--c-green)' : 'var(--c-red)' }} />
          </span>
          <span className="text-right tabular-nums">{d.contribution > 0 ? '+' : ''}{d.contribution.toFixed(1)}</span>
        </li>
      ))}
    </ul>
  );
}

function History({ history }: { history: Breakdown['history'] }) {
  const W = 280, H = 96, P = 16;
  const vals = history.flatMap(h => [h.espn, h.ours, h.actual]).filter((v): v is number => v != null);
  if (history.length < 2 || !vals.length) return <p className="ds-note">Not enough weeks yet for a trend.</p>;
  const hi = Math.max(...vals, 1), x = (i: number) => P + (i * (W - 2 * P)) / (history.length - 1), y = (v: number) => H - P - (v / hi) * (H - 2 * P);
  const series: { key: 'espn' | 'ours' | 'actual'; color: string; name: string }[] = [
    { key: 'espn', color: 'var(--c-muted)', name: 'ESPN' }, { key: 'ours', color: 'var(--c-accent)', name: 'Ours' }, { key: 'actual', color: 'var(--c-ink)', name: 'Scored' }];
  return (
    <div data-testid="duel-history">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-sm" role="img" aria-label="Both projections and the actual score, week by week">
        {series.map(s => {
          const pts2 = history.map((h, i) => (h[s.key] == null ? null : `${x(i)},${y(h[s.key] as number)}`)).filter(Boolean);
          return <g key={s.key}>{pts2.length > 1 && <polyline points={pts2.join(' ')} fill="none" stroke={s.color} strokeWidth="2" />}
            {history.map((h, i) => (h[s.key] == null ? null : <circle key={i} cx={x(i)} cy={y(h[s.key] as number)} r="3" fill={s.color} />))}</g>;
        })}
        {history.map((h, i) => <text key={h.week} x={x(i)} y={H - 2} fontSize="9" textAnchor="middle" fill="var(--c-muted)">Wk {h.week}</text>)}
      </svg>
      <div className="flex flex-wrap gap-3 text-xs">{series.map(s => <span key={s.key} className="inline-flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}

export default function ProjDuelSheet({ leagueId, week, playerId, headshot, onClose }: {
  leagueId: number; week: number; playerId: string | null; headshot?: string | null; onClose: () => void;
}) {
  const coach = useCoach();
  const res = useApi<Breakdown>(playerId ? `/proj-duel/${leagueId}/player/${playerId}?week=${week}` : null);
  const b = res.data;
  const ask = async () => {
    if (!b) return;
    try {
      await api(`/coach/thread/${leagueId}/focus`, { method: 'POST', body: JSON.stringify({ move_id: null, partner: null, players: [b.player_id] }) });
    } catch (e) {
      // The focus is a convenience: Coach still gets the question with the player named in it.
      console.warn(`[proj-duel] Coach focus not set: ${e instanceof Error ? e.message : String(e)}`);
    }
    coach.open(`Why does our model have ${b.name} at ${pts(b.ours)} when ESPN says ${pts(b.espn)}?`);
  };
  return (
    <Sheet open={playerId != null} title="ESPN vs our model" onClose={onClose}>
      <div data-testid="duel-sheet" className="space-y-5">
        {res.loading && !b && <Skeleton className="h-[320px] w-full" />}
        {res.error && !b && <ErrorState message={res.error} retry={() => res.refetch()} />}
        {b && <>
          <div className="flex items-center gap-3">
            <Avatar name={b.name} src={headshot ?? null} size={48} />
            <div className="min-w-0"><div className="truncate font-semibold">{b.name}</div>
              <div className="ds-note">{[b.position, b.team, `week ${b.week}`].filter(Boolean).join(' · ')}</div></div>
          </div>
          <p className="ds-note">{b.label}</p>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="ESPN" value={pts(b.espn)} /><Stat label="Ours" value={pts(b.ours)} />
            <Stat label="Scored" value={pts(b.actual)} foot={b.actual == null ? 'after the game' : undefined} />
          </div>
          {b.closer && <Chip tone={b.closer === 'ours' ? 'good' : b.closer === 'espn' ? 'warn' : 'neutral'}>
            {b.closer === 'ours' ? 'Ours was closer' : b.closer === 'espn' ? 'ESPN was closer' : 'Tie'}</Chip>}
          {b.why && <p className="text-sm">{b.why}</p>}
          {b.happened && <p className="text-sm">What happened: {b.happened}</p>}

          <section><h3 className="mb-2 text-sm font-semibold">What moved our number</h3>
            {b.drivers.length ? <Bars drivers={b.drivers} /> : <p className="ds-note">{b.drivers_note}</p>}
            {b.drivers.length > MAX_DRIVERS && <p className="ds-note mt-1">The {MAX_DRIVERS} biggest of {b.drivers.length}; green pushed ours up, red pulled it down.</p>}</section>

          {!!b.usage.length && <section><h3 className="mb-2 text-sm font-semibold">Usage: expected vs actual</h3>
            <ul className="space-y-1 text-sm" data-testid="duel-usage">
              {b.usage.map(u => <li key={u.label} className="flex justify-between gap-3"><span>{u.label}</span>
                <span className="tabular-nums">{u.expected == null ? '—' : `${u.expected}${u.unit}`} expected · {u.actual == null ? 'after the game' : `${u.actual}${u.unit}`}</span></li>)}
            </ul></section>}

          {(b.team_implied != null || b.team_scored != null) && <section className="flex justify-between gap-3 text-sm">
            <span>Team implied total</span><span className="tabular-nums">{pts(b.team_implied)}{b.team_scored != null ? ` · scored ${pts(b.team_scored)}` : ''}</span></section>}

          <section><h3 className="mb-2 text-sm font-semibold">Recent weeks</h3><History history={b.history} /></section>
          <Button icon="coach" onClick={() => { void ask(); }}>Ask Coach about this</Button>
        </>}
        {!res.loading && !res.error && !b && playerId && <EmptyState title="No breakdown for this player" />}
      </div>
    </Sheet>
  );
}
