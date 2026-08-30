import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';

/**
 * What changed lately, and what to do about it.
 *
 * The page is built around one honest constraint that shapes every design
 * decision on it: most weeks, almost nothing has changed by more than noise. The
 * upstream statistics deliberately return a short list, and a layout that needs
 * twenty cards to look finished would push the page back toward inventing
 * content. So the hierarchy is: what is NEW (rare, and the only thing that is
 * actually an edge), what you can DO about it, and only then the full picture.
 *
 * The sparklines are not decoration. A trend shown as two averages hides the
 * shape that decides whether to believe it — a steady climb and one enormous
 * outlier produce identical means — so every claim is drawn with the weeks it
 * was computed from, with the recent window highlighted against the baseline.
 */

type Kind = 'sell' | 'claim' | 'hold' | 'avoid';

const KIND: Record<Kind, { label: string; ring: string; chip: string; dot: string }> = {
  sell: { label: 'Sell now', ring: 'ring-rose-200', chip: 'bg-rose-50 text-rose-800', dot: 'bg-rose-500' },
  claim: { label: 'Claim him', ring: 'ring-emerald-200', chip: 'bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500' },
  hold: { label: 'Hold', ring: 'ring-sky-200', chip: 'bg-sky-50 text-sky-800', dot: 'bg-sky-500' },
  avoid: { label: 'Do not buy', ring: 'ring-amber-200', chip: 'bg-amber-50 text-amber-900', dot: 'bg-amber-500' }
};

