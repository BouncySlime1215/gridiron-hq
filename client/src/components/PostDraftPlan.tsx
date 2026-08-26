import { headshotUrl, useApi } from '../api';
import { Headshot } from './PlayerRow';

/**
 * Phase 4A: assembles the existing selfScout, findTrades, and bestLineup engine
 * outputs into one post-draft view. No new analysis here — just a single call
 * to the backend's combined endpoint, so the card doesn't fire three separate
 * requests (and doesn't need to reconcile three separate loading states).
 */
export default function PostDraftPlan({ leagueId, teamId }: { leagueId: number; teamId: string | null }) {
  const url = teamId ? `/trades/${leagueId}/post-draft-plan?team_id=${teamId}` : null;
  const { data, loading, error, refetch } = useApi<any>(url);

  if (!teamId) return null;

  return (
    <div className="card p-4 mb-4">
      <h3 className="text-sm font-bold text-slate-700 mb-3">Post-Draft Action Plan</h3>

      {loading && !data && <p className="text-sm text-slate-400">Loading your post-draft plan…</p>}

      {error && (
        <div className="text-sm text-slate-500">
          Couldn&apos;t load the post-draft plan: {error}{' '}
          <button className="text-emerald-600 underline" onClick={refetch}>Retry</button>
        </div>
      )}

      {!loading && !error && data && data.drafted === false && (
        <p className="text-sm text-slate-500">
          {data.message || 'Your draft isn\'t complete yet — the post-draft plan will show up here once it wraps up.'}
        </p>
      )}

      {!loading && !error && data?.drafted && (
        <div className="grid md:grid-cols-3 gap-4">
          <SelfScoutSection scout={data.self_scout} />
          <TradesSection trades={data.trades} />
          <LineupSection lineup={data.lineup} />
        </div>
      )}
    </div>
  );
}

function SelfScoutSection({ scout }: { scout: any }) {
  return (
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Self-Scout</h4>
      {scout?.error && <p className="text-xs text-slate-400">{scout.error}</p>}
      {!scout?.error && (!scout?.fixes || scout.fixes.length === 0) && (
        <p className="text-xs text-slate-400">No issues found — your roster looks solid.</p>
      )}
      {!scout?.error && scout?.fixes?.length > 0 && (
        <div className="space-y-2">
          {scout.fixes.slice(0, 4).map((f: any, i: number) => (
            <div key={i} className="text-xs">
              <div className="font-medium text-slate-700">{f.issue}</div>
              <div className="text-slate-500">{f.action}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TradesSection({ trades }: { trades: any }) {
  const deals = trades?.deals ?? [];
  return (
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Suggested Trades</h4>
      {trades?.error && <p className="text-xs text-slate-400">{trades.error}</p>}
      {!trades?.error && deals.length === 0 && (
        <p className="text-xs text-slate-400">No trade suggestions right now.</p>
      )}
      {!trades?.error && deals.length > 0 && (
        <div className="space-y-2">
          {deals.slice(0, 3).map((d: any, i: number) => (
            <div key={i} className="text-xs">
              <div className="font-medium text-slate-700">{d.partner}</div>
              <div className="text-slate-500">
                {(d.i_give ?? []).map((p: any) => p.name).join(' + ')} for {(d.i_get ?? []).map((p: any) => p.name).join(' + ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LineupSection({ lineup }: { lineup: any }) {
  return (
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Best Lineup</h4>
      {!lineup?.slots?.length && <p className="text-xs text-slate-400">No lineup available.</p>}
      {!!lineup?.slots?.length && (
        <div className="space-y-1">
          {lineup.slots.map((s: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="text-slate-400 w-8 shrink-0 uppercase">{s.slot}</span>
              {s.player ? (
                <>
                  <Headshot src={headshotUrl(s.player)} pos={s.player.position} size={20} />
                  <span className="text-slate-700 truncate">{s.player.name}</span>
                </>
              ) : <span className="text-crit">— empty —</span>}
            </div>
          ))}
        </div>
      )}
      {lineup?.points != null && (
        <p className="text-[10px] text-slate-400 mt-2">{lineup.points} ppg</p>
      )}
    </div>
  );
}
