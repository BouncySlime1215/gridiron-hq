import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Drafts from './Drafts';
import LiveDraft from './LiveDraft';
import { PageHeader } from '../components/ui/DesignSystem';
import { useApi } from '../api';

type View = 'mock' | 'survival' | 'live' | 'recap';
export default function DraftHub() {
  const [params] = useSearchParams();
  const requested = params.get('view');
  const [view, setView] = useState<View>(requested === 'live' || requested === 'recap' ? requested : 'mock');
  return <div>
    <PageHeader eyebrow="Fantasy" title="Draft" description="Mock preparation, live ESPN tracking and completed draft recaps live in one workflow." />
    <div role="tablist" aria-label="Draft modes" className="mb-5 flex gap-1 border-b border-slate-200">
      {([['mock','Mock & boards'],['survival','Who survives'],['live','Live'],['recap','Recaps']] as const).map(([id,label]) => <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)} className={`border-b-2 px-3 py-2 text-sm font-semibold ${view === id ? 'border-emerald-600 text-emerald-800' : 'border-transparent text-slate-500'}`}>{label}</button>)}
    </div>
    {view === 'live' ? <LiveDraft /> : view === 'survival' ? <DraftSurvival /> : <Drafts />}
  </div>;
}

/**
 * Who is still on the board at your next pick.
 *
 * A board ranked by value cannot answer the question a drafter actually has,
 * because it has no model of what the other managers are about to do. This
 * does: it simulates the rest of the draft and reports survival, so the split
 * between "take him now" and "he comes back" is measured rather than felt.
 */
function DraftSurvival() {
  const [seat, setSeat] = useState(5);
  const [teams, setTeams] = useState(10);
  const { data, loading } = useApi<any>(`/edge/draft-survival?seat=${seat}&teams=${teams}&trials=3000`);

  return (
    <div>
      <div className="card p-4 mb-3">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            League size
            <select className="input text-sm" value={teams} onChange={e => setTeams(Number(e.target.value))}>
              {[8, 10, 12, 14].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            Your seat
            <select className="input text-sm" value={seat} onChange={e => setSeat(Number(e.target.value))}>
              {Array.from({ length: teams }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {data?.my_remaining_picks && (
            <span className="text-xs text-slate-500 ml-auto tabular-nums">
              your picks: {data.my_remaining_picks.join(' · ')}
            </span>
          )}
        </div>
      </div>

      {loading ? <div className="card p-6 text-sm text-slate-500">Simulating the rest of the draft…</div>
      : data?.error ? <div className="card p-6 text-sm text-rose-600">{data.error}</div>
      : (
        <>
          <div className="card p-4 mb-3 border-emerald-200 bg-emerald-50/40">
            <p className="text-sm text-slate-800">{data.guidance}</p>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {([['take_now', 'Take now — gone by your next pick', 'rose'],
               ['can_wait', 'Can wait — comes back to you', 'emerald']] as const).map(([key, title, tone]) => (
              <div key={key} className="card overflow-hidden">
                <div className={`px-4 py-2.5 border-b border-slate-200 text-sm font-bold ${
                  tone === 'rose' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>
                  {title}
                </div>
                <div className="divide-y divide-slate-100">
                  {(data[key] ?? []).map((p: any) => (
                    <div key={p.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <span className={`text-[9px] font-black pos-${p.position}`}>{p.position}</span>
                      <span className="font-semibold text-slate-800 truncate">{p.name}</span>
                      <span className="text-[11px] text-slate-400">{p.team_abbr}</span>
                      <span className="ml-auto text-right tabular-nums">
                        <span className="block text-xs font-bold text-slate-800">
                          {Math.round((p.survives_pick_after ?? 0) * 100)}%
                        </span>
                        <span className="block text-[10px] text-slate-400">back at your next</span>
                      </span>
                    </div>
                  ))}
                  {!(data[key] ?? []).length && (
                    <div className="px-4 py-3 text-xs text-slate-500">Nothing falls clearly into this bucket.</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">{data.note}</p>
        </>
      )}
    </div>
  );
}
