import { useMemo, useState } from 'react';
import { useApi } from '../../api';

interface Variable { key: string; scope: string; group: string; kind: string; description: string; }
interface Payload {
  summary: { total: number; team: number; player: number; by_group: Record<string, number> };
  variables: Variable[];
}

/**
 * The full variable list, browsable and searchable.
 *
 * This page exists so the headline number is checkable rather than taken on
 * faith — every variable the model computes is here with a definition, and the
 * count at the top is derived from this same list.
 */
export default function VariableCatalog() {
  const { data, loading, error } = useApi<Payload>('/nfl-betting/catalog');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'team' | 'player'>('all');
  const [group, setGroup] = useState('all');

  const groups = useMemo(
    () => Object.keys(data?.summary.by_group ?? {}).sort(),
    [data]
  );

  const filtered = useMemo(() => (data?.variables ?? []).filter(v =>
    (scope === 'all' || v.scope === scope) &&
    (group === 'all' || v.group === group) &&
    (!q || v.key.toLowerCase().includes(q.toLowerCase()) || v.description.toLowerCase().includes(q.toLowerCase()))
  ), [data, q, scope, group]);

  if (loading) return <div className="card p-6 text-sm text-slate-500">Loading catalog…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-600">{error}</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Variable Catalog</h1>
      <p className="text-sm text-slate-500 mb-4">
        Every variable the NFL model computes, with what it means. The totals below are counted from
        this list, so the number is verifiable rather than asserted.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Card label="Total variables" value={data?.summary.total ?? 0} />
        <Card label="Team level" value={data?.summary.team ?? 0} />
        <Card label="Player level" value={data?.summary.player ?? 0} />
      </div>

      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <input className="input py-1 text-xs flex-1 min-w-[180px]" placeholder="Search name or definition…"
          value={q} onChange={e => setQ(e.target.value)} />
        <div className="flex gap-1">
          {(['all', 'team', 'player'] as const).map(s => (
            <button key={s} onClick={() => setScope(s)}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                scope === s ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
              }`}>{s === 'all' ? 'All' : s === 'team' ? 'Team' : 'Player'}</button>
          ))}
        </div>
        <select className="input py-1 text-xs" value={group} onChange={e => setGroup(e.target.value)}>
          <option value="all">All groups ({groups.length})</option>
          {groups.map(g => <option key={g} value={g}>{g} ({data?.summary.by_group[g]})</option>)}
        </select>
      </div>

      <div className="text-[11px] text-slate-400 mb-2">Showing {filtered.length} variables</div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-400 sticky top-0">
              <tr>{['Variable', 'Scope', 'Group', 'What it means'].map((h, i) => (
                <th key={i} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((v, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-mono text-[11px] font-semibold text-slate-800 whitespace-nowrap">{v.key}</td>
                  <td className="px-3 py-1.5">
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                      v.scope === 'team' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'}`}>
                      {v.scope}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{v.group}</td>
                  <td className="px-3 py-1.5 text-slate-600">{v.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-3 mt-4 text-[11px] text-slate-500">
        More variables does not automatically mean a better model — a large feature set can overfit.
        These are computed from real play-by-play, tracking and charted data; which of them actually
        earn their way into a prediction is decided by the walk-forward backtest on the Board page,
        not by the size of this list.
      </div>
    </div>
  );
}

const Card = ({ label, value }: { label: string; value: number }) => (
  <div className="card p-3">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-2xl font-black text-slate-800">{value}</div>
  </div>
);
