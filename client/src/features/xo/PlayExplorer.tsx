import { useMemo, useState } from 'react';

export interface PlayAssignment {
  id: string; label: string; side: 'offense' | 'defense'; start: [number, number]; path: [number, number][];
  responsibility: string; fantasy_connection?: string;
}
export interface PlayDefinition {
  id: string; name: string; personnel: string; concept: string; description: string;
  observed?: boolean; source?: string | null; assignments: PlayAssignment[];
}

const line = (points: [number, number][]) => points.map(point => point.join(',')).join(' ');

export default function PlayExplorer({ play }: { play: PlayDefinition }) {
  const [step, setStep] = useState(0);
  const [perspective, setPerspective] = useState<'offense' | 'defense'>('offense');
  const max = Math.max(0, ...play.assignments.map(x => x.path.length));
  const assignments = useMemo(() => play.assignments.filter(x => x.side === perspective), [play, perspective]);
  const active = assignments.map(x => ({ ...x, visiblePath: [x.start, ...x.path.slice(0, step)] as [number, number][] }));

  return <section className="card overflow-hidden" aria-labelledby="play-title">
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
      <div><h2 id="play-title" className="font-bold">{play.name}</h2><p className="text-xs text-slate-500">{play.personnel} · {play.concept}</p></div>
      <div className="ml-auto flex gap-2"><button className={perspective === 'offense' ? 'btn-primary' : 'btn-ghost'} onClick={() => setPerspective('offense')}>Offense</button>
        <button className={perspective === 'defense' ? 'btn-primary' : 'btn-ghost'} onClick={() => setPerspective('defense')}>Defense</button></div>
    </header>
    <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <div className="bg-emerald-800 p-3">
        <svg viewBox="0 0 100 54" className="w-full" role="img" aria-label={`${play.name}, step ${step} of ${max}`}>
          <rect width="100" height="54" fill="#166534" />
          {Array.from({ length: 11 }, (_, index) => <line key={index} x1={index * 10} x2={index * 10} y1="0" y2="54" stroke="white" strokeOpacity=".25" strokeWidth=".25" />)}
          <line x1="0" x2="100" y1="27" y2="27" stroke="white" strokeWidth=".6" />
          {active.map(item => <g key={item.id}><polyline points={line(item.visiblePath)} fill="none" stroke={item.side === 'offense' ? '#fde047' : '#7dd3fc'} strokeWidth=".8" strokeDasharray={item.side === 'defense' ? '1.5 1' : undefined} />
            <circle cx={item.start[0]} cy={item.start[1]} r="1.8" fill={item.side === 'offense' ? '#fde047' : '#7dd3fc'} /><text x={item.start[0]} y={item.start[1] - 2.6} textAnchor="middle" fontSize="2.2" fill="white">{item.label}</text></g>)}
        </svg>
      </div>
      <aside className="p-4"><p className="text-sm text-slate-600">{play.description}</p>
        <p className="mt-2 text-xs font-semibold">{play.observed ? `Observed${play.source ? ` · ${play.source}` : ''}` : 'Modeled concept — not observed charting'}</p>
        <ol className="mt-4 space-y-3">{active.map(item => <li key={item.id} className="text-xs"><span className="font-bold">{item.label}:</span> {item.responsibility}{item.fantasy_connection && <span className="block text-emerald-700">Fantasy: {item.fantasy_connection}</span>}</li>)}</ol>
      </aside>
    </div>
    <footer className="flex items-center gap-3 border-t border-slate-200 p-3">
      <button className="btn-ghost" disabled={step === 0} onClick={() => setStep(x => Math.max(0, x - 1))}>Previous</button>
      <input aria-label="Playback step" type="range" min="0" max={max} value={step} onChange={event => setStep(Number(event.target.value))} className="min-w-0 flex-1" />
      <span className="text-xs text-slate-500">{step}/{max}</span>
      <button className="btn-primary" disabled={step === max} onClick={() => setStep(x => Math.min(max, x + 1))}>Next</button>
    </footer>
  </section>;
}

