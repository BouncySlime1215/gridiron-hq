import { useState } from 'react';
import { api } from '../../api';
import { PageError } from '../PageState';
import { sanitizedMessage } from '../../lib/errorSanitize';
import { Avatar } from '../ui/DesignSystem';
import ChanceStat from '../warroom/ChanceStat';
import { TIERS, TIER_SHORT, MIN_OBSERVATIONS, isThin, asText, metricLabel } from './types';
import type { ManagerSignal, ProfileManager, SignalManager, Tier } from './types';

/**
 * ManagerCard (docs/ui/CONSOLIDATION-MAP.md section 6): one league-mate. Trades → People renders one
 * per manager; "Ask Coach" opens the app-wide Coach on a trade with him. Initials and team, a one-line
 * read from what was measured, how he says yes (only when it rests on something, never the default),
 * the stance as one segmented control (its own row on a phone), recent chatter, and the measured
 * detail folded inside.
 */
export type PulseItem = { id: number; roster_id: number; phrase: string; credible: boolean; ago: string };

/** The measured answers worth one line: only a basis that read him (not a prior), in plain words. */
const LEAN: Record<string, string> = { rb_heavy: 'likes RBs', wr_heavy: 'likes WRs', qb_early: 'takes QBs early', te_early: 'takes TEs early', balanced: 'balanced drafter' };
function oneLine(signal: SignalManager | null): string | null {
  const answers = ((signal as any)?.model_read?.answers ?? []) as { question: string; measured?: boolean; top?: { outcome: string } }[];
  const bits: string[] = [];
  const lean = answers.find(a => a.question === 'position_bias' && a.measured && a.top);
  if (lean?.top && LEAN[lean.top.outcome]) bits.push(LEAN[lean.top.outcome]);
  const style = answers.find(a => a.question === 'trade_style' && a.measured && a.top);
  if (style?.top) bits.push(style.top.outcome === 'never' ? 'rarely trades' : style.top.outcome === 'often' ? 'trades often' : `trades ${style.top.outcome}`);
  const rec = (signal?.receptiveness ?? {}) as Record<string, any>;
  if (typeof rec.accept_rate === 'number' && rec.accept_rate_n > 0) bits.push(`accepted ${Math.round(rec.accept_rate * 100)}% of ${rec.accept_rate_n} offers`);
  if (signal?.corpus && typeof rec.trade_talk_pct === 'number' && rec.chat_msgs > 0) bits.push(rec.trade_talk_pct > 0.5 ? 'talks trade in chat' : 'quiet in chat');
  return bits.length ? bits.join(' · ') : null;
}

/**
 * How readily he says yes, only when it rests on something about him: his measured accept rate
 * (a ChanceStat with its n), or a receptiveness priced from his own data. The default / assumed read
 * is the same for everyone, so it is not drawn at all.
 */
function yesRead(signal: SignalManager | null): { rate: number | null; n: number | null; label: string | null; basis: string } | null {
  const rec = (signal?.receptiveness ?? {}) as Record<string, any>;
  const assumed = rec.priced_by === 'default' || rec.tier_is_assumption === true || rec.priced_by == null;
  const rate = typeof rec.accept_rate === 'number' && rec.accept_rate_n > 0 ? rec.accept_rate : null;
  if (rate != null) return { rate, n: rec.accept_rate_n, label: null, basis: 'his answers to offers' };
  if (assumed || typeof rec.value !== 'number') return null;
  const n = typeof rec.chat_msgs === 'number' && rec.chat_msgs > 0 ? rec.chat_msgs : null;
  const label = rec.value >= 1.1 ? 'says yes more than most' : rec.value <= 0.9 ? 'says yes less than most' : null;
  return label ? { rate: null, n, label, basis: String(rec.priced_by) } : null;
}

