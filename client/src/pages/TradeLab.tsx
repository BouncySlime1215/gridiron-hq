import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, headshotUrl, useApi } from '../api';
import { Headshot, PosBadge } from '../components/PlayerRow';
import { sanitizedMessage } from '../lib/errorSanitize';
import { useLeague } from '../state/league';
import TradeCard, { PlayerPill, num } from '../components/TradeCard';
import MarketAsOf from '../components/MarketAsOf';
import { usePlayerCard } from '../components/PlayerCard';
import EvidenceTable from '../components/draft/EvidenceTable';
import StreakChips from '../components/draft/StreakChips';
import { statHeadline } from '../components/draft/types';
import { hasEvidence } from '../components/trade/types';
import { PageLoading, PageError, EmptyState } from '../components/PageState';
import RulesHidden from '../components/trade/RulesHidden';
import { Chip, Sheet } from '../components/ui/DesignSystem';


/** Reads/writes the untouchable-player list for one league from localStorage. */
const untouchableKey = (leagueId: number) => `gh:untouchable:${leagueId}`;
const loadUntouchable = (leagueId: number | null): number[] => {
  if (!leagueId) return [];
  try { return JSON.parse(localStorage.getItem(untouchableKey(leagueId)) ?? '[]'); }
  catch { return []; }
};

/* ------------------------------------------------------------ shared state */
/**
 * The trade tools' shared state for the active league (Trades → Go get, Find deals, Build):
 * rosters, which team is mine, and the untouchable list (per league, in this browser). The Trade
 * Lab page and its tab strip are gone; the Trades area (pages/Trades.tsx) hosts these tools.
 */
export function useTradeDesk() {
  const { activeId: active } = useLeague();
  const { data: rosters, loading: rostersLoading, error: rostersError, refetch: refetchRosters } = useApi<any>(active ? `/trades/${active}/rosters` : null);
  const [teamId, setTeamId] = useState<string | null>(null);
  // A "which team is me" pick only means something within the league it was made in.
  useEffect(() => { setTeamId(null); }, [active]);
  const me = teamId ?? rosters?.my_team_id ?? rosters?.teams?.[0]?.roster_id ?? null;
  // Players marked untouchable are never offered by Find deals or Go get: saved per league.
  const [untouchable, setUntouchable] = useState<number[]>(() => loadUntouchable(active));
  useEffect(() => { setUntouchable(loadUntouchable(active)); }, [active]);
  const toggleUntouchable = (id: number) => {
    setUntouchable(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      if (active) localStorage.setItem(untouchableKey(active), JSON.stringify(next));
      return next;
    });
  };
  const myPlayers: any[] = rosters?.teams?.find((t: any) => t.roster_id === me)?.players ?? [];
  // Handed to every TradeCard, so the AI writing a pitch never suggests one of these as a sweetener.
  const untouchableNames = myPlayers.filter((p: any) => untouchable.includes(p.id)).map((p: any) => p.name);
  return { active, rosters, rostersLoading, rostersError, refetchRosters, me, setTeamId, untouchable, toggleUntouchable, myPlayers, untouchableNames };
}

/**
 * Trades' one context bar (shown once, above every view): trade values freshness as a chip, the
 * untouchables as a chip that opens a sheet, and "Trading as" only when the league has no team marked
 * as yours (the app header already picks the league).
 */
