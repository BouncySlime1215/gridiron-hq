/**
 * BENCH-CONSOLIDATION FINDER (batch D item 46) + ROSTER-SPOT VALUE (item 43). SHADOW.
 *
 * 46: 2-for-1 and 3-for-1 offers where Nick gives only depth (board score below the Blue chip floor)
 * for ONE Blue chip (83+), that raise his weekly starting-lineup points AND his title odds, on the
 * planner's dice and again on the confirm pass's fresh dice (research V6: shallow leagues favour
 * consolidation). Nick's rules are hard filters, never weights:
 *   - the give is depth only (search.js#isDepth: scored below 83, never 160 / 80 / 277, never untouchable);
 *   - every candidate passes never-give.js#ruleVerdict (the ONE rule gate: never-give, never-get,
 *     sold this season, Blue chip get, FantasyCalc overpay with the +12% depth-only 2-for-1 exception);
 *   - the overpay cap is Nick's rule, 0, never loosened by a destination tolerance; only a depth-only
 *     2-for-1 may ride the CAP-1C premium (up to +12%), and only when lineup points and title odds rise
 *     on both dice. A 3-for-1 never rides it;
 *   - trade memory (no buy-backs, no reversals) through the planner's stepPasses;
 *   - fails closed: no board, a missing trade ledger or no confirm dice -> no rows.
 *
 * 43: the value of an open bench spot. In a 10-team redraft the replacement is local (research V1):
 * a spot a consolidation frees is filled from THIS league's wire (adapter.freeAgents), picked the way
 * trade-engine.js#lineupValue (RL-9-3) fills a freed spot: the free agent that raises Nick's starting
 * lineup most, ties to the higher rest-of-season rate. Reported per candidate and for one open spot
 * on today's roster, in rest-of-season points per game (the planner's ros_ppg basis, no dice).
 *
 * Flag GRIDIRON_CONSOLIDATION: '1' or 'shadow' -> shadow; anything else off. There is no 'on' yet:
 * nothing served reads this report (the producer writes it to `_run.inputs.consolidation`), the
 * roster-spot value moves no served number, and preview mode never turns it on. Ids only (public repo).
 */
import { SCORED, BLUE_CHIP_SCORE, DEPTH_PREMIUM_MAX, isDepth, overpayPct, premiumHolds } from './search.js';
import { ruleVerdict, PINNED_NEVER_GIVE, PINNED_NEVER_GET } from './never-give.js';
import { SCREEN_WINDOW, combos } from './paths.js';

export const CONSOLIDATION_ENV = 'GRIDIRON_CONSOLIDATION';

/** 'shadow' when GRIDIRON_CONSOLIDATION is '1' or 'shadow'; otherwise 'off'. Never on through preview. */
export function consolidationFlag(env = process.env) {
  const v = env?.[CONSOLIDATION_ENV];
  return v === '1' || v === 'shadow' ? 'shadow' : 'off';
}

/**
 * Budget (hand-set, a GUESS until timed on league 4): candidates rescored on the planner's dice
 * (each survivor costs one more rescore on the confirm dice), rows reported, Blue chips searched.
 */
export const CONSOLIDATION_BUDGET = Object.freeze({ candidates: 30, rows: 5, gets: 16, maxGive: 3 });

/**
 * Pre-registered pass bar (PR body "Pre-registration"). Changing it after a run is a new version.
 * The finder leaves shadow only when ALL hold on league 4 over 3 nightly producer runs:
 *   B1 rules       0 reported rows fail ruleVerdict, the overpay cap or the depth-only give (count, every run)
 *   B2 confirm     every reported row gains lineup points and title odds on the fresh dice (by construction;
 *                  the count of rows that failed there is printed) and its confirm title gain is > 1 SE
 *                  on at least half the rows
 *   B3 found       >= 1 reported row on at least 2 of the 3 runs (otherwise the unit has nothing to serve)
 *   B4 stable      with rosters unchanged between two runs, the top row's (give, get) repeats
 *   B5 cost        the finder's own rescores <= 2 x candidates budget and it adds <= 25% to runtime_ms
 * The roster-spot value (43) leaves shadow only with a graded run (scripts/rnd, not built here): its
 * predicted spot value vs the realised next-4-week points of the free agent actually added, MAE no
 * worse than a flat league-size replacement level, n >= 20 adds.
 */
