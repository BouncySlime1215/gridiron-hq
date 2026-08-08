import { useState } from 'react';
import { api, headshotUrl, useApi } from '../api';
import { Headshot } from '../components/PlayerRow';
import { usePlayerCard } from '../components/PlayerCard';

type Tab = 'vor' | 'movers' | 'volatility' | 'efficiency' | 'schedule' | 'trade' | 'sim';
const TABS: [Tab, string, string][] = [
  ['vor', 'Value Board', 'Points over replacement — the real draft currency'],
  ['movers', 'Breakouts & Regression', 'Who the projections are moving on, and why'],
  ['volatility', 'Boom / Bust', 'Weekly floor, ceiling and consistency from real games'],
  ['efficiency', 'Efficiency', 'Rate stats — usage share, yards per opportunity, TD-rate regression'],
  ['schedule', 'Playoff Schedule', 'Weeks 15-17 strength, ranked easiest to hardest'],
  ['trade', 'Trade Analyzer', 'Value both sides on VOR, not vibes'],
  ['sim', 'Season Simulator', 'Monte Carlo your lineup from real distributions']
];

const Name = ({ id, name, pos }: { id: number; name: string; pos: string }) => {
  const open = usePlayerCard();
  return (
    <button onClick={() => open(id)} className="text-left font-semibold text-slate-800 hover:text-emerald-700 truncate">
      <span className={`text-[10px] font-black mr-1.5 pos-${pos}`}>{pos}</span>{name}
    </button>
  );
};

