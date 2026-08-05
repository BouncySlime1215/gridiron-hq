import type { ReactNode } from 'react';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

const TONE: Record<Tone, string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  bad: 'border-rose-200 bg-white text-rose-700',
  neutral: 'border-slate-200 bg-white text-slate-600',
  info: 'border-blue-200 bg-blue-50/60 text-blue-800'
};

export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-normal ${TONE[tone]}`}>{children}</span>;
}

export function BettingHero({ eyebrow, title, description, status, actions, children }: {
  eyebrow: string; title: string; description: string; status?: ReactNode;
  actions?: ReactNode; children?: ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-black/[0.07] bg-white px-5 py-6 text-slate-950 sm:px-7 sm:py-7">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold tracking-wide text-slate-500">{eyebrow}</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-[40px] sm:leading-[1.08]">{title}</h1>
            {status}
          </div>
          <p className="mt-3 max-w-3xl text-[15px] leading-6 text-slate-600">{description}</p>
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
        {eyebrow && <div className="text-xs font-semibold tracking-wide text-slate-500">{eyebrow}</div>}
        <h2 className="text-xl font-semibold tracking-[-0.025em] text-slate-900">{title}</h2>
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
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
        {icon}<span>{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-semibold tracking-[-0.03em] ${accent}`}>{value}</div>
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