export function TradeDeskHeader({ desk, extra = null }: { desk: ReturnType<typeof useTradeDesk>; extra?: ReactNode }) {
  const { rosters, me, setTeamId, myPlayers, untouchable, toggleUntouchable } = desk;
  const [sheet, setSheet] = useState(false);
  const locked = myPlayers.filter((p: any) => untouchable.includes(p.id));
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="trades-context">
      {rosters?.teams && !rosters?.my_team_id && (
        <label className="text-xs text-slate-600">Trading as
          <select className="input league-select ml-2 w-[12rem] max-w-full" value={me ?? ''} onChange={e => setTeamId(e.target.value)}>
            {rosters.teams.map((t: any) => <option key={t.roster_id} value={t.roster_id}>{t.owner}</option>)}
          </select>
        </label>
      )}
      <MarketAsOf asOf={rosters?.market_as_of} compact />
      {myPlayers.length > 0 && (
        <button type="button" className={`ds-chip ${locked.length ? 'ds-chip-accent' : ''}`} onClick={() => setSheet(true)}
          aria-haspopup="dialog" data-testid="untouchables-chip" title="Players Find deals, Go get and Build never offer">
          Untouchables: {locked.length}
        </button>
      )}
      {extra}
      <Sheet open={sheet} title="Untouchables" onClose={() => setSheet(false)}>
        <p className="ds-note mb-3">Tap a player to lock him: Find deals, Go get and Build never offer a locked player. Saved for this league in this browser.
          Your hard rules (never-give players, no buy-backs, blue chips only, no overpaying) apply on top, on the server.</p>
        <div className="flex flex-wrap gap-1.5">
          {myPlayers.map((p: any) => (
            <Chip key={p.id} on={untouchable.includes(p.id)} onClick={() => toggleUntouchable(p.id)}>{untouchable.includes(p.id) ? 'Locked · ' : ''}{p.name}</Chip>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

export { FindDeals, TitleTrades, TargetPlayer, TargetMany, MockTrade };

/**
 * Deals scored in championship probability rather than points per week.
 *
 * The headline case for this tab is when the two disagree — a trade can add
 * three points a week and still leave you less likely to win the league.
 */
function TitleTrades({ leagueId, teamId, controls }: { leagueId: number; teamId: string | null; controls?: ReactNode }) {
  const { data, loading, error, refetch } = useApi<any>(
    teamId ? `/trades/${leagueId}/title-trades?team_id=${teamId}&shortlist=6` : null);
  const row = controls ? <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" data-testid="find-controls">{controls}</div> : null;

  if (loading) return <>{row}<PageLoading label="Simulating each deal twice under the same season… this takes a moment on the first run." /></>;
  if (error && !data) return <>{row}<PageError message={error} onRetry={refetch} /></>;
  if (data?.error) return <>{row}<div className="card p-6 text-sm text-rose-600">{data.error}</div></>;
  const deals = data?.deals ?? [];

  return (
    <div>
      {row}
      <RulesHidden n={data?.dropped_by_rule} className="mb-3" />
      <div className={`card p-4 mb-3 ${data?.objectives_disagree ? 'border-amber-300 bg-amber-50/50' : ''}`}>
        <h2 className="text-sm font-bold text-slate-800 mb-1">
          {data?.simulated ?? 0} deals simulated · ranked by championship odds
          {data?.no_deal_clears_noise && <span className="font-normal text-slate-500"> · none moves your odds past its noise band</span>}
        </h2>
        <p className="text-xs text-slate-700 leading-relaxed">{data?.disagreement_note}</p>
      </div>

      {!deals.length ? (
        <EmptyState title="No plausible deals to simulate"
          description="The finder returned nothing that clears its acceptance bar." />
      ) : (
        <div className="space-y-2">
          {deals.map((d: any, i: number) => {
            // RL-6-3: a delta inside 2 paired standard errors has no established sign,
            // so it is greyed rather than painted as a gain or a loss.
            const real = d.title_delta_clears_noise === true;
            const good = real && (d.title_delta ?? 0) > 0;
            const tone = !real ? 'text-slate-400' : good ? 'text-emerald-700' : 'text-rose-700';
            return (
              <div key={i} className={`card p-4 border ${good ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'}`}>
                <div className="flex items-baseline gap-3 flex-wrap mb-2">
                  <span className={`text-xl font-black tabular-nums ${tone}`}>
                    {(d.title_delta ?? 0) > 0 ? '+' : ''}{((d.title_delta ?? 0) * 100).toFixed(1)}%
                  </span>
                  {d.title_delta_se != null && (
                    <span className="text-[11px] tabular-nums text-slate-400">±{(2 * d.title_delta_se * 100).toFixed(1)}</span>
                  )}
                  <span className="text-[11px] text-slate-500">{real ? 'championship odds' : 'championship odds · within noise'}</span>
                  <span className={`text-xs font-bold tabular-nums ml-auto ${(d.ppg_delta ?? 0) > 0 ? 'text-slate-700' : 'text-slate-400'}`}>
                    {(d.ppg_delta ?? 0) > 0 ? '+' : ''}{d.ppg_delta} ppg
                  </span>
                </div>
                <div className="text-sm text-slate-700">
                  <span className="text-rose-700">give</span> {d.i_give.map((p: any) => p.name).join(' + ')}
                  <span className="text-slate-400 mx-2">→</span>
                  <span className="text-emerald-700">get</span> {d.i_get.map((p: any) => p.name).join(' + ')}
                </div>
                <div className="text-[11px] text-slate-500 mt-1.5">
                  with <b className="text-slate-700">{d.partner}</b> · {d.fairness}
                  {d.their_title_delta != null && (
                    <> · their title <span className={d.their_title_delta_clears_noise === true ? '' : 'text-slate-400'}>
                        {(d.their_title_delta * 100).toFixed(1)}%
                        {d.their_title_delta_se != null && <> ±{(2 * d.their_title_delta_se * 100).toFixed(1)}</>}
                        {d.their_title_delta_clears_noise !== true && ' (within noise)'}</span>
                      {d.mutual_title_gain && <b className="text-emerald-700"> · both gain</b>}</>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {data?.note && <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">{data.note}</p>}
    </div>
  );
}

/** Collapsible roster picker for marking players your auto-suggestions must leave alone. */
/* ------------------------------------------------------------- find deals */

/** The same "headline pieces" idea the server collapses duplicate packages on
 *  (see findTrades in trade-engine.js) — used client-side so "seen" tracking
 *  survives the throw-in players changing between refreshes of the same idea. */
function dealSignature(d: any): string {
  const headline = (list: any[]) => list.slice().sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.id;
  return `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`;
}

function seenKey(leagueId: number, teamId: string | null) { return `gh:trades-seen:${leagueId}:${teamId ?? ''}`; }

function loadSeen(leagueId: number, teamId: string | null): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(seenKey(leagueId, teamId)) ?? '[]')); }
  catch { return new Set(); }
}

function saveSeen(leagueId: number, teamId: string | null, seen: Set<string>) {
  try { localStorage.setItem(seenKey(leagueId, teamId), JSON.stringify([...seen])); } catch { /* private mode, etc. */ }
}

const reloadSeenKey = (leagueId: number, teamId: string | null) => `gh:trades-batch-seen:${leagueId}:${teamId ?? ''}`;

function FindDeals({ leagueId, teamId, rosters, untouchable, untouchableNames, controls, onGoGet }: {
  leagueId: number; teamId: string | null; rosters: any; untouchable: number[]; untouchableNames: string[];
  /** Trades → Find deals: the ranking switch, drawn first in this view's one control row. */
  controls?: ReactNode;
  /** The empty state's next step: Go get → someone else. */
  onGoGet?: () => void;
}) {
  const [mutual, setMutual] = useState(true);
  const [size, setSize] = useState(2);
  const [hideSeen, setHideSeen] = useState(true);
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen(leagueId, teamId));
  useEffect(() => { setSeen(loadSeen(leagueId, teamId)); }, [leagueId, teamId]);

  // Separate from the individual per-card dismiss above: this is what "Reload"
  // pushes a whole shown batch into, so a reload never re-shows the same eight
  // cards. Kept apart from `seen` because dismissing one card you don't like is
  // a different action from cycling the whole curated set.
  const [batchSeen, setBatchSeen] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(reloadSeenKey(leagueId, teamId)) ?? '[]')); }
    catch { return new Set(); }
  });
  useEffect(() => {
    try { setBatchSeen(new Set(JSON.parse(localStorage.getItem(reloadSeenKey(leagueId, teamId)) ?? '[]'))); }
    catch { setBatchSeen(new Set()); }
  }, [leagueId, teamId]);

  const exclude = untouchable.length ? `&exclude=${untouchable.join(',')}` : '';
  // Package size measured, not assumed: max=3 vs max=2 found the exact same
  // set of partner teams with a real deal in a live check (6 of 9 either
  // way) at 2.5x the search cost (12.7s vs 5.0s) — bigger packages add more
  // VARIANTS with partners already found, not new partners. Respecting the
  // selector below is therefore both faster and just as good for coverage.
  // The server itself evaluates every combination regardless of `limit` — it
  // only controls how much of the already-computed, ranked, deduplicated
  // result comes back. Raised well past what one batch needs so "Reload" has
  // real distinct ideas to draw on across many clicks.
  const q = `/trades/${leagueId}/find?team_id=${teamId ?? ''}&mutual=${mutual ? 1 : 0}&max_per_side=${size}&limit=300${exclude}`;
  const { data, loading, error, refetch } = useApi<any>(teamId ? q : null);

  const allDeals = data?.deals ?? [];
  const hiddenCount = hideSeen ? allDeals.filter((d: any) => seen.has(dealSignature(d))).length : 0;
  const visible = hideSeen ? allDeals.filter((d: any) => !seen.has(dealSignature(d))) : allDeals;

  const dismiss = (d: any) => {
    const next = new Set(seen); next.add(dealSignature(d));
    setSeen(next); saveSeen(leagueId, teamId, next);
  };
  const resetSeen = () => { setSeen(new Set()); saveSeen(leagueId, teamId, new Set()); };

  // The curated batch is organized by TRADE PARTNER, not just grade: one real
  // deal per opponent in the league (up to all of them), so "find deals"
  // actually surfaces a genuine trade with as many different people as real
  // candidates exist — not five variations of a deal with the same one or
  // two teams, which is what a pure best-score ranking tends to produce.
  // Each partner's own best not-yet-shown deal is picked, preferring ones
  // "Reload" hasn't shown yet for THAT partner specifically; a partner with
  // no real mutual/plausible deal right now is shown as such, not skipped
  // silently — the point is to see the whole league's trade landscape.
  const partners = useMemo(() => {
    const notDismissed = allDeals.filter((d: any) => !seen.has(dealSignature(d)));
    const byPartner = new Map<string, any[]>();
    for (const d of notDismissed) {
      const pid = String(d.partner_id);
      if (!byPartner.has(pid)) byPartner.set(pid, []);
      byPartner.get(pid)!.push(d);
    }
    const allTeams = (rosters?.teams ?? []).filter((t: any) => String(t.roster_id) !== String(teamId));
    return allTeams.map((t: any) => {
      const pool = byPartner.get(String(t.roster_id)) ?? [];
      const fresh = pool.filter(d => !batchSeen.has(dealSignature(d)));
      const stale = pool.filter(d => batchSeen.has(dealSignature(d)));
      // Deals arrive from the server already ranked best-first — prefer a
      // never-shown one, only falling back to a previously-cycled one for
      // THIS partner when fresh ones genuinely run out.
      const picked = fresh[0] ?? stale[0] ?? null;
      return { roster_id: t.roster_id, owner: t.owner, picked, totalAvailable: pool.length, freshCount: fresh.length };
    }).sort((a: any, b: any) => {
      // Teams with a real deal first (best score first, since the pool is
      // already server-ranked), teams with nothing real right now last.
      if (!!a.picked !== !!b.picked) return a.picked ? -1 : 1;
      if (a.picked && b.picked) return (b.picked.score ?? 0) - (a.picked.score ?? 0);
      return 0;
    });
  }, [allDeals, seen, batchSeen, rosters, teamId]);

  const partnersWithDeals = partners.filter((p: any) => p.picked).length;

  const reload = () => {
    const next = new Set(batchSeen);
    for (const p of partners) if (p.picked) next.add(dealSignature(p.picked));
    setBatchSeen(next);
    try { localStorage.setItem(reloadSeenKey(leagueId, teamId), JSON.stringify([...next])); } catch { /* private mode, etc. */ }
  };
  const reloadOne = (rosterId: string) => {
    const p = partners.find((x: any) => String(x.roster_id) === String(rosterId));
    if (!p?.picked) return;
    const next = new Set(batchSeen);
    next.add(dealSignature(p.picked));
    setBatchSeen(next);
    try { localStorage.setItem(reloadSeenKey(leagueId, teamId), JSON.stringify([...next])); } catch { /* private mode, etc. */ }
  };
  const resetBatchSeen = () => {
    setBatchSeen(new Set());
    try { localStorage.setItem(reloadSeenKey(leagueId, teamId), '[]'); } catch { /* private mode, etc. */ }
  };

  return (
    <div>
      {/* One control row: the ranking switch, package size, "only plausible". */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs" data-testid="find-controls">
        {controls}
        {controls && <span className="hidden h-5 w-px bg-[var(--c-line)] sm:block" aria-hidden />}
        <label className="flex items-center gap-1.5">
          <span className="text-slate-600">Package size</span>
          <select className="input py-1" value={size} onChange={e => setSize(Number(e.target.value))}>
            <option value={1}>1-for-1</option>
            <option value={2}>up to 2-for-2</option>
            <option value={3}>up to 3-for-3</option>
          </select>
        </label>
        <button type="button" role="switch" aria-checked={mutual} onClick={() => setMutual(v => !v)}
          className={`ds-chip ${mutual ? 'ds-chip-on' : ''}`} title="Only deals the other manager would plausibly accept">
          Only plausible {mutual ? 'on' : 'off'}
        </button>
      </div>
      <RulesHidden n={data?.dropped_by_rule} className="mb-3" />

      {loading && <PageLoading label="Searching every roster in the league…" />}
      {error && !data && <PageError message={error} onRetry={refetch} />}

      {data?.deals?.length === 0 && (
        <div className="ds-card p-6 text-center" data-testid="find-empty">
          <h3 className="ds-h">Nothing clears the bar right now</h3>
          <p className="ds-note mx-auto mt-1 max-w-md">No package up to {size}-for-{size} helps you and them{mutual ? ' at once' : ''}.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {onGoGet && <button type="button" className="ds-btn ds-btn-primary ds-btn-sm" onClick={onGoGet}>Go get someone specific</button>}
            {size < 3 && <button type="button" className="ds-btn ds-btn-sm" onClick={() => setSize(3)}>Try up to 3-for-3</button>}
            {mutual && <button type="button" className="ds-btn ds-btn-sm" onClick={() => setMutual(false)}>Show deals that only help you</button>}
          </div>
        </div>
      )}

      {data?.deals?.length > 0 && (
        <div className="card p-4 mb-4">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <h3 className="text-sm font-bold text-slate-700">
              Trade partners — {partnersWithDeals} of {partners.length} team{partners.length === 1 ? '' : 's'} have a real deal right now
            </h3>
            <button className="ml-auto text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={reload}>
              Reload — find new trades
            </button>
            {batchSeen.size > 0 && (
              <button className="text-xs text-slate-400 underline hover:text-slate-600" onClick={resetBatchSeen}>
                start over ({batchSeen.size} cycled)
              </button>
            )}
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {partners.map((p: any) => (
              <div key={p.roster_id}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{p.owner}</span>
                  {p.totalAvailable > 0 && (
                    <span className="text-[11px] font-normal text-slate-400">
                      · {p.totalAvailable} real candidate{p.totalAvailable === 1 ? '' : 's'}
                    </span>
                  )}
                  {p.picked && p.totalAvailable > 1 && (
                    <button className="ml-auto text-[11px] text-emerald-700 underline hover:text-emerald-900"
                      onClick={() => reloadOne(p.roster_id)}>
                      reload this one
                    </button>
                  )}
                </div>
                {!p.picked && (
                  <div className="text-xs text-slate-400 mb-2">
                    No real trade with {p.owner} clears the bar right now — not shown rather than faked.
                  </div>
                )}
                {p.picked && (
                  <TradeCard key={dealSignature(p.picked)} deal={p.picked} leagueId={leagueId} untouchableNames={untouchableNames}
                    onDismiss={() => dismiss(p.picked)} compact />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* RL-19-3: 1-for-1s the lineup-points gate drops that raise BOTH teams' title
          odds past 2 SE. Their own class, never mixed into the points list below. */}
      {data?.title_mutual?.status === 'failed' && (
        <p className="text-xs text-[var(--crit)] mb-3">Title-mutual check could not run: {data.title_mutual.error}</p>
      )}
      {data?.title_mutual?.deals?.length > 0 && (
        <div className="mb-5">
          <div className="text-xs text-slate-500 font-semibold mb-2">
            {data.title_mutual.preview ? 'Preview (unconfirmed forward): ' : ''}
            Both title odds up, points say no · {data.title_mutual.deals.length} of {data.title_mutual.simulated} simulated
          </div>
          <div className="space-y-3">
            {data.title_mutual.deals.map((d: any, i: number) => (
              <TradeCard key={`tm-${dealSignature(d) || i}`} deal={d} leagueId={leagueId} untouchableNames={untouchableNames}
                onDismiss={() => dismiss(d)} compact />
            ))}
          </div>
        </div>
      )}

      {/* Only when there are ideas to browse: no counters or "candidates evaluated" on an empty list. */}
      {allDeals.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold text-slate-600">Every distinct idea, best first ({allDeals.length})</span>
          <button type="button" role="switch" aria-checked={hideSeen} onClick={() => setHideSeen(v => !v)}
            className={`ds-chip ${hideSeen ? 'ds-chip-on' : ''}`} title="Hide deals you dismissed">Hide dismissed {hideSeen ? 'on' : 'off'}</button>
          {hiddenCount > 0 && <button type="button" className="text-slate-600 underline hover:text-slate-800" onClick={resetSeen}>{hiddenCount} dismissed · show again</button>}
        </div>
      )}

      {data?.deals?.length > 0 && visible.length === 0 && (
        <EmptyState title="You've dismissed every deal that clears the bar right now"
          description="Check back after the next data refresh — new rosters and projections surface new ideas."
          actionLabel="Show them again" onAction={resetSeen} />
      )}
      <div className="space-y-3">
        {visible.map((d: any, i: number) => (
          <TradeCard key={dealSignature(d) || i} deal={d} leagueId={leagueId} untouchableNames={untouchableNames}
            onDismiss={() => dismiss(d)} />
        ))}
      </div>

      <TradeSequences leagueId={leagueId} teamId={teamId} mutual={mutual} size={size} exclude={exclude} untouchableNames={untouchableNames} />
    </div>
  );
}

/**
 * findTrades() prices every deal against the roster you have right now, so it
 * can't see a deal that only makes sense *after* another one — the throw-in
 * you'd only have post-trade, or a hole the first deal just opened that a
 * second one happens to fill. This runs that one step ahead and shows the
 * chain: take this trade, and these become live next.
 */
function TradeSequences({ leagueId, teamId, mutual, size, exclude, untouchableNames }: {
  leagueId: number; teamId: string | null; mutual: boolean; size: number; exclude: string; untouchableNames: string[];
}) {
  const q = `/trades/${leagueId}/find/sequences?team_id=${teamId ?? ''}&mutual=${mutual ? 1 : 0}&max_per_side=${size}${exclude}`;
  const { data, loading, error, refetch } = useApi<any>(teamId ? q : null);
  // A failure here is worth surfacing even though this whole section is
  // optional/supplementary — otherwise a broken sequences call looks
  // identical to "nothing chains together right now" and hides a real bug.
  if (error && !data) return <div className="mt-6"><PageError message={error} onRetry={refetch} /></div>;
  if (loading || !data?.step1 || !data?.sequences?.length) return null;

  return (
    <div className="mt-6">
      <RulesHidden n={data?.dropped_by_rule} className="mb-2" />
      <h3 className="text-sm font-bold text-slate-800 mb-1">Do this, then this opens up</h3>
      <p className="text-xs text-slate-500 mb-3">
        Every deal above is priced against your roster as it is right now. These only become live
        <em> after</em> you make the trade below — the engine re-ran the whole search assuming you'd already made it.
      </p>
      <div className="rounded-xl border-2 border-dashed border-slate-300 p-3 mb-3 bg-slate-50">
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Step 1 — do this first</div>
        <TradeCard deal={data.step1} leagueId={leagueId} untouchableNames={untouchableNames} compact />
      </div>
      <div className="pl-4 border-l-2 border-slate-200 ml-3 space-y-3">
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Step 2 — then one of these</div>
        {data.sequences.map((d: any, i: number) => <TradeCard key={i} deal={d} leagueId={leagueId} untouchableNames={untouchableNames} />)}
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
  const { data: offer, loading, error, refetch } = useApi<any>(
    picked && teamId ? `/trades/${leagueId}/offer?team_id=${teamId}&player_id=${picked.id}${exclude}` : null);
  const { data: outlook, loading: outlookLoading, error: outlookError, refetch: refetchOutlook } = useApi<any>(
    picked ? `/trades/${leagueId}/player/${picked.id}` : null);

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
      <RulesHidden n={offer?.dropped_by_rule} className="mb-3 lg:col-span-2" />
      <div>
        <div className="card p-4 mb-3">
          <label className="text-xs text-slate-600">Name the player you want</label>
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

        {loading && <PageLoading label="Pricing him against your roster…" />}
        {error && !offer && <PageError message={error} onRetry={refetch} />}
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

      {picked && outlookLoading && !outlook && <PageLoading label="Loading player outlook…" />}
      {picked && outlookError && !outlook && <PageError message={outlookError} onRetry={refetchOutlook} />}
      {outlook && !outlook.error && <PlayerOutlook o={outlook} />}
    </div>
  );
}

/**
 * "Go get them" — the same offer-ladder logic as TargetPlayer, but for a whole
 * shopping list at once. Targets on different rosters come back as separate
 * ladders (one per owner) since a real trade is with one team at a time.
 */
function TargetMany({ leagueId, teamId, rosters, untouchable, untouchableNames }: {
  leagueId: number; teamId: string | null; rosters: any; untouchable: number[]; untouchableNames: string[];
}) {
  const [partnerId, setPartnerId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<any[]>([]);
  useEffect(() => { setQuery(''); setPicked([]); setPartnerId(''); }, [leagueId]);
  useEffect(() => { setPicked([]); setQuery(''); }, [partnerId]);
  const exclude = untouchable.length ? `&exclude=${untouchable.join(',')}` : '';
  const ids = picked.map(p => p.id).join(',');
  const { data: result, loading, error, refetch } = useApi<any>(
    picked.length && teamId ? `/trades/${leagueId}/offer-many?team_id=${teamId}&player_ids=${ids}${exclude}` : null);

  const partners = useMemo(() =>
    (rosters?.teams ?? []).filter((t: any) => t.roster_id !== teamId), [rosters, teamId]);

  const pool = useMemo(() => {
    const teams = partnerId ? partners.filter((t: any) => t.roster_id === partnerId) : partners;
    return teams.flatMap((t: any) => t.players.map((p: any) => ({ ...p, owner: t.owner })));
  }, [partners, partnerId]);

  const results = useMemo(() => {
    if (query.trim().length < 2) return [];
    const q = query.toLowerCase();
    const pickedIds = new Set(picked.map(p => p.id));
    return pool.filter((p: any) => p.name.toLowerCase().includes(q) && !pickedIds.has(p.id))
      .sort((a: any, b: any) => b.value - a.value).slice(0, 8);
  }, [query, pool, picked]);

  return (
    <div>
      <RulesHidden n={result?.dropped_by_rule} className="mb-3" />
      <div className="card p-4 mb-3">
        <label className="text-xs font-bold uppercase tracking-wide text-slate-400">Trade with a specific manager? (optional)</label>
        <select className="input w-full mt-1.5" value={partnerId} onChange={e => setPartnerId(e.target.value)}>
          <option value="">Any manager — search the whole league</option>
          {partners.map((t: any) => <option key={t.roster_id} value={t.roster_id}>{t.owner}</option>)}
        </select>

        <label className="mt-3 block text-xs font-bold uppercase tracking-wide text-slate-400">Who do you want? Add as many as you like.</label>
        <input className="input w-full mt-1.5" placeholder="Start typing a player's name…"
          value={query} onChange={e => setQuery(e.target.value)} />
        {query.trim().length >= 2 && results.length === 0 && (
          <p className="mt-2 text-xs text-slate-400">No match{partnerId ? ` on ${partners.find((t: any) => t.roster_id === partnerId)?.owner}'s roster` : ''}.</p>
        )}
        {results.length > 0 && (
          <div className="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            {results.map((p: any) => (
              <button key={p.id} onClick={() => { setPicked(prev => [...prev, p]); setQuery(''); }}
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
        {picked.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {picked.map(p => (
              <button key={p.id} onClick={() => setPicked(prev => prev.filter(x => x.id !== p.id))}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700">
                {p.name} <span className="text-slate-400">×</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && <PageLoading label="Pricing them against your roster…" />}
      {error && !result && <PageError message={error} onRetry={refetch} />}
      {result?.error && <div className="card p-5 border-amber-200 bg-amber-50/40 text-sm text-slate-700">{result.error}</div>}

      {result?.ladders?.map((l: any) => (
        <div key={l.owner_id} className="mb-4">
          <div className="card p-4 border-emerald-200 mb-2">
            <div className="flex items-center gap-2 flex-wrap">
              {l.targets.map((t: any) => <PlayerPill key={t.id} p={t} tone="get" />)}
              <span className="text-xs text-slate-500">owned by <span className="font-semibold text-slate-700">{l.owner}</span></span>
            </div>
            <p className="text-xs text-slate-600 mt-2">{l.leverage}</p>
          </div>

          {l.error && (
            <div className="card p-4 border-amber-200 bg-amber-50/40 text-sm text-slate-700">
              <p className="font-bold text-slate-800 mb-1">{l.error}</p>
              <p>{l.reason}</p>
            </div>
          )}

          {l.offers?.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-slate-700 mb-0.5">{l.offers.length} ways to land {l.targets.length > 1 ? 'this package' : 'him'} from {l.owner}</h3>
              <p className="text-[11px] text-slate-500 mb-2">
                Cheapest first. Open with #1; if they say no, move down the list.
                {untouchable.length > 0 && ` Your ${untouchable.length} untouchable player${untouchable.length > 1 ? 's' : ''} never appear here.`}
              </p>
              <div className="space-y-2">
                {l.offers.map((o: any) => (
                  <div key={o.rank}>
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-sky-200 bg-sky-100 text-[10px] font-black text-sky-900">{o.rank}</span>
                      <h4 className="text-xs font-bold text-slate-700">{o.label}</h4>
                      <span className="text-[11px] text-slate-400">{(o.ratio * 100).toFixed(0)}% of their combined market price</span>
                    </div>
                    <TradeCard deal={{ ...o, partner: l.owner, i_get: l.targets }} leagueId={leagueId} compact untouchableNames={untouchableNames} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {!picked.length && (
        <EmptyState title="Pick a few players to get started"
          description={partnerId
            ? `Search ${partners.find((t: any) => t.roster_id === partnerId)?.owner}'s roster and add the players you want — this builds the real packages that would get a deal done with them specifically.`
            : 'Search and add a few players — from one team or several — and this builds the real packages that would land them, priced against your own roster.'} />
      )}
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
            <dd className={`tabular-nums font-semibold ${o.sos > 1.02 ? 'text-good' : o.sos < 0.98 ? 'text-crit' : ''}`}>{o.sos}</dd></div>
          <div><dt className="text-slate-400">Playoff SOS</dt>
            <dd className={`tabular-nums font-semibold ${o.playoff_sos > 1.02 ? 'text-good' : o.playoff_sos < 0.98 ? 'text-crit' : ''}`}>{o.playoff_sos}</dd></div>
          <div><dt className="text-slate-400">Bye</dt><dd className="tabular-nums">Week {o.bye ?? '—'}</dd></div>
          <div><dt className="text-slate-400">Age</dt><dd className="tabular-nums">{o.age ?? '—'}</dd></div>
          {o.dynasty_age_decay && (
            <div className="col-span-2">
              <dt className="text-slate-400">
                Dynasty value, age-adjusted
                <span className="text-slate-300"> (4for4 production-curve decay, ×{o.dynasty_age_decay.multiplier})</span>
              </dt>
              <dd className="tabular-nums font-semibold">
                {o.dynasty_value_age_adjusted?.toLocaleString()}
                <span className="text-slate-400 font-normal"> (raw market {o.dynasty_value_raw?.toLocaleString()})</span>
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* The record: "select this guy because he has X yards consistently every
          season" — season-by-season rows, streaks, this season's band, the
          offseason read as a flag. Absent entirely when the league has no history. */}
      {hasEvidence(o) && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <h3 className="text-sm font-bold text-slate-700">The record</h3>
            {statHeadline(o.career, o.preseason) && (
              <p className="text-[11px] text-slate-600 mt-0.5">{statHeadline(o.career, o.preseason)}</p>
            )}
          </div>
          <div className="p-3 space-y-2 text-xs">
            <StreakChips career={o.career} />
            <div className="overflow-x-auto">
              <EvidenceTable career={o.career} preseason={o.preseason} position={o.position} />
            </div>
            {o.preseason?.p20 != null && o.preseason?.p80 != null && (
              <p className="tabular-nums text-slate-600" title="Our preseason model's p20–p80 season band">
                This season: <b className="text-slate-800">{Math.round(o.preseason.p20)}–{Math.round(o.preseason.p80)}</b> pts
                {o.preseason.points != null && <span className="text-slate-400"> · median {Math.round(o.preseason.points)}</span>}
                {o.preseason.drivers?.length > 0 && <span className="text-slate-500"> · {o.preseason.drivers.slice(0, 2).join('; ')}</span>}
              </p>
            )}
            {o.offseason && (
              <p className={`rounded border px-2 py-1 text-[11px] ${
                o.offseason.direction === 'upside' ? 'border-good bg-good-tint text-good'
                  : o.offseason.direction === 'risk' ? 'border-amber-300 bg-amber-50 text-amber-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'}`}
                title="Offseason-changes model — shown as context only, never multiplied into the value (which already prices the depth chart)">
                <b>{o.offseason.direction === 'upside' ? 'Upside' : o.offseason.direction === 'risk' ? 'Risk' : 'Offseason'}</b> ×{o.offseason.opportunity_multiplier.toFixed(2)}
                {o.offseason.drivers?.length > 0 && <span> · {o.offseason.drivers.slice(0, 2).join('; ')}</span>}
              </p>
            )}
          </div>
        </div>
      )}

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
                <span className={`ml-auto font-bold tabular-nums ${s.pct > 0 ? 'text-good' : 'text-crit'}`}>
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
const RULE_WHY: Record<string, string> = {
  never_give: 'sends a player you never trade',
  never_get: 'brings back a player you never take back',
  sold_this_season: 'brings back a player you sold this season',
  below_blue_chip: 'gets a player who is not a blue chip',
  unscored: 'gets a player the blue-chip board has not scored',
  no_fc_value: 'includes a player with no FantasyCalc value to check',
  overpay: 'sends more trade value than you get back',
  rules_unreadable: 'your rules could not be read, so nothing is certified',
};

/**
 * Trades → Build: any two-sided deal. Two cards side by side (You send / You get), tap a row to add
 * a player, K/DEF hidden unless asked, 12 rows then "Show all". A bottom summary bar carries the
 * value each way, the % over or under, your rules' verdict once scored, and "Who wins this?".
 */
function MockTrade({ leagueId, teamId, rosters, untouchable, untouchableNames }: {
  leagueId: number; teamId: string | null; rosters: any; untouchable: number[]; untouchableNames: string[];
}) {
  const [theirId, setTheirId] = useState<string | null>(null);
  const [give, setGive] = useState<number[]>([]);
  const [get, setGet] = useState<number[]>([]);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kdef, setKdef] = useState(false);
  // A mocked trade's rosters/result only mean something within the league it was built in.
  useEffect(() => { setTheirId(null); setGive([]); setGet([]); setResult(null); setErr(null); }, [leagueId]);

  const mine = rosters?.teams?.find((t: any) => t.roster_id === teamId);
  const others = rosters?.teams?.filter((t: any) => t.roster_id !== teamId) ?? [];
  const them = others.find((t: any) => t.roster_id === theirId) ?? others[0];

  const toggle = (list: number[], set: (v: number[]) => void, id: number) => {
    set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]); setResult(null);
  };
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setResult(await api(`/trades/${leagueId}/evaluate`, {
        method: 'POST', body: JSON.stringify({ my_team_id: teamId, their_team_id: them?.roster_id, give, get })
      }));
    } catch (e: any) { setErr(sanitizedMessage('Build.evaluate', "Couldn't score that deal", e.message)); setResult(null); }
    finally { setBusy(false); }
  };

  const valueOf = (team: any, ids: number[]) => (team?.players ?? []).filter((p: any) => ids.includes(p.id)).reduce((s: number, p: any) => s + (p.value ?? 0), 0);
  const sendV = valueOf(mine, give), getV = valueOf(them, get);
  const diff = sendV > 0 ? Math.round(((getV - sendV) / sendV) * 100) : null;
  const rules = result?.rules;

  return (
    <div data-testid="build">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2 text-slate-600">Trading with
          <select className="input league-select w-[12rem] max-w-full py-1" value={them?.roster_id ?? ''}
            onChange={e => { setTheirId(e.target.value); setGet([]); setResult(null); }}>
            {others.map((t: any) => <option key={t.roster_id} value={t.roster_id}>{t.owner}</option>)}
          </select>
        </label>
        <button type="button" role="switch" aria-checked={kdef} onClick={() => setKdef(v => !v)}
          className={`ds-chip ${kdef ? 'ds-chip-on' : ''}`} title="Show kickers and team defences">K / DEF {kdef ? 'shown' : 'hidden'}</button>
      </div>
      {/* The summary bar sits above the two cards, never over them (CLAUDE.md UI rules: nothing sticky over text or a button). */}
      <div className="build-bar" data-testid="build-bar">
        <div className="min-w-0 flex-1 text-sm">
          <span className="whitespace-nowrap">Send <b className="tabular-nums">{sendV.toLocaleString()}</b></span>
          <span className="mx-2 text-slate-400">·</span>
          <span className="whitespace-nowrap">Get <b className="tabular-nums">{getV.toLocaleString()}</b></span>
          {diff != null && getV > 0 && <span className={`ml-2 ds-chip ${diff >= 0 ? 'ds-chip-good' : 'ds-chip-bad'}`}
            title="FantasyCalc trade value you get, against what you send">{diff >= 0 ? `+${diff}%` : `${diff}%`} value</span>}
          {rules?.applies && (
            <span className={`ml-2 ds-chip ${rules.ok ? 'ds-chip-good' : 'ds-chip-warn'} !whitespace-normal`} data-testid="build-rules"
              title={rules.ok ? 'Passes your hard rules' : (rules.reasons ?? []).map((r: string) => RULE_WHY[r] ?? r).join('; ')}>
              {rules.ok ? 'Your rules: pass' : `Your rules: no, ${RULE_WHY[rules.reasons?.[0]] ?? 'breaks a rule'}`}
            </span>
          )}
        </div>
        {(give.length > 0 || get.length > 0) && <button type="button" className="ds-btn ds-btn-sm" onClick={() => { setGive([]); setGet([]); setResult(null); }}>Clear</button>}
        <button type="button" className="ds-btn ds-btn-primary" disabled={busy || !give.length || !get.length} onClick={run}
          title={!give.length || !get.length ? 'Add at least one player on each side' : 'Score this deal for both teams'}>
          {busy ? 'Scoring…' : 'Who wins this?'}
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <BuildSide title="You send" team={mine} sel={give} tone="give" kdef={kdef} locked={new Set(untouchable)}
          onToggle={id => toggle(give, setGive, id)} />
        <BuildSide title="You get" team={them} sel={get} tone="get" kdef={kdef} locked={new Set()}
          onToggle={id => toggle(get, setGet, id)} />
      </div>
      {err && <p role="alert" className="mt-2 text-xs text-crit">{err}</p>}
      {result && <div className="mt-4"><TradeCard deal={{ ...result, partner: them?.owner, i_give: result.me.gives, i_get: result.me.gets }} leagueId={leagueId} untouchableNames={untouchableNames} /></div>}

    </div>
  );
}

function BuildSide({ title, team, sel, tone, kdef, locked, onToggle }: {
  title: string; team: any; sel: number[]; tone: 'give' | 'get'; kdef: boolean; locked: Set<number>; onToggle: (id: number) => void;
}) {
  const [all, setAll] = useState(false);
  // 12 rows on a wide screen, 8 on a phone (the two cards stack there); the rest behind "Show all".
  const [cap] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches ? 8 : 12));
  const pool = (team?.players ?? []).filter((p: any) => kdef || !['K', 'DEF', 'D/ST', 'DST'].includes(p.position))
    .slice().sort((a: any, b: any) => Number(sel.includes(b.id)) - Number(sel.includes(a.id)) || (b.value ?? 0) - (a.value ?? 0));
  const shown = all ? pool : pool.slice(0, cap);
  return (
    <section className="ds-card overflow-hidden" aria-label={title}>
      <header className="flex items-baseline gap-2 px-4 pb-2 pt-3">
        <h3 className="ds-h">{title}</h3>
        <span className="ds-note min-w-0 truncate">{team?.owner}{team?.lineup_ppg != null ? ` · ${team.lineup_ppg} ppg` : ''}</span>
        <span className="ds-note ml-auto" title="FantasyCalc trade value">Value</span>
      </header>
      <div className="ds-rows">
        {shown.map((p: any) => {
          const on = sel.includes(p.id);
          return (
            <button key={p.id} type="button" aria-pressed={on} onClick={() => onToggle(p.id)}
              className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors hover:bg-[var(--c-hover)] ${on ? (tone === 'give' ? 'bg-[var(--c-red-tint)]' : 'bg-[var(--c-green-tint)]') : ''}`}
              title={locked.has(p.id) ? 'Marked untouchable: you can still build with him, as a reminder only' : on ? 'Tap to remove' : 'Tap to add'}>
              <Headshot src={headshotUrl(p)} pos={p.position} size={28} />
              <PosBadge pos={p.position} />
              <span className={`min-w-0 flex-1 truncate ${p.starter ? 'font-semibold' : ''}`}>{p.name}{locked.has(p.id) ? ' · locked' : ''}</span>
              <span className="tabular-nums text-slate-600" title="FantasyCalc trade value">{p.value?.toLocaleString() ?? '–'}</span>
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${on ? 'bg-[var(--c-accent)] text-[var(--c-accent-ink)]' : 'shadow-[0_0_0_1px_var(--c-line-strong)] text-slate-500'}`} aria-hidden>{on ? '✓' : '+'}</span>
            </button>
          );
        })}
      </div>
      {pool.length > cap && <button type="button" className="w-full py-2 text-xs font-semibold text-[var(--c-accent)]" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${pool.length}`}</button>}
    </section>
  );
}

/* --------------------------------------------------------------- matchups */
