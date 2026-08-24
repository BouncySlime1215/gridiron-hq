import { useApi } from '../api';

const money = (n?: number | null) =>
  n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;

const GROUP_LABEL: Record<string, string> = {
  QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', OL: 'O-Line',
  DL: 'D-Line', EDGE: 'Edge', LB: 'LB', CB: 'CB', S: 'Safety', ST: 'Specialists'
};
// Rough healthy 53-man allocations — used only to flag thin rooms.
const HEALTHY = { QB: 3, RB: 4, WR: 6, TE: 3, OL: 9, DL: 5, EDGE: 4, LB: 4, CB: 5, S: 4, ST: 3 };

export default function OffseasonPanel({ abbr }: { abbr: string }) {
  const { data, loading } = useApi<any>(`/nfl/offseason/${abbr}`);

  if (loading || !data) return <p className="text-sm text-slate-500">Loading offseason data…</p>;
  const { cap, sos, rookies, group_counts: counts, group_avg_age: ages } = data;

  const thin = Object.entries(counts)
    .filter(([g, n]) => (HEALTHY as any)[g] && (n as number) < (HEALTHY as any)[g])
    .map(([g, n]) => ({ group: g, have: n as number, want: (HEALTHY as any)[g] }));

  return (
    <div className="space-y-4">
      {/* cap + schedule headline numbers */}
      <div className="grid sm:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Cap space</div>
          <div className={`text-xl font-bold ${(cap?.cap_space ?? 0) < 0 ? 'text-rose-600' : 'text-slate-800'}`}>
            {money(cap?.cap_space)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {cap ? <>dead money {money(cap.dead_money)} · {cap.roster_count} under contract</> : 'not synced'}
          </div>
          {cap?.source && <div className="text-[10px] text-slate-400 mt-1">source: {cap.source} · {cap.fetched_at?.slice(0, 10)}</div>}
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Strength of schedule</div>
          <div className="text-xl font-bold text-slate-800">
            {sos ? `#${sos.rank}` : '—'}<span className="text-sm font-normal text-slate-400"> / 32</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {sos ? `${sos.rank <= 10 ? 'One of the easiest' : sos.rank >= 23 ? 'One of the hardest' : 'Middle-of-the-pack'} slates · ${sos.home_games} home` : 'not synced'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Roster</div>
          <div className="text-xl font-bold text-slate-800">{data.roster_size}</div>
          <div className="text-[11px] text-slate-500 mt-1">{rookies.length} rookies / first-year players</div>
        </div>
      </div>

      {/* positional needs off the real 90-man roster */}
      <div className="card p-4">
        <h3 className="text-sm font-bold text-slate-700 mb-1">Roster composition &amp; needs</h3>
        <p className="text-[11px] text-slate-500 mb-3">Counts are the live 90-man roster. “Thin” flags a room carrying fewer bodies than a typical 53-man allocation.</p>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {Object.entries(counts).map(([g, n]) => {
            const isThin = thin.some(t => t.group === g);
            return (
              <div key={g} className={`rounded-lg border p-2 ${isThin ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}>
                <div className="text-[10px] font-bold text-slate-500">{GROUP_LABEL[g] ?? g}</div>
                <div className="text-lg font-bold text-slate-800 leading-tight">{n as number}</div>
                <div className="text-[10px] text-slate-400">
                  {ages[g] ? `avg ${ages[g]}y` : '—'}{isThin && <span className="text-rose-600 font-bold"> · thin</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* rookies */}
      {rookies.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-bold text-slate-700 mb-2">Rookies &amp; first-year players ({rookies.length})</h3>
          <div className="flex flex-wrap gap-1.5">
            {rookies.map((p: any, i: number) => (
              <span key={i} className="text-xs px-2 py-1 rounded-lg bg-slate-50 border border-slate-200">
                <span className="font-bold text-slate-500 mr-1">{p.position}</span>{p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* honest gaps */}
      <div className="card p-4 bg-slate-50">
        <h3 className="text-xs font-bold text-slate-600 mb-1">Not shown (no reliable free source)</h3>
        <ul className="text-[11px] text-slate-500 space-y-1 list-disc list-inside">
          <li>{data.unavailable.future_draft_picks}</li>
          <li>{data.unavailable.transactions}</li>
        </ul>
      </div>
    </div>
  );
}
