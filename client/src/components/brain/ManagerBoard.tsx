import { useMemo, useState } from 'react';
import { useApi } from '../../api';
import ManagerCard, { type PulseItem } from './ManagerCard';
import { useCoach } from '../../state/coach';
import { Link } from 'react-router-dom';
import { PageError, PageLoading } from '../PageState';
import { logServerDetail, sanitizedMessage } from '../../lib/errorSanitize';
import type { ProfilesResponse, SignalsResponse } from './types';

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
  const coach = useCoach();
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
            <ManagerCard key={m.roster_id} profile={m} leagueId={leagueId} signalsLive={signalsLive}
              signal={byRoster.get(String(m.roster_id)) ?? null} pulse={pulse.data?.enabled ? pulse.data.items ?? [] : null}
              onAsk={coach.enabled ? coach.open : undefined}
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
