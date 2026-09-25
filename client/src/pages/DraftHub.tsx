import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Drafts from './Drafts';
import LiveDraft from './LiveDraft';
import { Chip, PageHeader, Tabs } from '../components/ui/DesignSystem';
import { useApi } from '../api';
import { EmptyState, PageData } from '../components/PageState';

type View = 'boards' | 'survival' | 'live' | 'recaps';
const VIEWS: { id: View; label: string }[] = [
  { id: 'boards', label: 'Boards' }, { id: 'survival', label: 'Who survives' }, { id: 'live', label: 'Live' }, { id: 'recaps', label: 'Recaps' }
];
// Older links: ?view=mock was the boards tab, ?view=recap the recaps tab.
const viewOf = (v: string | null): View => (v === 'mock' ? 'boards' : v === 'recap' ? 'recaps' : VIEWS.some(x => x.id === v) ? v as View : 'boards');

/**
 * The Draft area (docs/ui/CONSOLIDATION-MAP.md): Boards (mock drafts and manual trackers),
 * Who survives, Live (link an ESPN draft) and Recaps (finished drafts and their grade), one
 * title, views on ?view=. A draft itself opens at /draft/:id, a live one at /draft/live/:id.
 */
export default function DraftHub() {
  const [params, setParams] = useSearchParams();
  const view = viewOf(params.get('view'));
  const setView = (v: View) => setParams(() => (v === 'boards' ? new URLSearchParams() : new URLSearchParams(`view=${v}`)), { replace: true });
  return <div>
    <PageHeader eyebrow="Draft" title="Draft" description="Practice with mock drafts, see who lasts to your next pick, mirror a live ESPN draft, and read the grade afterwards." />
    <div className="mb-5"><Tabs label="Draft views" value={view} onChange={setView} tabs={VIEWS} /></div>
    {view === 'live' ? <LiveDraft /> : view === 'survival' ? <DraftSurvival /> : view === 'recaps' ? <Recaps /> : <Drafts />}
  </div>;
}

/** Finished drafts, newest first, each opening its recap and grade (DraftRecap on /draft/:id?recap=1). */
function Recaps() {
  const { data, loading, error, refetch } = useApi<any[]>('/drafts');
  const done = (data ?? []).filter(d => d.team_count && d.rounds && d.picks_made >= d.team_count * d.rounds);
  return (
    <PageData data={data} loading={loading} error={error} onRetry={refetch} loadingLabel="Loading drafts…"
      isEmpty={() => done.length === 0}
      empty={<EmptyState title="No finished drafts yet" description="Finish a mock draft (or sim it to the end) and its recap and grade show up here." />}>
      {() => (
        <div className="grid gap-3 md:grid-cols-2">
          {done.map(d => (
            <Link key={d.id} to={`/draft/${d.id}?recap=1`} className="ds-card ds-lift block p-4">
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-semibold">{d.name}</span>
                <Chip tone="good">Finished</Chip>
              </span>
              <span className="ds-note mt-1 block">{d.team_count} teams · {d.rounds} rounds · pick {d.my_slot}</span>
              <span className="mt-2 block text-sm font-semibold text-[var(--c-accent)]">Recap and grade →</span>
            </Link>
          ))}
        </div>
      )}
    </PageData>
  );
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
  const { data, loading, error, refetch } = useApi<any>(`/edge/draft-survival?seat=${seat}&teams=${teams}&trials=3000`);

  return (
    <div>
      <div className="ds-card p-4 mb-3">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            League size
            <select className="input w-20 text-sm" value={teams} onChange={e => setTeams(Number(e.target.value))}>
              {[8, 10, 12, 14].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            Your seat
            <select className="input w-20 text-sm" value={seat} onChange={e => setSeat(Number(e.target.value))}>
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

      <PageData data={data} loading={loading} error={error} onRetry={refetch}
        loadingLabel="Simulating the rest of the draft…">
        {(data) => (
          data.error ? <div className="ds-card p-6 text-sm text-crit">{data.error}</div> : (
            <>
              <div className="ds-card p-4 mb-3">
                <p className="text-sm text-slate-800">{data.guidance}</p>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                {([['take_now', 'Take now — gone by your next pick', 'rose'],
                   ['can_wait', 'Can wait — comes back to you', 'emerald']] as const).map(([key, title, tone]) => (
                  <div key={key} className="ds-card overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5">
                      <Chip tone={tone === 'rose' ? 'bad' : 'good'}>{tone === 'rose' ? 'Take now' : 'Can wait'}</Chip>
                      <span className="text-sm font-semibold">{title.split(' — ')[1]}</span>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {(data[key] ?? []).map((p: any) => (
                        <div key={p.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                          <span className={`text-[9px] font-black pos-${p.position}`}>{p.position}</span>
                          <span className="font-semibold text-slate-800 truncate">{p.name}</span>
                          <span className="text-[11px] text-slate-500">{p.team_abbr}</span>
                          <span className="ml-auto text-right tabular-nums">
                            <span className="block text-xs font-bold text-slate-800">
                              {Math.round((p.survives_pick_after ?? 0) * 100)}%
                            </span>
                            <span className="block text-[10px] text-slate-500">back at your next</span>
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
              <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">{data.note}</p>
            </>
          )
        )}
      </PageData>
    </div>
  );
}
