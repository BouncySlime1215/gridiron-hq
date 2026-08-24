import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api';

const POS_ORDER = ['QB', 'RB', 'WR', 'TE'] as const;

/** Matchup color: green when the defense is soft for this position, red when tough. */
function tone(mult: number | undefined) {
  if (mult == null) return 'text-slate-400';
  if (mult >= 1.06) return 'text-good font-semibold';
  if (mult <= 0.94) return 'text-crit font-semibold';
  return 'text-slate-500';
}

function overallTone(week: any) {
  const skill = ['RB', 'WR', 'TE'].map(p => week.matchups[p]?.mult).filter((x: any) => x != null);
  if (!skill.length) return { label: 'no read', className: 'bg-slate-100 text-slate-500' };
  const avg = skill.reduce((s: number, x: number) => s + x, 0) / skill.length;
  if (avg >= 1.05) return { label: 'soft matchup', className: 'bg-good-tint text-good' };
  if (avg <= 0.95) return { label: 'tough matchup', className: 'bg-crit-tint text-crit' };
  return { label: 'average', className: 'bg-slate-100 text-slate-500' };
}

const fmtDate = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

export default function TeamSchedule({ abbr }: { abbr: string }) {
  const { data, loading } = useApi<any>(`/nfl/${abbr}/schedule`);
  const [open, setOpen] = useState<number | null>(null);

  if (loading || !data) return <p className="text-sm text-slate-500">Loading schedule…</p>;
  if (!data.weeks?.length) return <p className="text-sm text-slate-500">Schedule not synced yet.</p>;

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
        <h3 className="text-sm font-bold text-slate-700">{data.season} Schedule</h3>
        <span className="text-[11px] text-slate-400">tap a week for the full matchup read</span>
      </div>
      <div className="divide-y divide-slate-100">
        {data.weeks.map((w: any) => {
          const isOpen = open === w.week;
          const t = overallTone(w);
          const date = fmtDate(w.date);
          return (
            <div key={w.week}>
              <button onClick={() => setOpen(isOpen ? null : w.week)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-black/[.015] transition-colors">
                <span className="text-[10px] font-semibold text-slate-400 w-9 shrink-0">WK{w.week}</span>
                <span className="text-sm font-semibold text-slate-800 w-16 shrink-0">{w.home ? 'vs' : '@'} {w.opponent}</span>
                <span className="text-xs text-slate-400 w-24 shrink-0 hidden sm:inline">{date ?? '—'}</span>
                {w.played ? (
                  <span className="text-xs font-semibold tabular-nums text-slate-600">
                    {w.team_score > w.opp_score ? 'W' : w.team_score < w.opp_score ? 'L' : 'T'} {w.team_score}-{w.opp_score}
                  </span>
                ) : w.spread != null ? (
                  <span className="text-xs text-slate-500 tabular-nums">
                    {w.spread > 0 ? '+' : ''}{w.spread} · O/U {w.total}
                  </span>
                ) : <span className="text-xs text-slate-300">line not posted</span>}
                <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${t.className}`}>{t.label}</span>
                <span className="text-slate-300 text-xs">{isOpen ? '▲' : '▼'}</span>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 pt-1 bg-black/[.012]">
                  <div className="flex flex-wrap gap-4 mb-3 text-xs text-slate-500">
                    {date && w.gametime && <span>{date} · {w.gametime.slice(0, 5)} ET</span>}
                    {w.implied_points != null && <span>Vegas implied points: <b className="text-slate-700">{w.implied_points}</b></span>}
                    <Link to={`/teams/${w.opponent}`} className="text-[var(--accent)] hover:underline ml-auto">
                      scout {w.opponent} →
                    </Link>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {POS_ORDER.map(pos => {
                      const m = w.matchups[pos];
                      return (
                        <div key={pos} className="rounded-lg border border-slate-200 bg-white p-2">
                          <div className={`text-[10px] font-black pos-${pos}`}>{pos}</div>
                          {m ? (
                            <>
                              <div className={`text-sm tabular-nums ${tone(m.mult)}`}>
                                {m.mult > 1 ? '+' : ''}{Math.round((m.mult - 1) * 100)}%
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {w.opponent} allows · {m.rank ? `${m.rank}${ordinal(m.rank)} toughest` : 'no rank'}
                              </div>
                            </>
                          ) : <div className="text-[10px] text-slate-300 mt-1">no read</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ordinal = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
