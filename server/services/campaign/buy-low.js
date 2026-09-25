/**
 * BUY-LOW (Project queue item 22): players whose usage is up but whose points are down.
 *
 * ONE producer for the buy-low number. Per player, as of week W of season S, from weeks < W only:
 *   - xFP per game: nflverse ffopportunity expected_fantasy_points (full PPR). It already prices
 *     targets, carries, air yards and red-zone location, so it is reused, not rebuilt.
 *   - usage per game: WR/TE target share; RB carries + 2.5 x targets (an RB target is worth about
 *     2.5 carries); QB xFP.
 *   - role change: a game is "usage up" against the player's earlier games this season (or last
 *     season when fewer than 2). One game DETECTS a role change, 2+ of the last 3 CONFIRM it.
 *   - gap: mean (xFP - actual) over the last 3 games, shrunk toward 0 by n / (n + 2).
 *     Both actual and expected points enter (actual PPG explains more than xPPG alone).
 * Flag: role change AND shrunk gap >= 2 pts/game, among players averaging 5+ xFP.
 *
 * Frozen by docs/tdd/BUY-LOW-PREREG.md (rule version 1). SHADOW behind GRIDIRON_BUY_LOW
 * (own flag, default off, never via preview). On, a Go get target carries a buy_low field and
 * target ordering may use it as a tie-breaker only: it never adds, drops or re-ranks a target
 * across a different rank score, so Nick's rules (never-give.js) and the 83+ floor are untouched.
 */

export const BUY_LOW_ENV = 'GRIDIRON_BUY_LOW';
/** TE is served only with its own flag: its backtest had too few rows to pass (27 < 30). */
export const BUY_LOW_TE_ENV = 'GRIDIRON_BUY_LOW_TE';
/**
 * Position-aware, explicit '1' only; preview mode never turns either on.
 * GRIDIRON_BUY_LOW=1 serves QB/RB/WR (the positions whose pre-registered CI cleared 0);
 * GRIDIRON_BUY_LOW_TE=1 adds TE. Neither: [] (off).
 */
export function buyLowPositions(env = {}) {
  return [...(env?.[BUY_LOW_ENV] === '1' ? BUY_LOW_RULE.served_positions : []), ...(env?.[BUY_LOW_TE_ENV] === '1' ? ['TE'] : [])];
}
/** Whether the read runs at all (either flag). */
export const buyLowEnabled = (env = {}) => buyLowPositions(env).length > 0;

export const BUY_LOW_RULE = Object.freeze({
  version: 1,
  prereg: 'docs/tdd/BUY-LOW-PREREG.md',
  window: 3,
  min_baseline_games: 2,
  shrink_games: 2,
  min_gap_ppg: 2.0,
  min_xfp_ppg: 5,
  rb_target_weight: 2.5,
  last_regular_week: 18,
  // A game is "usage up" when usage minus the baseline mean is at least this much.
  usage_up: Object.freeze({ WR: 0.03, TE: 0.03, RB: 2.0, QB: 2.0 }),
  // Positions whose pre-registered CI lower bound cleared 0 (docs/tdd/BUY-LOW-results.md). Only these
  // are served or break ties; TE (27 rows, too few) is read and listed in shadow only.
  served_positions: Object.freeze(['QB', 'RB', 'WR']),
});

/** A read that may be served / break a tie: flagged, at a served position (default: the ones the backtest passed). */
export const servedRead = (r, positions = BUY_LOW_RULE.served_positions) => r?.buy_low === true && positions.includes(r.position);

const finite = x => typeof x === 'number' && Number.isFinite(x);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** One game's usage for a position, or null when the game has no usage read. */
export function usageOf(position, g) {
  if (position === 'WR' || position === 'TE') return finite(g.target_share) ? g.target_share : null;
  if (position === 'RB') {
    return finite(g.carries) && finite(g.targets) ? g.carries + BUY_LOW_RULE.rb_target_weight * g.targets : null;
  }
  if (position === 'QB') return finite(g.xfp) ? g.xfp : null;
  return null;
}

