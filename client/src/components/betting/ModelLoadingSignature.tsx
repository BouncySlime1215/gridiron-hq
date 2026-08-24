import { useEffect, useState } from 'react';

const DEFAULT_STAGES = ['Connecting to the evidence ledger', 'Checking cutoff-safe inputs', 'Rendering the model view'];

/** A truthful loading state: it communicates work without implying a prediction is ready. */
export function ModelLoadingSignature({ sport, stages = DEFAULT_STAGES, compact = false, title }: {
  sport: 'NFL' | 'MLB'; stages?: string[]; compact?: boolean; title?: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 100) / 10), 100);
    return () => window.clearInterval(timer);
  }, []);
  const active = Math.min(stages.length - 1, Math.floor(elapsed / 0.7));
  return <div className={`card overflow-hidden ${compact ? 'p-4' : 'p-6'}`} role="status" aria-live="polite">
    <div className="flex items-center gap-3">
      <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-sky-50 ring-1 ring-sky-100">
        <span className="absolute h-5 w-5 animate-ping rounded-full bg-sky-300/40" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-sky-600" />
      </div>
      <div className="min-w-0 flex-1"><div className="text-sm font-black text-slate-900">{title ?? `Preparing ${sport} model intelligence`}</div><div className="mt-0.5 text-xs text-slate-500">{title ? 'Loading saved research view' : 'Evidence-first load'} · {elapsed.toFixed(1)}s</div></div>
      <div className="text-[10px] font-bold uppercase tracking-[.16em] text-sky-700">Live</div>
    </div>
    <div className="mt-5 grid gap-2 sm:grid-cols-3">{stages.map((stage, i) => <div key={stage} className={`rounded-xl border px-3 py-2 text-xs transition-colors ${i < active ? 'border-sky-100 bg-sky-50 text-sky-800' : i === active ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-slate-100 bg-slate-50 text-slate-400'}`}>
      <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-current" />{stage}
    </div>)}</div>
  </div>;
}
