import { useMemo, useState } from 'react';
import { useApi, api } from '../../api';
import { TrainingSummaryCard, useEnsembleWeek, findEnsembleGameByTeams, EnsembleBadge, EnsembleDetail } from '../../components/NflModelInsight';

interface Proj {
  player: string; team: string; position: string | null; opponent: string | null;
  pass_yds: number; rush_yds: number; rec_yds: number; receptions: number; any_td_prob: number;
  percentiles: { rec_yds: number[]; rush_yds: number[]; pass_yds: number[] };
  game_script: { spread: number; total: number; implied_points: number } | null;
}
interface BoardRow {
  market: string; market_label: string; player: string; team: string; position: string | null;
  matchup: string; line: number; side: string; american_price: number | null; book: string;
  model_probability: number; implied_probability: number | null;
  probability_difference: number | null; projection: number;
}
interface Payload { season: number; week: number; market_status: string; board: BoardRow[]; projections: Proj[]; }

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const american = (v: number | null) => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);

const POS_COLOR: Record<string, string> = {
  QB: 'bg-rose-100 text-rose-700', RB: 'bg-emerald-100 text-emerald-700',
  WR: 'bg-sky-100 text-sky-700', TE: 'bg-amber-100 text-amber-700'
};

/**
 * Player props. Projections always render; market columns and the edge ranking
 * only appear once odds have been fetched, which costs credits and therefore
 * happens on an explicit click rather than on page load.
 */
export default function NflProps() {
  const [week, setWeek] = useState(1);
  const [season, setSeason] = useState(2025);
  const [fetched, setFetched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data, loading } = useApi<Payload>(`/nfl-betting/props?season=${season}&week=${week}&limit=60`);
  const shown = live ?? data;
  // The game script (spread/total) behind every projection below comes from
  // the same 20-model ensemble used on the NFL Auto Picks board — surfacing it
  // here answers "how much should I trust the total driving this projection."
  const { data: ensemble } = useEnsembleWeek(week, season);
  const [expandedGame, setExpandedGame] = useState<string | null>(null);

  const refreshOdds = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/nfl-betting/props?season=${season}&week=${week}&market=1&limit=60`);
      setLive(r); setFetched(true);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const top5 = useMemo(() => (shown?.board ?? []).slice(0, 5), [shown]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Player Props</h1>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <select className="input py-1" value={season} onChange={e => { setSeason(Number(e.target.value)); setLive(null); }}>
            {[2025, 2026].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input py-1" value={week} onChange={e => { setWeek(Number(e.target.value)); setLive(null); }}>
            {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>Wk {w}</option>)}
          </select>
          <button className="btn-primary text-xs" onClick={refreshOdds} disabled={busy}>
            {busy ? 'Fetching…' : '↻ Refresh odds'}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-3">
        Every prop is answered from a simulated distribution rather than a point estimate — the
        question is where the line falls, not what the average is.
      </p>

      <div className={`card p-2.5 mb-4 text-xs ${fetched ? 'text-slate-600' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
        {shown?.market_status ?? 'Loading…'}
      </div>
      {err && <div className="card p-3 mb-4 text-xs text-rose-600">{err}</div>}

      <TrainingSummaryCard />

      {top5.length > 0 && (
        <>
          <h2 className="text-sm font-bold text-slate-700 mb-2">Top 5 edges</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
            {top5.map((b, i) => (
              <div key={i} className="card p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Avatar name={b.player} position={b.position} />
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-800 truncate">{b.player}</div>
                    <div className="text-[10px] text-slate-400 truncate">{b.team} · {b.matchup}</div>
                  </div>
                </div>
                <div className="text-[11px] font-semibold text-slate-700">{b.side} {b.line}</div>
                <div className="text-[10px] text-slate-400 mb-1.5">{b.market_label}</div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-lg font-black text-emerald-700">+{pct(b.probability_difference)}</span>
                  <span className="text-[10px] text-slate-400">edge</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-1">
                  model {pct(b.model_probability)} · mkt {pct(b.implied_probability)} · {american(b.american_price)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="text-sm font-bold text-slate-700 mb-2">
        Model projections {shown?.projections?.length ? `(${shown.projections.length})` : ''}
      </h2>
      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Simulating…</div>
      ) : !shown?.projections?.length ? (
        <div className="card p-6 text-sm text-slate-500">
          No projections for this week — the model needs at least one prior game of usage.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {shown.projections.map((p, i) => {
            const eGame = findEnsembleGameByTeams(ensemble?.games, p.team, p.opponent);
            const gameKey = eGame ? `${eGame.home}-${eGame.away}` : null;
            const open = gameKey != null && expandedGame === gameKey;
            return (
            <div key={i} className="card p-3">
              <div className="flex items-center gap-2 mb-2">
                <Avatar name={p.player} position={p.position} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-slate-800 truncate">{p.player}</div>
                  <div className="text-[10px] text-slate-400">
                    {p.team}{p.opponent ? ` vs ${p.opponent}` : ''}
                    {p.game_script ? ` · total ${p.game_script.total}` : ''}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mb-2">
                {p.pass_yds > 20 && <Stat label="Pass yds" value={p.pass_yds.toFixed(0)} band={p.percentiles.pass_yds} />}
                {p.rush_yds > 5 && <Stat label="Rush yds" value={p.rush_yds.toFixed(0)} band={p.percentiles.rush_yds} />}
                {p.rec_yds > 5 && <Stat label="Rec yds" value={p.rec_yds.toFixed(0)} band={p.percentiles.rec_yds} />}
                {p.receptions > 0.5 && <Stat label="Receptions" value={p.receptions.toFixed(1)} />}
                <Stat label="Any TD" value={pct(p.any_td_prob)} />
              </div>
              {eGame && (
                <button
                  onClick={() => setExpandedGame(open ? null : gameKey)}
                  className="text-left"
                  title="How confident the game script behind this projection actually is"
                >
                  <EnsembleBadge game={eGame} />
                </button>
              )}
              {open && eGame && (
                <div className="-mx-3 -mb-3 mt-2 border-t border-slate-100">
                  <EnsembleDetail game={eGame} />
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, band }: { label: string; value: string; band?: number[] }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-bold text-slate-800 tabular-nums">{value}</div>
      {band && band.length === 3 && (
        <div className="text-[9px] text-slate-400 tabular-nums">
          {band[0]?.toFixed(0)}–{band[2]?.toFixed(0)} <span className="text-slate-300">80%</span>
        </div>
      )}
    </div>
  );
}

/**
 * Initials rather than a photo. Headshots key off ESPN athlete ids, and the
 * play-by-play feed identifies players by an abbreviated name ("A.Brown"), so
 * matching them would guess wrong often enough to show the wrong player's face.
 */
function Avatar({ name, position }: { name: string; position: string | null }) {
  const initials = String(name ?? '?').replace(/[^A-Za-z. ]/g, '')
    .split(/[. ]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  return (
    <div className={`w-9 h-9 rounded-full grid place-items-center shrink-0 text-[11px] font-black ${
      POS_COLOR[position ?? ''] ?? 'bg-slate-100 text-slate-500'}`}>
      {initials || '?'}
    </div>
  );
}
