import { useState } from 'react';
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
  const { data: validation } = useApi<any>(`/analysis/validate?team=${abbr}`);
  const staleNames: string[] = Array.from(new Set(
    (validation?.teams?.[0]?.stale ?? []).map((x: any) => x.name)
  )) as string[];
  const [phase, setPhase] = useState<Phase>('offense');
  const [unit, setUnit] = useState<string | null>(null);



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
          depth={(team as any).depth ?? {}}
          depthMulti={(team as any).depth_multi}
          grades={(team as any).grades}
          accent={team.primary_color}
          onPlayerClick={pid => nav(`/players/${pid}`)}
          onUnitClick={u => setUnit(u === unit ? null : u)}
          selectedUnit={unit}
        />

        <div className="flex items-center gap-4 mt-2 mb-1 text-[11px] text-slate-500 flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full" style={{ background: 'rgba(16,185,129,0.25)', border: '1.5px solid #10b981' }} />
            strength
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full" style={{ background: 'rgba(244,63,94,0.25)', border: '1.5px solid #f43f5e' }} />
            weak spot (pulsing)
          </span>
          <span className="text-slate-400">hover a highlighted player for why</span>
        </div>

        {(team as any).grades?.units && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-2">
            {Object.entries((team as any).grades.units).map(([unit, g]: any) => (
              <div key={unit} className={`rounded-lg border p-2 ${
                g.grade === 'strength' ? 'border-emerald-300 bg-emerald-50'
                : g.grade === 'weakness' ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'}`}>
                <div className="text-[10px] font-bold text-slate-500">{unit}</div>
                <div className={`text-xs font-bold ${
                  g.grade === 'strength' ? 'text-emerald-700' : g.grade === 'weakness' ? 'text-rose-700' : 'text-slate-600'}`}>
                  {g.grade === 'ok' ? 'average' : g.grade}
                </div>
                <div className="text-[10px] text-slate-500 truncate" title={`weakest: ${g.weakest}`}>
                  weak link: {g.weakest?.split(' ').slice(-1)[0] ?? '—'}
                </div>
              </div>
            ))}
          </div>
        )}

        {staleNames.length > 0 && (
          <div className="card p-3 mt-3 border-amber-300 bg-amber-50">
            <p className="text-xs text-amber-800">
              <strong>Heads up:</strong> the written analysis below still mentions{' '}
              <strong>{staleNames.join(', ')}</strong>, who {staleNames.length === 1 ? 'is' : 'are'} not on
              the current {team.abbr} roster. The diagrams and unit grades above use the live roster and are correct.
              {' '}Use <em>Re-check outlook</em> to rewrite it (needs an API key in the Dev Hub).
            </p>
          </div>
        )}

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