export default function Trends() {
  const { activeId: leagueId } = useLeague();
  const [lookback, setLookback] = useState(3);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<any>(null);
  const exploits = useApi<any>(leagueId ? `/trades/${leagueId}/trends?lookback=${lookback}` : null);
  const watch = useApi<any>(`/trades/trends/watch?lookback=${lookback}`);
  const regression = useApi<any>(leagueId ? `/trades/${leagueId}/regression` : null);

  const runScan = async () => {
    setScanning(true);
    try {
      const r = await api<any>('/trades/trends/scan', {
        method: 'POST', body: JSON.stringify({ lookback })
      });
      setScan(r);
      watch.refetch();
      exploits.refetch();
    } finally { setScanning(false); }
  };

  const d = exploits.data;
  const fresh = scan?.new ?? [];

  if (!leagueId) return <Shell><Empty>Connect a league first.</Empty></Shell>;

  return (
    <Shell>
      <header className="tr-rise">
        <div className="text-[11px] font-black uppercase tracking-[.16em] text-emerald-700">Week over week</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">What changed, and how to use it</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">
          Fifteen metrics per team, tested against that team's own earlier weeks and corrected for
          testing fifteen of them. Most weeks that leaves a handful of claims — which is the point.
          A page that always has something exciting to say is the same page whether or not anything
          happened.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            {[2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setLookback(n)}
                className={`rounded-md px-2.5 py-1 text-xs font-bold transition ${
                  lookback === n ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                {n} games
              </button>
            ))}
          </div>
          <button onClick={runScan} disabled={scanning}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50">
            {scanning ? 'Sweeping…' : 'Sweep the league'}
          </button>
          {d?.reading_from && (
            <span className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-bold text-sky-800 ring-1 ring-sky-200">
              Reading {d.reading_from}
            </span>
          )}
        </div>
      </header>

      {scanning && <Sweeping lookback={lookback} />}

      {/* Newly emerged trends: the only ones that are still an edge. */}
      {!scanning && fresh.length > 0 && (
        <section className="tr-rise surface-deep overflow-hidden rounded-2xl" style={{ animationDelay: '60ms' }}>
          <div className="flex flex-wrap items-center gap-2 px-5 pt-5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </span>
            <span className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-300">
              {fresh.length} emerged this sweep
            </span>
          </div>
          <div className="px-5 pb-5 pt-2">
            <p className="max-w-2xl text-sm leading-6 text-slate-300">{scan.note}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {fresh.slice(0, 6).map((f: any, i: number) => (
                <div key={i} className="tr-rise rounded-xl bg-white/[.06] p-3" style={{ animationDelay: `${100 + i * 45}ms` }}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-black text-white">{f.subject}</span>
                    <span className="text-xs text-slate-400">{f.label}</span>
                  </div>
                  <div className="mt-1 flex items-baseline gap-2 font-mono text-sm tabular-nums">
                    <span className="text-slate-500">{f.baseline}</span>
                    <span className="text-slate-600">→</span>
                    <span className={f.favourable ? 'font-bold text-emerald-300' : 'font-bold text-rose-300'}>
                      {f.recent}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {!scanning && scan?.faded?.length > 0 && (
        <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '90ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Stopped being true</h2>
          <div className="mt-2 space-y-1.5">
            {scan.faded.slice(0, 5).map((f: any, i: number) => (
              <p key={i} className="text-sm leading-6 text-slate-600">{f.reading}</p>
            ))}
          </div>
        </section>
      )}

      {/* The actionable join. */}
      {!exploits.loading && d && (
        <section className="tr-rise" style={{ animationDelay: '120ms' }}>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-xl font-black tracking-tight text-slate-950">What to do about it</h2>
              <p className="mt-0.5 max-w-3xl text-sm leading-6 text-slate-500">
                {d.teams_with_real_trends} of {d.teams_examined} offences moved by more than noise.
                Only the ones touching a player you own, can claim, or might be offered are listed.
              </p>
            </div>
            {d.by_kind && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(d.by_kind).map(([k, n]: any) => (
                  <span key={k} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${KIND[k as Kind]?.chip ?? 'bg-slate-100 text-slate-700'}`}>
                    {n} {KIND[k as Kind]?.label ?? k}
                  </span>
                ))}
              </div>
            )}
          </div>

          {!d.exploits?.length && <Empty>{d.note}</Empty>}
          <div className="space-y-2">
            {d.exploits?.map((e: any, i: number) => <Exploit key={i} e={e} index={i} />)}
          </div>
        </section>
      )}

      {exploits.loading && <Sweeping lookback={lookback} label="Reading the last few weeks" />}

      {/* Touchdown luck. A separate section from the trends above because it is
          a different kind of claim: those measure a change in role, this
          measures a gap between role and results that has not closed yet. */}
      {regression.data && !regression.data.error && <Regression d={regression.data} />}

      {/* The full league picture, with real sparklines. */}
      {!!d?.team_reads?.length && (
        <section className="tr-rise" style={{ animationDelay: '160ms' }}>
          <h2 className="text-xl font-black tracking-tight text-slate-950">Every offence that moved</h2>
          <p className="mt-0.5 max-w-3xl text-sm leading-6 text-slate-500">
            Drawn with the weeks each claim was computed from. The highlighted tail is the recent
            window; a steady slope and a single outlier produce the same average and mean very
            different things.
          </p>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {d.team_reads.map((t: any, i: number) => <TeamRead key={t.team} t={t} index={i} />)}
          </div>
        </section>
      )}

      {watch.data?.conflicts?.length > 0 && (
        <section className="tr-rise rounded-2xl border border-amber-200 bg-amber-50/60 p-4" style={{ animationDelay: '200ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-amber-900">Pulling both ways</h2>
          <div className="mt-2 space-y-2">
            {watch.data.conflicts.map((c: any, i: number) => (
              <p key={i} className="text-sm leading-6 text-slate-700">
                <b className="text-slate-900">{c.team}</b> — {c.reading}
              </p>
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}

/**
 * Touchdown regression, split by what you can do about each player.
 *
 * The numbers are deliberately shown as "N touchdowns on M expected" rather than
 * as a single luck score. The two counts are the argument; a score is something
 * the reader has to take on trust.
 */
function Regression({ d }: { d: any }) {
  const groups = [
    { key: 'sell', title: 'Sell these', tone: 'rose',
      blurb: 'Yours, and scoring far above what their chances support. Touchdown rate does not carry; usage does.' },
    { key: 'buy', title: 'Buy these', tone: 'emerald',
      blurb: 'Someone else owns them and their box scores look bad. The chances say otherwise.' },
    { key: 'claim', title: 'Free right now', tone: 'emerald',
      blurb: 'Unrostered, with real opportunity and nothing to show for it yet.' },
    { key: 'hold', title: 'Hold — do not panic-sell', tone: 'sky',
      blurb: 'Yours, underperforming their chances. Selling now is selling the low.' }
  ].filter(g => (d[g.key]?.length ?? 0) > 0);

  if (!groups.length) return null;

  return (
    <section className="tr-rise" style={{ animationDelay: '140ms' }}>
      <h2 className="text-xl font-black tracking-tight text-slate-950">Touchdown luck</h2>
      <p className="mt-0.5 max-w-3xl text-sm leading-6 text-slate-500">
        Expected touchdowns come from opportunity priced at league rates — goal-line carries,
        end-zone targets and open-field touches all converted at their own fitted rate, per position.
        Touchdown rate is the least stable number in football, so the gap closes.
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {groups.map((g, gi) => (
          <div key={g.key} className={`tr-rise rounded-2xl border bg-white p-4 ${
            g.tone === 'rose' ? 'border-rose-200' : g.tone === 'sky' ? 'border-sky-200' : 'border-emerald-200'}`}
            style={{ animationDelay: `${160 + gi * 50}ms` }}>
            <div className="text-sm font-black text-slate-900">{g.title}</div>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{g.blurb}</p>
            <div className="mt-2 space-y-1.5">
              {d[g.key].slice(0, 5).map((p: any, i: number) => (
                <div key={i} className="flex flex-wrap items-baseline gap-x-2 border-t border-slate-100 pt-1.5 text-sm first:border-0 first:pt-0">
                  <span className="font-bold text-slate-900">{p.name}</span>
                  <span className="text-xs text-slate-400">{p.position} · {p.team}</span>
                  <span className="ml-auto font-mono text-xs tabular-nums text-slate-600">
                    {p.actual} TD <span className="text-slate-400">vs</span> {p.expected} expected
                  </span>
                  <span className={`font-mono text-xs font-bold tabular-nums ${
                    p.ppg_swing > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                    {p.ppg_swing > 0 ? '+' : ''}{p.ppg_swing} ppg
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Rates fitted on {d.rates_fitted_on?.join(', ')}. A player can be a genuine regression
        candidate and still be a bad hold if his role is shrinking — read this against the usage
        trends above, and where they disagree, trust the usage.
      </p>
    </section>
  );
}

/**
 * The staged loader, in the house style: elapsed time, work described honestly,
 * and no progress bar — because the work is not divisible into a percentage and
 * a bar that fakes one is a small lie told on every load.
 */
function Sweeping({ lookback, label }: { lookback: number; label?: string }) {
  const stages = useMemo(() => [
    `Pulling ${lookback}-game windows for 32 offences`,
    'Running Welch tests against each own baseline',
    'Correcting for fifteen simultaneous tests',
    'Crossing survivors against your roster and the wire'
  ], [lookback]);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 100) / 10), 100);
    return () => window.clearInterval(timer);
  }, []);
  const active = Math.min(stages.length - 1, Math.floor(elapsed / 0.55));

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-emerald-50 ring-1 ring-emerald-100">
          <span className="absolute h-5 w-5 animate-ping rounded-full bg-emerald-300/40" />
          <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-black text-slate-900">{label ?? 'Sweeping the league'}</div>
          <div className="mt-0.5 font-mono text-xs tabular-nums text-slate-500">{elapsed.toFixed(1)}s</div>
        </div>
      </div>
      <div className="mt-4 space-y-1.5">
        {stages.map((s, i) => (
          <div key={s} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors duration-300 ${
            i < active ? 'border-emerald-100 bg-emerald-50 text-emerald-800'
              : i === active ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900'
                : 'border-slate-100 bg-slate-50 text-slate-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${i <= active ? 'bg-current' : 'bg-slate-300'} ${i === active ? 'animate-pulse' : ''}`} />
            {s}
          </div>
        ))}
      </div>
    </div>
  );
}

function Exploit({ e, index }: { e: any; index: number }) {
  const [open, setOpen] = useState(false);
  const k = KIND[e.kind as Kind] ?? KIND.hold;
  return (
    <article className={`tr-rise overflow-hidden rounded-2xl bg-white ring-1 ${k.ring}`}
      style={{ animationDelay: `${index * 40}ms` }}>
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-slate-50">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${k.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-black text-slate-900">{e.headline}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${k.chip}`}>
              {k.label}
            </span>
            {e.urgency === 'high' && (
              <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                act this week
              </span>
            )}
            {/* The same offence moved both ways. Flagged rather than hidden —
                a contested read is still worth showing, just not as a clean one. */}
            {e.contested && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
                mixed signals
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {e.player?.name} · {e.player?.position} · {e.player?.team_abbr ?? e.team}
            {e.metric && <> · {e.metric}</>}
          </div>
        </div>
        <Delta from={e.from} to={e.to} good={e.kind === 'claim' || e.kind === 'hold'} />
      </button>
      {open && (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-sm leading-6 text-slate-700">{e.detail}</p>
          {e.opposing?.length > 0 && (
            <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 ring-1 ring-amber-200">
              Pulling the other way: {e.opposing.map((o: any) => `${o.metric} (${o.kind})`).join(', ')}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] tabular-nums text-slate-500">
            <span>effect size {e.effect_size}</span>
            <span>p = {e.p}</span>
            {e.change_pct != null && <span>{e.change_pct > 0 ? '+' : ''}{e.change_pct}%</span>}
          </div>
        </div>
      )}
    </article>
  );
}

function Delta({ from, to, good }: { from: number; to: number; good: boolean }) {
  return (
    <div className="hidden shrink-0 items-baseline gap-1.5 font-mono text-xs tabular-nums sm:flex">
      <span className="text-slate-400">{from}</span>
      <span className="text-slate-300">→</span>
      <span className={`font-bold ${good ? 'text-emerald-700' : 'text-rose-700'}`}>{to}</span>
    </div>
  );
}

function TeamRead({ t, index }: { t: any; index: number }) {
  return (
    <div className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: `${index * 50}ms` }}>
      <div className="flex items-baseline gap-2">
        <span className="text-base font-black text-slate-950">{t.team}</span>
        <span className="text-xs text-slate-400">
          last {t.window?.recent_weeks?.length} games vs weeks {t.window?.baseline_weeks?.[0]}–
          {t.window?.baseline_weeks?.slice(-1)[0]}
        </span>
      </div>
      <div className="mt-2 space-y-3">
        {t.trends.map((tr: any, i: number) => (
          <div key={i}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">{tr.label}</span>
              <span className={`text-xs font-bold ${tr.favourable ? 'text-emerald-700' : 'text-rose-700'}`}>
                {tr.baseline} → {tr.recent}
              </span>
            </div>
            <Spark series={tr.series} recentCount={t.window?.recent_weeks?.length ?? 3} up={tr.direction === 'up'} good={tr.favourable} />
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {tr.what_it_means} <span className="text-slate-400">· helps {tr.helps}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A sparkline that draws itself in.
 *
 * The recent window is a separate, thicker path over the baseline so the reader
 * can see exactly which points the claim rests on — the whole argument of the
 * chart is "these last three are different from those", and drawing one
 * undifferentiated line would make that invisible.
 */
function Spark({ series, recentCount, good }: { series: any[]; recentCount: number; up?: boolean; good: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const W = 260, H = 34, PAD = 3;

  const { basePath, recentPath, zeroY } = useMemo(() => {
    if (!series?.length) return { basePath: '', recentPath: '', zeroY: null as number | null };
    const vals = series.map(s => s.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const x = (i: number) => PAD + (i / Math.max(1, series.length - 1)) * (W - PAD * 2);
    const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
    const d = (from: number, to: number) => series.slice(from, to)
      .map((s, j) => `${j === 0 ? 'M' : 'L'}${x(from + j).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ');
    const split = Math.max(0, series.length - recentCount);
    return {
      basePath: d(0, split + 1),
      recentPath: d(split, series.length),
      zeroY: min < 0 && max > 0 ? y(0) : null
    };
  }, [series, recentCount]);

  useEffect(() => {
    const el = ref.current?.querySelector('.spark-recent') as SVGPathElement | null;
    if (!el) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray = String(len);
    el.style.strokeDashoffset = String(len);
    // Reflow, then release — a CSS transition alone will not fire because the
    // dash properties were only just set on this element.
    void el.getBoundingClientRect();
    el.style.transition = 'stroke-dashoffset 700ms cubic-bezier(.22,1,.36,1)';
    el.style.strokeDashoffset = '0';
  }, [recentPath]);

  if (!basePath) return null;
  const stroke = good ? '#059669' : '#be123c';
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" preserveAspectRatio="none"
      role="img" aria-label={`${series.length} weeks, most recent ${recentCount} highlighted`}>
      {zeroY != null && (
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3 3" />
      )}
      <path d={basePath} fill="none" stroke="#cbd5e1" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <path className="spark-recent" d={recentPath} fill="none" stroke={stroke} strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) =>
  <div className="mx-auto max-w-[1240px] space-y-5">{children}</div>;

const Empty = ({ children }: { children: React.ReactNode }) =>
  <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm leading-6 text-slate-500">{children}</div>;