export const CONSOLIDATION_PASS_BAR = Object.freeze({
  version: 1,
  runs: 3,
  rules_failures: 0,
  min_runs_with_rows: 2,
  min_share_confirm_over_1se: 0.5,
  max_rescores_per_candidate: 2,
  max_runtime_share: 0.25,
  roster_spot: 'ungraded: needs a local grade (predicted spot value vs realised free-agent points, n >= 20)',
});

const S = x => String(x);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => (finite(x) ? Math.round(x * 100) / 100 : null);
const r5 = x => (finite(x) ? Math.round(x * 1e5) / 1e5 : null);

/**
 * ROSTER-SPOT VALUE (43): fill `spots` open roster spots on `roster` from the league's wire.
 * roster, freeAgents: player objects { id, position, ros_ppg }; lineupPpg(list) -> the starting lineup's
 * points per game (the adapter's startersOf over the league's slots). blocked: ids never picked
 * (Nick's never-get list, a player he sold).
 * Each spot takes the free agent that raises the lineup most, ties to the higher ros_ppg, then the id.
 * -> { status: 'ok' | 'no_lineup' | 'no_spot' | 'empty_wire', spots, fills: [{ id, position, ros_ppg }],
 *      lineup_ppg_gain, bench_ppg, unfilled }
 */
export function rosterSpotValue({ roster, freeAgents, lineupPpg, spots = 1, blocked = new Set() }) {
  const base = { spots, fills: [], lineup_ppg_gain: null, bench_ppg: null, unfilled: Math.max(0, spots) };
  if (typeof lineupPpg !== 'function') return { status: 'no_lineup', ...base };
  if (!(spots > 0)) return { status: 'no_spot', ...base, lineup_ppg_gain: 0, bench_ppg: 0, unfilled: 0 };
  const pool = (freeAgents ?? []).filter(f => f && SCORED.has(f.position) && finite(f.ros_ppg) && f.ros_ppg > 0
    && f.available !== false && !blocked.has(S(f.id)));
  if (!pool.length) return { status: 'empty_wire', ...base };
  const before = lineupPpg(roster);
  let cur = [...roster];
  const fills = [];
  for (let i = 0; i < spots; i++) {
    const held = new Set(cur.map(p => S(p.id)));
    let pick = null, pickPts = -Infinity;
    for (const fa of pool) {
      if (held.has(S(fa.id))) continue;
      const pts = lineupPpg([...cur, fa]);
      if (pts > pickPts || (pts === pickPts && (fa.ros_ppg > pick.ros_ppg || (fa.ros_ppg === pick.ros_ppg && S(fa.id) < S(pick.id))))) {
        pick = fa; pickPts = pts;
      }
    }
    if (!pick) break;
    cur = [...cur, pick];
    fills.push({ id: S(pick.id), position: pick.position, ros_ppg: r2(pick.ros_ppg) });
  }
  return { status: 'ok', spots, fills, lineup_ppg_gain: r2(lineupPpg(cur) - before),
    bench_ppg: r2(fills.reduce((s, f) => s + f.ros_ppg, 0)), unfilled: spots - fills.length };
}

/** A fresh report: every counter at zero. */
function newReport(mode) {
  return { mode, status: 'ok', reason: null, screened: 0, rescored: 0, confirm_rescored: 0,
    dropped: { his_screen: 0, overpay: 0, lineup_points: 0, title_odds: 0, rules: {}, trade_memory: 0,
      confirm_lineup_points: 0, confirm_title_odds: 0 },
    rows: [], found: 0, roster_spot_now: null, budget: CONSOLIDATION_BUDGET, pass_bar: CONSOLIDATION_PASS_BAR,
    basis: 'shadow: nothing served reads this; title and lineup deltas on the planner dice, then the confirm dice; roster spot on ros_ppg (no dice)' };
}

