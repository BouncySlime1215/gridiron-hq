import { Link } from 'react-router-dom';
import { Team, useApi } from '../api';

export default function Teams() {
  const { data: teams, loading } = useApi<Team[]>('/teams');
  if (loading) return <p className="text-slate-500">Loading teams…</p>;

  const divisions: Record<string, Team[]> = {};
  for (const t of teams ?? []) {
    const key = `${t.conference} ${t.division}`;
    (divisions[key] ??= []).push(t);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">All 32 Teams</h1>
      <p className="text-sm text-slate-600 mb-6">Click a team for the full X&apos;s and O&apos;s deep dive — offense, defense, special teams, coach and scheme analysis.</p>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {Object.entries(divisions).map(([div, ts]) => (
          <div key={div} className="card p-4">
            <h2 className="text-sm font-bold text-slate-600 mb-3 tracking-wide">{div.toUpperCase()}</h2>
            <div className="grid grid-cols-2 gap-2">
              {ts.map(t => (
                <Link key={t.abbr} to={`/teams/${t.abbr}`}
                  className="rounded-lg p-3 border border-slate-200 hover:border-slate-500 transition-colors"
                  style={{ background: `linear-gradient(135deg, ${t.primary_color}22, transparent)` }}>
                  <div className="flex items-center gap-2">
                    <span className="w-8 h-8 rounded-full grid place-items-center text-xs font-black text-white"
                      style={{ background: t.primary_color }}>{t.abbr}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{t.name}</div>
                      <div className="text-[10px] text-slate-500 truncate">HC {t.head_coach}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
