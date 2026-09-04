import { useApi } from '../../api';
import { NOT_PROVEN_MESSAGE } from './copy';
import { usePageExplain } from '../../components/betting/PageExplainContext';

/**
 * Why staking is blocked, condition by condition.
 *
 * This page exists because "blocked from sizing" is a useless thing to read
 * without the reason attached, and because two of the three conditions that
 * used to fail here were measurement artifacts rather than findings. A gate
 * that rejects on noise is worse than no gate: it hides the one real problem
 * behind two fake ones.
 *
 * The blend sweep at the bottom is the decisive panel. The calibration model is
 * anchored to the market, so at infinite shrinkage it IS the closing line —
 * which means the sweep brackets the entire space of "how much should we trust
 * our model over the book". If nothing in that range beats the market, no
 * staking policy can manufacture an edge, and there is no point looking for one
 * in the sizing layer.
 */

interface Metrics {
  walk_forward_n: number;
  walk_forward_calibrated_brier: number; walk_forward_market_brier: number;
  walk_forward_calibrated_log_loss: number; walk_forward_market_log_loss: number;
  walk_forward_calibration_intercept: number;
  walk_forward_calibration_slope: number;
  walk_forward_calibration_slope_se: number | null;
  walk_forward_calibration_slope_estimable: boolean | null;
  walk_forward_edge_slope: number | null;
  walk_forward_edge_slope_se: number | null;
  walk_forward_edge_slope_z: number | null;
  walk_forward_edge_predicts_covers: boolean | null;
  walk_forward_expected_calibration_error: number;
  forward_gate_passed: boolean;
  selected_lambda: number; lambda_reason: string;
  lambda_by_season: { season: number; lambda: number }[];
  blend_sweep: { lambda: number; blend_brier: number; market_brier: number;
    difference: number; beats_market: boolean }[];
  any_lambda_beats_market: boolean;
  blend_verdict: string;
}
interface Cal {
  calibration: {
    model_version: string; trained_from: number; trained_through: number;
    sample_size: number; created_at: string; metrics: Metrics;
  } | null;
}

const num = (v: number | null | undefined, d = 4) =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);