/** Games strictly before week `week` of `season` (and last season's), regular season only. */
export function priorGames(games, { season, week }) {
  return (games ?? []).filter(g => finite(g?.season) && finite(g?.week) && g.week <= BUY_LOW_RULE.last_regular_week
    && (g.season === season - 1 || (g.season === season && g.week < week)) && finite(g.xfp) && finite(g.act));
}

/** The shrunk gap: a prior of 0 worth `shrink_games` games. */
export const shrinkGap = (gap, n) => (finite(gap) && n > 0 ? gap * n / (n + BUY_LOW_RULE.shrink_games) : 0);

/**
 * Score one player as of week `week` of `season`. games: [{ season, week, xfp, act, target_share,
 * carries, targets }]; anything at or after the as-of week is ignored (never read).
 * Returns { status, role, buy_low, score, gap, gap_shrunk, games, xfp_ppg, act_ppg, usage_delta, ups }.
 * status: 'ok' | 'no_games' | 'no_baseline' | 'no_usage_rule'.
 */
export function scoreBuyLow({ position, games }, { season, week }) {
  const R = BUY_LOW_RULE;
  const none = status => ({ status, position, role: 'none', buy_low: false, score: 0 });
  if (!(position in R.usage_up)) return none('no_usage_rule');
  const prior = priorGames(games, { season, week });
  const cur = prior.filter(g => g.season === season).sort((a, b) => a.week - b.week);
  const T = cur.slice(-R.window);
  if (!T.length) return none('no_games');
  let B = cur.slice(0, cur.length - T.length);
  if (B.length < R.min_baseline_games) B = prior.filter(g => g.season === season - 1);
  const baseU = B.map(g => usageOf(position, g)).filter(finite);
  if (B.length < R.min_baseline_games || baseU.length < R.min_baseline_games) return none('no_baseline');
  const base = mean(baseU);
  const tU = T.map(g => usageOf(position, g));
  const ups = tU.map(u => finite(u) && u - base >= R.usage_up[position]);
  const nUp = ups.filter(Boolean).length;
  const role = nUp >= 2 ? 'confirmed' : ups[ups.length - 1] ? 'detected' : 'none';
  const n = T.length;
  const xfpPpg = mean(T.map(g => g.xfp));
  const actPpg = mean(T.map(g => g.act));
  const gap = xfpPpg - actPpg;
  const gapShrunk = shrinkGap(gap, n);
  const eligible = xfpPpg >= R.min_xfp_ppg;
  const buyLow = eligible && role !== 'none' && gapShrunk >= R.min_gap_ppg;
  const tMean = mean(tU.filter(finite));
  return {
    status: 'ok', position, role, buy_low: buyLow, score: buyLow ? gapShrunk : 0, eligible,
    gap, gap_shrunk: gapShrunk, games: n, xfp_ppg: xfpPpg, act_ppg: actPpg,
    usage_delta: finite(tMean) ? tMean - base : null, ups: nUp, through_week: T[T.length - 1].week,
  };
}

const r1 = x => (finite(x) ? Math.round(x * 10) / 10 : null);
const r3 = x => (finite(x) ? Math.round(x * 1000) / 1000 : null);

/** The served buy_low value for a flagged player (plans-schema.js target.buy_low), or null. */
export function buyLowRow(read, positions) {
  if (!servedRead(read, positions)) return null;
  return { role: read.role, points_below_expected: r1(read.gap_shrunk), games: read.games,
    usage_change: r3(read.usage_delta), through_week: read.through_week };
}

const scoreOfRead = (r, positions) => (servedRead(r, positions) ? r.score : 0);

/**
 * Tie-breaker only: suggestions are already sorted by rank_score (planner.js). Among rows whose
 * rank_score is exactly equal, a buy-low player goes first (bigger shrunk gap first). Rows with a
 * different rank_score never swap, and nothing is added or dropped. Returns a new array and the
 * number of rows whose position moved.
 */
export function tieBreakSuggestions(suggestions, reads, positions) {
  const list = suggestions ?? [];
  const idx = new Map(list.map((s, i) => [s, i]));
  const sc = s => scoreOfRead(reads?.get(String(s.player)), positions);
  const out = [...list].sort((a, b) => (b.rank_score - a.rank_score) || (sc(b) - sc(a)) || (idx.get(a) - idx.get(b)));
  const moved = out.filter((s, i) => s !== list[i]).length;
  return { suggestions: out, moved };
}

