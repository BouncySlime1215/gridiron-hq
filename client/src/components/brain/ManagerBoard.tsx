import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { PageError, PageLoading } from '../PageState';
import {
  TIERS, TIER_SHORT, TIER_STYLE, MIN_OBSERVATIONS, isThin, asText, metricLabel
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

const CHAT_FIX = 'The chat layer comes from the private league-chat database. Pull it from '
  + 'Settings; the archetype and outcome metrics come from the manager-archetype build '
  + '(scripts/build-manager-archetypes.mjs) and refresh on the normal league sync.';

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

function ManagerRow({ profile, signal, leagueId, onSaved, signalsLive }: {
  profile: ProfileManager; signal: SignalManager | null; leagueId: number;
  onSaved: () => void; signalsLive: boolean;
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
      setSaveError(e instanceof Error ? e.message : 'Could not save that tier — try again.');
    } finally { setSaving(false); }
  };

  const shown = (signal?.signals ?? []);
  // The factor list is shown as a list; the rest of the receptiveness block stays one line.
  const { factors: rawFactors, ...receptiveness } = signal?.receptiveness ?? {};
  const factors = (Array.isArray(rawFactors) ? rawFactors : []) as BoardFactor[];
  const priceable = shown.filter(s => !isThin(s));

  return (
    <div className="border-b border-slate-100 p-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-slate-900">{owner}</div>
          <div className="text-[11px] text-slate-400">
            {profile.is_set ? 'Set by you' : 'Default — assumed tradeable'}
          </div>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label={`Tradeability for ${owner}`}>
          {TIERS.map(t => (
            <button key={t} type="button" onClick={() => set(t)} disabled={saving}
              aria-pressed={profile.tradeability === t}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-bold ring-1 transition disabled:opacity-50 ${
                profile.tradeability === t ? TIER_STYLE[t] : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50'}`}>
              {TIER_SHORT[t]}
            </button>
          ))}
        </div>
      </div>

      {saveError && (
        <div className="mt-2">
          <PageError message={saveError} onRetry={pending ? () => set(pending) : undefined} />
        </div>
      )}

      {profile.notes && <p className="mt-1.5 text-[12px] leading-5 text-slate-600">{profile.notes}</p>}

      {/* The measured layer. Only rendered as a panel when there is something
          in it; otherwise the row says what is missing in one line, which is
          the honest answer for four of the five leagues. */}
      {signalsLive && signal && (signal.corpus || shown.length || signal.archetype) ? (
        <div className="mt-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
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
      ) : (
        <p className="mt-2 text-[11px] leading-5 text-slate-500">
          Nothing measured about this manager. The tier above is the only read we have,
          and it is yours, not a measurement.
        </p>
      )}
    </div>
  );
}

/** Why the measured half of this page is not on screen, in the user's terms. */
function SignalsGap({ title, reason, onRetry }: { title: string; reason: string; onRetry?: () => void }) {
  return (
    <section role="status" className="rounded-2xl border border-slate-300 bg-slate-50 p-4">
      <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">{title}</h2>
      <p className="mt-1.5 text-sm leading-6 text-slate-700">{reason}</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        The tiers below still work and still drive the trade finder — they are hand-set, not measured.
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-500">To fix: {CHAT_FIX}</p>
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
  const byRoster = useMemo(() => new Map(
    (signals.data?.managers ?? []).map(m => [String(m.roster_id), m])
  ), [signals.data]);

  const p = profiles.data;
  const others = (p?.managers ?? []).filter(m => String(m.roster_id) !== String(p?.my_roster_id ?? ''));

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
        You know things about these people that no model can find in the data — no fantasy league
        holds enough trade history to learn it. Set each one here and the trade finder re-ranks
        around it. Anyone marked <b>never trades</b> is dropped from planning entirely rather than
        shown at the bottom of a list. Beside your read is the measured one, with the sample size
        it rests on.
      </p>

      {/* Two independent reads: a missing or degraded signals layer must never
          take the hand-set tiers, which are the half that always works, off
          the screen with it. */}
      {signals.loading && !signals.data && <PageLoading label="Reading manager signals…" />}

      {!signals.loading && signals.error && (
        <SignalsGap
          title="Measured manager signals are not on screen"
          reason={/\b404\b/.test(signals.error)
            ? 'This server does not serve measured manager signals yet: the endpoint answered 404. '
              + 'Nothing is being hidden — there is nothing there to read.'
            : `The signals request failed: ${signals.error}.`}
          onRetry={signals.refetch}
        />
      )}

      {!signals.error && signals.data?.error && (
        <SignalsGap title="Measured manager signals are not on screen" reason={signals.data.error} />
      )}

      {!signals.error && signals.data && !signals.data.error && signals.data.available === false && (
        <SignalsGap
          title="No manager signals for this league"
          reason={signals.data.reason
            || 'The server reported the signal layer unavailable for this league without a reason.'}
        />
      )}

      {signalsLive && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">Where these numbers come from</h2>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            Computed {signals.data?.computed_at ?? 'at an unrecorded time'} ·{' '}
            {byRoster.size} manager{byRoster.size === 1 ? '' : 's'} read ·{' '}
            {[...byRoster.values()].filter(m => m.corpus).length} with a chat corpus
          </p>
          {!!signals.data?.sources && Object.keys(signals.data.sources).length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {Object.entries(signals.data.sources).map(([key, meta]) => (
                <li key={key} className="text-[11px] leading-5 text-slate-600">
                  <b className="text-slate-800">{key}</b> — {asText(meta)}
                </li>
              ))}
            </ul>
          )}
          {!!signals.data?.identity_warnings?.length && (
            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <div className="text-[11px] font-black uppercase tracking-wide text-amber-900">
                Identity is not certain for every manager
              </div>
              <ul className="mt-1 space-y-0.5">
                {signals.data.identity_warnings.map((w, i) => (
                  <li key={i} className="text-[11px] leading-5 text-amber-900">{asText(w)}</li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] leading-5 text-amber-800">
                A chat signal attached to the wrong person is worse than no signal, so these are
                named rather than quietly priced.
              </p>
            </div>
          )}
        </section>
      )}

      {/* The hand-set tiers. */}
      {profiles.loading && !p && <PageLoading label="Loading managers…" />}
      {!profiles.loading && profiles.error && !p && (
        <PageError message={profiles.error} onRetry={profiles.refetch} />
      )}
      {p?.error && (
        <section role="status" className="rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">No managers to set yet</h2>
          <p className="mt-1.5 text-sm leading-6 text-slate-700">{p.error}</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Sync this league from <Link className="font-semibold text-emerald-700" to="/league">League Hub</Link>,
            then come back — the roster list is what the tiers hang off.
          </p>
        </section>
      )}

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
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {others.map(m => (
            <ManagerRow key={m.roster_id} profile={m} leagueId={leagueId} signalsLive={signalsLive}
              signal={byRoster.get(String(m.roster_id)) ?? null}
              onSaved={profiles.refetch} />
          ))}
        </div>
      )}

      {p?.note && <p className="text-[12px] leading-5 text-slate-500">{p.note}</p>}
    </div>
  );
}
