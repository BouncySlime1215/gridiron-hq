import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, headshotUrl, useApi } from '../api';

/* --------------------------------------------------------------- primitives */

const POS_COLOR: Record<string, string> = {
  QB: 'bg-rose-100 text-rose-700 border-rose-200',
  RB: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  WR: 'bg-sky-100 text-sky-700 border-sky-200',
  TE: 'bg-amber-100 text-amber-700 border-amber-200',
  K: 'bg-violet-100 text-violet-700 border-violet-200',
  DEF: 'bg-slate-200 text-slate-700 border-slate-300',
  FLEX: 'bg-indigo-100 text-indigo-700 border-indigo-200'
};

const POS_TINT: Record<string, string> = {
  QB: 'bg-rose-50/70 border-rose-200', RB: 'bg-emerald-50/70 border-emerald-200',
  WR: 'bg-sky-50/70 border-sky-200', TE: 'bg-amber-50/70 border-amber-200',
  K: 'bg-violet-50/70 border-violet-200', DEF: 'bg-slate-50 border-slate-200'
};

const VERDICT_TINT: Record<string, string> = {
  'take': 'bg-emerald-50 border-emerald-300',
  'fine here': 'bg-white border-slate-200',
  'let him go': 'bg-rose-50/50 border-rose-200'
};

const STATUS_TINT: Record<string, string> = {
  healthy: 'bg-emerald-100 text-emerald-700',
  'injury risk': 'bg-rose-100 text-rose-700',
  rookie: 'bg-sky-100 text-sky-700',
  'bounce-back': 'bg-amber-100 text-amber-700',
  ageing: 'bg-slate-200 text-slate-700'
};

/** Draft-slot number -> the owning team's display name, from ESPN's pick order. */
function teamNameForSlot(draft: any, slot: number) {
  const espnId = draft?.pick_order?.order?.[slot - 1];
  const teamNames = draft?.pick_order?.team_names ?? {};
  return espnId != null ? (teamNames[espnId] ?? `Team ${espnId}`) : `Slot ${slot}`;
}

