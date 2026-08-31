import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useApi } from '../../api';

type Stage = 'scan' | 'price' | 'review' | 'track';

interface HubStatus {
  edges: { id: string; label: string; live: boolean; headline: string; detail: string; blocked_by: string | null }[];
  model: {
    calibration_gate: string; calibration_detail: string; sizing_allowed: boolean;
    /** The same result in a sentence, which is what the strip actually shows. */
    calibration_plain?: string; calibration_numbers?: string | null;
  };
  data: {
    credits_remaining: number | null;
    free_detector: { events_tracked: number; moves: number; worth_capturing: number };
    capture_stale: boolean;
  };
}

/** The four steps, named for what you do at each one rather than for its module. */
const stages: { id: Stage; label: string; detail: string }[] = [
  { id: 'scan', label: 'Find', detail: 'Which games moved, and why' },
  { id: 'price', label: 'Price', detail: 'Which book pays the most' },
  { id: 'review', label: 'Check', detail: 'Does it survive the rules' },
  { id: 'track', label: 'Record', detail: 'What the bet actually did' }
];

export function BettingWorkspace({ sport, title, description, activeStage, actions, children }: {
  sport: 'all' | 'nfl' | 'mlb'; title: string; description: string; activeStage: Stage;
  actions?: ReactNode; children: ReactNode;
}) {
  const { data: status } = useApi<HubStatus>('/betting/status');
  const teaser = status?.edges.find(edge => edge.id === 'teasers');
  const evidenceLabel = status?.model.sizing_allowed
    ? 'Model staking eligible'
    : teaser?.live ? 'Execution edge available' : 'Proof collection mode';

  return <div className="mx-auto max-w-[1480px] space-y-4">
    <section className="overflow-hidden rounded-[26px] border border-slate-800 bg-slate-950 text-white shadow-[0_24px_70px_rgba(15,23,42,.18)]">
      <div className="flex items-center gap-1 border-b border-white/10 p-2">
        {[
          ['/betting', 'Command'], ['/betting/nfl', 'NFL'], ['/betting/mlb/auto', 'MLB']
        ].map(([to, label]) => <NavLink key={to} to={to} end={to === '/betting'}
          className={({ isActive }) => `rounded-lg px-3 py-2 text-xs font-black transition ${isActive ? 'bg-white text-slate-950' : 'text-slate-400 hover:bg-white/10 hover:text-white'}`}>{label}</NavLink>)}
        <div className="ml-auto hidden items-center gap-1 lg:flex">{stages.map((stage, index) => <div key={stage.id} className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold ${stage.id === activeStage ? 'bg-emerald-400 text-slate-950' : 'text-slate-500'}`}><span>{index + 1}</span><span>{stage.label}</span></div>)}</div>
      </div>
      <div className="flex flex-col gap-5 px-5 py-6 sm:px-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[.16em] text-emerald-300">
            <span>Gridiron markets</span><span className="text-white/25">/</span><span>{sport === 'all' ? 'Command center' : sport.toUpperCase()}</span>
          </div>
          <h1 className="mt-2 !text-white">{title}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">{description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-slate-100">{evidenceLabel}</span>
          {actions}
        </div>
      </div>

      <div className="grid grid-cols-4 border-t border-white/10 lg:hidden">{stages.map((stage, index) => <div key={stage.id} className={`px-2 py-2 text-center ${stage.id === activeStage ? 'bg-emerald-400/[.1] text-emerald-300' : 'text-slate-500'}`}><div className="text-[10px] font-black">{index + 1} · {stage.label}</div></div>)}</div>
    </section>

    {status && <div className="grid gap-2 sm:grid-cols-3">
      <TruthChip label="Watching for free"
        value={`${status.data.free_detector.events_tracked} games · ${status.data.free_detector.moves} lines moved`}
        detail={status.data.free_detector.worth_capturing > 0
          ? `${status.data.free_detector.worth_capturing} moved enough to be worth spending a price check on`
          : 'Nothing moved enough to be worth spending a price check on'} />
      <TruthChip label="Prices"
        value={status.data.capture_stale ? 'Too old to bet on' : 'Fresh and comparable'}
        detail={`${status.data.credits_remaining ?? '—'} paid price checks left this month`}
        warn={status.data.capture_stale} />
      <TruthChip label="Real money"
        value={status.model.sizing_allowed ? 'Model is cleared to bet' : 'Fake money only'}
        detail={status.model.calibration_plain ?? status.model.calibration_detail}
        warn={!status.model.sizing_allowed} />
    </div>}

    {children}
  </div>;
}

function TruthChip({ label, value, detail, warn = false }: { label: string; value: string; detail: string; warn?: boolean }) {
  return <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
    <div className="text-[10px] font-black uppercase tracking-[.13em] text-slate-400">{label}</div>
    <div className={`mt-1 text-sm font-black ${warn ? 'text-amber-800' : 'text-slate-900'}`}>{value}</div>
    <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{detail}</div>
  </div>;
}

export function WorkspaceNav<T extends string>({ value, onChange, items }: {
  value: T; onChange: (value: T) => void; items: { id: T; label: string; detail: string; count?: ReactNode }[];
}) {
  return <nav aria-label="Workspace sections" className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2 sm:grid-cols-2 lg:grid-cols-4">
    {items.map(item => <button key={item.id} onClick={() => onChange(item.id)} aria-current={value === item.id ? 'page' : undefined}
      className={`rounded-xl px-4 py-3 text-left transition ${value === item.id ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white/70'}`}>
      <div className="flex items-center gap-2"><span className={`text-sm font-black ${value === item.id ? 'text-slate-950' : 'text-slate-600'}`}>{item.label}</span>{item.count != null && <span className="ml-auto text-xs font-bold text-slate-400">{item.count}</span>}</div>
      <div className="mt-0.5 text-xs text-slate-400">{item.detail}</div>
    </button>)}
  </nav>;
}

export function NextAction({ eyebrow, title, detail, to, action, tone = 'dark' }: {
  eyebrow: string; title: string; detail: string; to?: string; action?: () => void; tone?: 'dark' | 'light';
}) {
  const className = tone === 'dark'
    ? 'surface-deep border-slate-900 text-white'
    : 'border-slate-200 bg-white text-slate-950';
  const content = <>
    <div className={`text-[10px] font-black uppercase tracking-[.15em] ${tone === 'dark' ? 'text-emerald-300' : 'text-emerald-700'}`}>{eyebrow}</div>
    <div className="mt-2 text-xl font-black tracking-tight">{title}</div>
    <p className={`mt-1 text-sm leading-5 ${tone === 'dark' ? 'text-slate-300' : 'text-slate-500'}`}>{detail}</p>
    <div className={`mt-4 text-xs font-black ${tone === 'dark' ? 'text-emerald-300' : 'text-emerald-700'}`}>Open workflow →</div>
  </>;
  if (to) return <Link to={to} className={`block rounded-2xl border p-5 transition hover:-translate-y-0.5 hover:shadow-lg ${className}`}>{content}</Link>;
  return <button onClick={action} className={`w-full rounded-2xl border p-5 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${className}`}>{content}</button>;
}
