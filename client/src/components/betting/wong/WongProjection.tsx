import { Panel } from './shared';
import { dollars as money, pct, signedUnits } from './format';
import type { WongProjection, WongProjectionBlock, WongProjectionServerBlock } from './types';

/**
 * Season projection.
 *
 * The rule this panel exists to enforce: never show the point estimate alone.
 * The point estimate assumes the measured leg rate is exactly the true rate,
 * which it cannot be — it is an estimate from a finite sample, and the whole
 * difference between a season that works and one that does not lives inside
 * that uncertainty. So the uncertainty band is the headline, drawn larger and
 * first, and the point estimate sits beside it labelled for what it assumes.
 */
export function WongProjectionPanel({ projection, unitSizeDollars }: {
  projection: WongProjection | null | undefined; unitSizeDollars: number | null;
}) {
  // The server reports each statistic as `{ units, dollars }` and names the
  // optimistic block `optimistic_ignores_rate_uncertainty`, which is a better
  // name than `point_estimate` because it says what the assumption costs. This
  // component was written against a flat `{ mean: number }` and the other name,
  // so every figure rendered as an em dash while the probability beside it —
  // the one field that happens to be a bare number — rendered fine. A contract
  // mismatch that looks like missing data rather than an error.
  const uncertain = splitUnits(projection?.with_rate_uncertainty);
  const point = splitUnits(projection?.optimistic_ignores_rate_uncertainty ?? projection?.point_estimate);
  const dollarBlock = projection?.dollars ?? null;
  const uncertainDollars = uncertain.dollars ?? dollarBlock?.with_rate_uncertainty ?? stripNested(dollarBlock);
  const pointDollars = point.dollars ?? dollarBlock?.point_estimate ?? null;

  if (!uncertain.units && !point.units) {
    return <Panel title="Season projection" description="Where this season lands if you keep taking the qualifying tickets.">
      <div className="p-5 text-sm text-slate-500">
        No projection yet. It needs a settled sample to project from — take and settle some tickets first.
      </div>
    </Panel>;
  }

  return <Panel
    eyebrow="Both versions, never just the flattering one"
    title="Season projection"
    description="Where the season lands if you keep taking the qualifying tickets at your current stake."
    footer={<>
      The point estimate treats the measured historical leg rate as exactly correct. It is not — it is an
      estimate from a finite sample, and the honest band is the wider one on the left. Read that one.
    </>}
  >
    <div className="grid gap-px bg-slate-100 lg:grid-cols-2">
      <ProjectionColumn
        headline
        title="With rate uncertainty"
        note="Carries the error bar on the leg rate itself. This is the number to plan around."
        block={uncertain.units ?? point.units}
        dollarsBlock={uncertainDollars ?? (uncertain.units ? null : pointDollars)}
        unitSizeDollars={unitSizeDollars}
      />
      <ProjectionColumn
        title="Point estimate"
        note="Assumes the measured leg rate is exactly the true rate. Optimistically narrow."
        block={point.units}
        dollarsBlock={pointDollars}
        unitSizeDollars={unitSizeDollars}
      />
    </div>
  </Panel>;
}