function Pos({ pos, className = '' }: { pos: string; className?: string }) {
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${POS_COLOR[pos] ?? 'bg-slate-100 text-slate-600 border-slate-200'} ${className}`}>
      {pos}
    </span>
  );
}

/**
 * Player headshot with a positional-colour ring.
 *
 * ESPN serves a transparent PNG for anyone without a portrait rather than a 404, so a
 * plain <img> silently renders an empty circle. The initials sit underneath and only
 * show through when the image genuinely fails, which keeps every row the same height.
 */
function Face({ p, size = 40 }: { p: any; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = headshotUrl(p);
  const initials = (p?.name ?? '?').split(' ').map((w: string) => w[0]).slice(0, 2).join('');
  const ring = POS_COLOR[p?.position]?.split(' ').find(c => c.startsWith('border-')) ?? 'border-slate-200';
  return (
    <div style={{ width: size, height: size }}
      className={`relative shrink-0 rounded-full border-2 ${ring} bg-slate-100 overflow-hidden grid place-items-center`}>
      <span className="absolute text-[10px] font-bold text-slate-400">{initials}</span>
      {url && !failed && (
        <img src={url} alt="" onError={() => setFailed(true)}
          className="relative w-full h-full object-cover object-top" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ picker */

function ConnectLeague() {
  const { data: leagues } = useApi<any[]>('/leagues');
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const link = async (id: number) => {
    setBusy(id); setErr(null);
    try {
      const out = await api('/drafts/live/link', { method: 'POST', body: JSON.stringify({ league_row_id: id }) });
      nav(`/live-draft/${out.draft_id}`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const espn = (leagues ?? []).filter(l => l.platform === 'espn');
  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Live Draft Hub</h1>
      <p className="text-sm text-slate-600 mb-6">
        Mirrors your ESPN draft board pick-by-pick and tells you who to take while you're on the clock.
      </p>
      {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {espn.map(l => (
          <button key={l.id} onClick={() => link(l.id)} disabled={busy === l.id}
            className="card p-4 text-left hover:border-sky-300 disabled:opacity-50">
            <div className="font-semibold">{l.name ?? `ESPN ${l.league_id}`}</div>
            <div className="text-xs text-slate-500 mt-1">
              {l.season} · {l.team_count ?? '?'} teams · league {l.league_id}
            </div>
            <div className="text-xs font-medium text-sky-700 mt-2">
              {busy === l.id ? 'Connecting…' : 'Open draft room →'}
            </div>
          </button>
        ))}
        {!espn.length && (
          <p className="text-sm text-slate-500">
            No ESPN leagues connected yet — <Link to="/settings" className="text-sky-700 underline">connect ESPN</Link> first.
          </p>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the room */

export default function LiveDraft() {
  const { id } = useParams();
  if (!id) return <ConnectLeague />;
  return <Room id={id} />;
}

function Room({ id }: { id: string }) {
  const [state, setState] = useState<any>(null);
  const [advice, setAdvice] = useState<any>(null);
  const [adviceBusy, setAdviceBusy] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [rosterTab, setRosterTab] = useState<'lineup' | 'order'>('lineup');
  const adviceFor = useRef<number | null>(null);
  const targetIds = useRef<Map<number, string>>(new Map());
  const [snipes, setSnipes] = useState<{ key: number; name: string; team: string }[]>([]);
  const [desynced, setDesynced] = useState(false);
  // ESPN can be slower to answer during a live draft than the 4s poll interval — without
  // this, a slow request and the next timer tick can race through the same sync/resolve
  // path and duplicate or drop a pick.
  const syncing = useRef(false);

  const tick = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const s = await api(`/drafts/${id}/sync`, { method: 'POST' });
      if (s.new_picks?.length) setSyncNote(`+${s.new_picks.length} pick${s.new_picks.length > 1 ? 's' : ''} from ESPN`);
      setDesynced(!!s.desynced);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);   // a sync failure must never blank the board
    } finally {
      syncing.current = false;
    }
    try {
      const s = await api(`/drafts/${id}/assist`);
      // A target on our shortlist just went to someone else — worth a nudge, since it
      // reshuffles who's actually still reachable at the next turn.
      const gone = (s.recent_picks ?? []).filter(
        (p: any) => p.team_slot !== s.draft.my_slot && targetIds.current.has(p.id));
      if (gone.length) {
        setSnipes(cur => [
          ...gone.map((p: any) => ({ key: p.pick_number, name: p.name, team: teamNameForSlot(s.draft, p.team_slot) })),
          ...cur
        ].slice(0, 4));
      }
      targetIds.current = new Map((s.targets ?? []).map((t: any) => [t.player_id, t.name]));
      setState(s);
    } catch (e: any) { setErr(e.message); }
  }, [id]);

  useEffect(() => {
    if (!snipes.length) return;
    const t = setTimeout(() => setSnipes(cur => cur.slice(0, -1)), 6000);
    return () => clearTimeout(t);
  }, [snipes]);

  useEffect(() => { tick(); }, [tick]);
  useEffect(() => {
    if (!live) return;
    const iv = setInterval(tick, 4000);
    return () => clearInterval(iv);
  }, [live, tick]);

  const clock = state?.on_the_clock;
  const myTurn = !!clock?.my_turn;
  const until = clock?.picks_until_my_turn ?? null;

  // Ask Claude as the pick comes into view, so the answer is already on screen when
  // the clock starts rather than arriving six seconds into it.
  useEffect(() => {
    if (!state || clock?.complete) return;
    const pickNo = clock?.pick_number;
    if (pickNo == null || adviceFor.current === pickNo) return;
    if (until == null || until > 2) return;
    adviceFor.current = pickNo;
    setAdviceBusy(true);
    api(`/drafts/${id}/advice`).then(setAdvice).catch(() => {}).finally(() => setAdviceBusy(false));
  }, [state, clock?.pick_number, until, id, clock?.complete]);

  const refreshAdvice = async () => {
    setAdviceBusy(true);
    try { setAdvice(await api(`/drafts/${id}/advice?refresh=1`)); }
    catch (e: any) { setErr(e.message); }
    finally { setAdviceBusy(false); }
  };

  const targets = useMemo(
    () => (state?.targets ?? []).filter((t: any) => filter === 'ALL' || t.position === filter),
    [state, filter]);

  // The player Claude named, matched back to the board so his headshot and numbers
  // can lead the card instead of just his name.
  const pickPlayer = useMemo(() => {
    if (!advice?.pick || !state) return null;
    return state.available.find((a: any) => a.name === advice.pick)
      ?? state.targets.find((t: any) => t.name === advice.pick) ?? null;
  }, [advice, state]);

  if (!state) return <p className="text-slate-500">Connecting to your ESPN draft…</p>;

  const d = state.draft;
  const lineup = state.my_team.lineup;
  const needs = Object.entries(state.my_team.needs.starters ?? {}).filter(([, n]) => (n as number) > 0);
  const slotTeam = (slot: number) => teamNameForSlot(d, slot);

  return (
    <div>
      {/* ------------------------------------------------------- sniped toasts */}
      {snipes.length > 0 && (
        <div className="fixed top-4 right-4 z-50 space-y-2 w-72">
          {snipes.map(s => (
            <div key={s.key} className="rounded-xl border border-rose-300 bg-rose-50 shadow-md p-3">
              <div className="text-xs font-bold text-rose-700">🎯 SNIPED</div>
              <div className="text-sm text-slate-800"><b>{s.name}</b> just went to {s.team}</div>
            </div>
          ))}
        </div>
      )}
      {/* ---------------------------------------------------------- header */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <Link to="/live-draft" className="text-xs text-slate-500 hover:text-slate-700">← hub</Link>
        <h1 className="text-lg font-bold">{d.name}</h1>
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">LIVE · ESPN</span>
        <button onClick={() => setLive(v => !v)}
          className={`text-[11px] px-2 py-1 rounded-full border ${live ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
          {live ? '● syncing every 4s' : '‖ paused'}
        </button>
        {syncNote && <span className="text-[11px] text-slate-500">{syncNote}</span>}
        {desynced && (
          <span className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-300 px-2 py-0.5 rounded-full"
            title="ESPN has more picks than this board has mirrored — a pick failed to sync. Check the real draft board and reconnect if this doesn't clear on its own.">
            ⚠ OUT OF SYNC WITH ESPN
          </span>
        )}
        {err && <span className="text-[11px] text-rose-600">{err}</span>}
      </div>

      {/* ------------------------------------------------------ clock strip */}
      <div className={`card p-4 mb-4 ${myTurn ? 'ring-2 ring-emerald-400 bg-emerald-50/40' : ''}`}>
        {clock.complete ? (
          <div className="font-bold text-lg">Draft complete — {state.my_team.picks.length} picks on your roster.</div>
        ) : myTurn ? (
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xl font-extrabold text-emerald-700">YOU'RE ON THE CLOCK</span>
            <span className="text-sm text-slate-600">Pick {clock.pick_number} · Round {clock.round} · {d.pick_seconds}s</span>
            {pickPlayer && (
              <span className="ml-auto flex items-center gap-2 text-sm">
                <span className="text-slate-500">Claude says</span>
                <Face p={pickPlayer} size={28} />
                <b>{pickPlayer.name}</b>
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-slate-600">On the clock:</span>
            <span className="font-bold">{slotTeam(clock.slot)}</span>
            <span className="text-sm text-slate-500">pick {clock.pick_number} · round {clock.round}</span>
            <span className="ml-auto text-sm">
              <b className="text-sky-700">{until}</b> pick{until === 1 ? '' : 's'} until you're up
              {clock.my_upcoming_picks?.length > 1 &&
                <span className="text-slate-500"> · yours: {clock.my_upcoming_picks.slice(0, 3).join(', ')}</span>}
            </span>
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          {/* ------------------------------------------------ AI advice card */}
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="font-bold text-sm">Claude's call</h2>
              {adviceBusy && <span className="text-[11px] text-slate-400">thinking…</span>}
              <button onClick={refreshAdvice} disabled={adviceBusy}
                className="ml-auto text-[11px] text-sky-700 hover:underline disabled:opacity-40">re-ask</button>
            </div>
            {!advice ? (
              <p className="text-sm text-slate-500">
                {adviceBusy ? 'Reading the board…' : 'Advice appears as your pick comes up — or hit re-ask now.'}
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  {pickPlayer && <Face p={pickPlayer} size={56} />}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {pickPlayer && <Pos pos={pickPlayer.position} />}
                      <span className="text-xl font-extrabold">{advice.pick}</span>
                      {pickPlayer?.team_abbr && <span className="text-xs text-slate-500">{pickPlayer.team_abbr}</span>}
                      {pickPlayer?.projected_points != null && (
                        <span className="text-xs font-bold text-slate-600">{Math.round(pickPlayer.projected_points)} pts</span>
                      )}
                    </div>
                    <p className="text-sm text-slate-700 mt-1">{advice.why}</p>
                  </div>
                </div>

                {/* Per-player scouting read: projection, last season, health, camp. */}
                <div className="space-y-1.5">
                  {(advice.players ?? []).map((pl: any) => {
                    const bp = state.available.find((a: any) => a.name === pl.name);
                    return (
                      <details key={pl.name} open={pl.name === advice.pick}
                        className={`rounded-lg border p-2.5 ${VERDICT_TINT[pl.verdict] ?? 'bg-white border-slate-200'}`}>
                        <summary className="flex items-center gap-2 cursor-pointer list-none">
                          <Face p={bp ?? { name: pl.name }} size={32} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-sm truncate">{pl.name}</span>
                              {bp?.team_abbr && <span className="text-[11px] text-slate-500">{bp.team_abbr}</span>}
                            </div>
                            {pl.status && (
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${STATUS_TINT[pl.status] ?? 'bg-slate-100 text-slate-600'}`}>
                                {pl.status}
                              </span>
                            )}
                          </div>
                          <span className="ml-auto text-right shrink-0">
                            {bp?.projected_points != null && (
                              <span className="block text-xs font-bold">{Math.round(bp.projected_points)} pts</span>
                            )}
                            <span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500">{pl.verdict}</span>
                          </span>
                        </summary>
                        <div className="mt-2 space-y-1.5 text-xs">
                          <p><span className="font-semibold text-emerald-700">Pros. </span><span className="text-slate-700">{pl.pros}</span></p>
                          <p><span className="font-semibold text-rose-700">Cons. </span><span className="text-slate-700">{pl.cons}</span></p>
                          {pl.camp && <p><span className="font-semibold text-slate-500">Camp. </span><span className="text-slate-600">{pl.camp}</span></p>}
                        </div>
                      </details>
                    );
                  })}
                </div>

                <div className="grid gap-1 text-xs text-slate-600 pt-1 border-t border-slate-100">
                  <div><span className="font-semibold">Next few picks: </span>{advice.position_priority}</div>
                  <div><span className="font-semibold">At your next turn: </span>{advice.next_turn_outlook}</div>
                </div>
              </div>
            )}
          </div>

          {/* -------------------------------------------------- best available */}
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <h2 className="font-bold text-sm">Take one of these</h2>
              <div className="ml-auto flex gap-1">
                {['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(p => (
                  <button key={p} onClick={() => setFilter(p)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${filter === p ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 text-slate-600'}`}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              {targets.map((t: any, i: number) => (
                <div key={t.player_id}
                  className={`flex items-center gap-3 p-2 rounded-lg border ${POS_TINT[t.position] ?? 'bg-white border-slate-200'}`}>
                  <span className="text-xs font-bold text-slate-400 w-4 text-center">{i + 1}</span>
                  <Face p={t} size={44} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Pos pos={t.position} />
                      <Link to={`/players/${t.player_id}`} className="font-semibold text-sm truncate hover:underline">{t.name}</Link>
                      <span className="text-[11px] text-slate-500">{t.team_abbr}</span>
                    </div>
                    <div className="text-[11px] text-slate-600 truncate">{t.reasons.join(' · ') || 'best value on the board'}</div>
                  </div>
                  <div className="text-right shrink-0">
                    {t.projected_points != null && (
                      <div className="text-sm font-bold">{Math.round(t.projected_points)}<span className="text-[10px] font-normal text-slate-400"> pts</span></div>
                    )}
                    {t.gone_by_next != null && (
                      <div className={`text-[10px] font-semibold ${t.gone_by_next > 0.7 ? 'text-rose-600' : 'text-slate-400'}`}>
                        {Math.round(t.gone_by_next * 100)}% gone
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* -------------------------------------------------------- side rail */}
        <div className="space-y-4">
          {/* ---------------------------------------------- my team: lineup */}
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="font-bold text-sm">My team</h2>
              <span className="text-[11px] text-slate-500">
                {state.my_team.picks.length}/{d.rounds} picked
                {lineup.projected_total ? ` · ${lineup.projected_total} proj pts` : ''}
              </span>
              <div className="ml-auto flex gap-1">
                {(['lineup', 'order'] as const).map(t => (
                  <button key={t} onClick={() => setRosterTab(t)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${rosterTab === t ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 text-slate-600'}`}>
                    {t === 'lineup' ? 'Lineup' : 'Draft order'}
                  </button>
                ))}
              </div>
            </div>

            {needs.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                <span className="text-[11px] text-slate-500 mr-1">still need:</span>
                {needs.map(([pos, n]) => (
                  <span key={pos} className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                    {pos}{(n as number) > 1 ? ` ×${n}` : ''}
                  </span>
                ))}
              </div>
            )}

            {rosterTab === 'lineup' ? (
              <div className="space-y-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">
                    Starters · {lineup.filled}/{lineup.slots_total}
                  </div>
                  <div className="space-y-1">
                    {lineup.starters.map((s: any, i: number) => (
                      <div key={`${s.slot}-${i}`}
                        className={`flex items-center gap-2 p-1.5 rounded-lg border ${s.player ? 'bg-white border-slate-200' : 'bg-slate-50 border-dashed border-slate-200'}`}>
                        <span className={`text-[10px] font-bold w-11 text-center py-0.5 rounded border ${POS_COLOR[s.slot.replace(/\d/g, '')] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          {s.slot}
                        </span>
                        {s.player ? (
                          <>
                            <Face p={s.player} size={32} />
                            <div className="min-w-0 flex-1">
                              <Link to={`/players/${s.player.player_id}`} className="block text-xs font-semibold truncate hover:underline">
                                {s.player.name}
                              </Link>
                              <span className="text-[10px] text-slate-500">
                                {s.player.team_abbr}
                                {s.player.bye_week ? ` · bye ${s.player.bye_week}` : ''}
                              </span>
                            </div>
                            {s.player.projected_points != null && (
                              <span className="text-xs font-bold text-slate-600 shrink-0">{Math.round(s.player.projected_points)}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-slate-400 italic">empty</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">
                    Bench · {lineup.bench.length}
                  </div>
                  <div className="space-y-1">
                    {lineup.bench.map((p: any) => (
                      <div key={p.player_id} className="flex items-center gap-2 p-1.5 rounded-lg bg-slate-50/70 border border-slate-100">
                        <span className="w-11 text-center"><Pos pos={p.position} /></span>
                        <Face p={p} size={28} />
                        <div className="min-w-0 flex-1">
                          <Link to={`/players/${p.player_id}`} className="block text-xs font-medium truncate hover:underline">{p.name}</Link>
                          <span className="text-[10px] text-slate-500">
                            R{Math.ceil(p.pick_number / d.team_count)} · {p.team_abbr}
                            {p.bye_week ? ` · bye ${p.bye_week}` : ''}
                          </span>
                        </div>
                        {p.projected_points != null && (
                          <span className="text-xs font-bold text-slate-500 shrink-0">{Math.round(p.projected_points)}</span>
                        )}
                      </div>
                    ))}
                    {!lineup.bench.length && <p className="text-xs text-slate-400">Nobody on the bench yet.</p>}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {state.my_team.picks.map((p: any) => (
                  <div key={p.pick_number} className="flex items-center gap-2 p-1.5 rounded-lg border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 w-11 text-center">
                      R{Math.ceil(p.pick_number / d.team_count)}·{p.pick_number}
                    </span>
                    <Face p={p} size={28} />
                    <Pos pos={p.position} />
                    <span className="text-xs font-medium truncate flex-1">{p.name}</span>
                    <span className="text-[10px] text-slate-400">{p.team_abbr}</span>
                  </div>
                ))}
                {!state.my_team.picks.length && <p className="text-xs text-slate-400">No picks yet.</p>}
              </div>
            )}
          </div>

          {/* ------------------------------------------- positional scarcity */}
          <div className="card p-4">
            <h2 className="font-bold text-sm mb-2">What waiting costs you</h2>
            <div className="space-y-2">
              {['RB', 'WR', 'TE', 'QB'].map(pos => {
                const p = state.positions[pos];
                if (!p?.best) return null;
                const best = state.available.find((a: any) => a.player_id === p.best_player_id);
                return (
                  <div key={pos} className="flex items-center gap-2">
                    <span className="w-9 text-center"><Pos pos={pos} /></span>
                    {best && <Face p={best} size={30} />}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{p.best}</div>
                      <div className="text-[10px] text-slate-500 truncate">
                        falls to <b className="font-medium text-slate-600">{p.fallback ?? '—'}</b> by your next turn
                      </div>
                    </div>
                    {p.cost_of_waiting != null && p.cost_of_waiting > 0 && (
                      <span className={`text-xs font-bold shrink-0 ${p.cost_of_waiting > 40 ? 'text-rose-600' : 'text-slate-500'}`}>
                        −{Math.round(p.cost_of_waiting)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ------------------------------------------------------- runs */}
          {state.runs?.length > 0 && (
            <div className="card p-4">
              <h2 className="font-bold text-sm mb-2">Run in progress</h2>
              {state.runs.map((r: any) => (
                <p key={r.position} className="text-xs text-slate-700">
                  <b>{r.taken} {r.position}s</b> in the last {r.of} picks — the tier below is going faster than ADP says.
                </p>
              ))}
            </div>
          )}

          {/* -------------------------------------------------- pick feed */}
          <div className="card p-4">
            <h2 className="font-bold text-sm mb-2">Off the board</h2>
            <div className="space-y-1">
              {state.recent_picks.map((p: any) => (
                <div key={p.pick_number} className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-slate-400 w-8">
                    {Math.ceil(p.pick_number / d.team_count)}.{String(((p.pick_number - 1) % d.team_count) + 1).padStart(2, '0')}
                  </span>
                  <Face p={p} size={26} />
                  <Pos pos={p.position} />
                  <span className="text-xs truncate flex-1">{p.name}</span>
                  <span className="text-[10px] text-slate-400 truncate max-w-[6rem]">{slotTeam(p.team_slot)}</span>
                </div>
              ))}
              {!state.recent_picks.length && <p className="text-xs text-slate-400">Draft hasn't started.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
