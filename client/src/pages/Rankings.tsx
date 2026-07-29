import { useEffect, useState } from 'react';
import { api, RankingEntry, useApi } from '../api';

const TIER_COLORS = ['', '#f43f5e', '#f59e0b', '#10b981', '#38bdf8', '#a78bfa', '#64748b'];

export default function Rankings() {
  const { data: sets, refetch: refetchSets } = useApi<any[]>('/rankings');
  const [setId, setSetId] = useState<number | null>(null);
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  useEffect(() => {
    if (sets && sets.length && setId === null) setSetId(sets[0].id);
  }, [sets, setId]);

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
    const es = await api<RankingEntry[]>(`/rankings/${setId}/entries`);
    setEntries(es);
    setSearch('');
  };

  const visible = entries.map((e, i) => ({ e, i })).filter(({ e }) => filter === 'ALL' || e.position === filter);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-2xl font-bold">Rankings</h1>
        <select className="input" value={setId ?? ''} onChange={e => setSetId(Number(e.target.value))}>
          {sets?.map(s => <option key={s.id} value={s.id}>{s.name} ({s.entry_count})</option>)}
        </select>
        <button className="btn-ghost" onClick={createSet}>+ New set</button>
        <div className="ml-auto flex gap-2 items-center">
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
            <button key={p} onClick={() => setFilter(p)}
              className={`btn ${filter === p ? 'bg-slate-200 text-white' : 'bg-slate-100 text-slate-600'}`}>{p}</button>
          ))}
          <button className="btn-primary disabled:opacity-40" disabled={!dirty} onClick={save}>
            {dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      <div className="relative mb-4 max-w-md">
        <input className="input w-full" placeholder="Add a player to this board… (search)"
          value={search} onChange={e => setSearch(e.target.value)} />
        {searchResults.length > 0 && (
          <div className="absolute z-10 top-full mt-1 w-full card p-1">
            {searchResults.map(p => (
              <button key={p.id} onClick={() => addPlayer(p.id)}
                className="w-full text-left px-3 py-1.5 rounded hover:bg-slate-100 text-sm flex gap-2">
                <span className={`font-bold pos-${p.position}`}>{p.position}</span>
                {p.name} <span className="text-slate-500 ml-auto">{p.team_abbr}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card divide-y divide-slate-200/60">
        {visible.map(({ e, i }, vIdx) => (
          <div key={e.player_id}
            draggable={filter === 'ALL'}
            onDragStart={() => setDragIdx(i)}
            onDragOver={ev => ev.preventDefault()}
            onDrop={() => { if (dragIdx !== null && dragIdx !== i) move(dragIdx, i); setDragIdx(null); }}
            className={`flex items-center gap-3 px-4 py-2 text-sm ${filter === 'ALL' ? 'cursor-grab' : ''} hover:bg-slate-100/40 ${
              vIdx > 0 && visible[vIdx - 1].e.tier !== e.tier && filter === 'ALL' ? 'border-t-2 !border-t-slate-600' : ''}`}>
            <span className="w-8 text-right text-slate-500 font-mono">{i + 1}</span>
            <span className="w-1.5 h-6 rounded" style={{ background: TIER_COLORS[e.tier] ?? '#64748b' }} title={`Tier ${e.tier}`} />
            <span className={`font-bold w-8 pos-${e.position}`}>{e.position}</span>
            <a href={`/players/${e.player_id}`} className="font-medium hover:text-emerald-700 hover:underline">{e.name}</a>
            <span className="text-slate-500">{e.team_abbr}</span>
            <input
              className="ml-auto bg-transparent border-none text-xs text-slate-600 focus:outline-none w-64 text-right placeholder:text-slate-300"
              placeholder="add note…"
              value={e.note ?? ''}
              onChange={ev => { const v = ev.target.value; setEntries(es => es.map(x => x.player_id === e.player_id ? { ...x, note: v } : x)); setDirty(true); }}
            />
            <select className="bg-slate-100 rounded text-xs px-1 py-0.5 text-slate-700" value={e.tier}
              onChange={ev => { const t = Number(ev.target.value); setEntries(es => es.map(x => x.player_id === e.player_id ? { ...x, tier: t } : x)); setDirty(true); }}>
              {[1, 2, 3, 4, 5, 6].map(t => <option key={t} value={t}>T{t}</option>)}
            </select>
            <div className="flex flex-col">
              <button className="text-slate-500 hover:text-slate-900 text-xs leading-none" onClick={() => move(i, i - 1)}>▲</button>
              <button className="text-slate-500 hover:text-slate-900 text-xs leading-none" onClick={() => move(i, i + 1)}>▼</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
