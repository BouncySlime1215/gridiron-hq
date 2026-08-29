import { lazy, Suspense, useState } from 'react';
import { useApi } from '../../api';
import { BettingWorkspace, NextAction, WorkspaceNav } from '../../components/betting/BettingWorkspace';

const MlbBoard = lazy(() => import('./MlbBoard'));
const MlbAutoPicks = lazy(() => import('./MlbAutoPicks'));
const PropsPicks = lazy(() => import('../props/PropsPicks'));
const PropsModel = lazy(() => import('../props/PropsModel'));

type Tab = 'slate' | 'forward' | 'ledger' | 'model' | 'board' | 'auto' | 'picks' | 'legacy';
type View = 'slate' | 'forward' | 'ledger' | 'model';

interface MlbSummary {
  mlb: { standing: { tracked_picks: number; days_tracked: number; latest_slate: string | null; note: string } };
}

const normalize = (tab: Tab): View => tab === 'board' || tab === 'slate' ? 'slate' : tab === 'picks' || tab === 'ledger' ? 'ledger' : tab === 'model' || tab === 'legacy' ? 'model' : 'forward';

export default function MlbHub({ initialTab = 'slate' }: { initialTab?: Tab }) {
  const [view, setView] = useState<View>(() => normalize(initialTab));
  const { data } = useApi<MlbSummary>('/betting/summary');
  const standing = data?.mlb.standing;

  return <BettingWorkspace sport="mlb" title="MLB Evidence Workbench"
    description="The local model creates the slate; real pregame context and reachable prices create evidence. Retrospective rows remain visible for research but never enter the forward profit claim."
    activeStage={view === 'slate' ? 'scan' : view === 'forward' ? 'price' : view === 'ledger' ? 'track' : 'review'}>

    <WorkspaceNav value={view} onChange={setView} items={[
      { id: 'slate', label: 'Model slate', detail: 'Games, NRFI, props' },
      { id: 'forward', label: 'Forward capture', detail: 'Preserve price + context', count: standing?.tracked_picks || undefined },
      { id: 'ledger', label: 'Settled ledger', detail: 'Results without reconstruction' },
      { id: 'model', label: 'Proof room', detail: 'Calibration + limitations' }
    ]} />

    {view === 'forward' && <NextAction eyebrow="MLB next action" title="Capture tomorrow before the market closes"
      detail={`The ledger currently holds ${standing?.tracked_picks ?? 0} tracked picks across ${standing?.days_tracked ?? 0} days. Preserve probable starters, confirmed lineups and the actual offered price before evaluating the model.`}
      action={() => document.querySelector<HTMLButtonElement>('[data-prepare-mlb]')?.click()} />}

    <Suspense fallback={<div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading MLB workspace…</div>}>
      {view === 'slate' && <MlbBoard />}
      {view === 'forward' && <MlbAutoPicks />}
      {view === 'ledger' && <PropsPicks />}
      {view === 'model' && <PropsModel />}
    </Suspense>
  </BettingWorkspace>;
}
