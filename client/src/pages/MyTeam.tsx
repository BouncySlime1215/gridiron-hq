import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import FormationView from '../components/FormationView';

const POS: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const SLOT: Record<number, string> = {
  0: 'QB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP',
  16: 'D/ST', 17: 'K', 20: 'BE', 21: 'IR', 23: 'FLEX'
};
const STARTER_SLOTS = new Set([0, 2, 3, 4, 5, 6, 7, 16, 17, 23]);

export default function MyTeam() {
  const { data: settings } = useApi<any>('/espn/settings');
  const { data: league, refetch } = useApi<any>('/espn/league');
  const [teamId, setTeamId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  const myTeamId = teamId ?? settings?.team_id ?? league?.teams?.[0]?.id ?? null;
  const myTeam = league?.teams?.find((t: any) => t.id === myTeamId);

  const roster = myTeam?.roster?.entries ?? [];
  const starters = roster.filter((e: any) => STARTER_SLOTS.has(e.lineupSlotId));
  const bench = roster.filter((e: any) => !STARTER_SLOTS.has(e.lineupSlotId));

  const slots = useMemo(() => {
    const s: Record<string, string> = {};
    const by = (want: string[]) => starters.filter((e: any) =>
      want.includes(SLOT[e.lineupSlotId] ?? '')).map((e: any) => e.playerPoolEntry?.player?.fullName);
    const [qb] = by(['QB']); if (qb) s.QB = qb;
    const rbs = by(['RB']); if (rbs[0]) s.RB1 = rbs[0];
    const wrs = by(['WR']); wrs.slice(0, 3).forEach((w: string, i: number) => { s[`WR${i + 1}`] = w; });
    const flex = by(['FLEX', 'RB/WR', 'WR/TE', 'OP']); if (flex[0] && !s.WR3) s.WR3 = flex[0];
    const [te] = by(['TE']); if (te) s.TE1 = te;
    const [k] = by(['K']); if (k) s.K = k;
    return s;
  }, [starters]);

  const matchups = useMemo(() => {
    if (!league?.schedule || !myTeamId) return [];
    return league.schedule
      .filter((m: any) => m.home?.teamId === myTeamId || m.away?.teamId === myTeamId)
      .map((m: any) => {
        const mine = m.home?.teamId === myTeamId ? m.home : m.away;
        const theirs = m.home?.teamId === myTeamId ? m.away : m.home;
        const opp = league.teams?.find((t: any) => t.id === theirs?.teamId);
        return {
          period: m.matchupPeriodId,
          myPoints: mine?.totalPoints ?? 0,
          oppPoints: theirs?.totalPoints ?? 0,
          opp: opp ? (opp.name ?? `${opp.location} ${opp.nickname}`) : 'BYE',
          winner: m.winner
        };
      })
      .sort((a: any, b: any) => a.period - b.period);
  }, [league, myTeamId]);

  const sync = async () => {
    setSyncing(true);
    try { await api('/espn/sync', { method: 'POST' }); refetch(); }
    catch (e: any) { alert(`Sync failed: ${e.message}`); }
    finally { setSyncing(false); }
  };

  if (!settings?.league_id) {
    return (
      <div className="max-w-lg">
        <h1 className="text-2xl font-bold mb-2">My Team</h1>
        <div className="card p-6 text-center">
          <div className="text-4xl mb-2">🔌</div>
          <p className="text-sm text-slate-700 mb-3">Connect your ESPN league to see your roster, starting lineup on the field, and weekly scores.</p>
          <Link to="/settings" className="btn-primary inline-block">Set up ESPN →</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-2xl font-bold">My Team</h1>
        {league?.teams && (
          <select className="input" value={myTeamId ?? ''} onChange={e => setTeamId(Number(e.target.value))}>
            {league.teams.map((t: any) => (
              <option key={t.id} value={t.id}>{t.name ?? `${t.location} ${t.nickname}`}</option>
            ))}
          </select>
        )}
        <button className="btn-ghost ml-auto" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : `↻ Sync${league?.fetched_at ? ` (last: ${league.fetched_at})` : ''}`}
        </button>
      </div>

      {!league && (
        <div className="card p-6 text-sm text-slate-600">
          No league data yet — hit <button className="text-emerald-600 underline" onClick={sync}>Sync</button> to pull your league from ESPN.
        </div>
      )}

      {myTeam && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-4">
          <div>
            <h2 className="text-sm font-bold text-slate-700 mb-2">Starting Lineup — X&apos;s &amp; O&apos;s</h2>
            <FormationView phase="offense" slots={slots} accent="#10b981" />
            <div className="grid md:grid-cols-2 gap-4 mt-4">
              <div className="card p-4">
                <h3 className="text-sm font-bold text-slate-700 mb-2">Starters</h3>
                {starters.map((e: any) => (
                  <div key={e.playerId} className="flex gap-2 text-sm py-0.5">
                    <span className="text-slate-500 text-xs w-10">{SLOT[e.lineupSlotId] ?? e.lineupSlotId}</span>
                    <span>{e.playerPoolEntry?.player?.fullName}</span>
                    <span className={`ml-auto text-xs pos-${POS[e.playerPoolEntry?.player?.defaultPositionId] ?? ''}`}>
                      {POS[e.playerPoolEntry?.player?.defaultPositionId] ?? ''}
                    </span>
                  </div>
                ))}
              </div>
              <div className="card p-4">
                <h3 className="text-sm font-bold text-slate-700 mb-2">Bench</h3>
                {bench.map((e: any) => (
                  <div key={e.playerId} className="flex gap-2 text-sm py-0.5 text-slate-600">
                    <span className="text-slate-400 text-xs w-10">{SLOT[e.lineupSlotId] ?? 'BE'}</span>
                    <span>{e.playerPoolEntry?.player?.fullName}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="card p-4 h-fit">
            <h3 className="text-sm font-bold text-slate-700 mb-2">Weekly Points</h3>
            {matchups.length === 0 && <p className="text-xs text-slate-500">Season hasn&apos;t started — scores will appear here week by week.</p>}
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
    </div>
  );
}
