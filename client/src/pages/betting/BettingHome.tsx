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
  edges?: {
    teaser?: { legs: number; win_rate: number; standard_error: number;
      ev_at_110: { verdict: string; ev_per_bet: number; z: number };
      ev_at_130: { verdict: string; ev_per_bet: number } };
    break_even?: { real_breakeven: number; convention_breakeven: number; share_priced_at_minus_110: number };
    prop_edge?: { status: string; captured_quotes: number; settled_bets?: number; median_clv_cents?: number | null; verdict: string };
  };
}

interface HubStatus {
  edges: { id: string; label: string; live: boolean; headline: string; detail: string; blocked_by: string | null }[];
  model: { calibration_gate: string; calibration_detail: string; sizing_allowed: boolean };
  data: { credits_remaining: number | null; credits_used: number | null;
    free_detector: { events_tracked: number; moves: number; last_poll: string | null; worth_capturing: number };
    capture_stale: boolean; latest_multibook_capture: string | null };
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
  // Same endpoint the Edge Desk hero reads, deliberately: two pages describing
  // the same edges from two different sources is how they drift apart.
  const { data: hub } = useApi<HubStatus>('/betting/status');

  if (loading) return <div className="card p-6 text-sm text-slate-500">Loading…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-600">{error}</div>;

  const nfl = data?.nfl.standing;
  const mlb = data?.mlb.standing;
  const settledNfl = (nfl?.wins ?? 0) + (nfl?.losses ?? 0);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Betting</h1>
      <p className="text-sm text-slate-500 mb-5">
        Structural edges first — the ones that pay without predicting anything. The forecasting model
        is tracked below as research; it has never beaten a closing line.
      </p>

      <LiveEdges status={hub} />

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <SportCard
          sport="NFL" accent="emerald" icon="NFL"
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
          links={[['/betting/nfl/picks', 'Auto Picks'], ['/betting/nfl/props', 'Props']]}
        />
        <SportCard
          sport="MLB" accent="sky" icon="MLB"
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
        {/*
          Was "NFL model health", leading with a 63.8% straight-up accuracy —
          a number that sounds like success and is not one, because it never
          said the market still predicts covers better. The gate result is the
          fact that actually governs whether this model may size a bet.
        */}
        <div className={`card p-4 ${hub && !hub.model.sizing_allowed ? 'border-amber-300' : ''}`}>
          <h2 className="text-sm font-bold text-slate-700 mb-2">Forecasting model</h2>
          {hub ? (
            <>
              <div className={`text-lg font-black ${hub.model.sizing_allowed ? 'text-emerald-700' : 'text-amber-700'}`}>
                {hub.model.sizing_allowed ? 'Cleared to size' : 'Blocked from sizing'}
              </div>
              <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">{hub.model.calibration_detail}</p>
              <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                Staking refuses model-derived edges until the calibration gate passes. That is the code
                working, not a missing feature.
              </p>
            </>
          ) : <p className="text-xs text-slate-500">Checking the calibration gate…</p>}
          {data?.nfl.model && (
            <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
              <Row label="Margin error" value={`${data.nfl.model.margin_mae} pts`} />
              <Row label="Games graded" value={data.nfl.model.games_graded.toLocaleString()} />
            </div>
          )}
        </div>

        {/*
          Replaces a "328 variables tracked" counter. Variable count measures
          effort, not edge — and a bigger number would have been read as better.
          The break-even is the number that decides whether any bet is worth
          making, and it is not the one everybody quotes.
        */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">What you actually need to hit</h2>
          {data?.edges?.break_even ? (
            <>
              <div className="text-3xl font-black text-slate-800 tabular-nums">
                {pct(data.edges.break_even.real_breakeven)}
              </div>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                Not the {pct(data.edges.break_even.convention_breakeven)} everyone quotes — that assumes
                every spread is priced −110, and only {pct(data.edges.break_even.share_priced_at_minus_110)} of
                recorded games actually were.
              </p>
            </>
          ) : <p className="text-xs text-slate-500">Measuring from stored prices…</p>}
          <Link to="/betting/nfl/picks" className="text-[11px] text-emerald-600 hover:underline mt-2 inline-block">
            Open the Edge Desk →
          </Link>
        </div>

        {/*
          Credits are the binding constraint on every remaining edge, so the
          metered feed and the free one that conserves it belong side by side.
        */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Data budget</h2>
          {hub ? (
            <div className="space-y-1.5 text-xs text-slate-600">
              <Row label="Paid credits left"
                value={<span className={(hub.data.credits_remaining ?? 0) < 200 ? 'text-amber-700 font-bold' : 'font-semibold'}>
                  {hub.data.credits_remaining ?? '—'}
                </span>} />
              <Row label="Used" value={hub.data.credits_used ?? 0} />
              <div className="pt-1.5 mt-1.5 border-t border-slate-100">
                <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 mb-1">
                  Free detector
                </div>
                <Row label="Games watched" value={hub.data.free_detector.events_tracked} />
                <Row label="Moves seen" value={hub.data.free_detector.moves} />
                <Row label="Worth a credit" value={hub.data.free_detector.worth_capturing} />
              </div>
              <p className="text-[10px] text-slate-400 pt-1 leading-relaxed">
                ESPN&apos;s public scoreboard costs nothing and runs every 15 minutes. Paid multi-book
                capture is spent only where it has moved.
              </p>
            </div>
          ) : <p className="text-xs text-slate-500">Reading the budget…</p>}
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

/**
 * What's actually defensible right now, distinct from the model's win-loss
 * record above. Prediction is a settled negative (0 of 21 spread models beat
 * the closing line); these three numbers are properties of the MARKET, not a
 * forecast, so they get their own strip rather than being buried as footnotes.
 */
/**
 * What is actually working right now, read from the same /betting/status the
 * Edge Desk hero uses. This replaced a hand-assembled strip that recomputed the
 * same three facts from a different payload — the surest way for two pages to
 * start disagreeing about the same edge.
 *
 * Each card says plainly whether the edge is live and, when it is not, the one
 * thing it is waiting on.
 */
function LiveEdges({ status }: { status?: HubStatus | null }) {
  if (!status) {
    return (
      <div className="card p-4 mb-4 text-sm text-slate-500">Checking which edges are live…</div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
      {status.edges.map(e => (
        <div key={e.id} className={`card p-4 ${e.live ? 'border-emerald-200' : ''}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${e.live ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{e.label}</h3>
          </div>
          <div className={`text-lg font-black leading-tight ${e.live ? 'text-slate-900' : 'text-slate-400'}`}>
            {e.headline}
          </div>
          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{e.detail}</p>
          {e.blocked_by && (
            <div className="mt-2 text-[10px] font-bold uppercase tracking-wide text-amber-700">
              waiting on {e.blocked_by}
            </div>
          )}
        </div>
      ))}
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
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-[10px] font-semibold text-slate-700">{icon}</span>
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
    <div className={`text-lg font-bold ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-crit' : 'text-slate-800'}`}>
      {value}
    </div>
  </div>
);
