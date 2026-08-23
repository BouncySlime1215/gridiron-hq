import { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';
import TradeCard, { PlayerPill, num } from '../components/TradeCard';
import { usePlayerCard } from '../components/PlayerCard';

const TABS = [
  { id: 'find', label: 'Find deals', hint: 'Every realistic trade in your league, ranked' },
  { id: 'target', label: 'Target a player', hint: 'Name him — get the offer that lands him' },
  { id: 'mock', label: 'Mock a trade', hint: 'Build any deal, see who wins' },
  { id: 'matchups', label: 'Matchups', hint: 'Defence vs position, and head-to-head history' }
] as const;
type Tab = typeof TABS[number]['id'];

/** Reads/writes the untouchable-player list for one league from localStorage. */
const untouchableKey = (leagueId: number) => `gh:untouchable:${leagueId}`;
const loadUntouchable = (leagueId: number | null): number[] => {
  if (!leagueId) return [];
  try { return JSON.parse(localStorage.getItem(untouchableKey(leagueId)) ?? '[]'); }
  catch { return []; }
};

/* ------------------------------------------------------------------ shell */
export default function TradeLab() {
  // Which league is active now lives in the header, shared with My Team and the
  // Prediction Engine — this page just follows it rather than keeping its own.
  const { activeId: active } = useLeague();
  const [tab, setTab] = useState<Tab>('find');
  const { data: rosters } = useApi<any>(active ? `/trades/${active}/rosters` : null);
  const [teamId, setTeamId] = useState<string | null>(null);
  // A "which team is me" pick only means something within the league it was made in.
  useEffect(() => { setTeamId(null); }, [active]);
  const me = teamId ?? rosters?.my_team_id ?? rosters?.teams?.[0]?.roster_id ?? null;

  // Players marked untouchable are never offered by Find Deals or Target a Player —
  // saved per league, since "don't trade him" only means something within one roster.
  const [untouchable, setUntouchable] = useState<number[]>(() => loadUntouchable(active));
  useEffect(() => { setUntouchable(loadUntouchable(active)); }, [active]);
  const toggleUntouchable = (id: number) => {
    setUntouchable(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      if (active) localStorage.setItem(untouchableKey(active), JSON.stringify(next));
      return next;
    });
  };
  const myPlayers = rosters?.teams?.find((t: any) => t.roster_id === me)?.players ?? [];
  // Resolved once here and handed to every TradeCard, so the AI writing a pitch
  // knows never to suggest one of these as a sweetener — see server/routes/trades.js.
  const untouchableNames = myPlayers.filter((p: any) => untouchable.includes(p.id)).map((p: any) => p.name);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Trade Lab</h1>
        {rosters?.teams && (
          <select className="input" value={me ?? ''} onChange={e => setTeamId(e.target.value)}>
            {rosters.teams.map((t: any) => (
              <option key={t.roster_id} value={t.roster_id}>{t.owner}</option>
            ))}
          </select>
        )}
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Every deal is scored on the only currency that matters — points your <em>starting lineup</em> projects
        for, adjusted for how each defence actually treats that position.
      </p>

      {myPlayers.length > 0 && (
        <Untouchables players={myPlayers} ids={untouchable} onToggle={toggleUntouchable} />
      )}

      <div className="flex gap-1 border-b border-slate-200 mb-4 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} title={t.hint}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === t.id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {!active && <div className="card p-6 text-sm text-slate-500">Connect a league on the My Leagues page first.</div>}
      {active && tab === 'find' && <FindDeals leagueId={active} teamId={me} untouchable={untouchable} untouchableNames={untouchableNames} />}
      {active && tab === 'target' && <TargetPlayer leagueId={active} teamId={me} rosters={rosters} untouchable={untouchable} untouchableNames={untouchableNames} />}
      {active && tab === 'mock' && <MockTrade leagueId={active} teamId={me} rosters={rosters} untouchable={untouchable} untouchableNames={untouchableNames} />}
      {active && tab === 'matchups' && <Matchups />}
    </div>
  );
}

