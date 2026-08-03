import { Link } from 'react-router-dom';
import { useApi } from '../../api';

interface Standing {
  wins: number; losses: number; pushes: number; pending: number;
  win_rate: number | null; units: number; bets: number;
  by_market: { spread: any; total: any };
}
interface Summary {
  nfl: {
    standing: Standing;
    model: { win_accuracy: number; margin_mae: number; total_mae: number; games_graded: number } | null;
    variables: { total: number; team: number; player: number; by_group: Record<string, number> };
  };
  mlb: { standing: { tracked_picks: number; days_tracked: number; latest_slate: string | null; note: string } };
  odds_api: { has_key: boolean; requests_remaining: number | null; requests_used: number | null };
}

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
const units = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;

/**
 * The betting landing page — deliberately separate from the fantasy side, since
 * these answer different questions and share no league context.
 *
 * The two numbers that matter most, per sport, are up top: how often picks win
 * and what they'd have returned at a flat stake. A record with nothing settled
 * yet says so plainly rather than showing a flattering 0-0.
 */
export default function BettingHome() {
  const { data, loading, error } = useApi<Summary>('/betting/summary');

  if (loading) return <div className="card p-6 text-sm text-slate-500">Loading…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-600">{error}</div>;

  const nfl = data?.nfl.standing;
  const mlb = data?.mlb.standing;
  const settledNfl = (nfl?.wins ?? 0) + (nfl?.losses ?? 0);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Betting</h1>
      <p className="text-sm text-slate-500 mb-5">
        Model versus market across two sports. Every pick is tracked as its own straight bet at one
        unit — no parlays, no stake sizing, no retroactive edits.
      </p>

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <SportCard
          sport="NFL" accent="emerald" icon="🏈"
          record={`${nfl?.wins ?? 0}-${nfl?.losses ?? 0}${nfl?.pushes ? `-${nfl.pushes}` : ''}`}
          winRate={pct(nfl?.win_rate)}
          unitsValue={nfl?.units ?? 0}
          pending={nfl?.pending ?? 0}
          settled={settledNfl}
          lines={[
            ['Spread picks', `${nfl?.by_market.spread.wins ?? 0}-${nfl?.by_market.spread.losses ?? 0} · ${units(nfl?.by_market.spread.units)}`],
            ['Total picks', `${nfl?.by_market.total.wins ?? 0}-${nfl?.by_market.total.losses ?? 0} · ${units(nfl?.by_market.total.units)}`],
            ['Weeks tracked', String(nfl?.by_market.spread.weeks_tracked ?? 0)]
          ]}
          links={[['/betting/nfl', 'Board'], ['/betting/nfl/props', 'Props'], ['/betting/nfl/picks', 'Auto Picks']]}
        />
        <SportCard
          sport="MLB" accent="sky" icon="⚾"
          record={mlb?.tracked_picks ? `${mlb.tracked_picks} picks` : '—'}
          winRate="see Auto Picks"
          unitsValue={null}
          pending={0}
          settled={0}
          lines={[
            ['Days tracked', String(mlb?.days_tracked ?? 0)],
            ['Latest slate', mlb?.latest_slate ?? '—'],
            ['Grading', 'client-side vs results feed']
          ]}
          links={[['/betting/mlb', 'Board'], ['/betting/mlb/auto', 'Auto Picks'], ['/betting/mlb/picks', 'My Picks']]}
        />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <div className="card p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">NFL model health</h2>
          {data?.nfl.model ? (
            <div className="space-y-1.5 text-xs text-slate-600">
              <Row label="Straight-up accuracy" value={pct(data.nfl.model.win_accuracy)} />
              <Row label="Margin error" value={`${data.nfl.model.margin_mae} pts`} />
              <Row label="Total error" value={`${data.nfl.model.total_mae} pts`} />
              <Row label="Games graded" value={data.nfl.model.games_graded.toLocaleString()} />
              <p className="text-[10px] text-slate-400 pt-1">
                Walk-forward — every prediction used only games played before it.
              </p>
            </div>
          ) : <p className="text-xs text-slate-500">Model not fitted yet.</p>}
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Variables tracked</h2>
          <div className="text-3xl font-black text-slate-800">{data?.nfl.variables.total ?? 0}</div>
          <div className="text-[11px] text-slate-500 mb-2">
            {data?.nfl.variables.team} team · {data?.nfl.variables.player} player
          </div>
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {Object.entries(data?.nfl.variables.by_group ?? {}).map(([g, n]) => (
              <div key={g} className="flex justify-between text-[10px] text-slate-500">
                <span className="truncate pr-2">{g}</span><span className="tabular-nums font-semibold">{n}</span>
              </div>
            ))}
          </div>
          <Link to="/betting/catalog" className="text-[11px] text-emerald-600 hover:underline mt-2 inline-block">
            Browse the full catalog →
          </Link>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Odds feed</h2>
          {data?.odds_api.has_key ? (
            <div className="space-y-1.5 text-xs text-slate-600">
              <Row label="Status" value={<span className="text-emerald-700 font-semibold">connected</span>} />
              <Row label="Credits left" value={data.odds_api.requests_remaining ?? '—'} />
              <Row label="Used" value={data.odds_api.requests_used ?? 0} />
              <p className="text-[10px] text-slate-400 pt-1">
                Player props are fetched only when you ask for them, and cached for six hours, so
                browsing never spends credits.
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              No odds key configured. Everything runs model-only; set <code>ODDS_API_KEY</code> to
              light up market prices and edges.
            </p>
          )}
        </div>
      </div>

      <div className="card p-3 mt-4 text-[11px] text-slate-500">
        <b className="text-slate-700">On public betting percentages:</b> no free licensed feed exists —
        DraftKings and Action Network block automated access, Covers renders its consensus in the
        browser, and VegasInsider puts it behind a paywall. Line movement (where the number opened
        versus where it sits now) and disagreement between books are used instead, which is what
        those percentages are usually a proxy for anyway.
      </div>
    </div>
  );
}