/**
 * Apply BUY-LOW to one league's run. reads: Map String(player id) -> scoreBuyLow result for the
 * suggestion ids and every other-roster player. Mutates nothing it is given.
 *   res   -> { ...res, suggestions } with the tie-break applied and each suggestion's buy_low
 *   summary (for _run.inputs.buy_low): counts, flagged target ids, the other rosters' top reads.
 * floorOf(id): whether a player clears Nick's Blue chip floor (null when unknown); shown, never used to add.
 */
export function applyBuyLow(res, reads, { others = [], floorOf = () => null, top = 10, positions = BUY_LOW_RULE.served_positions } = {}) {
  const { suggestions, moved } = tieBreakSuggestions(res.suggestions, reads, positions);
  const withField = suggestions.map(s => {
    const row = buyLowRow(reads.get(String(s.player)), positions);
    return row ? { ...s, buy_low: row } : s;
  });
  const statusCounts = {};
  for (const r of reads.values()) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  const board = others.map(String).map(id => ({ id, r: reads.get(id) })).filter(x => x.r?.buy_low)
    .sort((a, b) => (b.r.score - a.r.score) || a.id.localeCompare(b.id));
  const summary = {
    flag: 'on', positions: [...positions], rule_version: BUY_LOW_RULE.version, prereg: BUY_LOW_RULE.prereg,
    read: reads.size, by_status: statusCounts,
    targets_flagged: withField.filter(s => s.buy_low).map(s => String(s.player)),
    tie_break_moved: moved,
    others_flagged: board.length,
    others_top: board.slice(0, top).map(({ id, r }) => ({ player: id, position: r.position, served: servedRead(r, positions), role: r.role,
      points_below_expected: r1(r.gap_shrunk), games: r.games, passes_floor: floorOf(id) })),
  };
  return { res: { ...res, suggestions: withField }, summary };
}

/**
 * One league run, flag on: read every other-roster player plus the suggestions, apply the tie-break.
 * adapter.buyLow(ids) -> { reads, sources } (league-adapter.mjs, buy-low-inputs.js#readBuyLow).
 * A reader fault is recorded as status 'error' on the summary and logged by the caller; the plan
 * is then served exactly as planned (shadow must never kill a league).
 */
export function buyLowForRun(res, adapter, { floor = 83, positions = BUY_LOW_RULE.served_positions } = {}) {
  const me = String(res.me ?? adapter.league?.me);
  const others = [...(adapter.rosters ?? [])].filter(([t]) => String(t) !== me).flatMap(([, ids]) => ids.map(String));
  const ids = [...new Set([...others, ...(res.suggestions ?? []).map(s => String(s.player))])];
  let read;
  try { read = adapter.buyLow(ids); } catch (e) {
    return { res, reads: new Map(), summary: { flag: 'on', status: 'error', reason: String(e?.message ?? e) } };
  }
  const floorOf = id => {
    const r = typeof adapter.scoreOf === 'function' ? adapter.scoreOf(id) : null;
    return r?.score == null || !finite(Number(r.score)) ? null : Number(r.score) >= floor;
  };
  const out = applyBuyLow(res, read.reads, { others, floorOf, positions });
  return { res: out.res, reads: read.reads, summary: { status: 'ok', ...out.summary, sources: read.sources } };
}

/**
 * The served entry's targets get the buy_low typed field (a guess: rule v1, not graded as an edge
 * unless the pre-registered backtest passed). entry is returned new; rows without a read are unchanged.
 */
export function annotateEntryTargets(entry, reads, positions) {
  const t = entry?.targets;
  if (t?.status !== 'ok' || !Array.isArray(t.value)) return entry;
  const value = t.value.map(row => {
    const b = buyLowRow(reads.get(String(row.player)), positions);
    return b ? { ...row, buy_low: { status: 'ok', source: 'usage.xfp', unit: 'points_per_week', guess: true, value: b } } : row;
  });
  return { ...entry, targets: { ...t, value } };
}
