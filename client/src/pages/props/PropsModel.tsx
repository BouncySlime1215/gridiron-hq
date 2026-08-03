import { useApi } from '../../api';
import { formatMarket } from './lib';

interface ModelSummary {
  market: string; selected_model: string; training_rows: number | null; test_rows: number | null;
  training_through: string; test_start: string; brier_score: number | null; log_loss: number | null;
  mae: number | null; rmse: number | null; auc: number | null;
}
interface ModelFactor { category: string; factor: string; plain_language: string; technical_detail: string; }
interface PipelineStatus {
  historical_data_through: string; model_training_through: string; line_feed_status: string;
  last_line_refresh: string; site_data_generated_at: string; sportsbook_name: string; priced_edge_count: string;
}

const PIPELINE_STEPS = [
  { title: 'What happened?', body: "Completed games, box scores, first-inning outcomes, venues, and game-time weather come from MLB's public Stats API." },
  { title: 'What was knowable beforehand?', body: 'Rolling player, opponent, team, starter, and venue features use only games before the target game. Current-game outcomes never enter their own inputs.' },
  { title: 'Does context improve prediction?', body: 'Baseline and context-enhanced models are compared on later dates. Extra factors are selected only when they improve probability performance.' },
  { title: 'What does the market imply?', body: 'FanDuel prices are converted from American odds to probabilities, then normalized across both sides to estimate a no-vig market probability.' },
  { title: 'Is the disagreement useful?', body: 'The board ranks model probability minus market probability. Rows below the research threshold stay off the main board.' }
];

/**
 * Consolidates Diamond Signal's three explainer pages (performance.qmd,
 * results.qmd, data-health.qmd) into one — they're all "about the system"
 * content with no interactivity, and didn't need three separate destinations
 * in a section that's already secondary to the rest of this app.
 */
export default function PropsModel() {
  const { data, loading, error } = useApi<{ summary: ModelSummary[]; factors: ModelFactor[]; status: PipelineStatus | null }>('/props/model');

  if (loading) return <div className="card p-6 text-sm text-slate-500">Loading model info…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-600">{error}</div>;

  const summary = data?.summary ?? [];
  const factors = data?.factors ?? [];
  const status = data?.status;

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">Model Info</h1>
      <p className="text-sm text-slate-500 mb-6">
        What the models know, what they don't, and how fresh the data behind the board actually is.
      </p>

      {status && (
        <section className="mb-8">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Data health</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <HealthCard label="Historical outcomes" value={status.historical_data_through} detail="Latest completed game included in local model inputs." />
            <HealthCard label="Model training" value={status.model_training_through} detail="Latest date included in the training side of chronological evaluation." />
            <HealthCard label="Line feed" value={status.line_feed_status} detail={`Last refresh: ${status.last_line_refresh}`} good />
            <HealthCard label="Site build" value={status.site_data_generated_at} detail="When this data snapshot was generated." />
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="text-sm font-bold text-slate-700 mb-2">Holdout scorecard</h2>
        <p className="text-xs text-slate-500 mb-2">
          Chronological holdout performance — each model is evaluated on games later than its training window,
          closer to the real daily-prediction problem than a random split.
        </p>
        {summary.length === 0 ? (
          <div className="card p-6 text-sm text-slate-500">No model summary available yet.</div>
        ) : (
          <div className="card overflow-hidden overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400">
                <tr>{['Market', 'Selected model', 'Holdout rows', 'Brier', 'Count MAE', 'Training through'].map(h => (
                  <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary.map((m, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-semibold text-slate-800">{formatMarket(m.market)}</td>
                    <td className="px-3 py-2">{m.selected_model}</td>
                    <td className="px-3 py-2 tabular-nums">{m.test_rows?.toLocaleString() ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums" title="Mean squared error of predicted probabilities; lower is better">{m.brier_score?.toFixed(3) ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums" title="Mean absolute error of count predictions; lower is better">{m.mae?.toFixed(2) ?? '—'}</td>
                    <td className="px-3 py-2">{m.training_through}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {factors.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Inputs available before first pitch</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {factors.map((f, i) => (
              <div key={i} className="card p-3" title={f.technical_detail}>
                <div className="text-[10px] font-bold uppercase tracking-wide text-sky-600">{f.category}</div>
                <div className="text-sm font-bold text-slate-800 mt-0.5">{f.factor}</div>
                <p className="text-xs text-slate-500 mt-1">{f.plain_language}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="text-sm font-bold text-slate-700 mb-2">One pipeline, five questions</h2>
        <div className="space-y-2">
          {PIPELINE_STEPS.map((s, i) => (
            <div key={i} className="card p-3 flex gap-3">
              <div className="shrink-0 w-6 h-6 rounded-full bg-sky-100 text-sky-700 text-xs font-black flex items-center justify-center">{i + 1}</div>
              <div>
                <div className="text-sm font-bold text-slate-800">{s.title}</div>
                <p className="text-xs text-slate-500 mt-0.5">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="card p-3 mt-3 border-sky-200 bg-sky-50/40">
          <div className="text-[10px] font-bold uppercase tracking-wide text-sky-700">Illustration only</div>
          <div className="text-sm font-bold text-slate-800 mt-0.5">Model: 58% · Market: 51% · Edge: +7%</div>
          <p className="text-xs text-slate-600 mt-1">
            The model thinks the selected side happens 58 times in 100 similar situations. The no-vig market
            estimate is 51 times in 100. That seven-point difference is a strong signal to investigate — not
            a claim the bet will win.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-bold text-slate-700 mb-2">Limitations</h2>
        <div className="card p-3 text-xs text-slate-600">
          The player models currently use Poisson count distributions, which are interpretable and practical
          but can understate extra game-to-game variance. NRFI discrimination is modest. Prices can move,
          probable pitchers can change, and total-bases props depend on confirmed playing time. Treat the
          board as a research ranking, not a guarantee or staking instruction. Pick tracking on the My Picks
          page is local to this browser only — no stake size, payout, account, or payment information is
          collected.
        </div>
      </section>
    </div>
  );
}

const HealthCard = ({ label, value, detail, good }: { label: string; value: string; detail: string; good?: boolean }) => (
  <div className="card p-3">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-sm font-bold mt-0.5 ${good ? 'text-emerald-700' : 'text-slate-800'}`}>{value}</div>
    <div className="text-[10px] text-slate-400 mt-0.5">{detail}</div>
  </div>
);
