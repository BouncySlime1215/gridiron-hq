import { useEffect, useState } from 'react';
import { api, headshotUrl, RankingEntry, useApi } from '../api';
import { TIER_COLORS } from '../components/PlayerRow';
import { StatRow, StatHeader, colsFor, StatMode } from '../components/StatTable';

const TIER_LABEL = ['', 'Elite', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5', 'Deep'];

export default function Rankings() {
  const { data: sets, refetch: refetchSets } = useApi<any[]>('/rankings');
  const [setId, setSetId] = useState<number | null>(null);
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [mode, setMode] = useState<StatMode>('projected');

  useEffect(() => { if (sets && sets.length && setId === null) setSetId(sets[0].id); }, [sets, setId]);

  useEffect(() => {
    if (setId == null) return;
    api<RankingEntry[]>(`/rankings/${setId}/entries`).then(es => { setEntries(es); setDirty(false); });
  }, [setId]);

  useEffect(() => {
    if (search.length < 2) { setSearchResults([]); return; }
    const t = setTimeout(() => {
      api<any[]>(`/players?q=${encodeURIComponent(search)}`).then(ps =>
        setSearchResults(ps.filter(p => !entries.some(e => e.player_id === p.id)).slice(0, 8)));
    }, 200);
    return () => clearTimeout(t);
  }, [search, entries]);

  const save = async () => {
    if (setId == null) return;
    await api(`/rankings/${setId}/entries`, {
      method: 'PUT',
      body: JSON.stringify(entries.map((e, i) => ({ ...e, rank: i + 1 })))
    });
    setEntries(es => es.map((e, i) => ({ ...e, rank: i + 1 })));
    setDirty(false);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length) return;
    setEntries(es => {
      const next = [...es];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setDirty(true);
  };

  const patch = (playerId: number, fields: Partial<RankingEntry>) => {
    setEntries(es => es.map(x => x.player_id === playerId ? { ...x, ...fields } : x));
    setDirty(true);
  };

  const createSet = async () => {
    const name = prompt('Ranking set name?');
    if (!name) return;
    const copy = setId != null && confirm('Copy current board into the new set?');
    const s = await api('/rankings', { method: 'POST', body: JSON.stringify({ name, copyFrom: copy ? setId : undefined }) });
    await refetchSets();
    setSetId(s.id);
  };

  const addPlayer = async (pid: number) => {
    if (setId == null) return;
    await api(`/rankings/${setId}/entries`, { method: 'POST', body: JSON.stringify({ player_id: pid }) });
    setEntries(await api<RankingEntry[]>(`/rankings/${setId}/entries`));
    setSearch('');
  };

  const visible = entries.map((e, i) => ({ e, i })).filter(({ e }) => filter === 'ALL' || e.position === filter);
  const canDrag = filter === 'ALL';
  // one position filtered = show that position's columns; ALL = generic receiving line
  const statCols = colsFor(filter);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-2xl font-bold">Rankings</h1>
        <select className="input" value={setId ?? ''} onChange={e => setSetId(Number(e.target.value))}>
          {sets?.map(s => <option key={s.id} value={s.id}>{s.name} ({s.entry_count})</option>)}
        </select>
        <button className="btn-ghost" onClick={createSet}>+ New set</button>
        <div className="ml-auto flex gap-1.5 items-center">
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
            <button key={p} onClick={() => setFilter(p)}
              className={`btn ${filter === p ? 'bg-sky-100 text-sky-900 border border-sky-200' : 'bg-white text-slate-500 hover:bg-sky-50'}`}>{p}</button>
          ))}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            {(['projected', 'actual'] as StatMode[]).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2.5 py-1.5 text-xs font-semibold ${mode === m ? 'bg-sky-100 text-sky-900' : 'bg-white text-slate-500 hover:bg-sky-50'}`}>
                {m === 'projected' ? '2026 proj' : '2025 actual'}
              </button>
            ))}
          </div>
          <button className="btn-primary disabled:opacity-40" disabled={!dirty} onClick={save}>
            {dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      <div className="relative mb-4 max-w-md">
        <input className="input w-full" placeholder="Add a player to this board… (search)"
          value={search} onChange={e => setSearch(e.target.value)} />
        {searchResults.length > 0 && (
          <div className="absolute z-10 top-full mt-1 w-full card p-1 shadow-lg">
            {searchResults.map(p => (
              <button key={p.id} onClick={() => addPlayer(p.id)}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-100 text-sm flex items-center gap-2">
                <img src={p.headshot ?? ''} alt="" className="w-7 h-7 rounded-full bg-slate-100 object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                <span className={`font-bold text-xs w-8 pos-${p.position}`}>{p.position}</span>
                <span className="font-medium">{p.name}</span>
                <span className="text-slate-400 ml-auto text-xs">{p.team_abbr}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!canDrag && <p className="text-xs text-slate-500 mb-2">Showing {filter} only — switch to ALL to drag-reorder.</p>}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><StatHeader cols={statCols} mode={mode}><th className="px-2 py-2 w-24" /></StatHeader></thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map(({ e, i }, vIdx) => {
                const prevTier = vIdx > 0 ? visible[vIdx - 1].e.tier : null;
                const isBreak = canDrag && prevTier != null && prevTier !== e.tier;
                return (
                  <>
                    {isBreak && (
                      <tr key={`t${e.player_id}`}>
                        <td colSpan={statCols.length + 7} className="px-3 py-1 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: TIER_COLORS[e.tier] }} />
                          {TIER_LABEL[e.tier] ?? `Tier ${e.tier}`}
                        </td>
                      </tr>
                    )}
                    <StatRow key={e.player_id} e={e} mode={mode} cols={statCols}>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1 justify-end">
                          {editing === e.player_id ? (
                            <input autoFocus className="input py-0.5 text-xs w-32" placeholder="note…"
                              value={e.note ?? ''} onChange={ev => patch(e.player_id, { note: ev.target.value })}
                              onBlur={() => setEditing(null)}
                              onKeyDown={ev => { if (ev.key === 'Enter') setEditing(null); }} />
                          ) : (
                            <button className="text-[11px] text-slate-300 hover:text-slate-600"
                              title={e.note || 'add note'} onClick={() => setEditing(e.player_id)}>
                              {e.note ? '✎*' : '✎'}
                            </button>
                          )}
                          <select className="bg-slate-50 border border-slate-200 rounded text-[10px] px-1 py-0.5 text-slate-600"
                            value={e.tier} onChange={ev => patch(e.player_id, { tier: Number(ev.target.value) })}>
                            {[1, 2, 3, 4, 5, 6].map(t => <option key={t} value={t}>T{t}</option>)}
                          </select>
                          <div className="flex flex-col leading-none">
                            <button className="text-slate-300 hover:text-slate-700 text-[9px]" onClick={() => move(i, i - 1)}>▲</button>
                            <button className="text-slate-300 hover:text-slate-700 text-[9px]" onClick={() => move(i, i + 1)}>▼</button>
                          </div>
                        </div>
                      </td>
                    </StatRow>
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <p className="p-6 text-sm text-slate-500 text-center">No players at this filter.</p>}
      </div>
    </div>
  );
}
