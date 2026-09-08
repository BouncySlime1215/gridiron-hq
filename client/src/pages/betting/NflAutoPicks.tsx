import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api';
import { pct, americanFmt } from '../props/lib';
import { PageLoading, PageError, EmptyState } from '../../components/PageState';
import { SectionHeading, StatusPill, type Tone } from '../../components/betting/BettingUI';

const SEASON = 2026;

type PickStatus = 'Won' | 'Lost' | 'Push' | 'Void' | 'Pending';

interface PickRow {
  season: number; week: number; rank: number;
  home_team: string; away_team: string; matchup: string;
  selection: string; side: string | null; line: number | null;
  american_price: number | null;
  model_probability: number | null; implied_probability: number | null; probability_difference: number | null;
  detail: string; units_staked: number; selected_at: string;
  policy_id: string | null; policy_version: string | null;
  book: string | null; quote_at: string | null; quote_source: string | null;
  voided_at: string | null; void_reason: string | null;
  status: PickStatus; units: number;
}

interface Standing {
  wins: number; losses: number; pushes: number;
  win_rate: number | null; units: number; weeks_tracked: number;
}

interface HistoryPayload { results: PickRow[]; standing: Standing }
interface WeekPayload { season: number; week: number; picks: PickRow[]; standing: Standing }

const STATUS_TONE: Record<PickStatus, Tone> = {
  Won: 'good', Lost: 'bad', Push: 'neutral', Void: 'neutral', Pending: 'warn'
};

const fmtDateTime = (v: string | null) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/**
 * The ledger of picks the model actually locked and staked — distinct from
 * the live candidate board at /betting/nfl (and its /picks alias), which
 * shows what the model would bet on the current slate right now. This page
 * never re-ranks or re-prices anything; it only reads back rows already
 * written to nfl_auto_picks, exactly as they were locked, graded against the
 * real final score once the game ends.
 */
export default function NflAutoPicks() {
  const [week, setWeek] = useState<number | null>(null);
  const history = useApi<HistoryPayload>('/nfl-market/picks/history');
  const weekPath = week == null ? `/nfl-market/picks?season=${SEASON}` : `/nfl-market/picks?season=${SEASON}&week=${week}`;
  const weekApi = useApi<WeekPayload>(weekPath);

  // Land on whatever week the server considers current (same default the API
  // itself falls back to) rather than always opening on Week 1.
  useEffect(() => {
    if (week == null && weekApi.data?.week != null) setWeek(weekApi.data.week);
  }, [week, weekApi.data?.week]);

  const standing = history.data?.standing;

  return (
    <div className="mx-auto max-w-[1200px] space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-700">Locked pick ledger</div>
            <h1 className="mt-1 text-2xl font-black text-slate-950">NFL Auto Picks</h1>
            <p className="mt-2 max-w-2xl text-sm leading-5 text-slate-500">
              This is what the model actually bet and how it did — every pick here was locked at a real price before kickoff and graded against the
              final score. It is not the live board: for what the model would bet on the current slate right now, see the{' '}
              <Link to="/betting/nfl" className="font-semibold text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-slate-900">
                live candidate board
              </Link>.
            </p>
          </div>
        </div>
      </div>

      <section>
        <SectionHeading eyebrow="Overall record" title="Where the model actually stands" description="Every graded pick ever locked, across every week tracked. Voided picks are excluded entirely — not counted as losses, not counted as pending." />
        {history.loading && !standing ? <PageLoading label="Loading the record…" /> : history.error && !standing ? <PageError message={history.error} onRetry={() => history.refetch()} /> : !standing ? null : (
          <div className="grid gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
            <StandingFact label="Record" value={`${standing.wins}-${standing.losses}${standing.pushes ? `-${standing.pushes}` : ''}`} detail={`${standing.wins + standing.losses} settled decisions`} />
            <StandingFact label="Win rate" value={pct(standing.win_rate)} detail="Wins over settled, non-push decisions" />
            <StandingFact label="Units" value={`${standing.units >= 0 ? '+' : ''}${standing.units.toFixed(2)}u`} tone={standing.units > 0 ? 'good' : standing.units < 0 ? 'bad' : undefined} detail="Net across every graded pick" />
            <StandingFact label="Weeks tracked" value={String(standing.weeks_tracked)} detail="Distinct season/week slates with a locked pick" />
          </div>
        )}
      </section>

      <section>
        <SectionHeading
          eyebrow="Week ledger"
          title={week == null ? 'Loading week…' : `Week ${week}`}
          description="Matchup, the locked line and price, the model's probability claim against the market's implied probability, the stake, and the outcome."
          action={
            <select aria-label="NFL week" value={week ?? ''} onChange={event => setWeek(Number(event.target.value))} className="input py-2 text-sm">
              {week == null && <option value="" disabled>—</option>}
              {Array.from({ length: 18 }, (_, index) => <option key={index + 1} value={index + 1}>Week {index + 1}</option>)}
            </select>
          }
        />
        {weekApi.loading && !weekApi.data ? <PageLoading label="Loading this week's picks…" />
          : weekApi.error && !weekApi.data ? <PageError message={weekApi.error} onRetry={() => weekApi.refetch()} />
          : !weekApi.data || weekApi.data.picks.length === 0
            ? <EmptyState title="No picks were locked this week" description="Either the policy found nothing that cleared its edge and disagreement bar, or this week hasn't been run yet. This page never invents a pick that wasn't actually recorded." />
            : <WeekTable picks={weekApi.data.picks} />}
      </section>
    </div>
  );
}

