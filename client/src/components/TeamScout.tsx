import { PlayerPill, num } from './TradeCard';

/**
 * Self-scouting report: where this roster is strong, where it breaks, and the
 * specific moves that fix it. Everything is measured against the other teams in
 * the league — "good at RB" only means anything relative to the nine managers you
 * actually play.
 *
 * The scout report is fetched once by the parent (MyTeam) — it needs the same
 * `/trades/:id/scout` payload for its own header stats and the roster tab, so this
 * component takes the data as a prop instead of re-fetching it. Fetching it here
 * too used to fire the identical request twice, back to back, on every page load.
 */

const STATUS_TONE: Record<string, string> = {
  strength: 'bg-good-tint text-good border-good',
  average: 'bg-slate-100 text-slate-600 border-slate-300',
  weakness: 'bg-crit-tint text-crit border-crit'
};
const PRIORITY_TONE: Record<string, string> = {
  high: 'border-rose-300 bg-rose-50/50',
  medium: 'border-amber-300 bg-amber-50/40',
  low: 'border-slate-200 bg-slate-50/60'
};

export default function TeamScout({ data: s, loading }: { data: any; loading?: boolean }) {
  if (loading) return <div className="card p-6 text-sm text-slate-500">Scouting your roster against the league…</div>;
  if (!s || s.error) return <div className="card p-6 text-sm text-slate-500">{s?.error ?? 'No analysis available.'}</div>;

  const maxLineup = Math.max(...s.league_lineups.map((l: any) => l.points));

  return (
    <div className="space-y-4">
      {/* headline */}
      <div className="card p-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <div>
            <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">Projected lineup strength</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black tabular-nums text-slate-800">{s.lineup.points}</span>
              <span className="text-sm text-slate-500">ppg</span>
              <span className={`text-sm font-bold ${s.rank <= 3 ? 'text-good' : s.rank > s.of - 3 ? 'text-crit' : 'text-amber-600'}`}>
                {s.rank}{ord(s.rank)} of {s.of}
              </span>
            </div>
          </div>
          {s.spread?.floor != null && (
            <div className="ml-auto text-right">
              <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">Weekly range</div>
              <div className="text-sm tabular-nums text-slate-600">
                <span className="text-crit font-semibold">{s.spread.floor}</span>
                <span className="text-slate-300 mx-1">—</span>
                <span className="text-good font-semibold">{s.spread.ceiling}</span>
              </div>
            </div>
          )}
        </div>

        {/* where every team sits */}
        <div className="mt-3 space-y-1">
          {s.league_lineups.map((l: any) => (
            <div key={l.roster_id} className="flex items-center gap-2 text-xs">
              <span className={`w-32 truncate shrink-0 ${l.me ? 'font-bold text-emerald-700' : 'text-slate-500'}`}>{l.owner}</span>
              <div className="flex-1 h-3 bg-slate-100 rounded overflow-hidden">
                <div className={`h-full rounded ${l.me ? 'bg-emerald-500' : 'bg-slate-300'}`}
                  style={{ width: `${(l.points / maxLineup) * 100}%` }} />
              </div>
              <span className="tabular-nums text-slate-500 w-12 text-right shrink-0">{l.points.toFixed(0)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* position by position */}
      <div>
        <h3 className="text-sm font-bold text-slate-700 mb-2">Position by position</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Object.entries(s.positions).map(([pos, v]: [string, any]) => (
            <div key={pos} className="card p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-sm font-black pos-${pos}`}>{pos}</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_TONE[v.status]}`}>
                  {v.status}
                </span>
                <span className="text-[10px] text-slate-400 ml-auto">{v.rank}{ord(v.rank)}/{v.of}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-black tabular-nums text-slate-800">{v.ppg.toFixed(1)}</span>
                <span className="text-[11px] text-slate-400">vs {v.league_avg.toFixed(1)} avg</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded mt-1.5 overflow-hidden">
                <div className={`h-full rounded ${v.ratio >= 1.12 ? 'bg-[var(--good)]' : v.ratio <= 0.88 ? 'bg-[var(--crit)]' : 'bg-slate-400'}`}
                  style={{ width: `${Math.min(100, (v.ratio / 1.6) * 100)}%` }} />
              </div>
              <div className="mt-2 space-y-1">
                {v.starters.map((p: any) => <div key={p.id}><PlayerPill p={p} /></div>)}
              </div>
              {v.depth.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-slate-100">
                  <div className="text-[9px] font-bold uppercase tracking-wide text-slate-400 mb-1">Bench</div>
                  <div className="flex flex-wrap gap-1">
                    {v.depth.slice(0, 3).map((p: any) => (
                      <span key={p.id} className="text-[10px] text-slate-500">{p.name}</span>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[10px] text-slate-400 mt-1.5">
                Lose your best {pos}: <span className="font-semibold text-slate-600">−{v.injury_dropoff} ppg</span>
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* what to do about it */}
      <div>
        <h3 className="text-sm font-bold text-slate-700 mb-2">What to fix, in order</h3>
        <div className="space-y-2">
          {s.fixes.map((f: any, i: number) => (
            <div key={i} className={`rounded-xl border p-3 ${PRIORITY_TONE[f.priority]}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] font-black uppercase tracking-wide text-slate-500">{f.priority}</span>
                <span className="text-sm font-bold text-slate-800">{f.area}</span>
              </div>
              <p className="text-xs text-slate-600">{f.issue}</p>
              <p className="text-xs text-slate-700 font-medium mt-1">→ {f.action}</p>
            </div>
          ))}
          {s.fixes.length === 0 && <div className="card p-4 text-sm text-slate-500">No structural problems found — you are in good shape.</div>}
        </div>
      </div>

      {/* playoff schedule */}
      {s.playoff_swing?.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <h3 className="text-sm font-bold text-slate-700">Your starters in Weeks 15–17</h3>
            <p className="text-[10px] text-slate-400">How each one&apos;s playoff matchups compare to his normal week</p>
          </div>
          <div className="divide-y divide-slate-100">
            {s.playoff_swing.slice().reverse().map((p: any) => (
              <div key={p.id} className="px-3 py-2 flex items-center gap-2 text-xs">
                <span className={`text-[9px] font-black pos-${p.position} w-6`}>{p.position}</span>
                <span className="font-semibold text-slate-700 w-32 truncate">{p.name}</span>
                <span className="text-slate-400 text-[10px] truncate flex-1">
                  {(p.games ?? []).map((g: any) => `${g.home ? '' : '@'}${g.opponent}`).join(' · ')}
                </span>
                <span className={`font-bold tabular-nums shrink-0 ${p.swing > 0.3 ? 'text-good' : p.swing < -0.3 ? 'text-crit' : 'text-slate-400'}`}>
                  {num(p.swing)} ppg
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
