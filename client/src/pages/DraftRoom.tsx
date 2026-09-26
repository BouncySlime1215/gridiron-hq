import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, Draft, headshotUrl, useApi } from '../api';
import PlayerRow, { Headshot, PosBadge } from '../components/PlayerRow';
import { PlayerName } from '../components/PlayerCard';
import DraftRecap from '../components/DraftRecap';
import { PageError, PageLoading } from '../components/PageState';
import { Button, Card, Chip, PageHeader } from '../components/ui/DesignSystem';
import DraftQueue from '../features/draft/DraftQueue';
import { useDraftQueue } from '../features/draft/useDraftQueue';

// RB uses the good CSS var directly — bg/border-emerald-* are remapped to the
// brand accent globally (see index.css), and a position's identity color must not.
const POS_TINT: Record<string, string> = {
  QB: 'bg-rose-50 border-rose-200', RB: 'bg-[var(--good-tint)] border-[var(--good)]',
  WR: 'bg-sky-50 border-sky-200', TE: 'bg-amber-50 border-amber-200',
  K: 'bg-violet-50 border-violet-200'
};

const lastName = (n: string) => {
  const parts = n.split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : n;
};

export default function DraftRoom() {
  const { id } = useParams();
  const { data: draft, refetch, loading, error } = useApi<Draft & { pick_seconds?: number }>(`/drafts/${id}`);
  const [filter, setFilter] = useState('ALL');
  const [lastCpu, setLastCpu] = useState<any>(null);
  const [entering, setEntering] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [rec, setRec] = useState<any>(null);
  const [zoom, setZoom] = useState(1);   // draft-board scale
  const { data: vorBoard } = useApi<any[]>('/edge/vor');
  const vorById = useMemo(() => new Map((vorBoard ?? []).map(v => [v.id, v])), [vorBoard]);
  // Recaps (Draft → Recaps) link here with ?recap=1: open the recap and grade straight away.
  const [params] = useSearchParams();
  const [recapOpen, setRecapOpen] = useState(() => params.get('recap') === '1');
  const [recapShown, setRecapShown] = useState(() => params.get('recap') === '1');
  const busy = useRef(false);

  // Whose turn it is depends on order_type (snake/linear/third_round_reversal),
  // so the server computes on_the_clock rather than this page reimplementing
  // that math — see the comment on GET /drafts/:id in server/routes/drafts.js.
  const nextPick = draft?.on_the_clock?.pick_number ?? (draft ? draft.total_picks + 1 : 1);
  const totalPicks = draft?.total_picks ?? 0;
  const round = draft?.on_the_clock?.round ?? draft?.rounds ?? 1;
  const posInRound = draft?.on_the_clock?.pos_in_round ?? 1;
  const onClockSlot = draft?.on_the_clock?.team_slot ?? 1;
  const myTurn = !!draft && !!draft.on_the_clock && onClockSlot === draft.my_slot;
  const draftOver = !!draft && !draft.on_the_clock;
  const isMock = draft?.type === 'mock';
  // Server-owned, not local React state: the draft clock job (server/draft/store.js)
  // must honor the same pause a user sees, or "Pause" would stop the CPU
  // animation locally while the server kept auto-picking on schedule underneath.
  const paused = !!draft?.paused;
  const setPausedRemote = async (next: boolean) => {
    await api(`/drafts/${id}/pause`, { method: 'POST', body: JSON.stringify({ paused: next }) });
    refetch();
  };

  const myQueue = useDraftQueue(id, draft?.my_slot ?? 1, draft?.queue.map(q => q.player_id) ?? []);
  const takenIds = useMemo(() => new Set((draft?.picks ?? []).map(p => p.player_id)), [draft]);
  useEffect(() => { myQueue.reconcile(takenIds); }, [takenIds]);
  const playersById = useMemo(() => {
    const m = new Map<number, { player_id: number; name: string; position: string; team_abbr?: string | null }>();
    for (const a of draft?.available ?? []) m.set(a.player_id, a);
    for (const p of draft?.picks ?? []) m.set(p.player_id, p);
    return m;
  }, [draft]);

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
    // Derived from the server-owned drafts.turn_deadline (not reset locally)
    // so a reconnect or a second tab shows the actual remaining time instead
    // of a fresh full countdown — and the server's own clock job (which
    // auto-picks even if no browser tab is open) stays the source of truth.
    if (!isMock || !myTurn || draftOver || paused || !draft?.turn_deadline) { setSecondsLeft(null); return; }
    const deadline = new Date(draft.turn_deadline).getTime();
    const tick = () => setSecondsLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [isMock, myTurn, draftOver, paused, draft?.turn_deadline]);

  useEffect(() => {
    if (!myTurn || draftOver) { setRec(null); return; }
    api(`/drafts/${id}/recommendation`).then(setRec).catch(() => setRec(null));
  }, [myTurn, draftOver, id, draft?.picks.length]);

  const pick = async (playerId: number) => {
    try {
      await api(`/drafts/${id}/picks`, {
        method: 'POST',
        body: JSON.stringify({ player_id: playerId, expected_revision: draft?.revision })
      });
    } catch {
      // A 409 (someone/the server clock beat this request to the pick) or a
      // 400 (already drafted) both just mean the board moved — the refetch
      // below reconciles the UI with whatever actually happened.
    }
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
  if (!draft && error) return <PageError message={error} onRetry={refetch} />;
  if (!draft) return <PageLoading label="Loading draft…" />;

  const lastPickNo = draft.picks.length;
  const roundsToShow = Math.min(draft.rounds, Math.ceil((lastPickNo + draft.team_count) / draft.team_count) + 1);
  const urgent = secondsLeft != null && secondsLeft <= 15;
  const pickByCell = new Map(draft.picks.map(p => [`${Math.ceil(p.pick_number / draft.team_count)}|${p.team_slot}`, p]));

  return (
    <div className="draft-room">
      <DraftRecap draft={draft} open={recapOpen} onClose={() => setRecapOpen(false)} />
      <PageHeader eyebrow="Draft" title={draft.name}
        meta={<>
          <Link to="/draft" className="ds-note hover:underline">← All drafts</Link>
          <Chip tone={isMock ? 'accent' : 'warn'}>{isMock ? 'Mock' : 'Live'}</Chip>
          <span className="ds-note tabular-nums">Pick {Math.min(nextPick, totalPicks)} of {totalPicks} · round {round}</span>
          {paused && <Chip tone="warn">Paused</Chip>}
        </>}
        actions={<>
          {isMock && !draftOver && <Button size="sm" onClick={() => setPausedRemote(!paused)}>{paused ? 'Resume' : 'Pause'}</Button>}
          {isMock && !draftOver && <Button size="sm" onClick={async () => { await api(`/drafts/${id}/sim-to-end`, { method: 'POST' }); refetch(); }}>Sim to end</Button>}
          {draft.picks.length > 0 && <Button size="sm" onClick={() => setRecapOpen(true)}>Recap</Button>}
          <Button size="sm" variant="quiet" onClick={undo} disabled={draft.picks.length === 0} title={draft.picks.length === 0 ? 'No pick to undo yet' : 'Undo the last pick'}>Undo</Button>
        </>} />

      {/* ---- the clock ---- */}
      {draftOver ? (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 !p-4">
          <span className="font-semibold">Draft complete: {myPicks.length} players on your roster.</span>
          <Button variant="primary" onClick={() => setRecapOpen(true)}>View recap and grade</Button>
        </Card>
      ) : myTurn ? (
        <section className={`dr-clock mb-4 ${urgent ? 'dr-clock-urgent' : ''}`} aria-live="polite" data-testid="on-the-clock">
          <div className="dr-clock-bar">
            <span className="dr-clock-t">You're on the clock</span>
            {secondsLeft != null && (
              <span className={`dr-clock-time tabular-nums ${urgent ? 'animate-pulse' : ''}`}>
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </span>
            )}
            <span className="dr-clock-s">Round {round}, pick {posInRound}{isMock ? ' · auto-picks the recommendation at 0:00' : ''}</span>
          </div>
          {rec?.recommendation && (
            <div className="dr-clock-body">
              <div className="flex flex-wrap items-center gap-3">
                <span className="ds-eyebrow !mb-0">Recommended</span>
                <Headshot src={headshotUrl(rec.recommendation)} pos={rec.recommendation.position} size={40} />
                <PosBadge pos={rec.recommendation.position} />
                <div className="min-w-0">
                  <div className="font-semibold leading-tight">{rec.recommendation.name}</div>
                  <div className="ds-note">
                    {rec.recommendation.team_abbr} · market #{rec.recommendation.market_rank}
                    {rec.recommendation.projected_points != null && (
                      <> · proj <strong className="text-[var(--c-ink)]">{Math.round(rec.recommendation.projected_points)}</strong>
                        {rec.recommendation.projected_pos_rank && ` (${rec.recommendation.position}${rec.recommendation.projected_pos_rank})`}</>
                    )}
                  </div>
                </div>
                <Button variant="primary" size="lg" icon="check" className="ml-auto" onClick={() => pick(rec.recommendation.player_id)}>
                  Draft {lastName(rec.recommendation.name)}
                </Button>
              </div>
              <p className="ds-note mt-2">{rec.recommendation.why}</p>
              {rec.alternatives?.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="ds-note">Or take</span>
                  {rec.alternatives.slice(0, 4).map((a: any) => (
                    <Button key={a.player_id} size="sm" onClick={() => pick(a.player_id)}>
                      <span className={`font-bold pos-${a.position}`}>{a.position}</span> {lastName(a.name)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <Card className="mb-4 flex items-center gap-3 overflow-hidden !px-4 !py-3">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[var(--c-green)]" aria-hidden />
          <span className="shrink-0 text-sm font-semibold">Team {onClockSlot} on the clock</span>
          {lastCpu && (
            <div className="ml-2 flex min-w-0 items-center gap-2.5 transition-all duration-300 ease-out"
              style={{ opacity: entering ? 1 : 0, transform: entering ? 'translateY(0)' : 'translateY(6px)' }}>
              <span className="ds-note shrink-0 font-mono">
                {lastCpu.round}.{String(((lastCpu.pick_number - 1) % draft.team_count) + 1).padStart(2, '0')}
              </span>
              <Headshot src={headshotUrl(lastCpu)} pos={lastCpu.position} size={30} />
              <span className="shrink-0 font-semibold">{lastCpu.name}</span>
              <span className="ds-note shrink-0">{lastCpu.team_abbr}</span>
              {lastCpu.reason && <span className="ds-note truncate italic">“{lastCpu.reason}”</span>}
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr_210px]">
        {/* ---- available ---- */}
        <section className="dr-panel" aria-labelledby="dr-avail">
          <div className="dr-panel-h">
            <h2 id="dr-avail" className="ds-h mr-auto">Best available</h2>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Position">
              {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => <Chip key={p} on={filter === p} onClick={() => setFilter(p)}>{p === 'ALL' ? 'All' : p}</Chip>)}
            </div>
          </div>
          <div className="dr-panel-b divide-y divide-[var(--c-line)]">
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
                meta={(() => {
                  const v = vorById.get(a.player_id);
                  const bits: string[] = [];
                  if (a.projected_points != null) bits.push(`${a.position}${a.projected_pos_rank ?? ''} · ${Math.round(a.projected_points)}pts`);
                  if (v?.vor != null) bits.push(`VOR ${v.vor}`);
                  if (v?.adp_edge != null && Math.abs(v.adp_edge) >= 4) {
                    bits.push(v.adp_edge > 0 ? `value +${v.adp_edge.toFixed(0)}` : `reach ${v.adp_edge.toFixed(0)}`);
                  }
                  return bits.length ? bits.join(' · ') : undefined;
                })()}
                action={
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button"
                      onClick={e => { e.stopPropagation(); myQueue.has(a.player_id) ? myQueue.remove(a.player_id) : myQueue.add(a.player_id); }}
                      disabled={draftOver}
                      title={draftOver ? 'The draft is over' : myQueue.has(a.player_id) ? 'Remove from queue' : 'Add to queue'}
                      aria-label={myQueue.has(a.player_id) ? `Remove ${a.name} from queue` : `Add ${a.name} to queue`}
                      className={`dr-mini ${myQueue.has(a.player_id) ? 'dr-mini-on' : ''}`}>
                      {myQueue.has(a.player_id) ? '✓' : '+'}
                    </button>
                    <button type="button"
                      onClick={e => { e.stopPropagation(); pick(a.player_id); }}
                      disabled={draftOver}
                      title={draftOver ? 'The draft is over' : myTurn ? 'Draft this player' : 'Mark as taken by another team'}
                      className={`dr-pick ${myTurn && !draftOver ? 'dr-pick-go' : ''}`}>
                      {draftOver ? 'Done' : myTurn ? 'Draft' : 'Taken'}
                    </button>
                  </div>
                }
              />
            ))}
            {available.length === 0 && <p className="ds-note p-4">The board is empty. Add players in Players → Rankings.</p>}
          </div>
        </section>

        {/* ---- board: compact cells, horizontal scroll, nothing overlaps ---- */}
        <section className="dr-panel" aria-labelledby="dr-board">
          <div className="dr-panel-h">
            <h2 id="dr-board" className="ds-h mr-auto">Draft board</h2>
            <div className="flex items-center gap-1">
              <button type="button" className="dr-mini" onClick={() => setZoom(z => Math.max(0.7, +(z - 0.15).toFixed(2)))} title="Zoom out" aria-label="Zoom out">−</button>
              <span className="ds-note w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <button type="button" className="dr-mini" onClick={() => setZoom(z => Math.min(1.6, +(z + 0.15).toFixed(2)))} title="Zoom in" aria-label="Zoom in">+</button>
              <Button size="sm" variant="quiet" onClick={() => setZoom(1)} disabled={zoom === 1} title={zoom === 1 ? 'Already at 100%' : 'Back to 100%'}>Reset</Button>
            </div>
          </div>
          <div className="dr-panel-b overflow-auto p-2">
            <table className="border-separate" style={{ borderSpacing: '3px' }}>
              <thead>
                <tr>
                  <th className="w-5" />
                  {Array.from({ length: draft.team_count }, (_, i) => (
                    <th key={i} style={{ width: 74 * zoom, fontSize: 10 * zoom }}
                      className={`rounded py-0.5 font-semibold ${i + 1 === draft.my_slot ? 'dr-you' : 'text-[var(--c-muted)]'}`}>
                      {i + 1 === draft.my_slot ? 'You' : `T${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: roundsToShow }, (_, r) => (
                  <tr key={r}>
                    <td className="pr-0.5 text-right font-mono text-[10px] text-[var(--c-muted)]">{r + 1}</td>
                    {Array.from({ length: draft.team_count }, (_, i) => {
                      const slot = i + 1;
                      const p = pickByCell.get(`${r + 1}|${slot}`) ?? null;
                      const isLatest = p && p.pick_number === lastPickNo;
                      return (
                        <td key={slot} className="p-0 align-top">
                          <div style={{ width: 74 * zoom, height: 34 * zoom }}
                            className={`overflow-hidden rounded-md border px-1 py-0.5 transition-all duration-700 ease-out
                              ${p ? (POS_TINT[p.position] ?? 'dr-cell') : 'dr-cell-empty'}
                              ${isLatest ? 'ring-2 ring-[var(--c-accent-ring)]' : ''}
                              ${slot === draft.my_slot && !p ? 'dr-cell-mine' : ''}`}
                            aria-label={p ? `${p.position} ${p.name}` : `Round ${r + 1}, team ${slot}: not picked yet`}>
                            {p && (
                              <>
                                <div style={{ fontSize: 8 * zoom }} className="font-bold leading-none text-[var(--c-ink2)]">{p.position}</div>
                                <div style={{ fontSize: 10.5 * zoom }} className="truncate font-semibold leading-tight text-[var(--c-ink)]">{lastName(p.name)}</div>
                              </>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ---- my team and queue ---- */}
        <section className="dr-panel" aria-labelledby="dr-mine">
          <div className="dr-panel-h"><h2 id="dr-mine" className="ds-h">My team ({myPicks.length})</h2></div>
          <div className="dr-panel-b min-h-[8rem] flex-1 space-y-1 p-2">
            {myPicks.map(p => (
              <div key={p.pick_number} className={`flex items-center gap-1.5 overflow-hidden rounded-lg border px-2 py-1.5 ${POS_TINT[p.position] ?? 'dr-cell'}`}>
                <span className="w-5 shrink-0 font-mono text-[10px] text-[var(--c-ink2)]">{p.pick_number}</span>
                <span className={`w-6 shrink-0 text-[10px] font-black pos-${p.position}`}>{p.position}</span>
                <PlayerName id={p.player_id} className="min-w-0 flex-1 truncate text-xs font-medium">{p.name}</PlayerName>
              </div>
            ))}
            {myPicks.length === 0 && <p className="ds-note p-2">Your picks land here.</p>}
          </div>
          <div className="mt-auto border-t border-[var(--c-line)]">
            <div className="dr-panel-h !border-b-0"><h2 className="ds-h">Queue ({myQueue.queue.length})</h2></div>
            <div className="max-h-[24vh] overflow-y-auto p-2">
              <DraftQueue queue={myQueue.queue} players={playersById} onReorder={myQueue.reorder} onRemove={myQueue.remove} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
