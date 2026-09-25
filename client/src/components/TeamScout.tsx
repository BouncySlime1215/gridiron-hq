import { PlayerPill, num } from './TradeCard';
import { Card, Chip, Fold, Stat, type Tone } from './ui/DesignSystem';

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

const STATUS_TONE: Record<string, Tone> = { strength: 'good', average: 'neutral', weakness: 'bad' };
const PRIORITY_TONE: Record<string, Tone> = { high: 'bad', medium: 'warn', low: 'neutral' };

export default function TeamScout({ data: s, loading }: { data: any; loading?: boolean }) {
  if (loading) return <Card className="text-sm text-slate-500">Scouting your roster against the league…</Card>;
  if (!s || s.error) return <Card className="text-sm text-slate-500">{s?.error ?? 'No analysis available.'}</Card>;

  const maxLineup = Math.max(...s.league_lineups.map((l: any) => l.points));

  return (
    <div className="space-y-4">
      {/* headline: the number, where it ranks, and where every team sits */}
      <Card>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <Stat label="Projected lineup strength"
            value={<>{s.lineup.points}<span className="ml-1 text-sm font-normal text-slate-500">ppg</span></>}
            foot={<Chip tone={s.rank <= 3 ? 'good' : s.rank > s.of - 3 ? 'bad' : 'warn'}>{s.rank}{ord(s.rank)} of {s.of}</Chip>} />
          {s.spread?.floor != null && (
            <Stat label="Weekly range" value={<><span className="text-crit">{s.spread.floor}</span><span className="mx-1 opacity-30">–</span><span className="text-good">{s.spread.ceiling}</span></>} />
          )}
        </div>
        <div className="mt-5 space-y-2 ds-stagger">
          {s.league_lineups.map((l: any) => (
            <div key={l.roster_id} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-3 text-xs">
              <span className={`truncate ${l.me ? 'font-semibold text-[var(--c-accent)]' : 'text-slate-500'}`} title={l.owner}>{l.owner}</span>
              <span className="ds-bar"><i className={l.me ? 'is-me' : undefined} style={{ width: `${(l.points / maxLineup) * 100}%` }} /></span>
              <span className="tabular-nums text-right text-slate-500">{l.points.toFixed(0)}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* position by position */}
      <section>
        <h3 className="ds-h mb-3">Position by position</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 ds-stagger">
          {Object.entries(s.positions).map(([pos, v]: [string, any]) => (
            <Card key={pos} lift className="!p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-sm font-bold pos-${pos}`}>{pos}</span>
                <Chip tone={STATUS_TONE[v.status] ?? 'neutral'}>{v.status}</Chip>
                <span className="ml-auto text-[11px] text-slate-400 tabular-nums">{v.rank}{ord(v.rank)}/{v.of}</span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="ds-stat-v !mt-0 !text-[26px]">{v.ppg.toFixed(1)}</span>
                <span className="text-[12px] text-slate-400">vs {v.league_avg.toFixed(1)} avg</span>
              </div>
              <div className="ds-bar mt-2 !h-1.5">
                <i className={v.ratio >= 1.12 ? 'is-good' : v.ratio <= 0.88 ? 'is-bad' : undefined} style={{ width: `${Math.min(100, (v.ratio / 1.6) * 100)}%` }} />
              </div>
              <div className="mt-3 space-y-1">
                {v.starters.map((p: any) => <div key={p.id}><PlayerPill p={p} /></div>)}
              </div>
              {v.depth.length > 0 && (
                <p className="ds-note mt-2">Bench: {v.depth.slice(0, 3).map((p: any) => p.name).join(', ')}</p>
              )}
              <p className="ds-note mt-1">
                Lose your best {pos}: <span className="font-semibold text-slate-600">−{v.injury_dropoff} ppg</span>
              </p>
            </Card>
          ))}
        </div>
      </section>

      {/* what to do about it */}
      <section>
        <h3 className="ds-h mb-3">What to fix, in order</h3>
        {s.fixes.length > 0 ? (
          <Card pad={false} className="ds-rows">
            {s.fixes.map((f: any, i: number) => (
              <div key={i} className="flex gap-3 p-4">
                <span className="pt-0.5"><Chip tone={PRIORITY_TONE[f.priority] ?? 'neutral'}>{f.priority}</Chip></span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800">{f.area}</div>
                  <p className="text-sm text-slate-600">{f.issue}</p>
                  <p className="mt-1 text-sm font-medium text-slate-800">{f.action}</p>
                </div>
              </div>
            ))}
          </Card>
        ) : <Card className="text-sm text-slate-500">No structural problems found — you are in good shape.</Card>}
      </section>

      {/* playoff schedule: folded, it is a reference list */}
      {s.playoff_swing?.length > 0 && (
        <Fold title="Your starters in Weeks 15–17" hint="How each one's playoff matchups compare to his normal week">
          <div className="ds-rows">
            {s.playoff_swing.slice().reverse().map((p: any) => (
              <div key={p.id} className="flex items-center gap-2 py-2 text-xs">
                <span className={`text-[10px] font-bold pos-${p.position} w-6`}>{p.position}</span>
                <span className="font-semibold text-slate-700 w-32 truncate" title={p.name}>{p.name}</span>
                <span className="text-slate-400 text-[11px] truncate flex-1" title={(p.games ?? []).map((g: any) => `${g.home ? '' : '@'}${g.opponent}`).join(' · ')}>
                  {(p.games ?? []).map((g: any) => `${g.home ? '' : '@'}${g.opponent}`).join(' · ')}
                </span>
                <span className={`font-semibold tabular-nums shrink-0 ${p.swing > 0.3 ? 'text-good' : p.swing < -0.3 ? 'text-crit' : 'text-slate-400'}`}>
                  {num(p.swing)} ppg
                </span>
              </div>
            ))}
          </div>
        </Fold>
      )}
    </div>
  );
}

const ord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
