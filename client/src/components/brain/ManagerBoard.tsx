import { useMemo, useState } from 'react';
import { useApi } from '../../api';
import { Avatar, Chip } from '../ui/DesignSystem';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { PageError, PageLoading } from '../PageState';
import { logServerDetail, sanitizedMessage } from '../../lib/errorSanitize';
import {
  TIERS, TIER_SHORT, MIN_OBSERVATIONS, isThin, asText, metricLabel
} from './types';
import type {
  ManagerSignal, ProfileManager, ProfilesResponse, SignalManager, SignalsResponse, Tier
} from './types';

/**
 * Who trades with you: the tier you set by hand, beside the numbers we measured.
 *
 * The two layers are deliberately on one screen and deliberately not blended.
 * `manager_profiles` is Nick's own read of a person — the thing no model can
 * find, because no fantasy league holds enough trade history to learn it. The
 * signals are measured, and four of the five leagues have no chat corpus at
 * all, so for most managers most of this panel is honestly empty. An empty
 * panel that says nothing is the failure mode this component exists to avoid:
 * every missing layer names itself and says what would produce it.
 */

const TIER_TINY: Record<Tier, string> = { fair: 'Fair', hard: 'Hard', never: 'Never' };

type PulseItem = { id: number; roster_id: number; phrase: string; credible: boolean; ago: string };

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

