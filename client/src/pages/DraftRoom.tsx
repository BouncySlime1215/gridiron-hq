import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Draft, headshotUrl, useApi } from '../api';
import PlayerRow, { Headshot, PosBadge } from '../components/PlayerRow';
import { PlayerName } from '../components/PlayerCard';
import DraftRecap from '../components/DraftRecap';

const POS_TINT: Record<string, string> = {
  QB: 'bg-rose-50 border-rose-200', RB: 'bg-emerald-50 border-emerald-200',
  WR: 'bg-sky-50 border-sky-200', TE: 'bg-amber-50 border-amber-200',
  K: 'bg-violet-50 border-violet-200'
};

const lastName = (n: string) => {
  const parts = n.split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : n;
};

export default function DraftRoom() {
  const { id } = useParams();
  const { data: draft, refetch, loading } = useApi<Draft & { pick_seconds?: number }>(`/drafts/${id}`);
  const [filter, setFilter] = useState('ALL');
  const [lastCpu, setLastCpu] = useState<any>(null);
  const [entering, setEntering] = useState(true);
  const [paused, setPaused] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [rec, setRec] = useState<any>(null);
  const [zoom, setZoom] = useState(1);   // draft-board scale
  const [recapOpen, setRecapOpen] = useState(false);
  const [recapShown, setRecapShown] = useState(false);
  const busy = useRef(false);

  const nextPick = (draft?.picks.length ?? 0) + 1;
  const totalPicks = draft ? draft.team_count * draft.rounds : 0;
  const round = draft ? Math.ceil(nextPick / draft.team_count) : 1;
  const posInRound = draft ? ((nextPick - 1) % draft.team_count) + 1 : 1;
  const onClockSlot = draft ? (round % 2 === 1 ? posInRound : draft.team_count - posInRound + 1) : 1;
  const myTurn = !!draft && onClockSlot === draft.my_slot;
  const draftOver = !!draft && draft.picks.length >= totalPicks;
  const isMock = draft?.type === 'mock';

  // one CPU pick at a time, with a flash on arrival
  const cpuStep = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api(`/drafts/${id}/cpu-pick`, { method: 'POST' });
      if (r.pick) {
        // slide the outgoing pick out, swap, then slide the new one in
        setEntering(false);
        await new Promise(res => setTimeout(res, 160));
        setLastCpu(r.pick);
        await refetch();
        requestAnimationFrame(() => setEntering(true));
      }
    } catch { /* next refetch surfaces it */ }
    finally { busy.current = false; }
  }, [id, refetch]);

  useEffect(() => {
    if (!isMock || myTurn || draftOver || paused) return;
    const t = setTimeout(cpuStep, 1100);
    return () => clearTimeout(t);
  }, [isMock, myTurn, draftOver, paused, draft?.picks.length, cpuStep]);

  useEffect(() => {
    if (!myTurn || draftOver) { setSecondsLeft(null); return; }
    setSecondsLeft(draft?.pick_seconds ?? 90);
    const iv = setInterval(() => setSecondsLeft(s => (s == null ? null : Math.max(0, s - 1))), 1000);
    return () => clearInterval(iv);
  }, [myTurn, draftOver, draft?.pick_seconds, draft?.picks.length]);

  useEffect(() => {
    if (!myTurn || draftOver) { setRec(null); return; }
    api(`/drafts/${id}/recommendation`).then(setRec).catch(() => setRec(null));
  }, [myTurn, draftOver, id, draft?.picks.length]);

  const pick = async (playerId: number) => {
    await api(`/drafts/${id}/picks`, { method: 'POST', body: JSON.stringify({ player_id: playerId }) });
    setLastCpu(null);
    refetch();
  };
  const undo = async () => {
    await api(`/drafts/${id}/picks/last`, { method: 'DELETE' });
    setLastCpu(null);
    refetch();
  };

  useEffect(() => {
    if (secondsLeft === 0 && myTurn && rec?.recommendation) pick(rec.recommendation.player_id);
  }, [secondsLeft, myTurn]);

  useEffect(() => {
    if (draftOver && !recapShown) { setRecapOpen(true); setRecapShown(true); }
  }, [draftOver, recapShown]);

  const myPicks = useMemo(() => draft?.picks.filter(p => p.team_slot === draft.my_slot) ?? [], [draft]);
  const available = (draft?.available ?? []).filter(a => filter === 'ALL' || a.position === filter);

  // Only blank the page on the very first load — refetching after each pick must
  // never tear down the board, or every CPU pick looks like a page reload.
  if (!draft) return <p className="text-slate-500">Loading draft…</p>;

  const lastPickNo = draft.picks.length;
  const roundsToShow = Math.min(draft.rounds, Math.ceil((lastPickNo + draft.team_count) / draft.team_count) + 1);
  const urgent = secondsLeft != null && secondsLeft <= 15;
  const pickByCell = new Map(draft.picks.map(p => [`${Math.ceil(p.pick_number / draft.team_count)}|${p.team_slot}`, p]));

  return (
    <div>
      <DraftRecap draft={draft} open={recapOpen} onClose={() => setRecapOpen(false)} />
      {/* ---- status bar ---- */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <Link to="/drafts" className="text-xs text-slate-500 hover:text-slate-700">← drafts</Link>
        <h1 className="text-lg font-bold">{draft.name}</h1>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isMock ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'}`}>
          {isMock ? 'MOCK' : 'LIVE'}
        </span>
        <span className="text-xs text-slate-400">Pick {Math.min(nextPick, totalPicks)}/{totalPicks} · Rd {round}</span>
        <div className="ml-auto flex gap-2">
          {isMock && !draftOver && (
            <button className="btn-ghost" onClick={() => setPaused(p => !p)}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
          )}
          {isMock && !draftOver && (
            <button className="btn-ghost" onClick={async () => {
              setPaused(true);
              await api(`/drafts/${id}/sim-to-end`, { method: 'POST' });
              refetch();
            }}>⏭ Sim to end</button>
          )}
          {draft.picks.length > 0 && (
            <button className="btn-ghost" onClick={() => setRecapOpen(true)}>📋 Recap</button>
          )}
          <button className="btn-ghost" onClick={undo} disabled={draft.picks.length === 0}>↩ Undo</button>
        </div>
      </div>

      {/* ---- ON THE CLOCK banner ---- */}
      {draftOver ? (
        <div className="card p-4 mb-4 flex items-center justify-center gap-3">
          <span className="text-slate-600 font-semibold">Draft complete — {myPicks.length} players on your roster.</span>
          <button className="btn-primary" onClick={() => setRecapOpen(true)}>View recap &amp; grade</button>
        </div>
      ) : myTurn ? (
        <div className={`rounded-2xl mb-4 overflow-hidden border-2 ${urgent ? 'border-rose-500' : 'border-emerald-500'}`}>
          <div className={`px-5 py-3 flex items-center gap-4 flex-wrap ${urgent ? 'bg-rose-600' : 'bg-emerald-600'}`}>
            <span className="text-white font-black tracking-wide text-lg">YOU'RE ON THE CLOCK</span>
            {secondsLeft != null && (
              <span className={`font-mono tabular-nums text-3xl font-black text-white ${urgent ? 'animate-pulse' : ''}`}>
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </span>
            )}
            <span className="text-white/80 text-xs ml-auto">
              Round {round}, pick {posInRound} · auto-picks the recommendation at 0:00
            </span>
          </div>
          {rec?.recommendation && (
            <div className="bg-white px-5 py-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[10px] font-black uppercase tracking-wider text-emerald-700">Recommended</span>
                <Headshot src={headshotUrl(rec.recommendation)} pos={rec.recommendation.position} size={40} />
                <PosBadge pos={rec.recommendation.position} />
                <div>
                  <div className="font-bold text-slate-900 leading-tight">{rec.recommendation.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {rec.recommendation.team_abbr} · market #{rec.recommendation.market_rank}
                    {rec.recommendation.projected_points != null && (
                      <> · proj <strong className="text-slate-700">{Math.round(rec.recommendation.projected_points)}</strong>
                        {rec.recommendation.projected_pos_rank && ` (${rec.recommendation.position}${rec.recommendation.projected_pos_rank})`}</>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => pick(rec.recommendation.player_id)}
                  className="ml-auto bg-emerald-600 hover:bg-emerald-500 text-white font-black text-base px-6 py-3 rounded-xl shadow-sm">
                  ✓ DRAFT {lastName(rec.recommendation.name).toUpperCase()}
                </button>
              </div>
              <p className="text-xs text-slate-600 mt-2">{rec.recommendation.why}</p>
              {rec.alternatives?.length > 0 && (
                <div className="flex gap-2 mt-3 flex-wrap items-center">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wide">Or take:</span>
                  {rec.alternatives.slice(0, 4).map((a: any) => (
                    <button key={a.player_id} onClick={() => pick(a.player_id)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-white border-2 border-slate-200 hover:border-emerald-500 hover:bg-emerald-50 font-medium">
                      <span className={`font-bold pos-${a.position}`}>{a.position}</span> {lastName(a.name)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="card px-4 py-3 mb-4 flex items-center gap-3 overflow-hidden">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <span className="text-sm font-semibold text-slate-700 shrink-0">Team {onClockSlot} on the clock</span>
          {lastCpu && (
            <div className="flex items-center gap-2.5 ml-4 min-w-0 transition-all ease-out duration-300"
              style={{ opacity: entering ? 1 : 0, transform: entering ? 'translateY(0)' : 'translateY(6px)' }}>
              <span className="text-[10px] font-mono text-slate-400 shrink-0">
                {lastCpu.round}.{String(((lastCpu.pick_number - 1) % draft.team_count) + 1).padStart(2, '0')}
              </span>
              <Headshot src={headshotUrl(lastCpu)} pos={lastCpu.position} size={30} />
              <span className="font-bold text-slate-800 shrink-0">{lastCpu.name}</span>
              <span className="text-xs text-slate-400 shrink-0">{lastCpu.team_abbr}</span>
              {lastCpu.reason && <span className="text-xs text-slate-500 italic truncate">“{lastCpu.reason}”</span>}
            </div>
          )}
          {paused && <span className="ml-auto text-xs text-amber-600 font-medium shrink-0">paused</span>}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr_210px] gap-4">
        {/* ---- available ---- */}
        <div className="card overflow-hidden flex flex-col max-h-[68vh]">
          <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-200 bg-slate-50">
            <h3 className="text-sm font-bold text-slate-700 mr-auto">Best Available</h3>
            {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
              <button key={p} onClick={() => setFilter(p)}
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${filter === p ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-100'}`}>{p}</button>
            ))}
          </div>
          <div className="overflow-y-auto divide-y divide-slate-100">
            {available.slice(0, 80).map(a => (
              <PlayerRow
                key={a.player_id}
                playerId={a.player_id}
                rank={a.rank}
                name={a.name}
                position={a.position}
                teamAbbr={a.team_abbr}
                headshot={headshotUrl(a as any)}
                tier={a.tier}
                dense
                hidePos
                meta={a.projected_points != null
                  ? `${a.position}${a.projected_pos_rank ?? ''} · proj ${Math.round(a.projected_points)}${a.last_season_points != null ? ` · '25 ${Math.round(a.last_season_points)}` : ''}`
                  : undefined}
                action={
                  <button
                    onClick={e => { e.stopPropagation(); pick(a.player_id); }}
                    title={myTurn ? 'Draft this player' : 'Mark as taken'}
                    className={`shrink-0 text-[9px] font-black px-1.5 py-1 rounded-md transition-colors
                      ${myTurn
                        ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                        : 'bg-slate-100 text-slate-400 hover:bg-slate-200 opacity-0 group-hover:opacity-100'}`}>
                    {myTurn ? 'DRAFT' : 'TAKEN'}
                  </button>
                }
              />
            ))}
            {available.length === 0 && <p className="p-4 text-xs text-slate-500">Board is empty — add players in Rankings.</p>}
          </div>
        </div>

        {/* ---- board: compact cells, horizontal scroll, nothing overlaps ---- */}
        <div className="card overflow-hidden flex flex-col max-h-[68vh]">
          <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 flex items-center">
            <h3 className="text-sm font-bold text-slate-700">Draft Board</h3>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => setZoom(z => Math.max(0.7, +(z - 0.15).toFixed(2)))}
                className="w-6 h-6 rounded-md bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 text-sm leading-none"
                title="Zoom out">−</button>
              <span className="text-[10px] text-slate-400 w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(z => Math.min(1.6, +(z + 0.15).toFixed(2)))}
                className="w-6 h-6 rounded-md bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 text-sm leading-none"
                title="Zoom in">+</button>
              <button onClick={() => setZoom(1)}
                className="text-[10px] text-slate-400 hover:text-slate-700 ml-1">reset</button>
            </div>
          </div>
          <div className="overflow-auto p-2">
            <table className="border-separate" style={{ borderSpacing: '3px' }}>
              <thead>
                <tr>
                  <th className="w-5" />
                  {Array.from({ length: draft.team_count }, (_, i) => (
                    <th key={i}
                      style={{ width: 74 * zoom, fontSize: 9 * zoom }}
                      className={`font-bold py-0.5 rounded
                        ${i + 1 === draft.my_slot ? 'bg-emerald-600 text-white' : 'text-slate-400'}`}>
                      {i + 1 === draft.my_slot ? 'YOU' : `T${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: roundsToShow }, (_, r) => (
                  <tr key={r}>
                    <td className="text-[9px] text-slate-400 font-mono text-right pr-0.5">{r + 1}</td>
                    {Array.from({ length: draft.team_count }, (_, i) => {
                      const slot = i + 1;
                      const p = pickByCell.get(`${r + 1}|${slot}`) ?? null;
                      const isLatest = p && p.pick_number === lastPickNo;
                      return (
                        <td key={slot} className="p-0 align-top">
                          <div
                            style={{ width: 74 * zoom, height: 34 * zoom }}
                            className={`rounded-md border px-1 py-0.5 overflow-hidden transition-all duration-700 ease-out
                              ${p ? (POS_TINT[p.position] ?? 'bg-slate-50 border-slate-200') : 'bg-slate-50/40 border-dashed border-slate-200'}
                              ${isLatest ? 'ring-2 ring-emerald-400/70' : ''}
                              ${slot === draft.my_slot && !p ? 'border-emerald-300' : ''}`}>
                            {p ? (
                              <>
                                <div style={{ fontSize: 8 * zoom }} className="font-bold text-slate-500 leading-none">{p.position}</div>
                                <div style={{ fontSize: 10.5 * zoom }} className="font-semibold text-slate-800 leading-tight truncate">{lastName(p.name)}</div>
                              </>
                            ) : <div className="text-[9px] text-slate-300 text-center leading-[26px]">—</div>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---- my team ---- */}
        <div className="card overflow-hidden flex flex-col max-h-[68vh]">
          <div className="px-3 py-2 border-b border-slate-200 bg-slate-50">
            <h3 className="text-sm font-bold text-slate-700">My Team ({myPicks.length})</h3>
          </div>
          <div className="overflow-y-auto p-2 space-y-1">
            {myPicks.map(p => (
              <div key={p.pick_number} className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 overflow-hidden ${POS_TINT[p.position] ?? 'bg-slate-50 border-slate-200'}`}>
                <span className="text-[10px] text-slate-400 font-mono w-5 shrink-0">{p.pick_number}</span>
                <span className={`text-[10px] font-black w-6 shrink-0 pos-${p.position}`}>{p.position}</span>
                <PlayerName id={p.player_id} className="text-xs font-medium truncate flex-1 min-w-0">{p.name}</PlayerName>
              </div>
            ))}
            {myPicks.length === 0 && <p className="text-xs text-slate-500 p-2">Your picks land here.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
