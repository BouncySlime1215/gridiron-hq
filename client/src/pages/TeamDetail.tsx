import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Team, useApi } from '../api';
import FormationView from '../components/FormationView';
import OffseasonPanel from '../components/OffseasonPanel';
import SidePanel from '../components/SidePanel';

type Phase = 'offense' | 'defense' | 'special_teams' | 'offseason';

const PHASE_TABS: { key: Phase; label: string }[] = [
  { key: 'offense', label: 'Offense' },
  { key: 'defense', label: 'Defense' },
  { key: 'special_teams', label: 'Special Teams' },
  { key: 'offseason', label: 'Offseason & Schedule' }
];

const UNIT_LABEL: Record<string, string> = {
  OL: 'Offensive Line Unit', DL: 'Defensive Front Unit', LB: 'Linebackers',
  DB: 'Secondary', ST: 'Special Teams Unit'
};

export default function TeamDetail() {
  const { abbr } = useParams();
  const nav = useNavigate();
  const { data: team, loading, refetch: refetchTeam } = useApi<Team>(`/teams/${abbr}`);
  const { data: teamNews, refetch: refetchNews } = useApi<any[]>(`/news?team=${abbr}`);
  const [newsBusy, setNewsBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);

  const pullTeamNews = async () => {
    setNewsBusy(true);
    try { await api(`/espn/sync-news?team=${abbr}`, { method: 'POST' }); refetchNews(); }
    catch (e: any) { alert(`News pull failed: ${e.message}`); }
    finally { setNewsBusy(false); }
  };

  const refreshOutlook = async () => {
    setAiBusy(true); setAiMsg(null);
    try {
      const r = await api('/analysis/refresh', { method: 'POST', body: JSON.stringify({ teams: [abbr] }) });
      const t = r.refreshed?.[0];
      setAiMsg(t?.error ? `AI refresh failed: ${t.error}` : t?.changed ? `Outlook updated — ${t.reason}` : `No changes needed — ${t?.reason ?? 'analysis is current'}`);
      refetchTeam();
    } catch (e: any) { setAiMsg(e.message); }
    finally { setAiBusy(false); }
  };
  const [phase, setPhase] = useState<Phase>('offense');
  const [unit, setUnit] = useState<string | null>(null);

  const slots = useMemo(() => {
    const m: Record<string, { name: string; id: number }> = {};
    for (const p of team?.players ?? []) if (p.slot_code) m[p.slot_code] = { name: p.name, id: p.id };
    return m;
  }, [team]);

  if (loading || !team) return <p className="text-slate-500">Loading team…</p>;

  const unitAnalysis: Record<string, string | undefined> = {
    OL: team.ol_analysis, DL: team.dl_analysis, LB: team.lb_analysis,
    DB: team.secondary_analysis, ST: team.st_analysis
  };

  const phaseScheme = phase === 'offense' ? team.off_scheme : phase === 'defense' ? team.def_scheme : 'Special Teams';
  const phaseDetail = phase === 'offense' ? team.off_scheme_detail : phase === 'defense' ? team.def_scheme_detail : team.st_analysis;

  return (
    <div className="flex flex-col xl:flex-row gap-6">
      <div className="flex-1 min-w-0">
        <Link to="/teams" className="text-xs text-slate-500 hover:text-slate-700">← all teams</Link>
        <div className="flex items-center gap-3 mt-1 mb-4">
          <span className="w-12 h-12 rounded-full grid place-items-center text-sm font-black text-white"
            style={{ background: team.primary_color }}>{team.abbr}</span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">{team.name}</h1>
            <div className="text-xs text-slate-600">
              HC <span className="text-slate-800">{team.head_coach}</span>
              {team.oc_name && <> · OC <span className="text-slate-800">{team.oc_name}</span></>}
              {team.dc_name && <> · DC <span className="text-slate-800">{team.dc_name}</span></>}
            </div>
          </div>
        </div>

        <div className="flex gap-1 mb-4">
          {PHASE_TABS.map(t => (
            <button key={t.key}
              onClick={() => { setPhase(t.key); setUnit(null); }}
              className={`btn ${phase === t.key ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {phase === 'offseason' ? <OffseasonPanel abbr={team.abbr} /> : (<>
        <FormationView
          phase={phase as any}
          slots={slots}
          scheme={phase === 'defense' ? team.def_scheme : team.off_scheme}
          accent={team.primary_color}
          onPlayerClick={pid => nav(`/players/${pid}`)}
          onUnitClick={u => setUnit(u === unit ? null : u)}
          selectedUnit={unit}
        />

        <div className="grid md:grid-cols-2 gap-4 mt-4">
          <div className="card p-4">
            <h3 className="text-sm font-bold text-emerald-600 mb-1">Scheme — {phaseScheme}</h3>
            <p className="text-sm text-slate-700 leading-relaxed">{phaseDetail}</p>
          </div>
          <div className="card p-4">
            <h3 className="text-sm font-bold text-amber-600 mb-1">
              {unit ? UNIT_LABEL[unit] : 'Coach & Fantasy Outlook'}
            </h3>
            <p className="text-sm text-slate-700 leading-relaxed">
              {unit ? (unitAnalysis[unit] ?? 'No analysis yet.') : team.coach_analysis}
            </p>
            {unit && (
              <button className="text-xs text-slate-500 hover:text-slate-700 mt-2" onClick={() => setUnit(null)}>
                ← back to coach outlook
              </button>
            )}
          </div>
        </div>

        {phase === 'defense' && (
          <div className="card p-4 mt-4">
            <h3 className="text-sm font-bold text-slate-600 mb-2">Unit Analyses</h3>
            <div className="grid md:grid-cols-3 gap-3 text-xs text-slate-700">
              <div><span className="font-bold text-slate-800 block mb-1">Front</span>{team.dl_analysis}</div>
              <div><span className="font-bold text-slate-800 block mb-1">Linebackers</span>{team.lb_analysis}</div>
              <div><span className="font-bold text-slate-800 block mb-1">Secondary</span>{team.secondary_analysis}</div>
            </div>
          </div>
        )}
        {phase === 'offense' && (
          <div className="card p-4 mt-4">
            <h3 className="text-sm font-bold text-slate-600 mb-1">O-Line Unit</h3>
            <p className="text-xs text-slate-700">{team.ol_analysis}</p>
          </div>
        )}

        <div className="card p-4 mt-4">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-bold text-slate-700">{team.abbr} News</h3>
            <button className="btn-ghost ml-auto text-xs" onClick={pullTeamNews} disabled={newsBusy}>
              {newsBusy ? 'Pulling…' : '↻ Pull latest from ESPN'}
            </button>
            <button className="btn-ghost text-xs" onClick={refreshOutlook} disabled={aiBusy}
              title="Ask AI: did any new news change this team's outlook?">
              {aiBusy ? 'Thinking…' : '✨ Re-check outlook'}
            </button>
          </div>
          {aiMsg && <p className="text-xs text-amber-600 mb-2">{aiMsg}</p>}
          {(teamNews ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">No stories for {team.abbr} yet — pull the latest from ESPN&apos;s team feed.</p>
          ) : (teamNews ?? []).slice(0, 8).map(n => (
            <div key={n.id} className="py-2 border-b border-slate-100 last:border-0">
              <div className="text-[11px] text-slate-500">{n.date}{n.source && ` · ${n.source}`}</div>
              <div className="text-sm font-medium">{n.headline}</div>
              {n.fantasy_impact && <div className="text-xs text-amber-600 mt-0.5">🎯 {n.fantasy_impact}</div>}
            </div>
          ))}
        </div>
        </>)}
      </div>
      <SidePanel />
    </div>
  );
}