/** How readily he says yes, from receptiveness (1 = league average), with what it rests on. */
function yesTendency(signal: SignalManager | null): { label: string; basis: string } | null {
  const rec = (signal?.receptiveness ?? {}) as Record<string, any>;
  if (typeof rec.value !== 'number') return null;
  const label = rec.value >= 1.1 ? 'says yes more than most' : rec.value <= 0.9 ? 'says yes less than most' : 'says yes about as often as most';
  const basis = rec.priced_by === 'default' || rec.tier_is_assumption ? 'assumed' : String(rec.priced_by ?? 'measured');
  return { label, basis };
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

function ManagerRow({ profile, signal, leagueId, onSaved, signalsLive, pulse }: {
  profile: ProfileManager; signal: SignalManager | null; leagueId: number;
  onSaved: () => void; signalsLive: boolean; pulse: PulseItem[] | null;
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
  const yes = yesTendency(signal);
  const chatter = (pulse ?? []).filter(p => String(p.roster_id) === String(profile.roster_id)).slice(0, 2);
  return (
    <article className="px-4 py-3" data-testid="manager-card">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={owner} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{owner}</div>
          <div className="ds-note truncate">{read ?? (profile.is_set ? 'Your read, set by you' : 'No measured read yet')}</div>
        </div>
        {/* One segmented control: how Nick reads him. Drives the finder and the planner's partners. */}
        <div className="ds-tabs" role="radiogroup" aria-label={`Tradeability for ${owner}`}>
          {TIERS.map(t => (
            <button key={t} type="button" role="radio" aria-checked={profile.tradeability === t} onClick={() => set(t)} disabled={saving}
              className="ds-tab !px-3 !text-xs" aria-selected={profile.tradeability === t}
              title={saving ? 'Saving your read' : `Mark ${owner}: ${TIER_SHORT[t].toLowerCase()}`}>
              <span className="hidden sm:inline">{TIER_SHORT[t]}</span><span className="sm:hidden">{TIER_TINY[t]}</span></button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-12 text-xs">
        {yes && <span className="text-slate-700">{yes.label}</span>}
        {yes && <Chip tone={yes.basis === 'assumed' ? 'neutral' : 'accent'} title="What this read rests on">{yes.basis}</Chip>}
        {profile.notes && <span className="ds-note">· {profile.notes}</span>}
      </div>
      {chatter.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-12" aria-label={`Recent chatter from ${owner}`} data-testid="manager-chatter">
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
        <details className="mt-2 pl-12" data-testid="manager-measured">
          <summary className="ds-note cursor-pointer">What we measured · {[signal.archetype && 'archetype', signal.receptiveness && 'receptiveness', shown.length ? `${shown.length} signal${shown.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'no measured signal yet'}</summary>
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
        <p className="mt-2 pl-12 text-[11px] leading-5 text-slate-500">
          Nothing measured about this manager. The tier above is the only read we have,
          and it is yours, not a measurement.
        </p>
      )}
    </article>
  );
}

/** Why the measured half of this page is not on screen, in the user's terms. */
/** UX-08b: `error` is the raw server/fetch message — never rendered, only logged. */
export function signalsRequestFailedReason(error: string): string {
  if (/\b404\b/.test(error)) {
    return 'This server does not serve measured manager signals yet: the endpoint answered 404. '
      + 'Nothing is being hidden — there is nothing there to read.';
  }
  logServerDetail('ManagerBoard.signals', error);
  return 'The signals request failed. Try again in a moment.';
}

/** UX-08b: `error` is the raw server/fetch message — never rendered, only logged. */
export function ManagerProfilesGap({ error }: { error: string }) {
  logServerDetail('ManagerBoard.profiles', error);
  return (
    <section role="status" className="rounded-2xl border border-slate-300 bg-slate-50 p-4">
      <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">No managers to set yet</h2>
      <p className="mt-1.5 text-sm leading-6 text-slate-700">Couldn't read the roster list. Try again in a moment.</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Sync this league from <Link className="font-semibold text-emerald-700" to="/league">League Hub</Link>,
        then come back — the roster list is what the tiers hang off.
      </p>
    </section>
  );
}

function SignalsGap({ title, reason, onRetry }: { title: string; reason: string; onRetry?: () => void }) {
  return (
    <section role="status" className="rounded-2xl border border-slate-300 bg-slate-50 p-4">
      <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">{title}</h2>
      <p className="mt-1.5 text-sm leading-6 text-slate-700">{reason}</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        The tiers below still work and still drive the trade finder — they are hand-set, not measured.
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-500">What fills it, and where each read comes from: Settings → AI &amp; developer.</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        Four of the five connected leagues have no chat corpus at all, so this is the normal
        state for most of them rather than a fault.
      </p>
      {onRetry && <button type="button" className="btn-ghost mt-3 text-xs" onClick={onRetry}>↻ Retry</button>}
    </section>
  );
}

export default function ManagerBoard({ leagueId, profiles, signals }: {
  leagueId: number;
  profiles: { data: ProfilesResponse | null; loading: boolean; error: string | null; refetch: () => void };
  signals: { data: SignalsResponse | null; loading: boolean; error: string | null; refetch: () => void };
}) {
  const signalsLive = !!signals.data && signals.data.available === true && !signals.data.error;
  const [allManagers, setAllManagers] = useState(false);
  // The chat pulse, per manager (their recent statements), instead of a strip across the page.
  const pulse = useApi<{ enabled: boolean; items?: PulseItem[] }>(`/trades/${leagueId}/people/pulse`, { staleTime: 60_000 });
  const byRoster = useMemo(() => new Map(
    (signals.data?.managers ?? []).map(m => [String(m.roster_id), m])
  ), [signals.data]);

  const p = profiles.data;
  const others = (p?.managers ?? []).filter(m => String(m.roster_id) !== String(p?.my_roster_id ?? ''));

  return (
    <div className="space-y-4">
      <p className="ds-note">Your read of each manager re-ranks the finder; anyone you mark <b>never trades</b> is left out of planning.</p>

      {/* Two independent reads: a missing or degraded signals layer must never
          take the hand-set tiers, which are the half that always works, off
          the screen with it. */}
      {signals.loading && !signals.data && <PageLoading label="Reading manager signals…" />}

      {!signals.loading && signals.error && (
        <SignalsGap
          title="Measured manager signals are not on screen"
          reason={signalsRequestFailedReason(signals.error)}
          onRetry={signals.refetch}
        />
      )}

      {!signals.error && signals.data?.error && (
        <SignalsGap title="Measured manager signals are not on screen"
          reason={sanitizedMessage('ManagerBoard.signalsPayload', 'The server could not produce measured signals', signals.data.error)} />
      )}

      {!signals.error && signals.data && !signals.data.error && signals.data.available === false && (
        <SignalsGap
          title="No manager signals for this league"
          reason={signals.data.reason
            || 'The server reported the signal layer unavailable for this league without a reason.'}
        />
      )}

      {signalsLive && (
        <p className="ds-note" data-testid="people-source">
          Measured from rosters, results, drafts{[...byRoster.values()].some(m => m.corpus) ? ' and league chat' : ''}
          {signals.data?.computed_at ? ` · updated ${new Date(signals.data.computed_at).toLocaleDateString()}` : ''}
          {(signals.data?.identity_warnings?.length ?? 0) > 0 ? ' · some names matched by hand' : ''}
        </p>
      )}

      {/* The hand-set tiers. */}
      {profiles.loading && !p && <PageLoading label="Loading managers…" />}
      {!profiles.loading && profiles.error && !p && (
        <PageError message={sanitizedMessage('ManagerBoard.profilesFetch', "Couldn't read the roster list", profiles.error)} onRetry={profiles.refetch} />
      )}
      {p?.error && <ManagerProfilesGap error={p.error} />}

      {p && !p.error && !others.length && (
        <section role="status" className="rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">No other managers in this league</h2>
          <p className="mt-1.5 text-sm leading-6 text-slate-700">
            The synced payload has no rosters other than yours, so there is nobody to trade with
            and nothing to set.
          </p>
        </section>
      )}

      {!!others.length && (
        <div className="ds-card ds-rows overflow-hidden">
          {(allManagers ? others : others.slice(0, 5)).map(m => (
            <ManagerRow key={m.roster_id} profile={m} leagueId={leagueId} signalsLive={signalsLive}
              signal={byRoster.get(String(m.roster_id)) ?? null} pulse={pulse.data?.enabled ? pulse.data.items ?? [] : null}
              onSaved={profiles.refetch} />
          ))}
          {others.length > 5 && <button type="button" className="w-full py-2 text-xs font-semibold text-[var(--c-accent)]" onClick={() => setAllManagers(v => !v)}>
            {allManagers ? 'Show fewer' : `Show all ${others.length} managers`}</button>}
        </div>
      )}

      {p?.note && <p className="text-[12px] leading-5 text-slate-500">{p.note}</p>}
    </div>
  );
}