const Row = ({ label, value }: { label: string; value: any }) => (
  <div className="flex justify-between"><span>{label}</span><span className="font-semibold text-slate-800">{value}</span></div>
);

function SportCard({ sport, accent, icon, record, winRate, unitsValue, pending, settled, lines, links }: {
  sport: string; accent: 'emerald' | 'sky'; icon: string; record: string; winRate: string;
  unitsValue: number | null; pending: number; settled: number;
  lines: [string, string][]; links: [string, string][];
}) {
  const ring = accent === 'emerald' ? 'border-emerald-200' : 'border-sky-200';
  const chip = accent === 'emerald' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700';
  return (
    <div className={`card p-4 border ${ring}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl">{icon}</span>
        <h2 className="text-base font-bold text-slate-800">{sport}</h2>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${chip}`}>
          {settled > 0 ? `${settled} settled` : pending > 0 ? `${pending} pending` : 'no bets yet'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <Metric label="Record" value={record} />
        <Metric label="Win rate" value={winRate} />
        <Metric
          label="Units"
          value={unitsValue == null ? '—' : units(unitsValue)}
          tone={unitsValue == null ? undefined : unitsValue > 0 ? 'good' : unitsValue < 0 ? 'bad' : undefined}
        />
      </div>
      {settled === 0 && pending > 0 && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
          {pending} pick{pending === 1 ? '' : 's'} locked in but not yet settled — a win rate will
          appear once games finish.
        </p>
      )}
      <div className="space-y-1 mb-3">
        {lines.map(([l, v]) => (
          <div key={l} className="flex justify-between text-[11px] text-slate-500">
            <span>{l}</span><span className="font-semibold text-slate-700">{v}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {links.map(([to, label]) => (
          <Link key={to} to={to}
            className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800">
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}

const Metric = ({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) => (
  <div>
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-lg font-bold ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-600' : 'text-slate-800'}`}>
      {value}
    </div>
  </div>
);
