import { Headshot, Trend } from './PlayerRow';
import { usePlayerCard } from './PlayerCard';
import { headshotUrl } from '../api';

export type StatMode = 'projected' | 'actual';

/** Columns that matter per position, in the order a fantasy player reads them. */
const COLS: Record<string, [string, string][]> = {
  QB: [['passYds', 'PASS'], ['passTD', 'PTD'], ['int', 'INT'], ['rushYds', 'RUSH'], ['rushTD', 'RTD']],
  RB: [['rushAtt', 'CAR'], ['rushYds', 'RUSH'], ['rushTD', 'RTD'], ['targets', 'TGT'], ['rec', 'REC'], ['recYds', 'RECY'], ['recTD', 'RECTD']],
  WR: [['targets', 'TGT'], ['rec', 'REC'], ['recYds', 'YDS'], ['recTD', 'TD'], ['rushYds', 'RUSH']],
  TE: [['targets', 'TGT'], ['rec', 'REC'], ['recYds', 'YDS'], ['recTD', 'TD']],
  K: [], DEF: []
};
// Mixed-position view: derived totals so a QB, RB and WR are comparable in one table.
const UNIVERSAL: [string, string][] = [
  ['_touches', 'TCH'], ['_totalYds', 'YDS'], ['_totalTD', 'TD'], ['_passYds', 'PASS']
];

const n0 = (v?: number | null) => (v == null ? '—' : Math.round(v).toLocaleString());
const n1 = (v?: number | null) => (v == null ? '—' : v.toFixed(1));

export function colsFor(position: string) {
  return position === 'ALL' ? UNIVERSAL : (COLS[position] ?? UNIVERSAL);
}

/** Derived cross-position totals. */
function derive(line: any) {
  const g = (k: string) => line?.[k] ?? 0;
  return {
    _touches: (g('rushAtt') + g('rec')) || null,
    _totalYds: (g('rushYds') + g('recYds')) || null,
    _totalTD: (g('rushTD') + g('recTD') + g('passTD')) || null,
    _passYds: g('passYds') || null
  };
}

/** One row of the ranking stat table. */
export function StatRow({ e, mode, cols, children }: {
  e: any; mode: StatMode; cols: [string, string][]; children?: React.ReactNode;
}) {
  const open = usePlayerCard();
  const st = e.stats ?? {};
  const base = (mode === 'projected' ? st.projected_line : st.last_season_line) ?? {};
  const line = { ...base, ...derive(base) };
  const pts = mode === 'projected' ? st.projected_points : st.last_season_points;

  return (
    <tr className="hover:bg-emerald-50/50 group">
      <td className="pl-3 pr-1 py-1.5 text-right text-xs font-mono text-slate-400 tabular-nums">{e.rank}</td>
      <td className="px-1 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <Headshot src={headshotUrl(e)} pos={e.position} size={28} />
          <div className="min-w-0">
            <button
              onClick={() => open(e.player_id)}
              className="block text-left font-semibold text-sm text-slate-800 hover:text-emerald-700 truncate max-w-[170px]"
              title={`${e.name} — click for outlook`}>
              <span className={`text-[10px] font-black mr-1.5 pos-${e.position}`}>{e.position}</span>
              {e.name}
            </button>
            <div className="text-[10px] text-slate-400 leading-tight">
              {e.team_abbr ?? 'FA'}
              {st.projected_pos_rank ? ` · ${e.position}${st.projected_pos_rank}` : ''}
              {e.injury_flag ? <span className="text-rose-600 font-bold"> · INJ</span> : null}
            </div>
          </div>
        </div>
      </td>
      <td className="px-1 py-1.5 text-right text-sm font-bold text-slate-800 tabular-nums">{n0(pts)}</td>
      <td className="px-1 py-1.5 text-right text-xs tabular-nums">
        {mode === 'projected' && st.delta != null
          ? <span className={st.delta >= 0 ? 'text-good' : 'text-crit'}>
              {st.delta >= 0 ? '+' : ''}{Math.round(st.delta)}
            </span>
          : <span className="text-slate-300">—</span>}
      </td>
      {cols.map(([key, label]) => (
        <td key={label} className="px-1 py-1.5 text-right text-xs tabular-nums text-slate-600">
          {line[key] == null ? '—' : (key === 'rec' || key.endsWith('TD') || key === 'int' || key === 'targets' || key === 'rushAtt')
            ? n1(line[key]).replace(/\.0$/, '')
            : n0(line[key])}
        </td>
      ))}
      <td className="px-1 py-1.5 text-right text-xs tabular-nums text-slate-500">{e.adp != null ? e.adp.toFixed(1) : '—'}</td>
      <td className="px-1 py-1.5 text-right text-xs tabular-nums text-slate-600">{n0(e.market_value)}</td>
      <td className="px-1 py-1.5 text-right text-xs"><Trend value={e.market_value} trend={e.market_trend} /></td>
      {children}
    </tr>
  );
}

export function StatHeader({ cols, mode, children }: { cols: [string, string][]; mode: StatMode; children?: React.ReactNode }) {
  return (
    <tr className="text-[10px] uppercase tracking-wide text-slate-400 bg-slate-50">
      <th className="pl-3 pr-1 py-2 text-right font-medium">#</th>
      <th className="px-1 py-2 text-left font-medium">Player</th>
      <th className="px-1 py-2 text-right font-medium">{mode === 'projected' ? 'Proj' : '25 Pts'}</th>
      <th className="px-1 py-2 text-right font-medium" title="projected points minus last season">Δ</th>
      {cols.map(([, label]) => <th key={label} className="px-1 py-2 text-right font-medium">{label}</th>)}
      <th className="px-1 py-2 text-right font-medium">ADP</th>
      <th className="px-1 py-2 text-right font-medium" title="FantasyCalc trade value">Val</th>
      <th className="px-1 py-2 text-right font-medium">30d</th>
      {children}
    </tr>
  );
}