function PlayerPicker({ label, ids, setIds }: { label: string; ids: number[]; setIds: (v: number[]) => void }) {
  const [q, setQ] = useState('');
  const { data: found } = useApi<any[]>(q.length >= 2 ? `/players?q=${encodeURIComponent(q)}` : null);
  const { data: all } = useApi<any[]>('/edge/vor');
  const byId = new Map((all ?? []).map(p => [p.id, p]));
  return (
    <div className="flex-1 min-w-[220px]">
      <div className="text-xs font-bold text-slate-500 mb-1">{label}</div>
      <input className="input w-full text-xs" placeholder="search a player…" value={q} onChange={e => setQ(e.target.value)} />
      {(found ?? []).slice(0, 5).length > 0 && q.length >= 2 && (
        <div className="card mt-1 p-1">
          {(found ?? []).slice(0, 5).map(p => (
            <button key={p.id} onClick={() => { setIds([...ids, p.id]); setQ(''); }}
              className="w-full text-left px-2 py-1 rounded hover:bg-slate-100 text-xs">
              <span className={`font-bold pos-${p.position} mr-1`}>{p.position}</span>{p.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 space-y-1">
        {ids.map(id => {
          const p = byId.get(id);
          return (
            <div key={id} className="flex items-center gap-2 text-xs bg-slate-50 rounded px-2 py-1">
              <span className="font-medium">{p?.name ?? `#${id}`}</span>
              {p && <span className="text-slate-400">VOR {p.vor}</span>}
              <button className="ml-auto text-rose-500" onClick={() => setIds(ids.filter(x => x !== id))}>✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Renders standalone, or driven by the Fantasy Lab hub: passing `tab` makes the
 * selection controlled and `embedded` hides the local header and tab strip, so
 * the hub can own one unified bar instead of stacking two.
 */
export default function Edge({ tab: controlledTab, embedded }: { tab?: Tab; embedded?: boolean } = {}) {
  const [ownTab, setTab] = useState<Tab>('vor');
  const tab = controlledTab ?? ownTab;
  const [pos, setPos] = useState('ALL');

  const { data: vor } = useApi<any[]>('/edge/vor');
  const { data: movers } = useApi<any>('/edge/movers');
  const { data: vol } = useApi<any[]>('/edge/volatility');
  const { data: sched } = useApi<any[]>('/edge/schedule-edge');
  const { data: eff } = useApi<any[]>(`/edge/efficiency${pos !== 'ALL' ? `?position=${pos}` : ''}`);

  const [give, setGive] = useState<number[]>([]);
  const [get, setGet] = useState<number[]>([]);
  const [trade, setTrade] = useState<any>(null);
  const [simIds, setSimIds] = useState<number[]>([]);
  const [sim, setSim] = useState<any>(null);

  const filt = (list: any[] | null) => (list ?? []).filter(p => pos === 'ALL' || p.position === pos);
  const active = TABS.find(t => t[0] === tab)!;

  return (
    <div>
      {!embedded && (
        <>
          <h1 className="text-2xl font-bold mb-1">Edge</h1>
          <p className="text-sm text-slate-500 mb-4">{active[2]}</p>
        </>
      )}

      <div className="flex gap-1.5 mb-4 flex-wrap">
        {!embedded && TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`btn ${tab === k ? 'bg-sky-100 text-sky-900 border border-sky-200' : 'bg-white text-slate-600 hover:bg-sky-50'}`}>
            {label}
          </button>
        ))}
        {['vor', 'movers', 'volatility', 'efficiency'].includes(tab) && (
          <div className="ml-auto flex gap-1">
            {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
              <button key={p} onClick={() => setPos(p)}
                className={`btn ${pos === p ? 'bg-emerald-600 text-white' : 'bg-white border border-slate-200 text-slate-500'}`}>{p}</button>
            ))}
          </div>
        )}
      </div>

      {/* ---------- VOR ---------- */}
      {tab === 'vor' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-right px-3 py-2">#</th><th className="text-left px-2 py-2">Player</th>
                <th className="text-right px-2 py-2">Proj</th>
                <th className="text-right px-2 py-2" title="points above the last startable player at this position">VOR</th>
                <th className="text-right px-2 py-2">ADP</th>
                <th className="text-right px-3 py-2" title="ADP minus VOR rank — positive means he lasts longer than he should">Edge</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filt(vor).slice(0, 120).map(p => (
                <tr key={p.id} className="hover:bg-emerald-50/50">
                  <td className="text-right px-3 py-1.5 text-xs font-mono text-slate-400">{p.vor_rank}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <Headshot src={headshotUrl(p)} pos={p.position} size={26} />
                      <Name id={p.id} name={p.name} pos={p.position} />
                      <span className="text-[10px] text-slate-400">{p.team_abbr}</span>
                    </div>
                  </td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-slate-600">{Math.round(p.proj)}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums font-bold text-slate-800">{p.vor}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-slate-500">{p.adp?.toFixed(1) ?? '—'}</td>
                  <td className={`text-right px-3 py-1.5 tabular-nums font-semibold ${
                    p.adp_edge == null ? 'text-slate-300' : p.adp_edge > 3 ? 'text-emerald-600' : p.adp_edge < -3 ? 'text-rose-600' : 'text-slate-400'}`}>
                    {p.adp_edge == null ? '—' : `${p.adp_edge > 0 ? '+' : ''}${p.adp_edge.toFixed(0)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- movers ---------- */}
      {tab === 'movers' && (
        <div className="grid lg:grid-cols-2 gap-4">
          {([['breakouts', 'Projected to break out', 'emerald'], ['regressions', 'Projected to regress', 'rose']] as const).map(([key, title, tone]) => (
            <div key={key} className="card overflow-hidden">
              <div className={`px-4 py-2 border-b border-slate-200 bg-${tone}-50`}>
                <h3 className={`text-sm font-bold text-${tone}-700`}>{title}</h3>
              </div>
              <div className="divide-y divide-slate-100 max-h-[65vh] overflow-y-auto">
                {filt(movers?.[key]).slice(0, 18).map((p: any) => (
                  <div key={p.id} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Headshot src={headshotUrl(p)} pos={p.position} size={26} />
                      <Name id={p.id} name={p.name} pos={p.position} />
                      <span className="text-[10px] text-slate-400">{p.team_abbr}</span>
                      <span className={`ml-auto text-xs font-bold tabular-nums ${p.pct_delta >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {p.pct_delta >= 0 ? '+' : ''}{p.pct_delta.toFixed(0)}%
                      </span>
                    </div>
                    {p.reasons?.length > 0 && (
                      <div className="text-[11px] text-slate-500 mt-0.5 pl-8">{p.reasons.join(' · ')}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- volatility ---------- */}
      {tab === 'volatility' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left px-3 py-2">Player</th><th className="text-right px-2 py-2">G</th>
                <th className="text-right px-2 py-2">Avg</th><th className="text-right px-2 py-2">Floor</th>
                <th className="text-right px-2 py-2">Ceiling</th><th className="text-right px-2 py-2">Boom</th>
                <th className="text-right px-2 py-2">Bust</th><th className="text-right px-3 py-2">Consistency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filt(vol).filter(p => p.games >= 6).slice(0, 100).map(p => (
                <tr key={p.player_id} className="hover:bg-emerald-50/50">
                  <td className="px-3 py-1.5"><Name id={p.player_id} name={p.name} pos={p.position} /></td>
                  <td className="text-right px-2 py-1.5 text-xs text-slate-400">{p.games}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums font-semibold">{p.avg}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-slate-500">{p.floor}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-slate-700">{p.ceiling}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-emerald-600">{(p.boom_rate * 100).toFixed(0)}%</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-rose-600">{(p.bust_rate * 100).toFixed(0)}%</td>
                  <td className="text-right px-3 py-1.5">
                    <div className="flex items-center gap-1.5 justify-end">
                      <div className="w-14 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full bg-emerald-500" style={{ width: `${p.consistency * 100}%` }} />
                      </div>
                      <span className="tabular-nums text-xs text-slate-500 w-7">{p.consistency.toFixed(2)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- efficiency ---------- */}
      {tab === 'efficiency' && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800">
            Usage share is computed across tracked fantasy players on each team, so it reads high for
            concentrated offenses — treat it as relative, not a true team-target percentage.
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="text-left px-3 py-2">Player</th>
                  <th className="text-right px-2 py-2">Tgt</th><th className="text-right px-2 py-2">Car</th>
                  <th className="text-right px-2 py-2">Use%</th><th className="text-right px-2 py-2">Catch%</th>
                  <th className="text-right px-2 py-2">Y/Tgt</th><th className="text-right px-2 py-2">Y/Car</th>
                  <th className="text-right px-2 py-2">Y/Tch</th><th className="text-right px-2 py-2">TD%</th>
                  <th className="text-left px-3 py-2">Regression signal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(eff ?? []).slice(0, 90).map(p => (
                  <tr key={p.id} className="hover:bg-emerald-50/50">
                    <td className="px-3 py-1.5">
                      <Name id={p.id} name={p.name} pos={p.position} />
                      <span className="text-[10px] text-slate-400 ml-1">{p.team_abbr}</span>
                    </td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-slate-600">{p.targets || '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-slate-600">{p.carries || '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-slate-500">
                      {p.target_share ?? p.rush_share ?? '—'}
                    </td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-slate-500">{p.catch_rate ?? '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums font-semibold text-slate-700">{p.yds_per_target ?? '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-slate-600">{p.yds_per_carry ?? '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-slate-600">{p.yds_per_touch ?? '—'}</td>
                    <td className={`text-right px-2 py-1.5 tabular-nums font-semibold ${
                      p.td_rate_vs_pos == null ? 'text-slate-400'
                      : p.td_rate_vs_pos > 2 ? 'text-rose-600' : p.td_rate_vs_pos < -2 ? 'text-emerald-600' : 'text-slate-600'}`}>
                      {p.td_rate ?? '—'}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-slate-500">{p.regression_flag ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- playoff schedule ---------- */}
      {tab === 'schedule' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-right px-3 py-2">#</th><th className="text-left px-2 py-2">Team</th>
                <th className="text-left px-2 py-2">Weeks 15-17</th>
                <th className="text-right px-2 py-2">Playoff SOS</th><th className="text-right px-3 py-2">Season SOS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(sched ?? []).map(t => (
                <tr key={t.abbr} className={t.playoff_rank <= 8 ? 'bg-emerald-50/40' : t.playoff_rank >= 25 ? 'bg-rose-50/40' : ''}>
                  <td className="text-right px-3 py-1.5 text-xs font-mono text-slate-400">{t.playoff_rank}</td>
                  <td className="px-2 py-1.5 font-semibold">{t.abbr}</td>
                  <td className="px-2 py-1.5 text-xs text-slate-500">{t.playoff_games.join('  ·  ')}</td>
                  <td className={`text-right px-2 py-1.5 tabular-nums font-bold ${t.playoff_sos < 0.95 ? 'text-emerald-600' : t.playoff_sos > 1.05 ? 'text-rose-600' : 'text-slate-600'}`}>
                    {t.playoff_sos.toFixed(2)}
                  </td>
                  <td className="text-right px-3 py-1.5 tabular-nums text-slate-500">{t.season_sos.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- trade ---------- */}
      {tab === 'trade' && (
        <div className="card p-5">
          <div className="flex gap-4 flex-wrap mb-4">
            <PlayerPicker label="I give" ids={give} setIds={setGive} />
            <PlayerPicker label="I get" ids={get} setIds={setGet} />
          </div>
          <button className="btn-primary" disabled={!give.length || !get.length}
            onClick={async () => setTrade(await api('/edge/trade', { method: 'POST', body: JSON.stringify({ give, get }) }))}>
            Analyze trade
          </button>
          {trade && (
            <div className="mt-4 rounded-xl border-2 p-4"
              style={{ borderColor: trade.vor_diff > 5 ? '#10b981' : trade.vor_diff < -5 ? '#f43f5e' : '#cbd5e1' }}>
              <div className="flex items-center gap-3">
                <span className="text-lg font-black uppercase"
                  style={{ color: trade.vor_diff > 5 ? '#059669' : trade.vor_diff < -5 ? '#e11d48' : '#475569' }}>
                  {trade.verdict}
                </span>
                <span className="text-sm text-slate-600">
                  VOR {trade.vor_diff > 0 ? '+' : ''}{trade.vor_diff} in your favour
                </span>
              </div>
              <div className="grid sm:grid-cols-2 gap-3 mt-3 text-xs">
                <div><span className="font-bold text-slate-500">You give</span> — {trade.give_total.vor} VOR / {trade.give_total.proj} pts</div>
                <div><span className="font-bold text-slate-500">You get</span> — {trade.get_total.vor} VOR / {trade.get_total.proj} pts</div>
              </div>
              {trade.note && <p className="text-xs text-amber-600 mt-2">{trade.note}</p>}
            </div>
          )}
        </div>
      )}

      {/* ---------- simulator ---------- */}
      {tab === 'sim' && (
        <div className="card p-5">
          <PlayerPicker label="Your starting lineup" ids={simIds} setIds={setSimIds} />
          <button className="btn-primary mt-3" disabled={simIds.length < 4}
            onClick={async () => setSim(await api('/edge/simulate', { method: 'POST', body: JSON.stringify({ player_ids: simIds }) }))}>
            Run 2,000 simulations
          </button>
          {sim && (
            <div className="mt-4">
              <div className="grid grid-cols-3 gap-3">
                {[['Floor (10th)', sim.floor_week, 'text-rose-600'],
                  ['Median week', sim.median_week, 'text-slate-800'],
                  ['Ceiling (90th)', sim.ceiling_week, 'text-emerald-600']].map(([l, v, c]: any) => (
                  <div key={l} className="rounded-lg border border-slate-200 p-3 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">{l}</div>
                    <div className={`text-2xl font-black ${c}`}>{v}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 h-3 rounded-full bg-slate-100 relative overflow-hidden">
                <div className="absolute h-full bg-emerald-200"
                  style={{ left: `${(sim.p25 / sim.ceiling_week) * 100}%`, width: `${((sim.p75 - sim.p25) / sim.ceiling_week) * 100}%` }} />
                <div className="absolute h-full w-0.5 bg-sky-500" style={{ left: `${(sim.median_week / sim.ceiling_week) * 100}%` }} />
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                Middle 50% of weeks lands between <strong>{sim.p25}</strong> and <strong>{sim.p75}</strong> points, from {sim.runs.toLocaleString()} simulations
                using each player&apos;s real weekly distribution.
              </p>
              {sim.missing_data?.length > 0 && (
                <p className="text-[11px] text-amber-600 mt-1">No weekly history for: {sim.missing_data.join(', ')} — they contribute 0.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