/** One measured number, or an honest statement that it is not one yet. */
function SignalRow({ signal }: { signal: ManagerSignal }) {
  const thin = isThin(signal);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1">
      <span className="text-[11px] font-semibold text-slate-600">{metricLabel(signal.metric)}</span>
      {thin ? (
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 ring-1 ring-slate-200">
          Not enough data yet
        </span>
      ) : (
        <span className="text-sm font-black tabular-nums text-slate-900">{asText(signal.value)}</span>
      )}
      {/* n travels with every value, measured or thin — a number from 4
          observations and a number from 400 must never look alike. */}
      <span className="text-[11px] tabular-nums text-slate-500">
        n={signal.n == null ? '—' : signal.n}
      </span>
      {signal.source && <span className="text-[11px] text-slate-400">· {signal.source}</span>}
      {signal.priceable === false && (
        <span className="text-[11px] text-slate-500">· descriptive only, never prices a deal</span>
      )}
      {thin && signal.value != null && (
        <span className="text-[11px] text-slate-500">
          · measured {asText(signal.value)}, under {MIN_OBSERVATIONS} observations
        </span>
      )}
      {signal.why && <span className="w-full text-[11px] leading-5 text-slate-500">{signal.why}</span>}
    </div>
  );
}

/** archetype / receptiveness / negotiation: shown when derived, named when not. */
function Read({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-[.12em] text-slate-400">{label}</div>
      {value && Object.keys(value).length ? (
        <div className="mt-0.5 text-[12px] leading-5 text-slate-700">{asText(value)}</div>
      ) : (
        <div className="mt-0.5 text-[12px] leading-5 text-slate-500">Not derived for this manager yet.</div>
      )}
    </div>
  );
}

type BoardFactor = { source?: string; label?: string; effect?: number | null; n?: number | null; why?: string | null };

/**
 * What moved his receptiveness, one line per source, with the sample. A
 * withheld source (effect null: under its gate, or unknown) says so rather
 * than printing as a zero.
 */
