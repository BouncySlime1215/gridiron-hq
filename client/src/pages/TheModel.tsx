import { useState } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api';

/**
 * Everything the platform believes, and what it is allowed to do about it.
 *
 * This is the page that answers "so does any of this work". The design job is to
 * make the distribution legible at a glance — two capabilities may size a
 * decision, ten may only inform one, three are retired on a failed audit — and
 * then let someone drill into the evidence behind any single row.
 *
 * Authority is the organising principle rather than domain, deliberately. Sorted
 * by fantasy-versus-betting it reads as a feature list; sorted by what each
 * component has earned, it reads as an argument, which is what it is.
 */

type Authority = 'authoritative' | 'advisory' | 'research' | 'retired';

const TIER: Record<Authority, {
  label: string; blurb: string; ring: string; chip: string; dot: string; order: number;
}> = {
  authoritative: {
    label: 'Can move money', order: 0,
    blurb: 'Measured positive against real outcomes on a sample large enough to mean something.',
    ring: 'border-emerald-300', chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200', dot: 'bg-emerald-500'
  },
  advisory: {
    label: 'Can inform, cannot size', order: 1,
    blurb: 'The method is sound and the inputs are honest. Nothing has shown it beats a market.',
    ring: 'border-sky-200', chip: 'bg-sky-50 text-sky-800 ring-sky-200', dot: 'bg-sky-500'
  },
  research: {
    label: 'Look, do not act', order: 2,
    blurb: 'Unvalidated. Visible for inspection; routing a decision through it is not allowed.',
    ring: 'border-slate-200', chip: 'bg-slate-100 text-slate-700 ring-slate-200', dot: 'bg-slate-400'
  },
  retired: {
    label: 'Measured dead', order: 3,
    blurb: 'Failed a sealed audit. Kept so the failure is on the record and nobody rebuilds it.',
    ring: 'border-rose-200', chip: 'bg-rose-50 text-rose-800 ring-rose-200', dot: 'bg-rose-500'
  }
};

