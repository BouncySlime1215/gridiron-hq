import { useState } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api';
import { useLeague } from '../state/league';

/**
 * The week's lineup, with the closeness of each call made visible.
 *
 * The design problem here is that a start/sit page is mostly a list of names,
 * and a list of names hides the one thing that separates a decision from a coin
 * flip: the margin. So the margin is the visual — a bar per slot showing how far
 * clear the starter is, scaled against the threshold where the gap stops being
 * inside the projection's own error. Two slots with identical names and
 * different bars are immediately different decisions, which is the whole point.
 */

const CONF: Record<string, { label: string; bar: string; chip: string }> = {
  clear: { label: 'Clear', bar: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  lean: { label: 'Lean', bar: 'bg-sky-500', chip: 'bg-sky-50 text-sky-800 ring-sky-200' },
  'coin flip': { label: 'Coin flip', bar: 'bg-amber-400', chip: 'bg-amber-50 text-amber-900 ring-amber-200' },
  'only option': { label: 'Only option', bar: 'bg-slate-300', chip: 'bg-slate-100 text-slate-600 ring-slate-200' }
};

export default function Lineup() {
  const { activeId: leagueId } = useLeague();
  const [objective, setObjective] = useState<'mean' | 'ceiling' | 'floor'>('mean');
  const { data: d, loading, error } = useApi<any>(
    leagueId ? `/trades/${leagueId}/lineup?objective=${objective}` : null);

  if (!leagueId) return <Shell><Empty>Connect a league first.</Empty></Shell>;
  if (error) return <Shell><Empty>{error}</Empty></Shell>;

  return (
    <Shell>
      <header className="tr-rise">
        <div className="text-[11px] font-black uppercase tracking-[.16em] text-emerald-700">This week</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">Who to start</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">
          Every call carries how close it was. Starting an 11.4 over an 11.2 and starting a 16 over a
          6 are the same instruction in most tools and they are not the same decision — the first is
          inside the projection's own error, and it is labelled as a tie here rather than dressed up.
        </p>
      </header>

      {d && (
        <section className="tr-rise surface-deep rounded-2xl p-5" style={{ animationDelay: '50ms' }}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-300">
                Week {d.week} projection
              </div>
              <div className="mt-1 text-4xl font-black tabular-nums text-white">{d.projected_points}</div>
              <p className="mt-1 text-sm text-slate-400">
                {d.coin_flips > 0
                  ? `${d.coin_flips} of these calls are ties inside the model's own error`
                  : 'Every call has a real margin behind it'}
              </p>
            </div>
            <div className="flex flex-wrap gap-1 rounded-xl bg-white/10 p-1">
              {(d.objectives ?? []).map((o: any) => (
                <button key={o.id} onClick={() => setObjective(o.id)}
                  title={o.when}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    objective === o.id ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-white/10'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {d.objectives?.find((o: any) => o.id === objective) && (
            <p className="mt-3 border-t border-white/10 pt-3 text-sm leading-6 text-slate-300">
              {d.objectives.find((o: any) => o.id === objective).when}
            </p>
          )}
        </section>
      )}

      {loading && !d && <Empty>Solving the lineup…</Empty>}

      {d?.warnings?.length > 0 && (
        <section className="tr-rise rounded-2xl border border-amber-200 bg-amber-50/60 p-4" style={{ animationDelay: '80ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-amber-900">Check before kickoff</h2>
          <div className="mt-2 space-y-1">
            {d.warnings.map((w: any, i: number) => (
              <p key={i} className="text-sm leading-6 text-slate-700">
                <b className="text-slate-900">{w.player}</b> ({w.slot}) — {w.issue}.
              </p>
            ))}
          </div>
        </section>
      )}

      <div className="space-y-2">
        {d?.lineup?.map((c: any, i: number) => <Slot key={i} c={c} index={i} />)}
      </div>

      {d?.unavailable?.length > 0 && (
        <details className="tr-rise rounded-xl border border-slate-200 bg-white p-4" style={{ animationDelay: '150ms' }}>
          <summary className="cursor-pointer text-sm font-bold text-slate-700">
            Why {d.unavailable.length} rostered player{d.unavailable.length === 1 ? ' is' : 's are'} not
            being considered
          </summary>
          <div className="mt-2 space-y-1.5">
            {d.unavailable.map((u: any, i: number) => (
              <p key={i} className="text-sm leading-6 text-slate-600">
                <b className="text-slate-900">{u.name}</b> ({u.position}, {u.team_abbr}) — {u.why}
              </p>
            ))}
          </div>
        </details>
      )}

      {d?.bench?.length > 0 && (
        <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '170ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">On the bench</h2>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {d.bench.map((p: any, i: number) => (
              <div key={i} className="flex items-baseline gap-2 text-sm">
                <span className="font-semibold text-slate-800">{p.name}</span>
                <span className="text-xs text-slate-400">{p.position} · {p.team_abbr}</span>
                <span className="ml-auto font-mono text-xs tabular-nums text-slate-600">{p.week_points}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {d?.note && <p className="text-xs leading-5 text-slate-500">{d.note}</p>}
    </Shell>
  );
}

function Slot({ c, index }: { c: any; index: number }) {
  const conf = CONF[c.confidence] ?? CONF.lean;
  // Scaled against the "clear" threshold, so the bar reads as a fraction of a
  // decisive margin rather than as an unanchored number.
  const width = c.margin == null ? 100 : Math.min(100, Math.max(4, (c.margin / 4) * 100));
  return (
    <article className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: `${index * 45}ms` }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="grid h-9 w-12 shrink-0 place-items-center rounded-lg bg-slate-100 text-[11px] font-black text-slate-600">
          {c.slot}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-base font-black text-slate-950">{c.player.name}</span>
            <span className="text-xs text-slate-400">{c.player.position} · {c.player.team_abbr}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${conf.chip}`}>
              {conf.label}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full transition-[width] duration-500 ${conf.bar}`}
                style={{ width: `${width}%` }} />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-slate-500">
              {c.margin == null ? '—' : `+${c.margin}`}
            </span>
          </div>
        </div>
        <span className="shrink-0 font-mono text-lg font-black tabular-nums text-slate-900">
          {c.player.week_points}
        </span>
      </div>

      <p className="mt-2 text-sm leading-6 text-slate-600">{c.why}</p>

      {(c.vegas || c.caution || c.upside) && (
        <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
          {c.vegas && (
            <p className="text-xs leading-5 text-sky-800">
              <b>Betting market:</b> {c.vegas}
            </p>
          )}
          {c.caution && (
            <p className="text-xs leading-5 text-amber-900">
              <b>Running hot:</b> {c.caution}
            </p>
          )}
          {c.upside && (
            <p className="text-xs leading-5 text-emerald-800">
              <b>Due to score:</b> {c.upside}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

const Shell = ({ children }: { children: ReactNode }) =>
  <div className="mx-auto max-w-[1000px] space-y-4">{children}</div>;

const Empty = ({ children }: { children: ReactNode }) =>
  <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm leading-6 text-slate-500">{children}</div>;
