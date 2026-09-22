import { useApi } from '../../api';
import { PageLoading, PageError } from '../PageState';

/**
 * "Does our projection beat the dumb rule?" — the standing start/sit gate (plan item C12).
 *
 * Reads GET /api/gates/start-sit (server/services/gates/start-sit-gate.js), which the
 * weekly start_sit_gate job stores. Every number, every threshold and every sentence of
 * basis comes from that response; nothing here restates a constant. The verdict is shown
 * whichever way it lands, and every week our projection lost is listed, never trimmed.
 */

type Interval = [number, number] | null;

interface WeekRow { season: number; week: number; n: number; win_rate: number | null; points_per_decision: number | null }

interface GateWindow {
  status?: string; reason?: string;
  season?: number; seasons?: number[]; weeks?: [number, number];
  n?: number; pairs?: number; agreement_share?: number | null;
  win_rate?: number | null; points_per_decision?: number | null;
  ci90?: { player?: { points?: Interval; win_rate?: Interval }; week?: { points?: Interval; clusters?: number } };
  mde80?: { points: number | null; win_rate: number | null };
  pair_accuracy?: { policy: number | null; baseline: number | null };
  failing_weeks?: WeekRow[];
}

interface GateResult {
  status: string; reason?: string; stored_at?: string;
  verdict?: string;
  policy?: string; baseline?: string; universe?: string; scoring?: string;
  sign_convention?: string; replay_caveat?: string;
  past?: GateWindow; forward?: GateWindow;
  configuration?: { k_control?: { season: number; target_share_k: number }[] };
}

const VERDICT: Record<string, { label: string; chip: string; say: string }> = {
  beats_dumb: { label: 'Beats the dumb rule', chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    say: 'Our projection picked the better player more often than "start the higher average", in past seasons and this one.' },
  beats_dumb_unconfirmed_forward: { label: 'Beat it before, not yet this season', chip: 'bg-sky-50 text-sky-800 ring-sky-200',
    say: 'Our projection beat "start the higher average" in past seasons, but this season\'s weeks do not confirm it yet.' },
  not_distinguishable: { label: 'No proven edge', chip: 'bg-amber-50 text-amber-900 ring-amber-200',
    say: 'On these weeks our projection cannot be told apart from "start the higher average". Read its calls as no better than that rule.' },
  loses_to_dumb: { label: 'Loses to the dumb rule', chip: 'bg-rose-50 text-rose-800 ring-rose-200',
    say: 'Where they disagreed, "start the higher average" picked the better player more often than our projection did.' },
  no_disagreements: { label: 'Never disagreed', chip: 'bg-slate-100 text-slate-700 ring-slate-200',
    say: 'Our projection and "start the higher average" made the same call on every startable pair, so there is nothing to grade.' },
  instrument_fault: { label: 'Could not grade', chip: 'bg-slate-100 text-slate-700 ring-slate-200',
    say: 'The gate\'s own check failed (a perfect-foresight pick found no edge on these rows), so no verdict was drawn.' },
  not_run: { label: 'Not measured yet', chip: 'bg-slate-100 text-slate-600 ring-slate-200',
    say: 'The weekly gate job has not stored a result yet.' },
};

const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);
const pts = (v: number | null | undefined) =>
  (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);
const range = (ci: Interval | undefined, f: (v: number) => string) => (ci ? `${f(ci[0])} to ${f(ci[1])}` : 'not computable');
const weeksLabel = (w?: [number, number]) => (w ? (w[0] === w[1] ? `week ${w[0]}` : `weeks ${w[0]}-${w[1]}`) : '');

export default function StartSitGate() {
  const { data, loading, error, refetch } = useApi<GateResult>('/gates/start-sit');
  return (
    <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '180ms' }}
      aria-labelledby="gate-heading">
      <h2 id="gate-heading" className="text-sm font-black uppercase tracking-wide text-slate-500">
        Does our projection beat the dumb rule?
      </h2>
      <Body data={data} loading={loading} error={error} onRetry={refetch} />
    </section>
  );
}

