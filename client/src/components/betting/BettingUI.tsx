import type { ReactNode } from 'react';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

const TONE: Record<Tone, string> = {
  good: 'border-slate-300 bg-slate-100 text-slate-900',
  warn: 'border-slate-300 bg-white text-slate-700',
  bad: 'border-rose-200 bg-white text-rose-700',
  neutral: 'border-slate-200 bg-white text-slate-600',
  info: 'border-blue-200 bg-blue-50/60 text-blue-800'
};

export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold ${TONE[tone]}`}>{children}</span>;
}

export function BettingHero({ eyebrow, title, description, status, actions, children }: {
  eyebrow: string; title: string; description: string; status?: ReactNode;
  actions?: ReactNode; children?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-5 text-slate-950 shadow-sm sm:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">{eyebrow}</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{title}</h1>
            {status}
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
          {children && <div className="mt-4 flex flex-wrap gap-2">{children}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}

export function SectionHeading({ eyebrow, title, description, action }: {
  eyebrow?: string; title: string; description?: string; action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{eyebrow}</div>}
        <h2 className="text-lg font-black tracking-tight text-slate-900">{title}</h2>
        {description && <p className="mt-0.5 max-w-3xl text-sm leading-5 text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function SignalCard({ label, value, detail, tone = 'neutral', icon }: {
  label: string; value: ReactNode; detail?: ReactNode; tone?: Tone; icon?: ReactNode;
}) {
  const accent = tone === 'bad' ? 'text-rose-700' : tone === 'info' ? 'text-blue-700' : 'text-slate-900';
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-slate-400">
        {icon}<span>{label}</span>
      </div>
      <div className={`mt-1 text-xl font-black tracking-tight ${accent}`}>{value}</div>
      {detail && <div className="mt-1 text-sm leading-5 text-slate-500">{detail}</div>}
    </div>
  );
}

export function Notice({ title, children, tone = 'neutral' }: {
  title: string; children: ReactNode; tone?: Tone;
}) {
  return (
    <div className={`rounded-xl border p-4 ${TONE[tone]}`}>
      <div className="text-sm font-black">{title}</div>
      <div className="mt-1 text-sm leading-5 opacity-80">{children}</div>
    </div>
  );
}

export function EmptyState({ title, description, action }: {
  title: string; description: string; action?: ReactNode;
}) {
  return (
    <div className="card grid min-h-40 place-items-center p-6 text-center">
      <div className="max-w-lg">
        <div className="text-base font-black text-slate-800">{title}</div>
        <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