/**
 * The finder. Pure over its inputs; every rescore goes through the planner's scorers.
 * ctx: {
 *   mode,            consolidationFlag(env)
 *   adapter,         the planner's adapter (after withNeverGive): league, rosters, players, managers,
 *                    untouchable, freeAgents, lineupPpg?
 *   S, S2,           makeScorer on the planner dice and on the confirm dice (S2 null: fails closed)
 *   board,           search.js#boardOf(adapter) (null: fails closed)
 *   vals,            playerValues (addN, lossN): the linear order candidates are rescored in
 *   depthPremium,    the CAP-1C premium (<= 0.12); 0 turns it off
 *   excludedTeam,    partners.js#excluded over a manager
 *   soldOut(id),     trade memory: a player Nick sold this season (no buy-backs)
 *   stepOk(step),    trade memory's stepPasses for { team, give, get }
 *   ledgerMissing,   the planner's fail-closed flag for an unread trade ledger
 *   budget?          overrides of CONSOLIDATION_BUDGET
 * }
 */
export function findConsolidations(ctx) {
  const { mode = 'shadow', adapter, S: Sc, S2, board, vals, depthPremium = 0,
    excludedTeam = () => false, soldOut = () => false, stepOk = () => true, ledgerMissing = false } = ctx;
  const budget = { ...CONSOLIDATION_BUDGET, ...(ctx.budget ?? {}) };
  const out = newReport(mode);
  const me = adapter.league.me;
  const untouchable = new Set([...(adapter.untouchable ?? [])].map(S));
  const valueOf = id => { const v = adapter.players.get(id)?.value; return v != null && finite(Number(v)) && Number(v) > 0 ? Number(v) : null; };
  const posOf = id => adapter.players.get(id)?.position ?? null;
  const scoreOf = id => { const s = board?.get(S(id)); return s == null ? null : s; };
  const myRoster = adapter.rosters.get(me) ?? [];

  // ROSTER-SPOT VALUE on today's roster: one open spot, whatever the finder finds.
  const playerObj = id => { const p = adapter.players.get(id); return p ? { id, position: p.position, ros_ppg: p.ros_ppg } : null; };
  // Never picked from the wire: a pinned never-get, an untouchable, a player Nick sold this season, or one he holds.
  const soldFas = (adapter.freeAgents ?? []).filter(f => soldOut(f.id)).map(f => S(f.id));
  const spotBlocked = ids => new Set([...untouchable, ...PINNED_NEVER_GET, ...soldFas, ...ids.map(S)]);
  out.roster_spot_now = rosterSpotValue({ roster: myRoster.map(playerObj).filter(Boolean), freeAgents: adapter.freeAgents,
    lineupPpg: adapter.lineupPpg, spots: 1, blocked: spotBlocked(myRoster) });

  const fail = (status, reason) => ({ ...out, status, reason });
  if (!board) return fail('no_board', 'no blue-chip board: depth and the Blue chip floor cannot be checked');
  if (ledgerMissing) return fail('ledger_missing', 'executed trades exist but the trade ledger is unread: no buy-back check');
  if (!S2) return fail('no_confirm_dice', 'the confirm world failed: nothing can be checked on fresh dice');

  // The one rule gate, fed from the planner's own sets.
  const fc = new Map();
  for (const [id] of adapter.players) { const v = valueOf(id); if (v != null) fc.set(S(id), v); }
  const rules = {
    neverGive: new Set([...PINNED_NEVER_GIVE, ...myRoster.map(S).filter(id => untouchable.has(id))]),
    neverGet: new Set([...PINNED_NEVER_GET, ...[...untouchable].filter(id => !myRoster.some(x => S(x) === id))]),
    sold: { has: id => !!soldOut(id) },
    fc, scoreOf, closed: null,
  };

  // Nick's depth: scored below the floor, priced, a scored position, never untouchable or pinned.
  const depth = myRoster.filter(id => SCORED.has(posOf(id)) && valueOf(id) != null && isDepth(id, { board, untouchable }));
  // Their Blue chips: priced, 83+, not untouchable, not sold by Nick, on a team he can trade with.
  const gets = [];
  for (const [team, ids] of adapter.rosters) {
    if (S(team) === S(me) || excludedTeam(adapter.managers.get(team))) continue;
    for (const id of ids) {
      if (!SCORED.has(posOf(id)) || valueOf(id) == null || untouchable.has(S(id)) || soldOut(id)) continue;
      const s = scoreOf(id);
      if (s != null && s >= BLUE_CHIP_SCORE) gets.push({ id, team });
    }
  }
  const lin = (give, get) => (vals?.addN?.get(get) ?? 0) - give.reduce((s, id) => s + (vals?.lossN?.get(id) ?? 0), 0);
  const topGets = gets.sort((a, b) => (vals?.addN?.get(b.id) ?? 0) - (vals?.addN?.get(a.id) ?? 0)).slice(0, budget.gets);

  // Screen every package arithmetically: fair on his screen, inside the cap (or the premium for a 2-for-1).
  const packs = combos(depth, Math.min(3, budget.maxGive)).filter(c => c.length >= 2);
  const pool = [];
  for (const g of topGets) {
    const v = valueOf(g.id);
    for (const give of packs) {
      out.screened++;
      const gv = give.reduce((s, id) => s + valueOf(id), 0);
      // His screen: what he gets (Nick's give) vs what he gives, inside the finder's window.
      const hisPct = ((gv - v) / v) * 100;
      if (hisPct < SCREEN_WINDOW.low || hisPct > SCREEN_WINDOW.high) { out.dropped.his_screen++; continue; }
      const over = overpayPct(gv, v);
      // Nick's cap: 0, or the premium on a 2-for-1 (every give is depth already). A looser max_overpay never applies here.
      const cap = give.length === 2 && depthPremium > 0 ? Math.min(depthPremium, DEPTH_PREMIUM_MAX) : 0;
      if (over > cap + 1e-9) { out.dropped.overpay++; continue; }
      pool.push({ team: g.team, give, get: [g.id], give_value: gv, get_value: v, overpay: over, est: lin(give, g.id) });
    }
  }
  pool.sort((a, b) => b.est - a.est || a.overpay - b.overpay);

  const found = [];
  for (const c of pool) {
    if (out.rescored >= budget.candidates) break;
    const step = { team: c.team, give: c.give, get: c.get };
    // Trade memory before any dice: a buy-back or a reversal is never priced.
    if (!stepOk(step)) { out.dropped.trade_memory++; continue; }
    out.rescored++;
    const r = Sc.rescore(Sc.applyTrade(new Map(), me, c.team, c.give, c.get), me, c.team).me;
    const h = premiumHolds(r, null);
    if (!h.ok) { out.dropped[h.why === 'title_odds' ? 'title_odds' : 'lineup_points']++; continue; }
    const verdict = ruleVerdict(rules, { give: c.give, get: c.get, premium: { points_delta: h.points_delta, title_delta: h.title_delta } });
    if (!verdict.ok) { for (const why of verdict.reasons) out.dropped.rules[why] = (out.dropped.rules[why] ?? 0) + 1; continue; }
    out.confirm_rescored++;
    const r2d = S2.rescore(S2.applyTrade(new Map(), me, c.team, c.give, c.get), me, c.team).me;
    const h2 = premiumHolds(r2d, null);
    // The premium's condition on fresh dice (ruleVerdict above only reads whether both rose, so it holds here too).
    if (!h2.ok) { out.dropped[h2.why === 'title_odds' ? 'confirm_title_odds' : 'confirm_lineup_points']++; continue; }
    const after = [...myRoster.filter(id => !c.give.includes(id)), ...c.get].map(playerObj).filter(Boolean);
    found.push({
      team: S(c.team), give: c.give.map(S), get: c.get.map(S), shape: `${c.give.length}-for-1`,
      give_value: Math.round(c.give_value), get_value: Math.round(c.get_value), overpay_pct: r5(c.overpay),
      premium: c.overpay > 1e-9,
      points_delta: r2(h.points_delta), title_delta: r5(h.title_delta), title_se: r5(r.title_delta_se ?? null),
      confirm: { points_delta: r2(h2.points_delta), title_delta: r5(h2.title_delta), title_se: r5(r2d.title_delta_se ?? null),
        over_1se: finite(r2d.title_delta_se) && r2d.title_delta_se > 0 ? h2.title_delta > r2d.title_delta_se : null },
      roster_spot: rosterSpotValue({ roster: after, freeAgents: adapter.freeAgents, lineupPpg: adapter.lineupPpg,
        spots: c.give.length - c.get.length, blocked: spotBlocked([...myRoster, ...c.get]) }),
    });
  }
  out.rows = found.sort((a, b) => b.confirm.title_delta - a.confirm.title_delta || b.confirm.points_delta - a.confirm.points_delta)
    .slice(0, budget.rows);
  out.found = found.length;
  return out;
}