export default function TheModel() {
  const { data: state } = useApi<any>('/model/state');
  const { data: map } = useApi<any>('/model/map');
  const { data: heads } = useApi<any>('/model/heads');

  const grouped = (map?.capabilities ?? []).slice().sort(
    (a: any, b: any) => (TIER[a.authority as Authority]?.order ?? 9) - (TIER[b.authority as Authority]?.order ?? 9)
  );
  const tiers = (Object.keys(TIER) as Authority[])
    .map(t => ({ t, items: grouped.filter((c: any) => c.authority === t) }))
    .filter(g => g.items.length);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <header className="tr-rise">
        <div className="text-[11px] font-black uppercase tracking-[.16em] text-emerald-700">One model</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">
          What this platform is allowed to believe
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">
          Every component that produces an opinion, with the sealed audit behind it and what that
          evidence permits it to do. Authority is read from the audit registry when this page loads,
          not written down here — so it cannot claim something passed when the record says it failed.
        </p>
      </header>

      {state && (
        <section className="tr-rise surface-deep rounded-2xl p-5" style={{ animationDelay: '50ms' }}>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-300">
                The distribution
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{state.summary}</p>
            </div>
            <div className="flex gap-px overflow-hidden rounded-xl bg-white/10">
              {(['authoritative', 'advisory', 'retired'] as Authority[]).map(t => (
                <div key={t} className="bg-slate-900/80 px-4 py-3 text-center">
                  <div className="text-2xl font-black tabular-nums text-white">
                    {state.counts?.[t] ?? 0}
                  </div>
                  <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    {t === 'authoritative' ? 'proven' : t === 'advisory' ? 'unproven' : 'dead'}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {state.why_not_one_number && (
            <p className="mt-4 border-t border-white/10 pt-3 text-sm leading-6 text-slate-400">
              <b className="text-slate-200">Why this is not a single number: </b>
              {state.why_not_one_number}
            </p>
          )}
        </section>
      )}

      {tiers.map(({ t, items }, gi) => (
        <section key={t} className="tr-rise" style={{ animationDelay: `${80 + gi * 40}ms` }}>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
            <h2 className="text-lg font-black tracking-tight text-slate-950">{TIER[t].label}</h2>
            <span className="text-xs text-slate-400">{items.length}</span>
          </div>
          <p className="mb-3 max-w-3xl text-sm leading-6 text-slate-500">{TIER[t].blurb}</p>
          <div className="space-y-2">
            {items.map((c: any, i: number) => <Capability key={c.id} c={c} index={i} />)}
          </div>
        </section>
      ))}

      {heads && !heads.error && <Heads h={heads} />}
    </div>
  );
}

function Capability({ c, index }: { c: any; index: number }) {
  const [open, setOpen] = useState(false);
  const tier = TIER[c.authority as Authority] ?? TIER.research;
  return (
    <article className={`tr-rise overflow-hidden rounded-2xl border bg-white ${tier.ring}`}
      style={{ animationDelay: `${index * 35}ms` }}>
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-start gap-3 p-4 text-left hover:bg-slate-50">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${tier.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-black text-slate-900">{c.question}</span>
            <span className="font-mono text-[11px] text-slate-400">{c.id}</span>
          </div>
          <div className="mt-1 text-xs leading-5 text-slate-500">{c.why}</div>
        </div>
        {c.audit && (
          <span className={`hidden shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 sm:inline ${tier.chip}`}>
            audit #{c.audit.id}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Fact label="Module" value={c.module} mono />
            <Fact label="May" value={c.may?.length ? c.may.join(', ') : 'nothing'} />
          </div>
          {c.audit && (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">
                Sealed audit #{c.audit.id}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-4 font-mono text-sm tabular-nums">
                <span className={c.audit.passed ? 'font-bold text-emerald-700' : 'font-bold text-rose-700'}>
                  {c.audit.observed}
                </span>
                <span className="text-slate-400">
                  needs {c.audit.direction === 'above' ? '>' : '<'} {c.audit.threshold}
                </span>
                {c.audit.sample_size != null && <span className="text-slate-400">n = {c.audit.sample_size}</span>}
                <span className={`text-xs font-bold ${c.audit.passed ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {c.audit.passed ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-slate-500">{c.audit.name}</p>
            </div>
          )}
          {c.note && <p className="text-sm leading-6 text-slate-700">{c.note}</p>}
          {c.refuses && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="text-[10px] font-black uppercase tracking-wide text-amber-900">Refuses</div>
              <p className="mt-1 text-sm leading-6 text-slate-700">{c.refuses}</p>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-sm text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

/**
 * The projection tournament, drawn as a bar per head.
 *
 * Error is the whole story here and it is a small range — 6.47 to 8.98 — so a
 * bar anchored at zero would compress every difference into invisibility. These
 * are scaled across the observed range instead, with the survivor marked, which
 * is the honest way to draw a narrow spread.
 */
function Heads({ h }: { h: any }) {
  const rmses = h.heads.map((x: any) => x.rmse);
  const lo = Math.min(...rmses), hi = Math.max(...rmses);
  return (
    <section className="tr-rise" style={{ animationDelay: '260ms' }}>
      <h2 className="text-lg font-black tracking-tight text-slate-950">Inside the fantasy projection</h2>
      <p className="mt-0.5 max-w-3xl text-sm leading-6 text-slate-500">
        {h.candidates_tested} candidate forecasters run against a held-out season,
        {' '}{h.candidates_redundant} discarded as duplicates of each other, Holm-corrected across
        the rest. {h.survivors.length === 1 ? 'One survived.' : `${h.survivors.length} survived.`}
      </p>
      <div className="mt-3 space-y-1.5 rounded-2xl border border-slate-200 bg-white p-4">
        {h.heads.slice(0, 12).map((x: any) => {
          const pct = hi > lo ? ((x.rmse - lo) / (hi - lo)) * 100 : 0;
          return (
            <div key={x.id} className="flex items-center gap-3">
              <span className={`w-48 shrink-0 truncate text-xs ${x.survived ? 'font-black text-slate-900' : 'text-slate-500'}`}>
                {x.name ?? x.id}
              </span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${x.survived ? 'bg-emerald-600' : 'bg-slate-300'}`}
                  style={{ width: `${Math.max(3, 100 - pct)}%` }} />
              </div>
              <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-slate-600">
                {x.rmse?.toFixed(2)}
              </span>
              {x.survived && (
                <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800 ring-1 ring-emerald-200">
                  survivor
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        Lower is better; bars are scaled across the observed range because the spread is narrow and
        a zero-anchored chart would hide every difference. {h.caveat}
      </p>
    </section>
  );
}
