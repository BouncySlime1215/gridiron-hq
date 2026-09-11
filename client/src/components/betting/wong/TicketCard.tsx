import { useState } from 'react';
import { api } from '../../../api';
import { TeamLogo } from './TeamLogo';
import { ProvenanceTag } from './shared';
import {
  american, bookLabel, canPush, dollars, evPercentText, kickoff, line, pct, signedUnits
} from './format';
import type { WongCandidate, WongLeg } from './types';

export function candidateKey(book: string, candidate: WongCandidate) {
  return `${book}:${candidate.american_price}:${candidate.legs.map(leg => `${leg.event_id}/${leg.team}`).sort().join('+')}`;
}

/**
 * One executable ticket.
 *
 * Deliberately absent: any confidence score, star rating, or ordering that
 * implies one qualifying leg is likelier to win than another. Roughly 4,600
 * tests found nothing that separates qualifying legs, so inventing a column
 * here would be inventing a signal. The one real difference between two legs
 * is push exposure — a leg teased onto a whole number can push, one on a
 * half-point cannot — and that is drawn from the teased number itself.
 */
export function TicketCard({ book, candidate, stakeUnits, unitSizeDollars, onTracked, badge }: {
  book: string; candidate: WongCandidate; stakeUnits: number;
  unitSizeDollars: number | null; onTracked?: () => void; badge?: string;
}) {
  const [busy, setBusy] = useState<'placed' | 'paper' | null>(null);
  const [done, setDone] = useState<'placed' | 'paper' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const track = async (mode: 'placed' | 'paper') => {
    setBusy(mode); setError(null);
    try {
      await api('/betting/wong/tickets', {
        method: 'POST',
        body: JSON.stringify({
          book, american_price: candidate.american_price,
          stake_units: stakeUnits, mode, legs: candidate.legs
        })
      });
      setDone(mode);
      onTracked?.();
    } catch (reason: any) {
      setError(reason?.message ?? 'Could not save this ticket.');
    } finally { setBusy(null); }
  };

  const stakeDollars = unitSizeDollars != null ? unitSizeDollars * stakeUnits : null;
  const toWin = candidate.american_price > 0
    ? stakeUnits * (candidate.american_price / 100)
    : stakeUnits * (100 / Math.abs(candidate.american_price || 100));

  return <article className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center gap-2">
      {badge && <span className="rounded-full bg-slate-950 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-white">{badge}</span>}
      <span className="text-sm font-black text-slate-900">{bookLabel(book)}</span>
      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-black tabular-nums text-slate-800">{american(candidate.american_price)}</span>
      <span className="text-[11px] text-slate-500">{candidate.legs.length}-leg 6-point teaser</span>
      <span className="ml-auto text-right">
        <span className={`block text-sm font-black tabular-nums ${candidate.ev >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
          {evPercentText(candidate.ev, candidate.ev_percent)}
        </span>
        <span className="block text-[10px] text-slate-400">expected value · {signedUnits(candidate.ev * stakeUnits)}</span>
      </span>
    </div>

    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {candidate.legs.map(leg => <LegRow key={`${leg.event_id}:${leg.team}`} leg={leg} />)}
    </div>

    <OutcomeBar probabilities={candidate.probabilities} />

    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
      <span className="text-[11px] text-slate-500">
        Stake {stakeUnits}u{stakeDollars != null ? ` · ${dollars(stakeDollars)}` : ''} to win {signedUnits(toWin)}
        {unitSizeDollars != null ? ` · ${dollars(toWin * unitSizeDollars)}` : ''}
      </span>
      <div className="ml-auto flex flex-wrap gap-2">
        {done ? (
          <span className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800">
            {done === 'placed' ? 'Tracking this ticket' : 'Paper-tracking this ticket'}
          </span>
        ) : <>
          <button type="button" onClick={() => track('paper')} disabled={busy != null}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 transition-colors hover:border-slate-400 disabled:opacity-50">
            {busy === 'paper' ? 'Saving…' : 'Paper track'}
          </button>
          <button type="button" onClick={() => track('placed')} disabled={busy != null}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white transition-colors hover:bg-emerald-700 disabled:opacity-50">
            {busy === 'placed' ? 'Saving…' : 'I took this bet'}
          </button>
        </>}
      </div>
    </div>
    {error && <p className="mt-2 text-xs font-semibold text-rose-700">{error}</p>}
  </article>;
}

function LegRow({ leg }: { leg: WongLeg }) {
  const pushable = canPush(leg.teased_to);
  return <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
    <div className="flex items-center gap-2">
      <TeamLogo team={leg.team} size={26} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-black text-slate-900">{leg.team}</div>
        <div className="text-[10px] text-slate-500">{kickoff(leg.commence_time)}</div>
      </div>
      <div className="text-right tabular-nums">
        <div className="text-xs text-slate-500">{line(leg.line)}{leg.spread_price != null && <span className="ml-1 text-slate-400">({american(leg.spread_price)})</span>}</div>
        <div className="text-sm font-black text-emerald-700">→ {line(leg.teased_to)}</div>
      </div>
    </div>
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <ProvenanceTag provenance={leg.provenance} ageMinutes={leg.age_minutes} compact />
      <span title={pushable
        ? 'Teased onto a whole number, so this leg can land exactly on the number and push.'
        : 'Teased onto a half-point, so this leg cannot push — it wins or it loses.'}
        className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${pushable
          ? 'border-slate-300 bg-white text-slate-600' : 'border-slate-200 bg-white text-slate-400'}`}>
        {pushable ? 'can push' : 'no push'}
      </span>
    </div>
  </div>;
}

/**
 * The four outcomes of a teaser, to scale. `reduced` is the case books
 * disagree about — one leg pushes and the ticket drops to a single — so it
 * gets its own colour rather than being folded into a win or a refund.
 */
function OutcomeBar({ probabilities }: { probabilities: WongCandidate['probabilities'] }) {
  const segments = [
    { key: 'win', label: 'Win', value: probabilities?.win, color: '#059669' },
    { key: 'reduced', label: 'Reduced to a single', value: probabilities?.reduced, color: '#f59e0b' },
    { key: 'both_push', label: 'Both push', value: probabilities?.both_push, color: '#94a3b8' },
    { key: 'loss', label: 'Loss', value: probabilities?.loss, color: '#e11d48' }
  ].filter(segment => typeof segment.value === 'number' && Number.isFinite(segment.value));
  const total = segments.reduce((sum, segment) => sum + (segment.value as number), 0);
  if (!segments.length || total <= 0) return null;

  return <div className="mt-3">
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100"
      role="img" aria-label={segments.map(s => `${s.label} ${pct(s.value as number)}`).join(', ')}>
      {segments.map(segment => <span key={segment.key}
        style={{ width: `${((segment.value as number) / total) * 100}%`, background: segment.color }} />)}
    </div>
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
      {segments.map(segment => <span key={segment.key} className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
        <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: segment.color }} />
        {segment.label} <b className="tabular-nums text-slate-800">{pct(segment.value as number, 1)}</b>
      </span>)}
    </div>
  </div>;
}