function Body({ data, loading, error, onRetry }: {
  data: GateResult | null; loading: boolean; error: string | null; onRetry: () => void;
}) {
  if (loading && !data) return <PageLoading label="Reading the start/sit gate…" />;
  if (error && !data) return <div className="mt-3"><PageError message={error} onRetry={onRetry} /></div>;
  if (!data) return null;
  if (data.status !== 'measured') {
    const v = VERDICT[data.status] ?? VERDICT.not_run;
    return <p className="mt-2 text-sm leading-6 text-slate-600">{data.reason ?? v.say}</p>;
  }

  const v = VERDICT[data.verdict ?? ''] ?? { label: data.verdict ?? '—', chip: 'bg-slate-100 text-slate-700 ring-slate-200', say: '' };
  const past = data.past ?? {};
  const fwd = data.forward ?? {};
  const failing = past.failing_weeks ?? [];
  const passed = data.verdict === 'beats_dumb';

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${v.chip}`}>
          {v.label}
        </span>
        <span className="text-xs text-slate-500">{v.say}</span>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-700">
        In {past.seasons?.join(' and ')} ({weeksLabel(past.weeks)}), our projection and the dumb rule disagreed on{' '}
        <b className="text-slate-950">{past.n ?? 0}</b> of {past.pairs ?? 0} startable pairs. Our pick scored more{' '}
        <b className="text-slate-950">{pct(past.win_rate)}</b> of the time (90% range{' '}
        {range(past.ci90?.player?.win_rate, pct)}), and{' '}
        <b className="text-slate-950">{pts(past.points_per_decision)}</b> points per disagreement (90% range{' '}
        {range(past.ci90?.player?.points, pts)} across players; {range(past.ci90?.week?.points, pts)} across weeks).
      </p>

      <p className="mt-2 text-sm leading-6 text-slate-700">
        {fwd.status
          ? `This season: ${fwd.reason ?? 'not available yet'}.`
          : `This season (${fwd.season}, ${weeksLabel(fwd.weeks)}): ${fwd.n ?? 0} disagreements, `
            + `our pick ${pts(fwd.points_per_decision)} points per disagreement, `
            + `${pct(fwd.win_rate)} won.`}
      </p>

      {!passed && past.mde80 && (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          The smallest edge these weeks could reliably detect is {pts(past.mde80.points)} points per disagreement
          ({pct(past.mde80.win_rate)} of win rate). A smaller real edge would not show up here, so "no proven edge"
          is not the same as "no edge".
        </p>
      )}

      <div className="mt-3">
        <div className="text-[10px] font-black uppercase tracking-wide text-slate-500">
          Weeks our projection lost ({failing.length})
        </div>
        {failing.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">None: our pick outscored the dumb rule's pick in every graded week.</p>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {failing.map(w => (
              <span key={`${w.season}-${w.week}`}
                className="whitespace-nowrap rounded-md bg-rose-50 px-2 py-0.5 font-mono text-[11px] tabular-nums text-rose-800 ring-1 ring-rose-200"
                title={`${w.n} disagreements, ${pct(w.win_rate)} won`}>
                {w.season} W{w.week} {pts(w.points_per_decision)}
              </span>
            ))}
          </div>
        )}
      </div>

      <details className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-4 text-slate-500">
        <summary className="cursor-pointer font-semibold text-slate-600">What was compared</summary>
        <dl className="mt-2 space-y-1.5">
          <div><dt className="inline font-semibold text-slate-600">Ours: </dt><dd className="inline">{data.policy}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Dumb rule: </dt><dd className="inline">{data.baseline}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Which calls: </dt><dd className="inline">{data.universe}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Scoring: </dt><dd className="inline">{data.scoring}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Reading the numbers: </dt><dd className="inline">{data.sign_convention}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Pick accuracy on all pairs: </dt>
            <dd className="inline">ours {pct(past.pair_accuracy?.policy)}, dumb rule {pct(past.pair_accuracy?.baseline)}</dd></div>
          {data.replay_caveat && <div><dt className="inline font-semibold text-slate-600">Limit: </dt><dd className="inline">{data.replay_caveat}</dd></div>}
          {data.stored_at && <div><dt className="inline font-semibold text-slate-600">Measured: </dt><dd className="inline">{data.stored_at} UTC</dd></div>}
        </dl>
      </details>
    </>
  );
}