export default function Gates() {
  const { data, loading } = useApi<Cal>('/nfl-betting/calibration/cover');
  const cal = data?.calibration;
  const m = cal?.metrics;

  // Small, honest summary — must run before any early return so hook order
  // never changes between renders.
  usePageExplain('engine', 'gates', {
    calibration_stored: !!cal, forward_gate_passed: m?.forward_gate_passed ?? null,
    walk_forward_n: m?.walk_forward_n ?? null
  });

  if (loading) return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading calibration…</div>;
  if (!cal || !m) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-base font-semibold text-slate-900">No calibration stored</h2>
        <p className="mt-1 text-sm text-slate-600">
          Run a calibration build before staking can evaluate anything.
        </p>
      </div>
    );
  }

  const checks = [
    { name: 'Walk-forward sample', value: String(m.walk_forward_n), need: '≥ 200',
      pass: m.walk_forward_n >= 200,
      why: 'Enough graded bets for any of the rest to mean anything.' },
    { name: 'Brier vs market', value: `${num(m.walk_forward_calibrated_brier)} vs ${num(m.walk_forward_market_brier)}`,
      need: 'not worse', pass: m.walk_forward_calibrated_brier <= m.walk_forward_market_brier,
      why: 'The blend is anchored to the closing line, so it should never be worse than it. When it was, the cause was an untuned shrinkage constant fitting noise.' },
    { name: 'Log-loss vs market', value: `${num(m.walk_forward_calibrated_log_loss)} vs ${num(m.walk_forward_market_log_loss)}`,
      need: 'not worse', pass: m.walk_forward_calibrated_log_loss <= m.walk_forward_market_log_loss,
      why: 'Same test, more sensitive to confident mistakes.' },
    { name: 'Calibration intercept', value: num(m.walk_forward_calibration_intercept),
      need: '|x| ≤ 0.2', pass: Math.abs(m.walk_forward_calibration_intercept ?? 99) <= 0.2,
      why: 'No systematic bias toward one side of the number.' },
    { name: 'Edge predicts covers', value: `b = ${num(m.walk_forward_edge_slope)}, z = ${num(m.walk_forward_edge_slope_z, 2)}`,
      need: 'z > 1.96', pass: m.walk_forward_edge_predicts_covers === true,
      why: 'The one that matters: do bigger claimed edges actually win more often? Measured on the edge scale, where the predictor has real variance and the estimate is roughly five times more precise than on the probability scale.' },
    { name: 'Expected calibration error', value: num(m.walk_forward_expected_calibration_error),
      need: '≤ 0.05', pass: (m.walk_forward_expected_calibration_error ?? 99) <= 0.05,
      why: 'Stated probabilities match observed frequencies bucket by bucket.' }
  ];
  const failing = checks.filter(c => !c.pass);

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-5 ${m.forward_gate_passed
        ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${
            m.forward_gate_passed ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-white'}`}>
            {m.forward_gate_passed ? 'Model staking eligible' : 'Model staking is off'}
          </span>
          <span className="text-sm text-slate-700">
            {checks.length - failing.length} of {checks.length} conditions pass
          </span>
        </div>
        {!m.forward_gate_passed && <p className="mt-2 text-sm font-medium text-slate-900">{NOT_PROVEN_MESSAGE}</p>}
        <p className="mt-3 text-sm text-slate-800">
          {m.forward_gate_passed
            ? 'Every calibration condition is satisfied. Staking will size model-derived edges.'
            : failing.length === 1
              ? `Why it is off: ${failing[0].name.toLowerCase()} failed. ${failing[0].why}`
              : `Why it is off: ${failing.map(check => check.name.toLowerCase()).join(', ')} failed.`}
        </p>
        {!m.forward_gate_passed && <p className="mt-2 rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-sm text-amber-950">
          The fix is new forward evidence that larger claimed edges win more often—not bypassing the gate. Until then, use Profit for the model-free teaser workflow and keep these forecasts on paper.
        </p>}
        <p className="mt-2 text-xs text-slate-600">
          Model {cal.model_version} · trained {cal.trained_from}–{cal.trained_through} ·
          {' '}{cal.sample_size.toLocaleString()} priced covers · walk-forward and cutoff-safe.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">Every condition</h3>
        <div className="mt-3 space-y-3">
          {checks.map(c => (
            <div key={c.name} className="border-t border-slate-100 pt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">{c.name}</span>
                <span className="flex items-center gap-3">
                  <span className="font-mono text-sm tabular-nums text-slate-700">{c.value}</span>
                  <span className="font-mono text-xs text-slate-400">{c.need}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    c.pass ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                    {c.pass ? 'pass' : 'fail'}
                  </span>
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{c.why}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">A test that was rejecting on noise</h3>
        <p className="mt-1 text-sm text-slate-600">
          This gate used to require the probability-scale calibration slope to land in [0.7, 1.3].
          On a spread market that cannot work. A spread is set so both sides are 50/50, so the
          no-vig probability barely moves, and the slope estimated against it carries a standard
          error wider than the window it is judged against.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Cell label="Slope estimate" value={num(m.walk_forward_calibration_slope, 3)} />
          <Cell label="Standard error" value={num(m.walk_forward_calibration_slope_se, 3)}
            tone={m.walk_forward_calibration_slope_estimable ? undefined : 'warn'} />
          <Cell label="Usable?" value={m.walk_forward_calibration_slope_estimable ? 'yes' : 'no — not applied'}
            tone={m.walk_forward_calibration_slope_estimable ? undefined : 'warn'} />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          A perfectly calibrated model cleared that window roughly a quarter of the time, at random.
          The slope is now only judged when the estimate is precise enough to judge, and the same
          question is asked on the edge scale instead — see “Edge predicts covers” above.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">How much should we trust the model?</h3>
        <p className="mt-1 text-sm text-slate-600">
          The blend is anchored to the market, so at infinite shrinkage it <em>is</em> the closing
          line. This sweep therefore brackets the whole space between “trust our model” and “just
          take the market”, measured out of sample.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="py-1 text-left">Shrinkage</th>
                <th className="text-right">Blend Brier</th>
                <th className="text-right">Market Brier</th>
                <th className="text-right">Difference</th>
                <th className="text-right">Result</th>
              </tr>
            </thead>
            <tbody>
              {(m.blend_sweep ?? []).map(g => (
                <tr key={g.lambda} className={`border-t border-slate-100 ${
                  g.lambda === m.selected_lambda ? 'bg-sky-50' : ''}`}>
                  <td className="py-1.5 font-mono tabular-nums text-slate-700">
                    λ = {g.lambda.toLocaleString()}
                    {g.lambda === m.selected_lambda && <span className="ml-2 text-[10px] uppercase text-sky-700">selected</span>}
                  </td>
                  <td className="text-right font-mono tabular-nums text-slate-900">{num(g.blend_brier)}</td>
                  <td className="text-right font-mono tabular-nums text-slate-500">{num(g.market_brier)}</td>
                  <td className="text-right font-mono tabular-nums text-slate-500">
                    {g.difference >= 0 ? '+' : ''}{g.difference.toFixed(6)}
                  </td>
                  <td className={`text-right text-xs font-medium ${g.beats_market ? 'text-emerald-700' : 'text-slate-400'}`}>
                    {g.beats_market ? 'beats market' : 'worse'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${m.any_lambda_beats_market
          ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}>
          {m.blend_verdict}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Shrinkage is chosen by cross-validation inside the training seasons, with the
          one-standard-error rule breaking ties toward the market. Per season:{' '}
          {(m.lambda_by_season ?? []).map(x => `${x.season}: λ=${x.lambda.toLocaleString()}`).join(' · ')}
        </p>
      </div>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === 'warn'
      ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 font-mono text-lg tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
