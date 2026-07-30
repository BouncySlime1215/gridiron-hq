import { useEffect, useMemo, useState } from 'react';
import { api, headshotUrl, useApi } from '../api';
import { Headshot, TIER_COLORS } from '../components/PlayerRow';
import { usePlayerCard } from '../components/PlayerCard';

type Col = { key: string; label: string; w?: string; fmt?: (p: any) => any; tone?: (p: any) => string; title?: string };

const n0 = (v: any) => (v == null ? '—' : Math.round(v).toLocaleString());
const n1 = (v: any) => (v == null ? '—' : Number(v).toFixed(1));
const pct = (v: any) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const signed = (v: any) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}`);
const line = (p: any, k: string, which: 'proj_line' | 'last_line' = 'proj_line') => p[which]?.[k] ?? null;

/** Column presets — the four different jobs the old separate pages were doing. */
const VIEWS: Record<string, { label: string; hint: string; cols: Col[] }> = {
  board: {
    label: 'My Board', hint: 'Your ranking with projections and value side by side',
    cols: [
      { key: 'proj', label: 'Proj', fmt: p => n0(p.proj) },
      { key: 'pos_rank', label: 'Pos', fmt: p => (p.pos_rank ? `${p.position}${p.pos_rank}` : '—') },
      { key: 'vor', label: 'VOR', title: 'points above replacement', fmt: p => n1(p.vor) },
      { key: 'adp', label: 'ADP', fmt: p => n1(p.adp) },
      { key: 'adp_edge', label: 'Edge', title: 'ADP minus VOR rank — positive means he lasts longer than he should',
        fmt: p => signed(p.adp_edge),
        tone: p => p.adp_edge == null ? 'text-slate-300' : p.adp_edge > 3 ? 'text-emerald-600' : p.adp_edge < -3 ? 'text-rose-600' : 'text-slate-400' },
      { key: 'last_pts', label: "'25", fmt: p => n0(p.last_pts) },
      { key: 'delta', label: 'Δ', fmt: p => signed(p.delta),
        tone: p => p.delta == null ? 'text-slate-300' : p.delta >= 0 ? 'text-emerald-600' : 'text-rose-600' }
    ]
  },
  value: {
    label: 'Value & Market', hint: 'VOR, ADP arbitrage and where the trade market is moving',
    cols: [
      { key: 'vor', label: 'VOR', fmt: p => n1(p.vor) },
      { key: 'vor_rank', label: 'VOR#', fmt: p => p.vor_rank ?? '—' },
      { key: 'adp', label: 'ADP', fmt: p => n1(p.adp) },
      { key: 'adp_edge', label: 'Edge', fmt: p => signed(p.adp_edge),
        tone: p => p.adp_edge == null ? 'text-slate-300' : p.adp_edge > 3 ? 'text-emerald-600' : p.adp_edge < -3 ? 'text-rose-600' : 'text-slate-400' },
      { key: 'market_value', label: 'Value', fmt: p => n0(p.market_value) },
      { key: 'market_trend_pct', label: '30d', fmt: p => p.market_trend_pct == null ? '—' : `${p.market_trend_pct > 0 ? '▲' : p.market_trend_pct < 0 ? '▼' : '·'}${Math.abs(p.market_trend_pct).toFixed(1)}%`,
        tone: p => p.market_trend_pct == null ? 'text-slate-300' : p.market_trend_pct > 0.5 ? 'text-emerald-600' : p.market_trend_pct < -0.5 ? 'text-rose-600' : 'text-slate-400' },
      { key: 'buy_sell', label: 'Call', fmt: p => p.buy_sell ?? p.scout_verdict ?? '—',
        tone: p => /BUY|WINNER|VALUE/.test(p.buy_sell ?? p.scout_verdict ?? '') ? 'text-emerald-600'
          : /SELL|AVOID|OVERPRICED/.test(p.buy_sell ?? p.scout_verdict ?? '') ? 'text-rose-600' : 'text-slate-400' }
    ]
  },
  weekly: {
    label: 'Weekly Profile', hint: 'Floor, ceiling, boom/bust and playoff schedule from real games',
    cols: [
      { key: 'games', label: 'G', fmt: p => p.games ?? '—' },
      { key: 'avg', label: 'Avg', fmt: p => n1(p.avg) },
      { key: 'floor', label: 'Floor', fmt: p => n1(p.floor) },
      { key: 'ceiling', label: 'Ceil', fmt: p => n1(p.ceiling) },
      { key: 'boom', label: 'Boom', fmt: p => pct(p.boom), tone: () => 'text-emerald-600' },
      { key: 'bust', label: 'Bust', fmt: p => pct(p.bust), tone: () => 'text-rose-600' },
      { key: 'consistency', label: 'Cons', fmt: p => p.consistency == null ? '—' : p.consistency.toFixed(2) },
      { key: 'playoff_rank', label: 'PO SOS', title: 'weeks 15-17 schedule rank, 1 = easiest',
        fmt: p => p.playoff_rank ?? '—',
        tone: p => p.playoff_rank == null ? 'text-slate-300' : p.playoff_rank <= 10 ? 'text-emerald-600' : p.playoff_rank >= 23 ? 'text-rose-600' : 'text-slate-500' }
    ]
  },
  stats: {
    label: 'Stat Line', hint: 'Projected box score for the coming season',
    cols: [
      { key: 'proj', label: 'Proj', fmt: p => n0(p.proj) },
      { key: 'tgt', label: 'Tgt', fmt: p => n0(line(p, 'targets')) },
      { key: 'rec', label: 'Rec', fmt: p => n0(line(p, 'rec')) },
      { key: 'recYds', label: 'RecY', fmt: p => n0(line(p, 'recYds')) },
      { key: 'car', label: 'Car', fmt: p => n0(line(p, 'rushAtt')) },
      { key: 'rushYds', label: 'RushY', fmt: p => n0(line(p, 'rushYds')) },
      { key: 'passYds', label: 'PassY', fmt: p => n0(line(p, 'passYds')) },
      { key: 'td', label: 'TD', fmt: p => n1((line(p, 'recTD') ?? 0) + (line(p, 'rushTD') ?? 0) + (line(p, 'passTD') ?? 0)) }
    ]
  }
};

/** Tiny inline weekly-points chart. Bars, so a zero week reads as a zero. */
function Spark({ series, height = 22 }: { series?: number[]; height?: number }) {
  if (!series?.length) return <span className="text-slate-300 text-[10px]">no weeks</span>;
  const max = Math.max(...series, 1);
  const w = 3, gap = 1.4;
  return (
    <svg width={series.length * (w + gap)} height={height} className="overflow-visible">
      {series.map((v, i) => {
        const h = Math.max(1, (v / max) * height);
        return (
          <rect key={i} x={i * (w + gap)} y={height - h} width={w} height={h} rx={1}
            fill={v >= max * 0.75 ? '#10b981' : v <= max * 0.25 ? '#f43f5e' : '#94a3b8'}>
            <title>{`Wk ${i + 1}: ${v} pts`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

const GLOSSARY: [string, string][] = [
  ['VOR', 'Value Over Replacement — projected points minus the last startable player at that position. The real draft currency: 300 QB points are worth less than 300 RB points when QB13 also scores 270.'],
  ['Edge', 'ADP minus VOR rank. Positive means the market lets him fall later than his value says he should — that is your arbitrage.'],
  ['Value', 'FantasyCalc trade value, aggregated from thousands of real league trades.'],
  ['30d', 'How that trade value moved over the last 30 days, as a percentage.'],
  ['Boom / Bust', 'Share of last season’s weeks above a positional boom line (RB/WR 18+, QB 24+, TE 14+) or below a bust line (RB/WR 8-, QB 14-, TE 6-).'],
  ['Floor / Ceil', '20th and 80th percentile of his weekly scores — the realistic bad week and good week, not the extremes.'],
  ['Cons', 'Consistency: output relative to weekly variance. 1.00 would be identical every week.'],
  ['PO SOS', 'Fantasy-playoff strength of schedule, weeks 15-17 only, ranked 1-32. 1 is the easiest slate.'],
  ['Δ', 'Projected points minus last season’s actual — how far the projection is moving him.'],
  ['Call', 'Your saved AI verdict: buy/sell from the player card, or the scout report verdict.']
];

/** One-click filter + sort combinations that answer a real draft question. */
const PRESETS: { label: string; hint: string; apply: (s: any) => void }[] = [
  { label: '💎 Best values', hint: 'Biggest positive gap between ADP and VOR rank',
    apply: s => { s.setSort({ key: 'adp_edge', dir: -1 }); s.setOnlyBoard(false); s.setView('value'); } },
  { label: '🛡 Safe floors', hint: 'Highest floor with low bust rate — set-and-forget starters',
    apply: s => { s.setSort({ key: 'floor', dir: -1 }); s.setView('weekly'); } },
  { label: '🚀 Highest ceilings', hint: 'Best 80th-percentile weeks — tournament and upside plays',
    apply: s => { s.setSort({ key: 'ceiling', dir: -1 }); s.setView('weekly'); } },
  { label: '📈 Market rising', hint: 'Trade value climbing fastest in the last 30 days',
    apply: s => { s.setSort({ key: 'market_trend_pct', dir: -1 }); s.setView('value'); } },
  { label: '📉 Market falling', hint: 'Value dropping — either a buy-low or a warning',
    apply: s => { s.setSort({ key: 'market_trend_pct', dir: 1 }); s.setView('value'); } },
  { label: '🗓 Easy playoffs', hint: 'Softest weeks 15-17 schedule',
    apply: s => { s.setSort({ key: 'playoff_rank', dir: 1 }); s.setView('weekly'); } },
  { label: '⭐ Proven stars', hint: 'Pro Bowl, All-Pro or NFL Top 100 only',
    apply: s => { s.setOnlyBadged(true); s.setSort({ key: 'vor', dir: -1 }); s.setView('board'); } },
  { label: '🔮 Biggest risers', hint: 'Projection furthest above last season',
    apply: s => { s.setSort({ key: 'delta', dir: -1 }); s.setView('board'); } }
];

export default function Players() {
  const { data: sets } = useApi<any[]>('/rankings');
  const [setId, setSetId] = useState<number | null>(null);
  const active = setId ?? sets?.[0]?.id ?? null;
  const { data: board, refetch } = useApi<any[]>(active ? `/edge/board?set_id=${active}` : '/edge/board');
  const open = usePlayerCard();

  const [view, setView] = useState<keyof typeof VIEWS>('board');
  const [q, setQ] = useState('');
  const [pos, setPos] = useState('ALL');
  const [team, setTeam] = useState('ALL');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'my_rank', dir: 1 });
  const [onlyBoard, setOnlyBoard] = useState(false);
  const [onlyBadged, setOnlyBadged] = useState(false);
  const [hideInjured, setHideInjured] = useState(false);
  const [limit, setLimit] = useState(75);
  const [dense, setDense] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [compare, setCompare] = useState<number[]>([]);
  const { data: sparks } = useApi<Record<string, number[]>>('/edge/sparklines');

  useEffect(() => { setLimit(75); }, [q, pos, team, onlyBoard, onlyBadged, hideInjured, view]);

  const teams = useMemo(
    () => [...new Set((board ?? []).map(p => p.team_abbr).filter(Boolean))].sort(),
    [board]);

  const rows = useMemo(() => {
    let list = board ?? [];
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(needle) ||
        (p.team_abbr ?? '').toLowerCase().includes(needle) ||
        p.position.toLowerCase() === needle);
    }
    if (pos !== 'ALL') list = list.filter(p => p.position === pos);
    if (team !== 'ALL') list = list.filter(p => p.team_abbr === team);
    if (onlyBoard) list = list.filter(p => p.my_rank != null);
    if (onlyBadged) list = list.filter(p => p.badges.length > 0);
    if (hideInjured) list = list.filter(p => !p.injury);

    const k = sort.key;
    return [...list].sort((a, b) => {
      const av = a[k], bv = b[k];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return typeof av === 'string' ? av.localeCompare(bv) * sort.dir : (av - bv) * sort.dir;
    });
  }, [board, q, pos, team, onlyBoard, onlyBadged, hideInjured, sort]);

  const cols = VIEWS[view].cols;
  const head = (key: string, label: string, title?: string) => (
    <th key={key} title={title}
      onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : (key === 'name' || key === 'my_rank' ? 1 : -1) }))}
      className="px-2 py-2 text-right font-medium cursor-pointer select-none hover:text-slate-700 whitespace-nowrap">
      {label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  );

  const addToBoard = async (pid: number) => {
    if (!active) return;
    await api(`/rankings/${active}/entries`, { method: 'POST', body: JSON.stringify({ player_id: pid }) });
    refetch();
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Players</h1>
        {sets && sets.length > 0 && (
          <select className="input" value={active ?? ''} onChange={e => setSetId(Number(e.target.value))}>
            {sets.map(s => <option key={s.id} value={s.id}>{s.name} ({s.entry_count})</option>)}
          </select>
        )}
        <span className="text-xs text-slate-400">{rows.length} of {board?.length ?? 0}</span>
      </div>
      <p className="text-sm text-slate-500 mb-3">{VIEWS[view].hint}</p>

      {/* view presets */}
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {Object.entries(VIEWS).map(([k, v]) => (
          <button key={k} onClick={() => setView(k as any)}
            className={`btn ${view === k ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            {v.label}
          </button>
        ))}
      </div>

      {/* one-click questions */}
      <div className="flex gap-1.5 mb-3 flex-wrap items-center">
        {PRESETS.map(p => (
          <button key={p.label} title={p.hint}
            onClick={() => p.apply({ setSort, setView, setOnlyBoard, setOnlyBadged })}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:border-emerald-400 hover:bg-emerald-50 transition-colors">
            {p.label}
          </button>
        ))}
        <button onClick={() => setShowGlossary(v => !v)}
          className="text-xs px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 ml-auto">
          {showGlossary ? 'Hide' : '?'} what do these mean
        </button>
      </div>

      {showGlossary && (
        <div className="card p-4 mb-3 grid sm:grid-cols-2 gap-x-6 gap-y-2">
          {GLOSSARY.map(([term, def]) => (
            <div key={term} className="text-xs">
              <span className="font-bold text-slate-800">{term}</span>
              <span className="text-slate-500"> — {def}</span>
            </div>
          ))}
        </div>
      )}

      {/* finder */}
      <div className="card p-3 mb-3 flex gap-2 flex-wrap items-center">
        <input className="input flex-1 min-w-[200px]" placeholder="Search name, team or position…"
          value={q} onChange={e => setQ(e.target.value)} />
        <select className="input" value={pos} onChange={e => setPos(e.target.value)}>
          {['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input" value={team} onChange={e => setTeam(e.target.value)}>
          <option value="ALL">All teams</option>
          {teams.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={() => setDense(d => !d)}
          className={`btn text-xs ${dense ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-500'}`}>
          {dense ? 'Compact' : 'Comfortable'}
        </button>
        <button
          onClick={() => {
            const cols = ['name','position','team_abbr','proj','pos_rank','vor','adp','adp_edge','last_pts','delta','floor','ceiling','boom','bust','consistency','playoff_rank'];
            const csv = [cols.join(','), ...rows.map(p => cols.map(c => JSON.stringify(p[c] ?? '')).join(','))].join('\n');
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
            const a = document.createElement('a');
            a.href = url; a.download = 'gridiron-players.csv'; a.click();
            URL.revokeObjectURL(url);
          }}
          className="btn text-xs bg-white border border-slate-200 text-slate-500">⭳ CSV</button>
        {([['On my board', onlyBoard, setOnlyBoard],
           ['Accoladed only', onlyBadged, setOnlyBadged],
           ['Hide injured', hideInjured, setHideInjured]] as const).map(([label, val, set]) => (
          <button key={label} onClick={() => (set as any)(!val)}
            className={`btn text-xs ${val ? 'bg-emerald-600 text-white' : 'bg-white border border-slate-200 text-slate-500'}`}>
            {label}
          </button>
        ))}
      </div>

      {compare.length > 0 && (
        <div className="card p-3 mb-3 border-emerald-300 bg-emerald-50/40">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-bold text-emerald-700">Comparing {compare.length}</span>
            <button className="text-xs text-slate-500 hover:text-slate-800 ml-auto" onClick={() => setCompare([])}>clear</button>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead className="text-[10px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="text-left pr-3">Player</th>
                  {['Proj','VOR','ADP','Edge','Floor','Ceil','Boom','Cons','PO SOS'].map(h => <th key={h} className="text-right px-2">{h}</th>)}
                  <th className="text-left pl-3">Weekly</th>
                </tr>
              </thead>
              <tbody>
                {compare.map(id => {
                  const p = (board ?? []).find(x => x.id === id);
                  if (!p) return null;
                  const best = (key: string, hi = true) => {
                    const vals = compare.map(i => (board ?? []).find(x => x.id === i)?.[key]).filter(v => v != null);
                    if (!vals.length) return false;
                    return p[key] === (hi ? Math.max(...vals) : Math.min(...vals));
                  };
                  const cell = (v: any, key: string, hi = true, f = n1) => (
                    <td className={`text-right px-2 tabular-nums ${best(key, hi) ? 'font-black text-emerald-700' : 'text-slate-600'}`}>{f(v)}</td>
                  );
                  return (
                    <tr key={id} className="border-t border-emerald-100">
                      <td className="pr-3 py-1 font-semibold whitespace-nowrap">
                        <span className={`text-[10px] font-black mr-1 pos-${p.position}`}>{p.position}</span>{p.name}
                      </td>
                      {cell(p.proj, 'proj', true, n0)}
                      {cell(p.vor, 'vor')}
                      {cell(p.adp, 'adp', false)}
                      {cell(p.adp_edge, 'adp_edge', true, signed)}
                      {cell(p.floor, 'floor')}
                      {cell(p.ceiling, 'ceiling')}
                      {cell(p.boom, 'boom', true, pct)}
                      {cell(p.consistency, 'consistency')}
                      {cell(p.playoff_rank, 'playoff_rank', false, (v: any) => v ?? '—')}
                      <td className="pl-3 py-1"><Spark series={sparks?.[String(id)]} height={16} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-2 py-2 w-6" />
                {head('my_rank', '#')}
                {head('name', 'Player')}
                {cols.map(c => head(c.key, c.label, c.title))}
                <th className="px-2 py-2 text-left font-medium" title="weekly points last season">Weekly</th>
                <th className="px-2 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.slice(0, limit).map(p => (
                <>
                <tr key={p.id}
                  className={`hover:bg-emerald-50/50 transition-colors ${expanded === p.id ? 'bg-emerald-50/70' : ''}`}>
                  <td className="px-2">
                    <input type="checkbox" className="accent-emerald-600"
                      checked={compare.includes(p.id)}
                      onChange={e => setCompare(c => e.target.checked ? [...c, p.id].slice(-4) : c.filter(x => x !== p.id))}
                      title="compare (up to 4)" />
                  </td>
                  <td className={`px-2 ${dense ? 'py-1' : 'py-1.5'} text-right text-xs font-mono text-slate-400 tabular-nums`}>
                    {p.my_rank ?? '·'}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {p.tier != null && (
                        <span className="w-1 h-7 rounded-full shrink-0" style={{ background: TIER_COLORS[p.tier] }} title={`Tier ${p.tier}`} />
                      )}
                      <Headshot src={headshotUrl(p)} pos={p.position} size={28} />
                      <div className="min-w-0">
                        <button onClick={() => open(p.id)}
                          className="block text-left font-semibold text-slate-800 hover:text-emerald-700 truncate max-w-[190px]">
                          <span className={`text-[10px] font-black mr-1.5 pos-${p.position}`}>{p.position}</span>
                          {p.name}
                        </button>
                        <div className="text-[10px] text-slate-400 leading-tight truncate max-w-[190px]">
                          {p.team_abbr ?? 'FA'}
                          {p.age ? ` · ${p.age}y` : ''}
                          {p.injury ? <span className="text-rose-600 font-bold"> · INJ</span> : null}
                          {p.badges.length > 0 && <span className="text-emerald-600"> · {p.badges[0]}</span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  {cols.map(c => (
                    <td key={c.key} className={`px-2 py-1.5 text-right tabular-nums text-xs ${c.tone ? c.tone(p) : 'text-slate-600'}`}>
                      {c.fmt ? c.fmt(p) : p[c.key] ?? '—'}
                    </td>
                  ))}
                  <td className="px-2 py-1.5"><Spark series={sparks?.[String(p.id)]} height={dense ? 14 : 20} /></td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    {p.my_rank == null && active && (
                      <button onClick={() => addToBoard(p.id)} title="add to my board"
                        className="text-[11px] text-slate-300 hover:text-emerald-600 mr-1">＋</button>
                    )}
                    <button onClick={() => setExpanded(e => e === p.id ? null : p.id)}
                      title="expand detail"
                      className="text-[11px] text-slate-300 hover:text-slate-700">
                      {expanded === p.id ? '▴' : '▾'}
                    </button>
                  </td>
                </tr>
                {expanded === p.id && (
                  <tr key={`${p.id}-x`} className="bg-slate-50/70">
                    <td colSpan={cols.length + 5} className="px-4 py-3">
                      <div className="grid sm:grid-cols-4 gap-4 text-xs">
                        <div>
                          <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Projected line</div>
                          {p.proj_line ? Object.entries(p.proj_line).map(([k, v]: any) => (
                            <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="tabular-nums">{n1(v)}</span></div>
                          )) : <span className="text-slate-400">none</span>}
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">2025 actual</div>
                          {p.last_line ? Object.entries(p.last_line).map(([k, v]: any) => (
                            <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="tabular-nums">{n1(v)}</span></div>
                          )) : <span className="text-slate-400">none</span>}
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Weekly profile</div>
                          {p.games ? (
                            <>
                              <div className="flex justify-between"><span className="text-slate-500">games</span><span>{p.games}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">floor → ceiling</span><span>{p.floor} → {p.ceiling}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">boom / bust</span><span>{pct(p.boom)} / {pct(p.bust)}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">consistency</span><span>{p.consistency}</span></div>
                            </>
                          ) : <span className="text-slate-400">no weekly data</span>}
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Context</div>
                          {p.badges.length > 0 && <div className="text-emerald-700 font-medium mb-1">{p.badges.join(' · ')}</div>}
                          <div className="flex justify-between"><span className="text-slate-500">playoff SOS</span><span>{p.playoff_rank ? `#${p.playoff_rank}/32` : '—'}</span></div>
                          <div className="flex justify-between"><span className="text-slate-500">season SOS</span><span>{p.season_sos ?? '—'}</span></div>
                          {p.note && <div className="text-slate-500 italic mt-1">“{p.note}”</div>}
                          <button onClick={() => open(p.id)} className="text-emerald-600 hover:underline mt-1">full card →</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-6 text-sm text-slate-500 text-center">No players match those filters.</p>}
      </div>

      {rows.length > limit && (
        <button className="btn-ghost w-full mt-3" onClick={() => setLimit(l => l + 100)}>
          Show 100 more ({rows.length - limit} left)
        </button>
      )}
    </div>
  );
}
