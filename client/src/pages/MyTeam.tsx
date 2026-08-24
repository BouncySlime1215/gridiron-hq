import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, headshotUrl, useApi } from '../api';
import { useLeague } from '../state/league';
import FormationView from '../components/FormationView';
import TeamScout from '../components/TeamScout';
import { Headshot } from '../components/PlayerRow';

/**
 * My Team, for whichever league is active in the header.
 *
 * Used to be wired to a single global ESPN connection (`/espn/settings`, `/espn/league`)
 * that could only ever show one league. Now it follows the shared active league —
 * switch leagues in the header and this page (and Trade Lab, and the Prediction Engine)
 * all follow.
 *
 * The "Roster & lineup" tab runs off the trade engine's own optimal-lineup solver
 * (`/trades/:id/scout`) rather than reading a platform's frozen lineup slots directly.
 * Two reasons: it's the same "what should actually start" logic the rest of the app
 * uses, and it works identically for ESPN and Sleeper, where the old page only ever
 * understood ESPN's lineup-slot codes.
 */
export default function MyTeam() {
  const { leagues, active, refetch: refetchLeagues } = useLeague();
  const { data: lg, loading: lgLoading, refetch: refetchData } = useApi<any>(active ? `/leagues/${active.id}/data` : null);
  const [teamOverride, setTeamOverride] = useState<string | null>(null);
  const [tab, setTab] = useState<'scout' | 'roster'>('scout');
  const [syncing, setSyncing] = useState(false);

  // A "my team" pick only means something within the league it was made in — carrying
  // it across a league switch would silently point at the wrong roster.
  useEffect(() => { setTeamOverride(null); }, [active?.id]);

  const myTeamId = teamOverride ?? active?.my_team_id ?? null;
  const synced = !!lg?.payload;

  const teamOptions = useMemo(() => {
    if (!lg?.payload) return [];
    if (lg.platform === 'sleeper') {
      const users = Object.fromEntries((lg.payload.users ?? []).map((u: any) => [u.user_id, u]));
      return (lg.payload.rosters ?? []).map((ro: any) => ({
        id: String(ro.roster_id),
        label: users[ro.owner_id]?.metadata?.team_name || users[ro.owner_id]?.display_name || `Team ${ro.roster_id}`
      }));
    }
    return (lg.payload.teams ?? []).map((t: any) => ({
      id: String(t.id),
      label: t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`
    }));
  }, [lg]);

  const scoutUrl = active && synced ? `/trades/${active.id}/scout${myTeamId ? `?team_id=${myTeamId}` : ''}` : null;
  const { data: scout } = useApi<any>(scoutUrl);

  // Once the engine resolves a default team (from the league's saved my_team_id, or
  // its own first-team fallback), reflect that in the picker — without this the
  // dropdown shows nothing until the user manually picks one.
  useEffect(() => {
    if (!teamOverride && scout?.team?.roster_id != null) setTeamOverride(String(scout.team.roster_id));
  }, [scout?.team?.roster_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMyTeam = async (id: string) => {
    setTeamOverride(id);
    if (!active) return;
    try {
      await api(`/leagues/${active.id}`, { method: 'PUT', body: JSON.stringify({ my_team_id: id }) });
      refetchLeagues();
    } catch { /* the picker still works for this session even if the save fails */ }
  };

  const sync = async () => {
    if (!active) return;
    setSyncing(true);
    try { await api(`/leagues/${active.id}/sync`, { method: 'POST' }); refetchData(); refetchLeagues(); }
    catch (e: any) { alert(`Sync failed: ${e.message}`); }
    finally { setSyncing(false); }
  };

  // Field-diagram slots from the engine's own optimal lineup. Only one running back
  // and up to three receivers get a body on the diagram — same as before, since this
  // is a skill-position formation view, not a full bench sheet (that's below it).
  const formationSlots = useMemo(() => {
    const s: Record<string, { name: string }> = {};
    const slots = scout?.lineup?.slots ?? [];
    const filled = slots.filter((x: any) => x.player);
    const byPos = (pos: string) => filled.filter((x: any) => x.player.position === pos).map((x: any) => x.player);
    const [qb] = byPos('QB'); if (qb) s.QB = { name: qb.name };
    const [rb] = byPos('RB'); if (rb) s.RB = { name: rb.name };
    const flexWr = filled.find((x: any) => x.slot === 'FLEX' && x.player.position === 'WR')?.player;
    const wrPool = [...byPos('WR'), ...(flexWr ? [flexWr] : [])];
    if (wrPool[0]) s.LWR = { name: wrPool[0].name };
    if (wrPool[1]) s.RWR = { name: wrPool[1].name };
    if (wrPool[2]) s.SWR = { name: wrPool[2].name };
    const [te] = byPos('TE'); if (te) s.TE = { name: te.name };
    return s;
  }, [scout]);

  // Realized week-by-week scores — only ESPN's synced payload carries a league
  // schedule with box scores; Sleeper's does not, so this stays honest rather than
  // faking history for it.
  const matchups = useMemo(() => {
    if (active?.platform !== 'espn' || !lg?.payload?.schedule || !myTeamId) return [];
    const myId = Number(myTeamId);
    return lg.payload.schedule
      .filter((m: any) => m.home?.teamId === myId || m.away?.teamId === myId)
      .map((m: any) => {
        const mine = m.home?.teamId === myId ? m.home : m.away;
        const theirs = m.home?.teamId === myId ? m.away : m.home;
        const opp = lg.payload.teams?.find((t: any) => t.id === theirs?.teamId);
        return {
          period: m.matchupPeriodId,
          myPoints: mine?.totalPoints ?? 0,
          oppPoints: theirs?.totalPoints ?? 0,
          opp: opp ? (opp.name ?? `${opp.location} ${opp.nickname}`) : 'BYE'
        };
      })
      .sort((a: any, b: any) => a.period - b.period);
  }, [lg, myTeamId, active?.platform]);

  if (!leagues.length) {
    return (
      <div className="max-w-lg">
        <h1 className="text-2xl font-bold mb-2">My Team</h1>
        <div className="card p-6 text-center">
          <div className="text-4xl mb-2">🔌</div>
          <p className="text-sm text-slate-700 mb-3">Connect a league to see your roster, scouting report, and schedule.</p>
          <Link to="/leagues" className="btn-primary inline-block">Connect a league →</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">My Team</h1>
        {teamOptions.length > 0 && (
          <select className="input" value={myTeamId ?? ''} onChange={e => setMyTeam(e.target.value)}>
            {teamOptions.map((t: any) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
        <button className="btn-ghost ml-auto" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : `↻ Sync${lg?.fetched_at ? ` (last: ${lg.fetched_at})` : ''}`}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        {active?.name ?? `${active?.platform} league`}
        {leagues.length > 1 && <span className="text-slate-400"> — switch leagues from the picker up top</span>}
      </p>

      {!lgLoading && active && !synced && (
        <div className="card p-6 text-sm text-slate-600 mb-4">
          This league hasn't been synced yet — hit{' '}
          <button className="text-emerald-600 underline" onClick={sync}>Sync</button> to pull rosters from{' '}
          {active.platform === 'espn' ? 'ESPN' : 'Sleeper'}.
        </div>
      )}

      {synced && (
        <>
          <div className="flex gap-1 border-b border-slate-200 mb-4">
            {([['scout', 'Scouting report'], ['roster', 'Roster & lineup']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'scout' && active && <TeamScout leagueId={active.id} teamId={myTeamId} />}

          {tab === 'roster' && scout && !scout.error && (
            <div className="grid lg:grid-cols-[1fr_320px] gap-4">
              <div>
                <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                  <h2 className="text-sm font-bold text-slate-700">Optimal Starting Lineup — X&apos;s &amp; O&apos;s</h2>
                  <span className="text-xs text-slate-400">{scout.lineup.points} ppg</span>
                </div>
                <p className="text-xs text-slate-400 mb-2">
                  What the engine would start this week — not necessarily what's currently set on {active?.platform === 'espn' ? 'ESPN' : 'Sleeper'}.
                </p>
                <FormationView phase="offense" depth={formationSlots} accent="#0f766e" />
                <div className="grid md:grid-cols-2 gap-4 mt-4">
                  <div className="card p-4">
                    <h3 className="text-sm font-bold text-slate-700 mb-2">Starters</h3>
                    <div className="space-y-1">
                      {scout.lineup.slots.map((s: any, i: number) => (
                        <div key={i} className="flex items-center gap-2.5 py-1">
                          <span className="text-[var(--muted)] text-[10px] font-semibold w-10 shrink-0 uppercase tracking-wide">{s.slot}</span>
                          {s.player ? (
                            <>
                              <Headshot src={headshotUrl(s.player)} pos={s.player.position} size={30} />
                              <span className="text-sm font-medium text-[var(--ink)] truncate">{s.player.name}</span>
                              <span className={`ml-auto text-[10px] font-semibold pos-${s.player.position}`}>{s.player.position}</span>
                            </>
                          ) : <span className="text-crit text-xs">— empty —</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="card p-4">
                    <h3 className="text-sm font-bold text-slate-700 mb-2">Bench</h3>
                    <div className="space-y-1">
                      {scout.lineup.bench.map((p: any) => (
                        <div key={p.id} className="flex items-center gap-2.5 py-1">
                          <Headshot src={headshotUrl(p)} pos={p.position} size={28} />
                          <span className="text-sm text-[var(--ink)]/85 truncate">{p.name}</span>
                          <span className={`ml-auto text-[10px] font-semibold pos-${p.position}`}>{p.position}</span>
                        </div>
                      ))}
                    </div>
                    {scout.lineup.bench.length === 0 && <p className="text-xs text-slate-400">No bench depth logged yet.</p>}
                  </div>
                </div>
              </div>
              <div className="card p-4 h-fit">
                <h3 className="text-sm font-bold text-slate-700 mb-2">Weekly Points</h3>
                {active?.platform !== 'espn' && (
                  <p className="text-xs text-slate-500">Game-by-game score history is ESPN-only for now.</p>
                )}
                {active?.platform === 'espn' && matchups.length === 0 && (
                  <p className="text-xs text-slate-500">Season hasn&apos;t started — scores will appear here week by week.</p>
                )}
                {matchups.map((m: any) => (
                  <div key={m.period} className="flex items-center gap-2 text-sm py-1 border-b border-slate-200/60 last:border-0">
                    <span className="text-slate-500 text-xs w-8">W{m.period}</span>
                    <span className="font-mono">{m.myPoints.toFixed(1)}</span>
                    <span className="text-slate-400 text-xs">vs</span>
                    <span className="font-mono text-slate-600">{m.oppPoints.toFixed(1)}</span>
                    <span className="text-xs text-slate-500 truncate ml-auto">{m.opp}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === 'roster' && scout?.error && (
            <div className="card p-6 text-sm text-slate-500">{scout.error}</div>
          )}
        </>
      )}
    </div>
  );
}
