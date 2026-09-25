import { Link } from 'react-router-dom';
import { Team, useApi } from '../api';
import { PageData, EmptyState } from '../components/PageState';
import DefenceVsPosition from '../components/DefenceVsPosition';

/** Black or white text on a team colour, whichever reads (a gold or yellow badge gets dark ink). */
function inkOn(hex?: string | null) {
  const n = parseInt(String(hex ?? '#333').replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b > .35 ? '#0b0d12' : '#ffffff';
}

export default function Teams() {
  const { data: teams, loading, error, refetch } = useApi<Team[]>('/teams');

  return (
    <div>
      <p className="ds-note mb-4">Pick a team for its offense, defense, special teams, coaching staff and scheme.</p>
      <PageData data={teams} loading={loading} error={error} onRetry={refetch}
        loadingLabel="Loading teams…"
        isEmpty={ts => ts.length === 0}
        empty={<EmptyState title="No teams found" description="Team data hasn't been loaded yet." />}>
        {(teams) => {
          const divisions: Record<string, Team[]> = {};
          for (const t of teams) {
            const key = `${t.conference} ${t.division}`;
            (divisions[key] ??= []).push(t);
          }
          return (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {Object.entries(divisions).map(([div, ts]) => (
                <div key={div} className="ds-card p-4">
                  <h2 className="ds-eyebrow mb-3">{div}</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {ts.map(t => (
                      <Link key={t.abbr} to={`/players/teams/${t.abbr}`}
                        className="ds-lift rounded-[var(--r-tile)] p-3 shadow-[0_0_0_1px_var(--c-line)]"
                        style={{ background: `linear-gradient(135deg, ${t.primary_color}22, transparent)` }}>
                        <div className="flex items-center gap-2">
                          <span className="w-8 h-8 rounded-full grid place-items-center text-xs font-black shrink-0"
                            style={{ background: t.primary_color, color: inkOn(t.primary_color) }}>{t.abbr}</span>
                          <div className="min-w-0">
                            <div className="text-sm font-semibold break-words">{t.name}</div>
                            <div className="text-[10px] text-slate-500 break-words">HC {t.head_coach}</div>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        }}
      </PageData>
      <DefenceVsPosition />
    </div>
  );
}
