import { useState } from 'react';
import Edge from './Edge';
import Model from './Model';

/**
 * Edge Tools and the Prediction Engine, merged into one hub.
 *
 * They were always two views of the same engine — Edge asks "who should I
 * start or trade for", the Prediction Engine asks "how good are the numbers
 * behind that". Keeping them apart meant switching pages mid-thought.
 *
 * Nothing was dropped in the merge: all seven Edge tabs and all five engine
 * tabs render the same components as before, just under one bar. Each page
 * still works standalone; passing `tab`/`embedded` is what lets this own the
 * navigation without either page drawing its own.
 */
const GROUPS = [
  {
    id: 'tools', label: 'Edge Tools', source: 'edge' as const,
    tabs: [
      ['vor', 'Value Board'], ['movers', 'Breakouts & Regression'],
      ['volatility', 'Boom / Bust'], ['efficiency', 'Efficiency'],
      ['schedule', 'Playoff Schedule'], ['trade', 'Trade Analyzer'],
      ['sim', 'Season Simulator']
    ] as [string, string][]
  },
  {
    id: 'engine', label: 'Prediction Engine', source: 'model' as const,
    tabs: [
      ['accuracy', 'Accuracy'], ['odds', 'Championship Odds'],
      ['correlation', 'Correlation'], ['gamescript', 'Game Script'],
      ['handcuffs', 'Handcuffs']
    ] as [string, string][]
  }
];

const BLURB: Record<string, string> = {
  vor: 'Points over replacement — the real draft currency',
  movers: 'Who the projections are moving on, and why',
  volatility: 'Weekly floor, ceiling and consistency from real games',
  efficiency: 'Rate stats — usage share, yards per opportunity, TD-rate regression',
  schedule: 'Weeks 15-17 strength, ranked easiest to hardest',
  trade: 'Value both sides on VOR, not vibes',
  sim: 'Monte Carlo your lineup from real distributions',
  accuracy: 'How the model scores against the baselines it has to beat',
  odds: 'Championship odds from a correlated season simulation',
  correlation: 'What rises together, and what cannot',
  gamescript: 'What the betting line predicts about volume',
  handcuffs: 'Who inherits the work if someone goes down'
};

export default function FantasyLab() {
  const [group, setGroup] = useState(GROUPS[0].id);
  const [tab, setTab] = useState<string>('vor');

  const active = GROUPS.find(g => g.id === group)!;

  const switchGroup = (id: string) => {
    const g = GROUPS.find(x => x.id === id)!;
    setGroup(id);
    setTab(g.tabs[0][0]);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Fantasy Lab</h1>
        <div className="flex gap-1 ml-auto">
          {GROUPS.map(g => (
            <button key={g.id} onClick={() => switchGroup(g.id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
                group === g.id
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
              }`}>{g.label}</button>
          ))}
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">{BLURB[tab] ?? ''}</p>

      <div className="flex gap-1 border-b border-slate-200 mb-4 overflow-x-auto">
        {active.tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>{label}</button>
        ))}
      </div>

      {active.source === 'edge'
        ? <Edge tab={tab as any} embedded />
        : <Model tab={tab as any} embedded />}
    </div>
  );
}
