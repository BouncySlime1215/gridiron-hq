
import { Link, useParams } from 'react-router-dom';
import { headshotUrl, useApi } from '../api';
import FormationView from '../components/FormationView';
import { Headshot } from '../components/PlayerRow';
import { usePlayerCard } from '../components/PlayerCard';

// Which unit analysis matters for this position
const UNIT_FOR_POS: Record<string, { key: string; label: string }> = {
  QB: { key: 'ol_analysis', label: 'His O-Line (protection)' },
  RB: { key: 'ol_analysis', label: 'His O-Line (run blocking)' },
  WR: { key: 'ol_analysis', label: 'His O-Line (time to throw)' },
  TE: { key: 'ol_analysis', label: 'His O-Line' },
  K: { key: 'st_analysis', label: 'Special Teams Unit' },
  EDGE: { key: 'dl_analysis', label: 'His Front' },
  DL: { key: 'dl_analysis', label: 'His Front' },
  LB: { key: 'lb_analysis', label: 'His LB Corps' },
  CB: { key: 'secondary_analysis', label: 'His Secondary' },
  S: { key: 'secondary_analysis', label: 'His Secondary' }
};

const OFF_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

export default function PlayerDetail() {
  const { id } = useParams();
  const openCard = usePlayerCard();
  const { data: p, loading } = useApi<any>(`/players/${id}`);



  if (loading || !p) return <p className="text-slate-500">Loading player…</p>;

  const phase = OFF_POS.has(p.position) ? (p.position === 'K' ? 'special_teams' : 'offense') : 'defense';
  const unit = UNIT_FOR_POS[p.position];
  const schemeDetail = phase === 'defense' ? p.def_scheme_detail : p.off_scheme_detail;
  const schemeName = phase === 'defense' ? p.def_scheme : p.off_scheme;

  return (
    <div className="max-w-4xl">
      {p.team_abbr
        ? <Link to={`/teams/${p.team_abbr}`} className="text-xs text-slate-500 hover:text-slate-700">← {p.team_name}</Link>
        : <Link to="/rankings" className="text-xs text-slate-500 hover:text-slate-700">← rankings</Link>}
      <div className="flex items-center gap-3 mt-1 mb-4">
        <Headshot src={headshotUrl(p)} pos={p.position} size={52} />
        <div>
          <h1 className="text-2xl font-bold leading-tight">
            {p.name} <span className={`text-lg pos-${p.position}`}>{p.position}</span>
          </h1>
          <div className="text-xs text-slate-500">
            {p.team_name ?? 'Free agent'}{p.head_coach && <> · HC <span className="text-slate-700">{p.head_coach}</span></>}
          </div>
        </div>
        {p.ranks?.length > 0 && (
          <div className="ml-auto text-right">
            {p.ranks.map((r: any) => (
              <div key={r.set_name} className="text-sm">
                <span className="font-black text-emerald-600">#{r.rank}</span>
                <span className="text-xs text-slate-500"> on {r.set_name} · T{r.tier}</span>
                {r.note && <div className="text-xs text-slate-500 italic">“{r.note}”</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {p.team_abbr && p.depth && Object.keys(p.depth).length > 0 && (
        <FormationView
          phase={phase}
          depth={p.depth}
          depthMulti={p.depth_multi}
          accent={p.primary_color ?? '#0f766e'}
          onPlayerClick={pid => { if (pid !== p.id) openCard(pid); }}
        />
      )}

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        {schemeDetail && (
          <div className="card p-4">
            <h3 className="text-sm font-bold text-emerald-600 mb-1">How the scheme uses him — {schemeName}</h3>
            <p className="text-sm text-slate-700 leading-relaxed">{schemeDetail}</p>
          </div>
        )}
        {unit && p[unit.key] && (
          <div className="card p-4">
            <h3 className="text-sm font-bold text-amber-600 mb-1">{unit.label}</h3>
            <p className="text-sm text-slate-700 leading-relaxed">{p[unit.key]}</p>
          </div>
        )}
        {p.coach_analysis && (
          <div className="card p-4 md:col-span-2">
            <h3 className="text-sm font-bold text-slate-700 mb-1">Coach &amp; Fantasy Outlook ({p.team_abbr})</h3>
            <p className="text-sm text-slate-700 leading-relaxed">{p.coach_analysis}</p>
          </div>
        )}
      </div>

      {p.news?.length > 0 && (
        <div className="card p-4 mt-4">
          <h3 className="text-sm font-bold text-slate-700 mb-2">News mentioning {p.name.split(' ').slice(-1)[0]}</h3>
          {p.news.map((n: any) => (
            <div key={n.id} className="py-2 border-b border-slate-200/60 last:border-0">
              <div className="text-xs text-slate-500">{n.date} {n.team_abbr && `· ${n.team_abbr}`}</div>
              <div className="text-sm font-medium">{n.headline}</div>
              {n.fantasy_impact && <div className="text-xs text-amber-600 mt-0.5">{n.fantasy_impact}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