/** Collapsible roster picker for marking players your auto-suggestions must leave alone. */
function Untouchables({ players, ids, onToggle }: { players: any[]; ids: number[]; onToggle: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const set = new Set(ids);
  const locked = players.filter((p: any) => set.has(p.id));

  return (
    <div className="card p-3 mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 text-left">
        <span className="text-sm">🔒</span>
        <span className="text-xs font-bold text-slate-700">Untouchables</span>
        <span className="text-[11px] text-slate-400">
          {locked.length ? `${locked.length} locked — never offered in Find Deals or Target a Player` : 'Mark players Find Deals and Target a Player should never offer'}
        </span>
        <span className="ml-auto text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {!open && locked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {locked.map((p: any) => (
            <span key={p.id} className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
              🔒 {p.name}
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {players.map((p: any) => (
            <button key={p.id} onClick={() => onToggle(p.id)}
              className={`text-[11px] px-2 py-1 rounded-lg border transition-colors ${
                set.has(p.id) ? 'bg-amber-100 border-amber-300 text-amber-800' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-400'
              }`}>
              {set.has(p.id) ? '🔒 ' : ''}{p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- find deals */
function FindDeals({ leagueId, teamId, untouchable, untouchableNames }: {
  leagueId: number; teamId: string | null; untouchable: number[]; untouchableNames: string[];
}) {
  const [mutual, setMutual] = useState(true);
  const [size, setSize] = useState(2);
  const exclude = untouchable.length ? `&exclude=${untouchable.join(',')}` : '';
  const q = `/trades/${leagueId}/find?team_id=${teamId ?? ''}&mutual=${mutual ? 1 : 0}&max_per_side=${size}&limit=15${exclude}`;
  const { data, loading } = useApi<any>(teamId ? q : null);

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={mutual} onChange={e => setMutual(e.target.checked)} className="accent-emerald-600" />
          <span className="text-slate-600">Only deals they&apos;d plausibly accept</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-slate-500">Package size</span>
          <select className="input py-1" value={size} onChange={e => setSize(Number(e.target.value))}>
            <option value={1}>1-for-1</option>
            <option value={2}>up to 2-for-2</option>
            <option value={3}>up to 3-for-3</option>
          </select>
        </label>
        {data && <span className="text-slate-400 ml-auto">{data.considered} candidate deals evaluated</span>}
      </div>

      {loading && <div className="card p-6 text-sm text-slate-500">Searching every roster in the league…</div>}
      {data?.deals?.length === 0 && (
        <div className="card p-6 text-sm text-slate-500">
          Nothing clears the bar right now. Try unticking “only deals they&apos;d accept”, or widening the package size —
          bigger packages find fits that 1-for-1s miss.
        </div>
      )}
      {data?.fell_back && (data?.deals?.length ?? 0) > 0 && (
        <div className="card p-3 mb-3 border-amber-200 bg-amber-50/40 text-xs text-amber-800">
          Nothing here clearly improves both lineups — your tradeable value is concentrated in a couple of
          starters rather than spare depth, so there&apos;s nothing cheap to sweeten a deal with. These are the
          closest fits anyway: expect to give a bit more than feels even, or try <b>Target a player</b> to work
          the ask up from a lowball offer instead.
        </div>
      )}
      <div className="space-y-3">
        {(data?.deals ?? []).map((d: any, i: number) => <TradeCard key={i} deal={d} leagueId={leagueId} untouchableNames={untouchableNames} />)}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- target a player */
function TargetPlayer({ leagueId, teamId, rosters, untouchable, untouchableNames }: {
  leagueId: number; teamId: string | null; rosters: any; untouchable: number[]; untouchableNames: string[];
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<any>(null);
  // A targeted player only means something within the league he was picked in.
  useEffect(() => { setQuery(''); setPicked(null); }, [leagueId]);
  const exclude = untouchable.length ? `&exclude=${untouchable.join(',')}` : '';
  const { data: offer, loading } = useApi<any>(
    picked && teamId ? `/trades/${leagueId}/offer?team_id=${teamId}&player_id=${picked.id}${exclude}` : null);
  const { data: outlook } = useApi<any>(picked ? `/trades/${leagueId}/player/${picked.id}` : null);

  // Everyone rostered by somebody other than me — the only players I can trade for.
  const pool = useMemo(() => {
    if (!rosters?.teams) return [];
    return rosters.teams
      .filter((t: any) => t.roster_id !== teamId)
      .flatMap((t: any) => t.players.map((p: any) => ({ ...p, owner: t.owner })));
  }, [rosters, teamId]);

  const results = useMemo(() => {
    if (query.trim().length < 2) return [];
    const q = query.toLowerCase();
    return pool.filter((p: any) => p.name.toLowerCase().includes(q))
      .sort((a: any, b: any) => b.value - a.value).slice(0, 8);
  }, [query, pool]);

  return (
    <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start">
      <div>
        <div className="card p-4 mb-3">
          <label className="text-xs font-bold uppercase tracking-wide text-slate-400">Who do you want?</label>
          <input className="input w-full mt-1.5" placeholder="Start typing a player's name…"
            value={query} onChange={e => { setQuery(e.target.value); setPicked(null); }} />
          {results.length > 0 && !picked && (
            <div className="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
              {results.map((p: any) => (
                <button key={p.id} onClick={() => { setPicked(p); setQuery(p.name); }}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-sm">
                  <span className={`text-[9px] font-black pos-${p.position}`}>{p.position}</span>
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-xs text-slate-400">{p.team_abbr}</span>
                  <span className="text-xs text-slate-500 ml-auto">{p.owner}</span>
                  <span className="text-xs text-emerald-700 font-semibold tabular-nums">{p.value?.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {loading && <div className="card p-6 text-sm text-slate-500">Pricing him against your roster…</div>}
        {offer?.error && (
          <div className="card p-5 border-amber-200 bg-amber-50/40">
            <p className="font-bold text-slate-800 mb-1.5">{offer.error}</p>
            {offer.reason && <p className="text-sm text-slate-600 mb-2">{offer.reason}</p>}
            {offer.bar && (
              <p className="text-xs text-slate-500">
                To upgrade this spot you need someone above{' '}
                <span className="font-semibold text-slate-700">{offer.bar.adj_ppg} ppg</span> — check the
                Find deals tab, which only surfaces players who clear that bar.
              </p>
            )}
            {offer.leverage && <p className="text-xs text-slate-500 mt-2">{offer.leverage}</p>}
          </div>
        )}

        {offer && !offer.error && (
          <div className="space-y-3">
            <div className="card p-4 border-emerald-200">
              <div className="flex items-center gap-2 flex-wrap">
                <PlayerPill p={offer.target} tone="get" />
                <span className="text-xs text-slate-500">owned by <span className="font-semibold text-slate-700">{offer.owner}</span></span>
              </div>
              <p className="text-xs text-slate-600 mt-2">{offer.leverage}</p>
            </div>

            {offer.offers?.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-slate-700 mb-0.5">Go get him — {offer.offers.length} ways to land him</h3>
                <p className="text-[11px] text-slate-500 mb-2">
                  Cheapest first. Open with #1; if he says no, move down the list.
                  {untouchable.length > 0 && ` Your ${untouchable.length} untouchable player${untouchable.length > 1 ? 's' : ''} never appear here.`}
                </p>
                <div className="space-y-2">
                  {offer.offers.map((o: any) => (
                    <div key={o.rank}>
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-sky-200 bg-sky-100 text-[10px] font-black text-sky-900">{o.rank}</span>
                        <h4 className="text-xs font-bold text-slate-700">{o.label}</h4>
                        <span className="text-[11px] text-slate-400">{(o.ratio * 100).toFixed(0)}% of his market price</span>
                      </div>
                      <TradeCard deal={{ ...o, partner: offer.owner, i_get: [offer.target] }} leagueId={leagueId} compact untouchableNames={untouchableNames} />
                    </div>
                  ))}
                </div>
                {offer.max?.note && <p className="text-[11px] text-amber-700 mt-2">{offer.max.note}</p>}
              </div>
            )}
          </div>
        )}
      </div>

      {outlook && !outlook.error && <PlayerOutlook o={outlook} />}
    </div>
  );
}

/** Schedule + opponent-history panel for the player being targeted. */
function PlayerOutlook({ o }: { o: any }) {
  return (
    <div className="space-y-3">
      <div className="card overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-700">{o.name} — outlook</h3>
        </div>
        <dl className="p-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div><dt className="text-slate-400">Projected</dt><dd className="font-semibold tabular-nums">{o.proj} pts · {o.ppg}/wk</dd></div>
          <div><dt className="text-slate-400">Market</dt><dd className="font-semibold tabular-nums">{o.value?.toLocaleString()}</dd></div>
          <div><dt className="text-slate-400">Floor / ceiling</dt><dd className="tabular-nums">{o.floor ?? '—'} / {o.ceiling ?? '—'}</dd></div>
          <div><dt className="text-slate-400">Consistency</dt><dd className="tabular-nums">{o.consistency ?? '—'}</dd></div>
          <div><dt className="text-slate-400">Season SOS</dt>
            <dd className={`tabular-nums font-semibold ${o.sos > 1.02 ? 'text-emerald-600' : o.sos < 0.98 ? 'text-rose-600' : ''}`}>{o.sos}</dd></div>
          <div><dt className="text-slate-400">Playoff SOS</dt>
            <dd className={`tabular-nums font-semibold ${o.playoff_sos > 1.02 ? 'text-emerald-600' : o.playoff_sos < 0.98 ? 'text-rose-600' : ''}`}>{o.playoff_sos}</dd></div>
          <div><dt className="text-slate-400">Bye</dt><dd className="tabular-nums">Week {o.bye ?? '—'}</dd></div>
          <div><dt className="text-slate-400">Age</dt><dd className="tabular-nums">{o.age ?? '—'}</dd></div>
        </dl>
      </div>

      {o.splits?.upcoming?.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <h3 className="text-sm font-bold text-slate-700">History vs 2026 opponents</h3>
            <p className="text-[10px] text-slate-400">His average against each, vs his own {o.splits.baseline} ppg baseline</p>
          </div>
          <div className="divide-y divide-slate-100">
            {o.splits.upcoming.map((s: any) => (
              <div key={s.opponent} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                <span className="font-bold text-slate-700 w-10">{s.opponent}</span>
                <span className="tabular-nums text-slate-600">{s.avg} ppg</span>
                <span className="text-[10px] text-slate-400">{s.games}g</span>
                <span className={`ml-auto font-bold tabular-nums ${s.pct > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {s.pct > 0 ? '+' : ''}{s.pct}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {o.playoff_games?.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <h3 className="text-sm font-bold text-slate-700">Fantasy playoffs</h3>
          </div>
          <div className="divide-y divide-slate-100">
            {o.playoff_games.map((g: any) => (
              <div key={g.week} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                <span className="text-slate-400 w-8">W{g.week}</span>
                <span className="font-semibold">{g.home ? '' : '@'}{g.opponent}</span>
                <span className="ml-auto text-slate-500">
                  {g.rank ? `${g.rank}${g.rank === 1 ? 'st' : g.rank === 2 ? 'nd' : g.rank === 3 ? 'rd' : 'th'} softest` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {o.news?.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <h3 className="text-sm font-bold text-slate-700">Recent news</h3>
          </div>
          <div className="divide-y divide-slate-100">
            {o.news.map((n: any, i: number) => (
              <div key={i} className="px-3 py-2 text-xs">
                <div className="text-[10px] text-slate-400">{n.date}</div>
                <div className="text-slate-700">{n.headline}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ mock trades */
function MockTrade({ leagueId, teamId, rosters, untouchable, untouchableNames }: {
  leagueId: number; teamId: string | null; rosters: any; untouchable: number[]; untouchableNames: string[];
}) {
  const [theirId, setTheirId] = useState<string | null>(null);
  const [give, setGive] = useState<number[]>([]);
  const [get, setGet] = useState<number[]>([]);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A mocked trade's rosters/result only mean something within the league it was built in.
  useEffect(() => { setTheirId(null); setGive([]); setGet([]); setResult(null); setErr(null); }, [leagueId]);

  const mine = rosters?.teams?.find((t: any) => t.roster_id === teamId);
  const others = rosters?.teams?.filter((t: any) => t.roster_id !== teamId) ?? [];
  const them = others.find((t: any) => t.roster_id === theirId) ?? others[0];

  const toggle = (list: number[], set: (v: number[]) => void, id: number) =>
    set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setResult(await api(`/trades/${leagueId}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({ my_team_id: teamId, their_team_id: them?.roster_id, give, get })
      }));
    } catch (e: any) { setErr(e.message); setResult(null); }
    finally { setBusy(false); }
  };

  const untouchableSet = new Set(untouchable);
  const Column = ({ team, sel, onToggle, tone }: any) => (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
        <h3 className="text-sm font-bold text-slate-700 truncate">{team?.owner ?? '—'}</h3>
        <span className="text-[10px] text-slate-400 ml-auto tabular-nums">{team?.lineup_ppg} ppg</span>
      </div>
      <div className="divide-y divide-slate-100 max-h-[52vh] overflow-y-auto">
        {(team?.players ?? []).map((p: any) => {
          const locked = tone === 'give' && untouchableSet.has(p.id);
          return (
            <button key={p.id} onClick={() => onToggle(p.id)}
              title={locked ? 'Marked untouchable — you can still send him here, this is just a reminder' : undefined}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-slate-50 transition-colors ${
                sel.includes(p.id) ? (tone === 'give' ? 'bg-rose-50' : 'bg-emerald-50') : ''}`}>
              <input type="checkbox" readOnly checked={sel.includes(p.id)}
                className={tone === 'give' ? 'accent-rose-500' : 'accent-emerald-600'} />
              <span className={`text-[9px] font-black pos-${p.position}`}>{p.position}</span>
              <span className={`truncate ${p.starter ? 'font-semibold text-slate-800' : 'text-slate-500'}`}>{p.name}</span>
              {p.starter && <span className="text-[9px] text-emerald-600 font-bold">ST</span>}
              {locked && <span className="text-[10px]" title="Untouchable">🔒</span>}
              <span className="ml-auto text-slate-400 tabular-nums shrink-0">{p.value?.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap text-xs">
        <span className="text-slate-500">Trading with</span>
        <select className="input py-1" value={them?.roster_id ?? ''} onChange={e => { setTheirId(e.target.value); setGet([]); setResult(null); }}>
          {others.map((t: any) => <option key={t.roster_id} value={t.roster_id}>{t.owner}</option>)}
        </select>
        <button className="btn-primary text-xs ml-auto" disabled={busy || (!give.length && !get.length)} onClick={run}>
          {busy ? 'Scoring…' : 'Who wins this?'}
        </button>
        {(give.length > 0 || get.length > 0) && (
          <button className="btn-ghost text-xs" onClick={() => { setGive([]); setGet([]); setResult(null); }}>Clear</button>
        )}
      </div>
      {err && <p className="text-xs text-rose-600 mb-2">{err}</p>}

      <div className="grid md:grid-cols-2 gap-3 mb-4">
        <div>
          <div className="text-[10px] font-black uppercase tracking-wide text-rose-500 mb-1">You send ({give.length})</div>
          <Column team={mine} sel={give} onToggle={(id: number) => { toggle(give, setGive, id); setResult(null); }} tone="give" />
        </div>
        <div>
          <div className="text-[10px] font-black uppercase tracking-wide text-emerald-600 mb-1">You receive ({get.length})</div>
          <Column team={them} sel={get} onToggle={(id: number) => { toggle(get, setGet, id); setResult(null); }} tone="get" />
        </div>
      </div>

      {result && <TradeCard deal={{ ...result, partner: them?.owner, i_give: result.me.gives, i_get: result.me.gets }} leagueId={leagueId} untouchableNames={untouchableNames} />}
    </div>
  );
}

/* --------------------------------------------------------------- matchups */
function Matchups() {
  const [pos, setPos] = useState('WR');
  const { data } = useApi<any>(`/trades/dvp?position=${pos}`);
  const open = usePlayerCard();

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-xs flex-wrap">
        <span className="text-slate-500">Points allowed to</span>
        {['QB', 'RB', 'WR', 'TE'].map(p => (
          <button key={p} onClick={() => setPos(p)}
            className={`px-2.5 py-1 rounded-lg font-bold border transition-colors ${
              pos === p ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'}`}>
            {p}
          </button>
        ))}
        {data && <span className="text-slate-400 ml-auto">from {data.seasons?.join(', ')} boxscores</span>}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {[['Softest defences — target these', 0, 8, 'emerald'], ['Toughest defences — fade these', -8, undefined, 'rose']].map(
          ([title, from, to, tone]: any) => {
            const list = to != null ? (data?.table ?? []).slice(from, to) : (data?.table ?? []).slice(from).reverse();
            return (
              <div key={title} className="card overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
                  <h3 className="text-sm font-bold text-slate-700">{title}</h3>
                </div>
                <div className="divide-y divide-slate-100">
                  {list.map((d: any) => (
                    <div key={d.opponent} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                      <span className="font-bold text-slate-700 w-10">{d.opponent}</span>
                      <span className="tabular-nums text-slate-600">{d.allowed} ppg allowed</span>
                      <span className="text-[10px] text-slate-400">{d.games}g</span>
                      <span className={`ml-auto font-bold tabular-nums text-${tone}-600`}>
                        {d.mult > 1 ? '+' : ''}{((d.mult - 1) * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
      </div>

      <p className="text-[11px] text-slate-400 mt-3">
        Weighted so recent seasons count more, and computed only over players who actually cleared a startable score —
        including every WR5 who played six snaps flattens every defence toward the same number.
      </p>
    </div>
  );
}
