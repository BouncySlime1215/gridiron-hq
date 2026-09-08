import { lazy, Suspense, useState } from 'react';
import { useApi } from '../../api';
import { BettingWorkspace, NextAction, WorkspaceNav } from '../../components/betting/BettingWorkspace';

const MlbBoard = lazy(() => import('./MlbBoard'));
const MlbAutoPicks = lazy(() => import('./MlbAutoPicks'));
const PropsBoard = lazy(() => import('../props/PropsBoard'));
const PropsAutoPicks = lazy(() => import('../props/PropsAutoPicks'));
const PropsPicks = lazy(() => import('../props/PropsPicks'));
const PropsModel = lazy(() => import('../props/PropsModel'));

type Tab = 'slate' | 'forward' | 'ledger' | 'model' | 'board' | 'auto' | 'picks' | 'legacy';
type View = 'slate' | 'forward' | 'ledger' | 'model';

/**
 * MLB has two parallel implementations of "the slate" and "today's picks":
 * the first-party model (`/mlb/board`, `/mlb/auto-picks`, built from
 * `mlb_games` / `mlb_market_quotes` / `mlb_first_party_picks`) and an older
 * proxied path (`/props/board`, `/props/auto-picks`). Both still return live
 * data — the proxied board answers with 31 rows and 120 projections — but
 * only the first-party pages were reachable. The proxied ones sat on
 * standalone `/props/*` routes that nothing in the app linked to, findable
 * only by typing the URL.
 *
 * Rather than delete a working second opinion or leave it orphaned, the two
 * sources are a toggle inside the views where they actually overlap. The
 * first-party path is the default because it is the one the rest of the
 * workbench is built on; the proxied one is labelled as what it is.
 */
type Source = 'first_party' | 'proxied';

interface MlbSummary {
  mlb: { standing: { tracked_picks: number; days_tracked: number; latest_slate: string | null; note: string } };
}

const normalize = (tab: Tab): View => tab === 'board' || tab === 'slate' ? 'slate' : tab === 'picks' || tab === 'ledger' ? 'ledger' : tab === 'model' || tab === 'legacy' ? 'model' : 'forward';

export default function MlbHub({ initialTab = 'slate', initialSource = 'first_party' }: {
  initialTab?: Tab; initialSource?: Source;
}) {
  const [view, setView] = useState<View>(() => normalize(initialTab));
  const [source, setSource] = useState<Source>(initialSource);
  const { data } = useApi<MlbSummary>('/betting/summary');
  const standing = data?.mlb.standing;
  const hasSourceToggle = view === 'slate' || view === 'forward';

  return <BettingWorkspace sport="mlb" title="MLB Evidence Workbench"
    description="The local model creates the slate; real pregame context and reachable prices create evidence. Retrospective rows remain visible for research but never enter the forward profit claim."
    activeStage={view === 'slate' ? 'scan' : view === 'forward' ? 'price' : view === 'ledger' ? 'track' : 'review'}>

    <WorkspaceNav value={view} onChange={setView} items={[
      { id: 'slate', label: 'Model slate', detail: 'Games, NRFI, props' },
      { id: 'forward', label: 'Forward capture', detail: 'Preserve price + context', count: standing?.tracked_picks || undefined },
      { id: 'ledger', label: 'Settled ledger', detail: 'Results without reconstruction' },
      { id: 'model', label: 'Proof room', detail: 'Calibration + limitations' }
    ]} />

    {hasSourceToggle && <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Source</span>
      {([['first_party', 'First-party model', 'Built here from mlb_games and captured quotes'],
         ['proxied', 'Proxied feed', 'The older vendor-priced path, kept as a second opinion']] as const)
        .map(([id, label, note]) => <button key={id} onClick={() => setSource(id)} title={note}
          aria-pressed={source === id}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${source === id
            ? 'bg-slate-950 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'}`}>{label}</button>)}
      <span className="text-xs text-slate-500">
        {source === 'first_party'
          ? 'The path the rest of this workbench is built on.'
          : 'A separate implementation of the same slate. Shown for comparison; it does not feed the forward ledger.'}
      </span>
    </div>}

    {view === 'forward' && <NextAction eyebrow="MLB next action" title="Capture tomorrow before the market closes"
      detail={`The ledger currently holds ${standing?.tracked_picks ?? 0} tracked picks across ${standing?.days_tracked ?? 0} days. Preserve probable starters, confirmed lineups and the actual offered price before evaluating the model.`}
      action={() => document.querySelector<HTMLButtonElement>('[data-prepare-mlb]')?.click()} />}

    <Suspense fallback={<div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading MLB workspace…</div>}>
      {view === 'slate' && (source === 'first_party' ? <MlbBoard /> : <PropsBoard />)}
      {view === 'forward' && (source === 'first_party' ? <MlbAutoPicks /> : <PropsAutoPicks />)}
      {view === 'ledger' && <PropsPicks />}
      {view === 'model' && <PropsModel />}
    </Suspense>
  </BettingWorkspace>;
}
