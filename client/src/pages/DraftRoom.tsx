import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Draft, useApi } from '../api';
import FormationView from '../components/FormationView';

const TIER_COLORS = ['', '#f43f5e', '#f59e0b', '#10b981', '#38bdf8', '#a78bfa', '#64748b'];

export default function DraftRoom() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: draft, refetch, loading } = useApi<Draft>(`/drafts/${id}`);
  const [filter, setFilter] = useState('ALL');
  const [showField, setShowField] = useState(false);

  const nextPick = (draft?.picks.length ?? 0) + 1;
  const round = draft ? Math.ceil(nextPick / draft.team_count) : 1;
  const posInRound = draft ? ((nextPick - 1) % draft.team_count) + 1 : 1;
  const onClockSlot = draft ? (round % 2 === 1 ? posInRound : draft.team_count - posInRound + 1) : 1;
  const myTurn = draft && onClockSlot === draft.my_slot;

  const [simming, setSimming] = useState(false);
  const simGuard = useRef(false);

  const simulate = async () => {
    if (simGuard.current) return;
    simGuard.current = true;
    setSimming(true);
    try { await api(`/drafts/${id}/simulate`, { method: 'POST' }); refetch(); }
    catch (e: any) { console.error(e); }
    finally { setSimming(false); simGuard.current = false; }
  };

  const draftOver = draft ? draft.picks.length >= draft.team_count * draft.rounds : false;

  // In mock drafts the CPU teams pick for themselves — auto-sim whenever it's not my turn.
  useEffect(() => {
    if (draft && draft.type === 'mock' && !myTurn && !draftOver && !simGuard.current) {
      const t = setTimeout(simulate, 400);
      return () => clearTimeout(t);
    }
  }, [draft, myTurn, draftOver]);

  const pick = async (playerId: number) => {
    await api(`/drafts/${id}/picks`, { method: 'POST', body: JSON.stringify({ player_id: playerId }) });
    refetch();
  };
  const undo = async () => {
    await api(`/drafts/${id}/picks/last`, { method: 'DELETE' });
    refetch();
  };

  const myPicks = useMemo(() => draft?.picks.filter(p => p.team_slot === draft.my_slot) ?? [], [draft]);

  const mySlots = useMemo(() => {
    const s: Record<string, { name: string; id: number }> = {};
    const take = (pos: string, codes: string[]) => {
      const players = myPicks.filter(p => p.position === pos);
      codes.forEach((c, i) => { if (players[i]) s[c] = { name: players[i].name, id: players[i].player_id }; });
    };
    take('QB', ['QB']);
    take('RB', ['RB1']);
    take('WR', ['WR1', 'WR2', 'WR3']);
    take('TE', ['TE1']);
    take('K', ['K']);
    return s;
  }, [myPicks]);

  const available = (draft?.available ?? []).filter(a => filter === 'ALL' || a.position === filter);

  if (loading || !draft) return <p className="text-slate-500">Loading draft…</p>;

  type BoardPick = Draft['picks'][number] | null;
  const boardRounds: BoardPick[][] = [];
  for (let r = 0; r < draft.rounds; r++) {
    const rowPicks: BoardPick[] = [];
    for (let s = 1; s <= draft.team_count; s++) {
      const slot = r % 2 === 0 ? s : draft.team_count - s + 1;
      const pickNo = r * draft.team_count + s;
      rowPicks.push(draft.picks.find(p => p.pick_number === pickNo) ?? null);
    }
    boardRounds.push(rowPicks);
    if (r * draft.team_count >= draft.picks.length + draft.team_count) break; // show one empty round ahead
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Link to="/drafts" className="text-xs text-slate-500 hover:text-slate-700">← drafts</Link>
        <h1 className="text-xl font-bold">{draft.name}</h1>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${draft.type === 'mock' ? 'bg-sky-100 text-sky-700' : 'bg-amber-900 text-amber-600'}`}>
          {draft.type === 'mock' ? 'MOCK' : 'LIVE TRACKER'}
        </span>
        <span className={`text-sm px-3 py-1 rounded-lg font-semibold ${myTurn ? 'bg-emerald-600 text-white animate-pulse' : 'bg-slate-100 text-slate-700'}`}>
          {draftOver ? 'DRAFT COMPLETE'
            : myTurn ? `Pick ${nextPick} · Round ${round} · YOU ARE ON THE CLOCK`
            : draft.type === 'mock' ? `Pick ${nextPick} · Round ${round} · ${simming ? 'CPU teams drafting…' : `Team ${onClockSlot} thinking…`}`
            : `Pick ${nextPick} · Round ${round} · Team ${onClockSlot} on the clock`}
        </span>
        <button className="btn-ghost ml-auto" onClick={undo} disabled={draft.picks.length === 0}>↩ Undo last pick</button>
        <button className="btn-ghost" onClick={() => setShowField(v => !v)}>{showField ? 'Hide' : 'Show'} my lineup (X&O)</button>
      </div>

      {showField && (
        <div className="max-w-2xl mb-4">
          <FormationView phase="offense" slots={mySlots} accent="#0f766e" onPlayerClick={pid => nav(`/players/${pid}`)} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_260px] gap-4">
        {/* Best available */}
        <div className="card p-3 max-h-[75vh] overflow-y-auto">
          <div className="flex items-center gap-1 mb-2 sticky top-0 bg-white pb-2">
            <h3 className="text-sm font-bold text-slate-700 mr-auto">Best Available</h3>
            {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
              <button key={p} onClick={() => setFilter(p)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${filter === p ? 'bg-slate-300 text-white' : 'bg-slate-100 text-slate-600'}`}>{p}</button>
            ))}
          </div>
          {available.slice(0, 60).map(a => (
            <button key={a.player_id} onClick={() => pick(a.player_id)}
              title={myTurn ? 'Draft to MY team' : `Mark as taken by team ${onClockSlot}`}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 text-left text-sm group">
              <span className="w-6 text-right text-slate-500 font-mono text-xs">{a.rank}</span>
              <span className="w-1 h-5 rounded" style={{ background: TIER_COLORS[a.tier] }} />
              <span className={`font-bold w-8 text-xs pos-${a.position}`}>{a.position}</span>
              <span className="truncate">{a.name}</span>
              <span className="text-slate-500 text-xs">{a.team_abbr}</span>
              <span className="ml-auto opacity-0 group-hover:opacity-100 text-emerald-600 text-xs font-bold">
                {myTurn ? 'DRAFT →' : 'TAKEN →'}
              </span>
            </button>
          ))}
          {available.length === 0 && <p className="text-xs text-slate-500 p-2">Everyone on your board is drafted. Add more players in Rankings.</p>}
        </div>

        {/* Board */}
        <div className="card p-3 overflow-x-auto max-h-[75vh] overflow-y-auto">
          <h3 className="text-sm font-bold text-slate-700 mb-2">Draft Board</h3>
          <table className="text-[11px] border-separate" style={{ borderSpacing: 3 }}>
            <thead>
              <tr>
                <th className="text-slate-400 font-normal pr-1">Rd</th>
                {Array.from({ length: draft.team_count }, (_, i) => (
                  <th key={i} className={`px-1 font-semibold ${i + 1 === draft.my_slot ? 'text-emerald-600' : 'text-slate-500'}`}>
                    {i + 1 === draft.my_slot ? 'ME' : `T${i + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {boardRounds.map((rowPicks, r) => (
                <tr key={r}>
                  <td className="text-slate-400 pr-1">{r + 1}</td>
                  {Array.from({ length: draft.team_count }, (_, i) => {
                    const slot = i + 1;
                    const p = rowPicks.find(x => x && x.team_slot === slot && Math.ceil(x.pick_number / draft.team_count) === r + 1) ?? null;
                    return (
                      <td key={slot}
                        className={`rounded px-1.5 py-1 min-w-[76px] align-top ${p ? '' : 'bg-slate-100/40'} ${slot === draft.my_slot ? 'ring-1 ring-emerald-700/50' : ''}`}
                        style={p ? { background: `${p.primary_color ?? '#334155'}55` } : {}}>
                        {p ? (
                          <>
                            <span className={`font-bold pos-${p.position}`}>{p.position}</span>{' '}
                            <span className="text-slate-900">{p.name.split(' ').slice(-1)[0]}</span>
                          </>
                        ) : <span className="text-slate-700">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* My team */}
        <div className="card p-3 max-h-[75vh] overflow-y-auto">
          <h3 className="text-sm font-bold text-slate-700 mb-2">My Team ({myPicks.length})</h3>
          {myPicks.map(p => (
            <div key={p.pick_number} className="flex items-center gap-2 text-sm py-1">
              <span className="text-slate-400 text-xs w-8">{p.pick_number}.</span>
              <span className={`font-bold w-8 text-xs pos-${p.position}`}>{p.position}</span>
              <span className="truncate">{p.name}</span>
              <span className="text-slate-500 text-xs ml-auto">{p.team_abbr}</span>
            </div>
          ))}
          {myPicks.length === 0 && <p className="text-xs text-slate-500">Your picks land here.</p>}
        </div>
      </div>
    </div>
  );
}