function WeekTable({ picks }: { picks: PickRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400">
            <tr>{['#', 'Matchup', 'Selection', 'Model vs. market', 'Price', 'Units staked', 'Locked', 'Result'].map(h => (
              <th key={h} className="whitespace-nowrap px-4 py-3 text-left font-bold">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {picks.map(p => (
              <tr key={`${p.season}-${p.week}-${p.rank}`}>
                <td className="px-4 py-3 text-slate-400 tabular-nums">{p.rank}</td>
                <td className="px-4 py-3">
                  <div className="font-black text-slate-900">{p.matchup}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{p.detail}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-bold text-slate-800">{p.selection}{p.side ? ` ${p.side}` : ''}{p.line != null ? ` ${p.line}` : ''}</div>
                  {p.book && <div className="text-xs text-slate-400">{p.book}</div>}
                </td>
                <td className="px-4 py-3 tabular-nums">
                  <div>{pct(p.model_probability)} <span className="text-slate-400">model</span></div>
                  <div className="text-xs text-slate-500">{pct(p.implied_probability)} implied · {p.probability_difference != null ? `${p.probability_difference > 0 ? '+' : ''}${pct(p.probability_difference)} edge` : '— edge'}</div>
                </td>
                <td className="px-4 py-3 tabular-nums font-bold">{americanFmt(p.american_price)}</td>
                <td className="px-4 py-3 tabular-nums">{p.units_staked}u</td>
                <td className="px-4 py-3 text-xs text-slate-500">{fmtDateTime(p.selected_at) ?? '—'}</td>
                <td className="px-4 py-3">
                  <StatusPill tone={STATUS_TONE[p.status]}>{p.status}</StatusPill>
                  {p.status === 'Void' && p.void_reason && <div className="mt-1 text-xs text-slate-500">{p.void_reason}</div>}
                  {p.status !== 'Void' && p.status !== 'Pending' && (
                    <div className={`mt-1 text-xs font-bold ${p.units > 0 ? 'text-emerald-700' : p.units < 0 ? 'text-rose-700' : 'text-slate-500'}`}>
                      {p.units === 0 ? 'push' : `${p.units > 0 ? '+' : ''}${p.units.toFixed(2)}u`}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StandingFact({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="bg-white p-4">
      <div className="text-[10px] font-black uppercase tracking-[.13em] text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-black ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700' : 'text-slate-950'}`}>{value}</div>
      <div className="mt-1 text-xs text-slate-500">{detail}</div>
    </div>
  );
}
