import { useMemo, useState } from 'react';
import { api, headshotUrl, useApi } from '../api';
import PlayerRow, { Trend } from '../components/PlayerRow';
import { EmptyState, PageError, PageLoading } from '../components/PageState';
import { Button, Card, Chip } from '../components/ui/DesignSystem';

/**
 * Players → Board: the blended consensus (FantasyCalc value and 30-day trend, ADP) with value over
 * replacement from /edge/vor, the same board the draft room reads. On a phone the row keeps the
 * name and the value; trend, ADP and VOR show from `sm` up.
 */
export default function Projections() {
  const { data: agg, refetch, loading, error } = useApi<any[]>('/aggregates');
  const { data: vorBoard } = useApi<any[]>('/edge/vor');
  const vorById = useMemo(() => new Map((vorBoard ?? []).map(v => [v.id, v.vor])), [vorBoard]);
  const [filter, setFilter] = useState('ALL');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // A phone starts at 25 rows (about 1,200 px) instead of 100 (4,800 px); "Show more" adds the rest in steps.
  const step = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches ? 25 : 100;
  const [limit, setLimit] = useState(step);

  const sync = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/aggregates/sync', { method: 'POST' });
      const part = (label: string, v: any) => v?.matched != null ? `${label} ${v.matched}` : v?.error ? `${label} failed` : null;
      setMsg([part('FFC', r.ffc), part('Sleeper', r.sleeper), part('FantasyCalc', r.fantasycalc)].filter(Boolean).join(' · '));
      refetch();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const createBoard = async () => {
    const name = prompt('Name for the new consensus board?', `Consensus ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    const r = await api('/aggregates/create-board', { method: 'POST', body: JSON.stringify({ name }) });
    setMsg(`Created “${name}” with ${r.count} players — available in Rankings and the Draft Room.`);
  };

  const all = (agg ?? []).filter(p => filter === 'ALL' || p.position === filter);
  const visible = all.slice(0, limit);

  return (
    <div className="max-w-4xl">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Position">
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
            <Chip key={p} on={filter === p} onClick={() => setFilter(p)}>{p === 'ALL' ? 'All' : p}</Chip>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" icon="refresh" onClick={sync} disabled={busy} title={busy ? 'Pulling ADP, ranks and values' : 'Pull the latest ADP, Sleeper ranks and FantasyCalc values'}>{busy ? 'Pulling…' : 'Pull latest'}</Button>
          <Button size="sm" variant="primary" onClick={createBoard} disabled={!agg?.length}
            title={!agg?.length ? 'Pull the market data first' : 'Save this board as a ranking set for Rankings and the draft room'}>Create board</Button>
        </div>
      </div>
      <p className="ds-note mb-3">
        Blended consensus: FantasyFootballCalculator ADP (real drafts), Sleeper ranks and FantasyCalc trade values. VOR is projected points over a replacement starter. A name opens the player card.
      </p>
      {msg && <p role="status" className="ds-note mb-3">{msg}</p>}

      {loading && !agg ? <PageLoading label="Loading projections & market data…" /> : error && !agg ? (
        <PageError message={error} onRetry={refetch} />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No market data yet"
          description="Pull ADP, Sleeper ranks and trade values to build the blended consensus board (all free, no keys)."
          actionLabel={busy ? 'Pulling…' : 'Pull latest'}
          onAction={sync}
        />
      ) : (
        <>
          <Card pad={false} className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-200 px-2.5 py-2 text-[11px] font-semibold text-slate-500">
              <span className="w-6 text-right">#</span>
              <span className="w-[28px]" />
              <span className="hidden w-8 sm:block" />
              <span className="flex-1">Player</span>
              <span className="w-9">Team</span>
              <span className="w-12 text-right">Value</span>
              <span className="hidden w-14 text-right sm:block">30d</span>
              <span className="hidden w-12 text-right sm:block">ADP</span>
              <span className="hidden w-12 text-right sm:block" title="Projected points over a replacement starter">VOR</span>
            </div>
            {visible.map((p, i) => (
              <PlayerRow
                key={p.id}
                playerId={p.id}
                rank={i + 1}
                name={p.name}
                position={p.position}
                teamAbbr={p.team_abbr}
                headshot={headshotUrl(p)}
                dense
                phonePos
                meta={p.injury_flag ? <span className="font-semibold text-crit">Injury</span> : undefined}
                right={
                  <>
                    <span className="w-12 shrink-0 text-right text-xs font-semibold text-slate-700 tabular-nums">
                      {p.fc_value != null ? Math.round(p.fc_value) : '—'}
                    </span>
                    <span className="hidden w-14 shrink-0 text-right text-xs sm:block"><Trend v={p.fc_trend_pct} raw={p.fc_trend30} /></span>
                    <span className="hidden w-12 shrink-0 text-right text-xs text-slate-600 tabular-nums sm:block">
                      {p.ffc_adp != null ? p.ffc_adp.toFixed(1) : '—'}
                    </span>
                    <span className="hidden w-12 shrink-0 text-right text-xs text-slate-600 tabular-nums sm:block">
                      {vorById.get(p.id) != null ? Number(vorById.get(p.id)).toFixed(1) : '—'}
                    </span>
                  </>
                }
              />
            ))}
          </Card>
          {all.length > visible.length && (
            <Button className="mt-3 w-full" onClick={() => setLimit(l => l + step)}>
              Show {Math.min(step, all.length - visible.length)} more ({all.length - visible.length} left)
            </Button>
          )}
        </>
      )}
    </div>
  );
}