function ProjectionColumn({ title, note, block, dollarsBlock, unitSizeDollars, headline = false }: {
  title: string; note: string; block: WongProjectionBlock | null;
  dollarsBlock: WongProjectionBlock | null; unitSizeDollars: number | null; headline?: boolean;
}) {
  if (!block) return <div className="bg-white p-5">
    <ColumnHeading title={title} note={note} headline={headline} />
    <p className="mt-3 text-sm text-slate-400">Not returned by the server.</p>
  </div>;

  const inDollars = (key: keyof WongProjectionBlock) => {
    const direct = dollarsBlock?.[key];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const units = block[key];
    if (unitSizeDollars != null && typeof units === 'number' && Number.isFinite(units)) return units * unitSizeDollars;
    return null;
  };

  const rows: { key: keyof WongProjectionBlock; label: string; hint: string }[] = [
    { key: 'mean', label: 'Mean', hint: 'Average across every simulated season' },
    { key: 'median', label: 'Median', hint: 'The middle season — half land above, half below' },
    { key: 'p95', label: 'Best case', hint: '95th percentile: better than this one season in twenty' },
    { key: 'p05', label: 'Worst case', hint: '5th percentile: worse than this one season in twenty' }
  ];
  const losing = block.probability_of_losing_season;

  return <div className={`p-5 ${headline ? 'bg-white' : 'bg-slate-50/60'}`}>
    <ColumnHeading title={title} note={note} headline={headline} />
    <RangeBar block={block} />
    <dl className="mt-4 space-y-2">
      {rows.map(row => {
        const units = block[row.key];
        const cash = inDollars(row.key);
        const tone = typeof units === 'number' ? (units > 0 ? 'text-emerald-700' : units < 0 ? 'text-rose-700' : 'text-slate-700') : 'text-slate-400';
        return <div key={row.key} className="flex items-baseline gap-3 border-b border-slate-100 pb-2 last:border-0">
          <dt className="w-24 shrink-0 text-xs font-bold text-slate-500" title={row.hint}>{row.label}</dt>
          <dd className="flex flex-1 items-baseline justify-between gap-3">
            <span className={`font-black tabular-nums ${headline ? 'text-xl' : 'text-base'} ${tone}`}>
              {signedUnits(typeof units === 'number' ? units : null)}
            </span>
            <span className="text-xs font-bold tabular-nums text-slate-500">{cash == null ? '—' : money(cash)}</span>
          </dd>
        </div>;
      })}
    </dl>
    <div className={`mt-3 rounded-lg border p-3 ${losing != null && losing >= 0.35
      ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <div className="text-[10px] font-black uppercase tracking-[.12em] text-slate-400">Chance of a losing season</div>
      <div className={`mt-0.5 font-black tabular-nums ${headline ? 'text-2xl' : 'text-lg'} ${losing != null && losing >= 0.35 ? 'text-amber-800' : 'text-slate-900'}`}>
        {pct(losing, 1)}
      </div>
    </div>
  </div>;
}

/**
 * Flatten `{ mean: { units, dollars } }` into the two flat blocks this
 * component renders, tolerating a server that already sends flat numbers.
 */
function splitUnits(block: WongProjectionServerBlock | null | undefined):
{ units: WongProjectionBlock | null; dollars: WongProjectionBlock | null } {
  if (!block) return { units: null, dollars: null };
  const units: WongProjectionBlock = {};
  const dollars: WongProjectionBlock = {};
  let sawNested = false;
  for (const key of ['mean', 'median', 'p05', 'p95'] as const) {
    const value = block[key];
    if (value && typeof value === 'object') {
      sawNested = true;
      if (typeof value.units === 'number') units[key] = value.units;
      if (typeof value.dollars === 'number') dollars[key] = value.dollars;
    } else if (typeof value === 'number') {
      units[key] = value;
    }
  }
  units.probability_of_losing_season = block.probability_of_losing_season ?? null;
  return { units, dollars: sawNested ? dollars : null };
}

function ColumnHeading({ title, note, headline }: { title: string; note: string; headline: boolean }) {
  return <div>
    <div className="flex flex-wrap items-center gap-2">
      <h3 className={`font-black tracking-[-0.02em] ${headline ? 'text-base text-slate-900' : 'text-sm text-slate-600'}`}>{title}</h3>
      {headline && <span className="rounded-full bg-slate-950 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-white">read this one</span>}
    </div>
    <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{note}</p>
  </div>;
}

/** p05 to p95 with the mean marked, so the spread is a shape and not four numbers. */
function RangeBar({ block }: { block: WongProjectionBlock }) {
  const low = block.p05, high = block.p95, mean = block.mean;
  if (typeof low !== 'number' || typeof high !== 'number' || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
  const span = high - low;
  const pad = span * 0.12;
  const min = Math.min(low, 0) - pad, max = Math.max(high, 0) + pad;
  const at = (value: number) => ((value - min) / (max - min)) * 100;

  return <div className="mt-4">
    <div className="relative h-8">
      <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-slate-100" />
      <div className="absolute top-3 h-2 rounded-full"
        style={{ left: `${at(low)}%`, width: `${at(high) - at(low)}%`, background: 'linear-gradient(90deg,#fca5a5,#fcd34d,#6ee7b7)' }} />
      {max > 0 && min < 0 && <div className="absolute top-1 h-6 w-px bg-slate-400" style={{ left: `${at(0)}%` }} title="Break even" />}
      {typeof mean === 'number' && Number.isFinite(mean) && <div
        className="absolute top-1.5 h-5 w-1 rounded-full bg-slate-900" style={{ left: `${at(mean)}%` }} title={`Mean ${signedUnits(mean)}`} />}
    </div>
    <div className="flex justify-between text-[10px] font-bold tabular-nums text-slate-400">
      <span>{signedUnits(low)} worst</span>
      {min < 0 && max > 0 && <span className="text-slate-400">break even</span>}
      <span>{signedUnits(high)} best</span>
    </div>
  </div>;
}

/** `dollars` may itself be a block; drop the nested keys before using it as one. */
function stripNested(block: WongProjection['dollars']): WongProjectionBlock | null {
  if (!block) return null;
  const { point_estimate, with_rate_uncertainty, ...rest } = block;
  void point_estimate; void with_rate_uncertainty;
  return Object.values(rest).some(value => typeof value === 'number') ? rest : null;
}