function ReceptivenessFactors({ factors }: { factors: BoardFactor[] }) {
  if (!factors.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {factors.map((f, i) => (
        <li key={`${f.source ?? 'factor'}-${i}`} className="text-[11px] leading-5 text-slate-600">
          <span className={`font-bold tabular-nums ${f.effect == null ? 'text-slate-400'
            : f.effect > 0 ? 'text-emerald-700' : f.effect < 0 ? 'text-rose-700' : 'text-slate-500'}`}>
            {f.effect == null ? 'withheld' : `${f.effect > 0 ? '+' : ''}${f.effect.toFixed(2)}`}
          </span>{' '}
          {f.label}
          <span className="text-slate-400"> · n={f.n == null ? '—' : f.n}</span>
          {f.why && <span className="block text-slate-500">{f.why}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function ManagerCard({ profile, signal, leagueId, onSaved, signalsLive, pulse, onAsk }: {
  profile: ProfileManager; signal: SignalManager | null; leagueId: number;
  onSaved: () => void; signalsLive: boolean; pulse: PulseItem[] | null;
  /** Ask the app-wide Coach for a trade with him. */
  onAsk?: (question: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState<Tier | null>(null);
  const owner = profile.owner || signal?.owner || `Roster ${profile.roster_id}`;

  const set = async (tier: Tier) => {
    setSaving(true); setSaveError(null); setPending(tier);
    try {
      await api(`/trades/${leagueId}/brain/managers/${profile.roster_id}`, {
        method: 'POST', body: JSON.stringify({ tradeability: tier, owner: profile.owner })
      });
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error
        ? sanitizedMessage('ManagerBoard.set', 'Could not save that tier', e.message)
        : 'Could not save that tier. Try again in a moment.');
    } finally { setSaving(false); }
  };

  const shown = (signal?.signals ?? []);
  // The factor list is shown as a list; the rest of the receptiveness block stays one line.
  const { factors: rawFactors, ...receptiveness } = signal?.receptiveness ?? {};
  const factors = (Array.isArray(rawFactors) ? rawFactors : []) as BoardFactor[];
  const priceable = shown.filter(s => !isThin(s));

  const read = oneLine(signal);
  const yes = yesRead(signal);
  const chatter = (pulse ?? []).filter(p => String(p.roster_id) === String(profile.roster_id)).slice(0, 2);
  return (
    <article className="px-4 py-3" data-testid="manager-card">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={owner} size={36} />
        {/* On a phone the stance control takes its own row (w-full), so the name is never cut short. */}
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{owner}</div>
          <div className="ds-note truncate">{read ?? (profile.is_set ? 'Your read, set by you' : 'No measured read yet')}</div>
        </div>
        {/* One segmented control: how Nick reads him. Drives the finder and the planner's partners. */}
        <div className="ds-tabs w-full justify-between sm:w-auto" role="radiogroup" aria-label={`Tradeability for ${owner}`}>
          {TIERS.map(t => (
            <button key={t} type="button" role="radio" aria-checked={profile.tradeability === t} onClick={() => set(t)} disabled={saving}
              className="ds-tab !px-3 !text-xs" aria-selected={profile.tradeability === t}
              title={saving ? 'Saving your read' : `Mark ${owner}: ${TIER_SHORT[t].toLowerCase()}`}>
              {TIER_SHORT[t]}</button>
          ))}
        </div>
      </div>
      {(yes || profile.notes || onAsk) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs sm:pl-12" data-testid="manager-yes">
          {yes?.rate != null && <ChanceStat label="Said yes" value={yes.rate} n={yes.n} basis={yes.basis} />}
          {yes?.label && <span className="text-slate-700">{yes.label}{yes.n != null ? ` (n=${yes.n})` : ''}</span>}
          {profile.notes && <span className="ds-note">{profile.notes}</span>}
          {onAsk && <button type="button" className="ml-auto text-xs font-semibold text-[var(--c-accent)] hover:underline"
            onClick={() => onAsk(`Find a trade for ${owner}`)} title={`Ask Coach for a trade with ${owner}`}>Ask Coach</button>}
        </div>
      )}
      {chatter.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 sm:pl-12" aria-label={`Recent chatter from ${owner}`} data-testid="manager-chatter">
          {chatter.map(c => <li key={c.id} className="truncate text-xs text-slate-600" title={c.credible ? 'Credible: he has followed through before' : 'A label only; no proven follow-through'}>
            “{c.phrase}” <span className="text-slate-500">· {c.ago}</span></li>)}
        </ul>
      )}

      {saveError && (
        <div className="mt-2">
          <PageError message={saveError} onRetry={pending ? () => set(pending) : undefined} />
        </div>
      )}

      {/* The measured layer, folded into the card: what was read about him, with its sample. */}
      {signalsLive && signal && (signal.corpus || shown.length || signal.archetype) ? (
        <details className="mt-2 sm:pl-12" data-testid="manager-measured">
          <summary className="ds-note cursor-pointer">{shown.length ? `Based on ${shown.length} things we measured about him` : 'What we know about him'}</summary>
          <div className="mt-2 rounded-[var(--r-tile)] bg-[var(--c-soft)] p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Read label="Archetype" value={signal.archetype} />
            <div>
              <Read label="Receptiveness" value={signal.receptiveness ? receptiveness : null} />
              <ReceptivenessFactors factors={factors} />
            </div>
            <Read label="Negotiation" value={signal.negotiation} />
          </div>
          {!signal.corpus && (
            <p className="mt-2 border-t border-slate-200 pt-2 text-[11px] leading-5 text-slate-600">
              No league chat for this manager. Everything below is from the synced roster,
              transactions and results — nothing here is read from anything they said.
            </p>
          )}
          {shown.length ? (
            <div className="mt-2 divide-y divide-slate-200 border-t border-slate-200 pt-1">
              {shown.map(s => <SignalRow key={`${s.metric}:${s.source ?? ''}`} signal={s} />)}
            </div>
          ) : (
            <p className="mt-2 border-t border-slate-200 pt-2 text-[11px] leading-5 text-slate-600">
              No measured signal for this manager yet. Not enough data yet is the honest read,
              not a neutral one — nothing has been measured to be neutral about.
            </p>
          )}
          {!!shown.length && (
            <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
              {priceable.length} of {shown.length} would price a deal; the rest are under{' '}
              {MIN_OBSERVATIONS} observations or marked descriptive-only.
            </p>
          )}
          </div>
        </details>
      ) : (
        <p className="mt-2 text-[11px] leading-5 text-slate-500 sm:pl-12">
          Nothing measured about this manager. The tier above is the only read we have,
          and it is yours, not a measurement.
        </p>
      )}
    </article>
  );
}

