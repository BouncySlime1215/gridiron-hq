import { useMemo, useState } from 'react';
import { api, useApi } from '../../api';

interface Pick {
  pick_date: string; rank: number; market: string; selection: string;
  player_id: number | null; matchup: string | null; game_pk: number | null;
  side: string; line: number | null; model_probability: number | null;
  projection: number | null; stake_units: number;
  status: 'Won' | 'Lost' | 'Push' | 'Pending'; detail: string; units: number;
}
interface MarketRow {
  market: string; picks: number; wins: number; losses: number;
  win_rate: number | null; units: number;
}
interface Standing {
  wins: number; losses: number; pushes: number; pending: number;
  win_rate: number | null; units: number; days_tracked: number; by_market: MarketRow[];
}
interface Payload {
  requested_date: string; slate_date: string | null;
  today: Pick[]; history: Pick[]; standing: Standing;
}

const MARKET_LABEL: Record<string, string> = {
  nrfi: 'NRFI / YRFI',
  batter_total_bases: 'Total Bases',
  pitcher_strikeouts: 'Strikeouts'
};
const STATUS_STYLE: Record<string, string> = {
  Won: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  Lost: 'bg-rose-100 text-rose-700 border-rose-300',
  Push: 'bg-slate-100 text-slate-600 border-slate-300',
  Pending: 'bg-amber-50 text-amber-700 border-amber-200'
};

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const u = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`);
const fmtDate = (d: string) => {
  const x = new Date(`${d}T12:00:00`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};

/**
 * MLB auto-picks, generated and graded entirely from local data.
 *
 * The previous version read from a proxied feed and froze on 19 July when that
 * pipeline stopped publishing — and could never grade itself, because grading
 * depended on the same dead source. These come from local projections and
 * settle against local box scores.
 *
 * The record here tests the projections, not an edge over a sportsbook. There
 * is no MLB odds feed wired up, so picks are ranked by model conviction rather
 * than by disagreement with a price, and the page says so rather than implying
 * a value it has not measured.
 */
export default function MlbAutoPicks() {
  const [busy, setBusy] = useState(false);
  const { data, loading, error, refetch } = useApi<Payload>('/mlb/auto-picks');

  const byDate = useMemo(() => {
    const m = new Map<string, Pick[]>();
    for (const p of data?.history ?? []) {
      const arr = m.get(p.pick_date) ?? [];
      arr.push(p);
      m.set(p.pick_date, arr);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);

  const backfill = async () => {
    setBusy(true);
    try { await api('/mlb/auto-picks/backfill?days=21', { method: 'POST' }); refetch(); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="card p-6 text-sm text-slate-500">Building today's slate…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-600">{error}</div>;

  const s = data?.standing;
  const settled = (s?.wins ?? 0) + (s?.losses ?? 0);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">MLB Auto Picks</h1>
        <button className="btn-ghost text-xs ml-auto" onClick={backfill} disabled={busy}>
          {busy ? 'Backfilling…' : '↻ Backfill 21 days'}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Five picks a slate, chosen by the model with no manual curation, graded against local box
        scores. Every pick is its own straight bet — never combined.
      </p>

      {data?.slate_date && data.slate_date !== data.requested_date && (
        <div className="card p-3 mb-4 border-amber-300 bg-amber-50">
          <div className="text-xs font-bold text-amber-900">
            Showing {fmtDate(data.slate_date)}, not {fmtDate(data.requested_date)}
          </div>
          <p className="text-[11px] text-amber-800 mt-0.5">
            Today's games have not been synced yet, so this is the most recent completed slate.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
        <Metric label="Record" value={`${s?.wins ?? 0}-${s?.losses ?? 0}${s?.pushes ? `-${s.pushes}` : ''}`} />
        <Metric label="Win rate" value={pct(s?.win_rate)} />
        <Metric label="Units" value={u(s?.units)}
          tone={(s?.units ?? 0) > 0 ? 'good' : (s?.units ?? 0) < 0 ? 'bad' : undefined} />
        <Metric label="Pending" value={String(s?.pending ?? 0)} />
        <Metric label="Days tracked" value={String(s?.days_tracked ?? 0)} />
      </div>

      {settled > 0 && settled < 40 && (
        <div className="card p-3 mb-4 text-[11px] text-slate-600">
          Only {settled} picks have settled. At this sample a win rate says very little — roughly
          200 settled bets are needed before the difference between a good model and a lucky one
          becomes visible.
        </div>
      )}

      {s?.by_market?.length ? (
        <>
          <h2 className="text-sm font-bold text-slate-700 mb-2">By market</h2>
          <div className="card overflow-hidden mb-5">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400">
                <tr>{['Market', 'Picks', 'Record', 'Win rate', 'Units'].map((h, i) => (
                  <th key={i} className="text-left font-semibold px-3 py-2">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {s.by_market.map(m => (
                  <tr key={m.market}>
                    <td className="px-3 py-2 font-semibold text-slate-800">{MARKET_LABEL[m.market] ?? m.market}</td>
                    <td className="px-3 py-2 tabular-nums">{m.picks}</td>
                    <td className="px-3 py-2 tabular-nums">{m.wins}-{m.losses}</td>
                    <td className="px-3 py-2 tabular-nums">{pct(m.win_rate)}</td>
                    <td className={`px-3 py-2 tabular-nums font-semibold ${
                      m.units > 0 ? 'text-emerald-700' : m.units < 0 ? 'text-rose-600' : ''}`}>{u(m.units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2 className="text-sm font-bold text-slate-700 mb-2">
        Latest slate — {data?.slate_date ? fmtDate(data.slate_date) : '—'}
      </h2>
      {!data?.today?.length ? (
        <div className="card p-6 text-sm text-slate-500 mb-6">
          No pick met the plausibility bar for this slate. Picks are only made where a sportsbook
          would realistically post the line — a projection at 96% is a line that would not exist.
        </div>
      ) : (
        <div className="card overflow-hidden mb-6">
          <PickTable picks={data.today} />
        </div>
      )}

      <h2 className="text-sm font-bold text-slate-700 mb-2">History</h2>
      {!byDate.length ? (
        <div className="card p-6 text-sm text-slate-500">
          No picks yet — use Backfill to generate them for recent slates.
        </div>
      ) : (
        <div className="space-y-3">
          {byDate.map(([date, picks]) => (
            <div key={date} className="card overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-600 flex items-center gap-2">
                <span>{fmtDate(date)}</span>
                <span className="ml-auto tabular-nums text-slate-400">
                  {picks.filter(p => p.status === 'Won').length}-{picks.filter(p => p.status === 'Lost').length}
                  {' · '}
                  {u(picks.reduce((a, p) => a + p.units, 0))}
                </span>
              </div>
              <PickTable picks={picks} />
            </div>
          ))}
        </div>
      )}

      <div className="card p-3 mt-4 text-[11px] text-slate-500">
        These are ranked by model conviction, not by edge against a price — there is no MLB odds feed
        connected, so no edge can honestly be claimed. Picks are also restricted to the band a book
        would actually price: a projection more certain than about 78% means the line would not be
        offered, and including those would inflate the win rate while testing nothing.
      </div>
      <div className="card p-3 mt-2 text-[11px] text-slate-500">
        Each pick's stake size (0.5u–5.0u) comes from tenth-Kelly against an assumed -110 price —
        this scales up or down with how far the model's own probability sits from a coin flip, so a
        bigger stake means a bigger swing both ways, not a safer bet. Checked before using it: settled
        picks split into probability bands do show a real, roughly monotonic rise in win rate, unlike a
        similar NFL "model agreement" signal that turned out to be backwards.
      </div>
    </div>
  );
}

function PickTable({ picks }: { picks: Pick[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-slate-100">
          {picks.slice().sort((a, b) => a.rank - b.rank).map(p => (
            <tr key={p.rank} className="hover:bg-slate-50">
              <td className="px-3 py-2 text-slate-400 tabular-nums w-6">{p.rank}</td>
              <td className="px-3 py-2">
                <div className="font-semibold text-slate-800">{p.selection}</div>
                <div className="text-[10px] text-slate-400">
                  {MARKET_LABEL[p.market] ?? p.market}
                  {p.projection != null && ` · projected ${p.projection.toFixed(2)}`}
                </div>
              </td>
              <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                {p.side}{p.line != null ? ` ${p.line}` : ''}
              </td>
              <td className="px-3 py-2 tabular-nums text-slate-600">{pct(p.model_probability)}</td>
              <td className="px-3 py-2">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200"
                  title="Stake size — tenth-Kelly against an assumed -110 price, scaled by model conviction">
                  {(p.stake_units ?? 1).toFixed(1)}u stake
                </span>
              </td>
              <td className="px-3 py-2">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${STATUS_STYLE[p.status]}`}>
                  {p.status}
                </span>
              </td>
              <td className="px-3 py-2 text-slate-500">{p.detail}</td>
              <td className="px-3 py-2 tabular-nums text-right font-semibold w-16"
                style={{ color: p.units > 0 ? '#047857' : p.units < 0 ? '#e11d48' : undefined }}>
                {p.units === 0 ? '—' : u(p.units)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Metric = ({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) => (
  <div className="card p-3">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-lg font-bold ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-600' : 'text-slate-800'}`}>
      {value}
    </div>
  </div>
);
