import { Link } from 'react-router-dom';
import { useApi, Draft, RankingEntry } from '../api';

// Right-hand rail: my current draft team + best available from my rankings.
export default function SidePanel() {
  const { data: drafts } = useApi<any[]>('/drafts');
  const active = drafts?.find(d => d.status === 'active');
  const { data: draft } = useApi<Draft>(active ? `/drafts/${active.id}` : null);
  const { data: sets } = useApi<any[]>('/rankings');
  const fallbackSet = sets?.[0];
  const { data: entries } = useApi<RankingEntry[]>(
    !active && fallbackSet ? `/rankings/${fallbackSet.id}/entries` : null);

  const myPicks = draft?.picks.filter(p => p.team_slot === draft.my_slot) ?? [];
  const best = draft ? draft.available.slice(0, 10) : (entries?.slice(0, 10) ?? []);

  return (
    <div className="w-full xl:w-72 shrink-0 space-y-4">
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-slate-700">My Team</h3>
          {active && <Link to={`/drafts/${active.id}`} className="text-xs text-emerald-600 hover:underline">draft room →</Link>}
        </div>
        {myPicks.length === 0 ? (
          <p className="text-xs text-slate-500">{active ? 'No picks yet.' : 'No active draft. Start one in the Draft Room.'}</p>
        ) : (
          <ul className="space-y-1">
            {myPicks.map(p => (
              <li key={p.pick_number} className="flex items-center gap-2 text-xs">
                <span className={`font-bold w-8 pos-${p.position}`}>{p.position}</span>
                <span className="text-slate-800">{p.name}</span>
                <span className="text-slate-500 ml-auto">{p.team_abbr}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card p-4">
        <h3 className="text-sm font-bold text-slate-700 mb-2">
          Best Available <span className="text-slate-500 font-normal">(my board)</span>
        </h3>
        {best.length === 0 ? (
          <p className="text-xs text-slate-500">No rankings yet.</p>
        ) : (
          <ul className="space-y-1">
            {best.map((e: any) => (
              <li key={e.player_id} className="flex items-center gap-2 text-xs">
                <span className="text-slate-500 w-6 text-right">{e.rank}</span>
                <span className={`font-bold w-8 pos-${e.position}`}>{e.position}</span>
                <span className="text-slate-800 truncate">{e.name}</span>
                <span className="text-slate-500 ml-auto">{e.team_abbr}</span>
              </li>
            ))}
          </ul>
        )}
        <Link to="/rankings" className="block mt-3 text-xs text-emerald-600 hover:underline">edit rankings →</Link>
      </div>
    </div>
  );
}
