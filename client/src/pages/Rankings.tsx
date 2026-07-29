import { useEffect, useState } from 'react';
import { api, headshotUrl, RankingEntry, useApi } from '../api';
import PlayerRow, { TIER_COLORS } from '../components/PlayerRow';

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

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-2xl font-bold">Rankings</h1>
        <select className="input" value={setId ?? ''} onChange={e => setSetId(Number(e.target.value))}>
          {sets?.map(s => <option key={s.id} value={s.id}>{s.name} ({s.entry_count})</option>)}
        </select>
        <button className="btn-ghost" onClick={createSet}>+ New set</button>
        <div className="ml-auto flex gap-1.5 items-center">
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
            <button key={p} onClick={() => setFilter(p)}
              className={`btn ${filter === p ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>{p}</button>
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

      <div className="card divide-y divide-slate-100 overflow-hidden">
        {visible.map(({ e, i }, vIdx) => {
          const prevTier = vIdx > 0 ? visible[vIdx - 1].e.tier : null;
          const isBreak = canDrag && prevTier != null && prevTier !== e.tier;
          return (
            <div key={e.player_id}
              draggable={canDrag}
              onDragStart={() => setDragIdx(i)}
              onDragOver={ev => ev.preventDefault()}
              onDrop={() => { if (dragIdx !== null && dragIdx !== i) move(dragIdx, i); setDragIdx(null); }}>
              {isBreak && (
                <div className="px-3 py-1 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: TIER_COLORS[e.tier] }} />
                  {TIER_LABEL[e.tier] ?? `Tier ${e.tier}`}
                </div>
              )}
              <PlayerRow
                playerId={e.player_id}
                rank={i + 1}
                name={e.name}
                position={e.position}
                teamAbbr={e.team_abbr}
                headshot={headshotUrl(e as any)}
                tier={e.tier}
                meta={editing === e.player_id ? null : (e.note || undefined)}
                right={
                  <div className="flex items-center gap-2" onClick={ev => ev.stopPropagation()}>
                    {editing === e.player_id ? (
                      <input autoFocus className="input py-0.5 text-xs w-56" placeholder="note…"
                        value={e.note ?? ''} onChange={ev => patch(e.player_id, { note: ev.target.value })}
                        onBlur={() => setEditing(null)}
                        onKeyDown={ev => { if (ev.key === 'Enter') setEditing(null); }} />
                    ) : (
                      <button className="text-[11px] text-slate-300 hover:text-slate-600"
                        onClick={() => setEditing(e.player_id)}>✎ note</button>
                    )}
                    <select className="bg-slate-50 border border-slate-200 rounded text-[11px] px-1 py-0.5 text-slate-600"
                      value={e.tier} onChange={ev => patch(e.player_id, { tier: Number(ev.target.value) })}>
                      {[1, 2, 3, 4, 5, 6].map(t => <option key={t} value={t}>T{t}</option>)}
                    </select>
                    <div className="flex flex-col leading-none">
                      <button className="text-slate-300 hover:text-slate-700 text-[10px]" onClick={() => move(i, i - 1)}>▲</button>
                      <button className="text-slate-300 hover:text-slate-700 text-[10px]" onClick={() => move(i, i + 1)}>▼</button>
                    </div>
                  </div>
                }
              />
            </div>
          );
        })}
        {visible.length === 0 && <p className="p-6 text-sm text-slate-500 text-center">No players at this filter.</p>}
      </div>
    </div>
  );
}
