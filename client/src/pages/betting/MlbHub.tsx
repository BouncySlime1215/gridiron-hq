import { Suspense, lazy, useState } from 'react';

/**
 * One MLB surface instead of six routes.
 *
 * MLB had grown into `/betting/mlb`, `/betting/mlb/legacy`, `/betting/mlb/auto`,
 * `/betting/mlb/auto-legacy`, `/betting/mlb/picks` and `/betting/mlb/model` —
 * two of them explicitly named "legacy", all reachable, none of them telling you
 * which was current. Meanwhile NFL sits behind a single hub with tabs. This is
 * the same shape applied to MLB: the pages are unchanged, the navigation stops
 * being a maze.
 *
 * Both backends stayed live during that drift, so the tabs point at whichever
 * one is actually the source for a given view rather than pretending one
 * replaced the other.
 */

const MlbBoard = lazy(() => import('./MlbBoard'));
const MlbAutoPicks = lazy(() => import('./MlbAutoPicks'));
const PropsPicks = lazy(() => import('../props/PropsPicks'));
const PropsModel = lazy(() => import('../props/PropsModel'));
const PropsBoard = lazy(() => import('../props/PropsBoard'));

type Tab = 'board' | 'auto' | 'picks' | 'model' | 'legacy';

const TABS: { id: Tab; label: string; note: string }[] = [
  { id: 'board', label: 'Board', note: 'Today’s slate and prices' },
  { id: 'auto', label: 'Auto picks', note: 'Policy output and pregame status' },
  { id: 'picks', label: 'My picks', note: 'Tracked bets and settled results' },
  { id: 'model', label: 'Model', note: 'Fit, calibration and limits' },
  { id: 'legacy', label: 'Legacy board', note: 'The older props surface' }
];

export default function MlbHub({ initialTab = 'board' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-slate-400">MLB betting</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Diamond Desk</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Player props and game markets. The same discipline as the NFL desk applies: the model may
          not size a bet until it has demonstrated closing-line value, and props carry roughly twice
          the hold of sides, so a prop edge has to be materially larger to clear the same bar.
        </p>
      </div>

      <div role="tablist"
        className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-2 sm:grid-cols-3 lg:grid-cols-5">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`rounded-xl px-3 py-2.5 text-left transition-colors ${
              tab === t.id ? 'bg-sky-50 text-sky-900 ring-1 ring-sky-200'
                : 'text-slate-600 hover:bg-slate-50'}`}>
            <div className="text-sm font-semibold">{t.label}</div>
            <div className={`mt-0.5 text-xs ${tab === t.id ? 'text-sky-700/70' : 'text-slate-400'}`}>
              {t.note}
            </div>
          </button>
        ))}
      </div>

      <Suspense fallback={<div className="card p-6 text-sm text-slate-500">Loading…</div>}>
        {tab === 'board' && <MlbBoard />}
        {tab === 'auto' && <MlbAutoPicks />}
        {tab === 'picks' && <PropsPicks />}
        {tab === 'model' && <PropsModel />}
        {tab === 'legacy' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              The older props board, kept because it is still the only view of some markets. If it
              shows you something the current board does not, that is a gap in the current board
              rather than a reason to keep two of them forever.
            </div>
            <PropsBoard />
          </div>
        )}
      </Suspense>
    </div>
  );
}
