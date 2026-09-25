import { useApi } from '../../api';
import { useLeague } from '../../state/league';
import { asText } from './types';
import type { SignalsResponse } from './types';

/**
 * Settings → AI & developer: where Trades → People's measured reads come from, for whoever maintains
 * them. The data sources with their refresh paths, the identity-matching notes, and what would fill a
 * missing layer. Kept off Trades → People on purpose (Nick's cleanup: no script or file names there).
 */
export const CHAT_FIX = 'The chat layer comes from the private league-chat database. Pull it from '
  + 'Settings; the archetype and outcome metrics come from the manager-archetype build '
  + '(scripts/build-manager-archetypes.mjs) and refresh on the normal league sync.';

export default function ManagerDataSources() {
  const { activeId } = useLeague();
  const signals = useApi<SignalsResponse>(activeId ? `/trades/${activeId}/managers/signals` : null);
  const d = signals.data;
  return (
    <section data-testid="manager-data-sources">
      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Manager reads: data sources</h3>
      {!d && <p className="ds-note mt-1">{signals.loading ? 'Reading…' : 'No manager signals for this league.'}</p>}
      {d && <>
        <p className="ds-note mt-1">Computed {d.computed_at ?? 'at an unrecorded time'} · {(d.managers ?? []).length} managers read · {(d.managers ?? []).filter(m => m.corpus).length} with a chat corpus</p>
        {!!d.sources && Object.keys(d.sources).length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {Object.entries(d.sources).map(([key, meta]) => <li key={key} className="text-[11px] leading-5 text-slate-600"><b>{key}</b> · {asText(meta)}</li>)}
          </ul>
        )}
        {!!d.identity_warnings?.length && (
          <div className="mt-2">
            <div className="text-[11px] font-semibold text-slate-700">Identity is not certain for every manager</div>
            <ul className="mt-1 space-y-0.5">{d.identity_warnings.map((w, i) => <li key={i} className="text-[11px] leading-5 text-slate-600">{asText(w)}</li>)}</ul>
            <p className="ds-note mt-1">A chat signal attached to the wrong person is worse than no signal, so these are named rather than quietly priced.</p>
          </div>
        )}
      </>}
      <p className="ds-note mt-2">To fix a missing layer: {CHAT_FIX}</p>
    </section>
  );
}
