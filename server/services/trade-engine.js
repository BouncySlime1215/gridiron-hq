/**
 * The trade engine.
 *
 * Everything here is deterministic — no API key required. The one currency that
 * decides a trade is **starting lineup points**: a roster is only as good as the
 * nine players it can start, so a deal is a win when your optimal lineup projects
 * higher afterwards, regardless of how the raw player values add up. Market price
 * is tracked alongside it as a separate axis, because "did I improve" and "did I
 * get fleeced" are different questions and a good deal answers both.
 *
 * Layers, bottom up:
 *   assets      — every rostered player enriched with projection, market price,
 *                 weekly floor/ceiling, and schedule/DvP context
 *   bestLineup  — optimal-lineup solver over a league's real slot config
 *   evaluate    — score any give/get package for both sides
 *   findTrades  — enumerate and rank realistic deals across the league
 *   offerFor    — "I want this player, what do I give up"
 *   selfScout   — my roster's strengths, holes and fix list
 */
import { rows } from '../db/index.js';
import { vorBoard, volatility } from '../routes/edge.js';
import { deriveFormat } from './format.js';
import { pickInventory } from './picks.js';
import { analyzeLeague } from '../routes/tradelab.js';
import { scheduleOutlook, relevantSplits, matchupModel, PLAYOFF_WEEKS } from './matchups.js';
import { SLOT_NAME } from './espn-draft.js';
import { seasonEndingEspnIds } from './player-availability.js';
import { buildPlayerWeekEngine, playerWeekDistribution } from './player-week-engine.js';
import { weeklyAvailability } from './contingency.js';
import { cached, fingerprint } from './compute-cache.js';
import { scoringFor } from './scoring.js';
import { activeFantasyCoordinatorFit, weeklyExpertValues, coordinateFantasy } from './fantasy-coordinator.js';
import { dynastyAgeAdjustment } from './dynasty-age-curve.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const GAMES = 17;
const SKILL = ['QB', 'RB', 'WR', 'TE'];
const FLEX_ELIGIBLE = { FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
                        SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] };
// Positions we model. K and D/ST are near-random week to week and roughly
// interchangeable, so including them adds noise to every lineup comparison.
const SCORED = new Set(SKILL);

const norm = s => (s ?? '').toLowerCase().replace(/[.'’-]/g, '')
  .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();

/**
 * Real roster context per team: which positions are a genuine need (starter value
 * well below league average) vs. genuine surplus, and each team's contention window
 * (win-now/rebuild/etc). Without this, the finder only knows "does the lineup-points
 * math improve" — it has no idea whether a package would actually gut a team at a
 * spot they can't afford to lose, which is exactly what makes an auto-suggested
 * trade read as fake to someone who knows the league.
 */
function rosterContext(lg) {
  const byRoster = new Map();
  try {
    for (const t of analyzeLeague(lg).teams) {
      byRoster.set(String(t.roster_id), {
        needs: new Set(t.needs.map(n => n.position)),
        surplus: new Set(t.surplus.map(s => s.position)),
        window: t.window
      });
    }
  } catch { /* analyzeLeague needs the same synced payload findTrades already checked for */ }
  return byRoster;
}

/* ------------------------------------------------------------------ assets */

/**
 * Build the enriched player universe for a league.
 *
 * @returns {Map<number, object>} player id -> asset
 */
export function tradeWeekContext() {
  const week = Number(process.env.NFL_WEEK) || rows(`SELECT MIN(week) AS week FROM game_lines
    WHERE season=? AND team_score IS NULL`, SEASON)[0]?.week || 1;
  return { season: SEASON, week: Math.max(1, Math.min(18, Number(week))) };
}

/**
 * The whole player universe, priced — memoised on the data it reads.
 *
 * This is the most expensive pure function in the fantasy half of the app: it
 * builds a weekly projection engine, a VOR board, a volatility table, schedule
 * outlooks and a 400-run distribution per player. One call is fine. The problem
 * is that the league brain makes about a dozen — `brainState`, `brainPlan`,
 * `waiverUpgrades`, `sellHigh`, `positionLiquidity`, and one `selfScout` per
 * team — each rebuilding the identical universe from the identical tables, and
 * the page went from 1.3 to 5.0 seconds as those callers were added.
 *
 * A fingerprint cache rather than a TTL, for the reason compute-cache.js
 * explains: keyed on the row counts and newest timestamps of the tables this
 * actually reads, a hit is not merely fresh enough, it is provably the same
 * answer. A sync changes the fingerprint and the work is redone on the next
 * call; nothing changes and the previous answer was already correct.
 */
export function assetUniverse(lg, formatKey, requested = null) {
  const target = requested ?? tradeWeekContext();
  return cached(
    `assets:${lg.id}:${formatKey}:${target.season}:${target.week}`,
    fingerprint([
      { table: 'players', stamp: 'id' },
      { table: 'roster_players', stamp: 'id' },
      { table: 'dynasty_values', stamp: 'player_id' },
      { table: 'player_week_usage', stamp: 'week' },
      { table: 'nfl_injuries', stamp: 'id' },
      { table: 'game_lines', stamp: 'week' },
      // buildAssetUniverse() also calls seasonEndingEspnIds(), which reads
      // news_items directly — omitted here, a genuine new release/season-ending
      // report (or a fix to how that news is matched) would never invalidate this
      // cache until an unrelated table happened to change, silently continuing
      // to bench an actually-available player.
      { table: 'news_items', stamp: 'id' },
      'trending_players', 'player_metrics', 'schedule_games'
    ], `${lg.id}:${formatKey}:${target.season}:${target.week}`),
    () => buildAssetUniverse(lg, formatKey, target));
}

function buildAssetUniverse(lg, formatKey, target) {
  const scoring = scoringFor(lg);
  // formatKey is `dyn_...`/`rd_...` per deriveFormat (format.js) — the age
  // decay only makes sense for a dynasty/keeper valuation, never redraft.
  const isDynasty = formatKey.startsWith('dyn_');
  const weekly = buildPlayerWeekEngine({ season: target.season, week: target.week, scoring });
  // Read-only, no computation — the coordinator itself is refit on a schedule
  // (scheduler.js#fantasy_coordinator_refit) and persisted; walk-forward
  // verified (fantasy-coordinator.js's own doc-comment) to beat the plain
  // structural+ensemble number it corrects. `ready: false` before the first
  // background refit falls back to exactly today's prior behavior below.
  const fantasyFit = activeFantasyCoordinatorFit();
  const active = weeklyAvailability(target.season, target.week, { through: target.season - 1 });
  const board = new Map(vorBoard(lg.team_count || 12).map(p => [p.id, p]));
  const vol = volatility();
  const market = new Map(rows(
    'SELECT player_id, value, age, trend30, pos_rank FROM dynasty_values WHERE format_key = ?', formatKey)
    .map(d => [d.player_id, d]));
  const ageByPlayer = new Map(rows(`SELECT p.id, rp.age FROM players p
                                    JOIN roster_players rp ON rp.espn_id = p.espn_id
                                    WHERE rp.age IS NOT NULL`).map(x => [x.id, x.age]));
  const injured = new Set(rows(`SELECT player_id FROM player_metrics WHERE source='injury_flag' AND value > 0`)
    .map(x => x.player_id));
  // Same season-ending/released detection the X's&O's depth chart uses — without
  // this, a player out for the year keeps getting picked as the optimal starter
  // here even after the roster page correctly benches him.
  const seasonEnding = seasonEndingEspnIds();
  const trending = new Map(rows('SELECT player_id, kind, count FROM trending_players')
    .map(t => [t.player_id, t]));

  const out = new Map();
  for (const p of rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, p.gsis_id, t.abbr AS team_abbr
                        FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id`)) {
    const v = board.get(p.id), w = vol.get(p.id), m = market.get(p.id);
    const dynastyAge = isDynasty && m?.value != null
      ? dynastyAgeAdjustment({
          position: p.position, rawValue: m.value, gsisId: p.gsis_id,
          rosterSnapshotAge: ageByPlayer.get(p.id) ?? m.age ?? null
        })
      : null;
    const weekProjection = weekly.get(p.id);
    const proj = v?.proj ?? 0;
    const sched = p.team_abbr && SCORED.has(p.position)
      ? scheduleOutlook(p.team_abbr, p.position, target.week)
      : { sos: 1, playoff_sos: 1, bye: null, best: [], worst: [], playoff_games: [] };
    const tr = trending.get(p.id);
    const availability = active.get(p.id);
    const activeProbability = availability?.active_probability ?? 0.92;
    const weeklyPpg = weekProjection?.ppg ?? (proj / GAMES);
    const thisGame = sched.games?.find(game => game.week === target.week) ?? null;
    // The coordinator only corrects THIS week's number (ensemble_shift and
    // game-script are both week-specific signals) — weeklyPpg itself, used
    // below for ROS/season-long figures, is untouched: the coordinator was
    // only walk-forward validated against weekly outcomes, not season totals.
    const expertValues = weekProjection ? weeklyExpertValues(weekProjection, target.season, target.week, scoring) : null;
    const coordinated = expertValues ? coordinateFantasy(fantasyFit, expertValues, weeklyPpg) : null;
    const currentWeekBasePpg = coordinated?.ready ? coordinated.corrected_ppg : weeklyPpg;
    const currentWeekPpg = thisGame ? currentWeekBasePpg * thisGame.mult * activeProbability : 0;
    const rosPpg = weeklyPpg * sched.sos;
    // A trade is a rest-of-season decision, not DFS. The live week matters, but
    // it cannot erase the remaining schedule or turn a bye into a player-value
    // collapse. The weekly engine itself refreshes from every completed week.
    const decisionPpg = 0.25 * currentWeekPpg + 0.75 * rosPpg;
    const weekDist = weekProjection
      ? playerWeekDistribution(weekProjection, { runs: 400, activeProbability, mult: thisGame?.mult ?? 1 })
      : null;

    out.set(p.id, {
      id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
      espn_id: p.espn_id, sleeper_id: p.sleeper_id,
      proj: +(weeklyPpg * Math.max(1, 18 - target.week)).toFixed(1),
      ppg: +weeklyPpg.toFixed(2),
      vor: v?.vor ?? 0,
      adp: v?.adp ?? null,
      value: m?.value ?? 0,
      trend30: m?.trend30 ?? null,
      pos_rank: m?.pos_rank ?? null,
      age: m?.age ?? ageByPlayer.get(p.id) ?? null,
      // Additive, inspectable age-curve decay on top of the raw FantasyCalc
      // dynasty price (4for4 2025 "Production Curves") — null for non-dynasty
      // formats or players FantasyCalc has no dynasty price for. `value` above
      // is left untouched (still the raw market pass-through every other
      // consumer of this universe already relies on); this is a separate,
      // explicit view onto the same player. See dynasty-age-curve.js.
      dynasty_value_raw: dynastyAge?.raw_value ?? null,
      dynasty_value_age_adjusted: dynastyAge?.adjusted_value ?? null,
      dynasty_age_decay: dynastyAge ? {
        multiplier: dynastyAge.multiplier, age: dynastyAge.age, age_source: dynastyAge.age_source,
        source: dynastyAge.source ?? null
      } : null,
      // Weekly shape from real boxscores — this is what separates two players who
      // project for the same total.
      floor: weekDist?.p10 ?? w?.floor ?? null, ceiling: weekDist?.p90 ?? w?.ceiling ?? null, avg: weekDist?.mean ?? w?.avg ?? null,
      boom: weekDist?.boom_rate ?? w?.boom_rate ?? null, bust: weekDist?.bust_rate ?? w?.bust_rate ?? null,
      consistency: w?.consistency ?? null, logged_games: w?.games ?? null,
      injury: injured.has(p.id) || !!(availability?.report_status && !/probable/i.test(availability.report_status)) ? 1 : 0,
      available: !(p.espn_id && seasonEnding.has(p.espn_id)),
      trend_kind: tr?.kind ?? null, trend_count: tr?.count ?? null,
      // Schedule-adjusted: the number the lineup solver actually optimises.
      sos: sched.sos, playoff_sos: sched.playoff_sos, bye: sched.bye,
      adj_ppg: +decisionPpg.toFixed(2),
      current_week_ppg: +currentWeekPpg.toFixed(2),
      // Transparency for the correction folded into current_week_ppg above —
      // null when no fit is persisted yet (fantasy_coordinator_refit hasn't
      // run) or this player has no weekly projection to correct.
      fantasy_coordinator: coordinated?.ready
        ? { corrected_ppg: coordinated.corrected_ppg, correction: coordinated.correction, contributions: coordinated.contributions }
        : null,
      ros_ppg: +rosPpg.toFixed(2),
      active_probability: +activeProbability.toFixed(3),
      injury_status: availability?.report_status ?? null,
      practice_status: availability?.practice_status ?? null,
      model_cutoff: weekProjection?.player_week_engine?.cutoff ?? `${target.season}-W${Math.max(0, target.week - 1)}`,
      model_mode: weekProjection?.player_week_engine?.mode ?? 'season_projection_fallback',
      role_change: weekProjection?.player_week_engine?.role_change ?? null,
      matchup: thisGame,
      playoff_ppg: +(weeklyPpg * sched.playoff_sos).toFixed(2),
      best_matchups: sched.best, worst_matchups: sched.worst,
      playoff_games: sched.playoff_games
    });
  }
  out.context = {
    season: target.season, week: target.week,
    cutoff: `${target.season}-W${Math.max(0, target.week - 1)}`,
    engine: 'player-week-v2.1 + weekly availability + current/remaining schedule',
    decision_horizon: '25% current week, 75% rest-of-season rate; dynasty market value remains a separate price axis'
  };
  return out;
}

/* ----------------------------------------------------------------- rosters */

/** League rosters as arrays of enriched assets, keyed the same way for both platforms. */
export function loadRosters(lg, assets) {
  const payload = JSON.parse(lg.payload);
  const byKey = new Map(), bySleeper = new Map(), byEspn = new Map();
  for (const a of assets.values()) {
    byKey.set(`${norm(a.name)}|${a.position}`, a);
    if (a.sleeper_id) bySleeper.set(String(a.sleeper_id), a);
    if (a.espn_id) byEspn.set(String(a.espn_id), a);
  }

  const teams = [];
  if (lg.platform === 'sleeper') {
    const users = Object.fromEntries((payload.users ?? []).map(u => [u.user_id, u]));
    for (const ro of payload.rosters ?? []) {
      const u = users[ro.owner_id];
      teams.push({
        roster_id: String(ro.roster_id),
        owner: u?.metadata?.team_name || u?.display_name || `Team ${ro.roster_id}`,
        players: (ro.players ?? []).map(sid => bySleeper.get(String(sid))).filter(Boolean)
      });
    }
  } else {
    const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
    for (const t of payload.teams ?? []) {
      teams.push({
        roster_id: String(t.id),
        owner: t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`,
        players: (t.roster?.entries ?? []).map(e => {
          const pl = e.playerPoolEntry?.player;
          if (!pl) return null;
          return byEspn.get(String(pl.id)) ?? byKey.get(`${norm(pl.fullName)}|${POS[pl.defaultPositionId] ?? ''}`);
        }).filter(Boolean)
      });
    }
  }
  return teams;
}

/** Starting slots for this league, defaulted sanely when the sync didn't record them. */
export function lineupSlots(lg) {
  const rp = lg.roster_positions ? JSON.parse(lg.roster_positions)
    : ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
  return rp.filter(s => SCORED.has(s) || FLEX_ELIGIBLE[s]);
}

/* -------------------------------------------------------- lineup optimiser */

/**
 * Best possible starting lineup from a set of players.
 *
 * Fills dedicated slots with the top players at each position, then flex slots from
 * whatever is left. That greedy order is optimal here because flex eligibility is a
 * superset of the dedicated slots it competes with — no dedicated slot can ever be
 * better served by a player the flex already took.
 *
 * @param key which projection to optimise: 'adj_ppg' (season) or 'playoff_ppg'
 */
export function bestLineup(players, slots, key = 'adj_ppg') {
  // Season-ending/released players (see player-availability.js) never fill a
  // starting slot — but they still belong on the bench list, not vanished
  // entirely, so the roster view can show why that slot moved to someone else.
  const eligible = players.filter(p => SCORED.has(p.position));
  const pool = eligible.filter(p => p.available !== false).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
  const used = new Set();
  const filled = [];

  for (const slot of slots.filter(s => SCORED.has(s))) {
    const pick = pool.find(p => !used.has(p.id) && p.position === slot);
    if (pick) used.add(pick.id);
    filled.push({ slot, player: pick ?? null });
  }
  for (const slot of slots.filter(s => FLEX_ELIGIBLE[s])) {
    const ok = FLEX_ELIGIBLE[slot];
    const pick = pool.find(p => !used.has(p.id) && ok.includes(p.position));
    if (pick) used.add(pick.id);
    filled.push({ slot, player: pick ?? null });
  }

  const points = filled.reduce((s, f) => s + (f.player?.[key] ?? 0), 0);
  return {
    points: +points.toFixed(2),
    slots: filled,
    bench: eligible.filter(p => !used.has(p.id)),
    holes: filled.filter(f => !f.player).map(f => f.slot)
  };
}

/**
 * Weekly floor and ceiling of a lineup, from each starter's observed distribution.
 * Two rosters can project identically and have very different variance; a Win-now
 * team wants floor, a longshot wants ceiling.
 */
export function lineupSpread(lineup) {
  const starters = lineup.slots.map(s => s.player).filter(Boolean);
  const withData = starters.filter(p => p.floor != null);
  if (!withData.length) return { floor: null, ceiling: null, coverage: 0 };
  const scale = starters.length / withData.length;   // extrapolate over unlogged starters
  return {
    floor: +(withData.reduce((s, p) => s + p.floor, 0) * scale).toFixed(1),
    ceiling: +(withData.reduce((s, p) => s + p.ceiling, 0) * scale).toFixed(1),
    coverage: +(withData.length / starters.length).toFixed(2)
  };
}

/* ------------------------------------------------------------- evaluation */

const verdictFor = (ppgDelta, valueDelta) => {
  if (ppgDelta >= 2.5) return 'clear win';
  if (ppgDelta >= 0.8) return 'win';
  if (ppgDelta > -0.8) return valueDelta > 0 ? 'even (value edge)' : 'even';
  if (ppgDelta > -2.5) return 'loss';
  return 'clear loss';
};

/**
 * Score one concrete package from both sides.
 *
 * @param a {{team, gives: asset[]}}  @param b {{team, gives: asset[]}}
 * @param ctx {{theirNeeds?: Set<string>, theirWindow?: object}} real roster context
 *   for team b, from rosterContext() — lets the plausibility check see whether this
 *   package actually makes sense for them, not just whether the numbers pencil out.
 */
export function evaluate(a, b, slots, ctx = {}) {
  const side = (team, gives, gets) => {
    const after = team.players.filter(p => !gives.some(g => g.id === p.id)).concat(gets);
    const before = bestLineup(team.players, slots);
    const post = bestLineup(after, slots);
    const bMonth = bestLineup(team.players, slots, 'playoff_ppg');
    const pMonth = bestLineup(after, slots, 'playoff_ppg');
    const valueOut = gives.reduce((s, p) => s + Math.max(0, p.value), 0);
    const valueIn = gets.reduce((s, p) => s + Math.max(0, p.value), 0);
    const spreadBefore = lineupSpread(before), spreadAfter = lineupSpread(post);

    return {
      roster_id: team.roster_id, owner: team.owner,
      gives: gives.map(slim), gets: gets.map(slim),
      lineup_before: before.points, lineup_after: post.points,
      ppg_delta: +(post.points - before.points).toFixed(2),
      season_delta: +((post.points - before.points) * GAMES).toFixed(1),
      playoff_ppg_delta: +(pMonth.points - bMonth.points).toFixed(2),
      value_out: valueOut, value_in: valueIn, value_delta: valueIn - valueOut,
      roster_spots: gets.length - gives.length,
      floor_delta: spreadBefore.floor != null && spreadAfter.floor != null
        ? +(spreadAfter.floor - spreadBefore.floor).toFixed(1) : null,
      ceiling_delta: spreadBefore.ceiling != null && spreadAfter.ceiling != null
        ? +(spreadAfter.ceiling - spreadBefore.ceiling).toFixed(1) : null,
      new_holes: post.holes,
      verdict: verdictFor(post.points - before.points, valueIn - valueOut)
    };
  };

  const A = side(a.team, a.gives, b.gives);
  const B = side(b.team, b.gives, a.gives);
  // A deal only gets sent if both sides can tell themselves they won. Joint gain is
  // what makes that possible — it comes from positional scarcity, not from one manager
  // being wrong.
  const joint = +(A.ppg_delta + B.ppg_delta).toFixed(2);
  const theirTotal = B.value_out + B.value_in;
  const theirValuePct = theirTotal ? (B.value_delta / theirTotal) * 100 : 0;
  const bothImprove = A.ppg_delta > 0.15 && B.ppg_delta > 0.15;
  // "Would a real GM take this" is a lower bar than "does the optimal-lineup solver
  // say their projection went up." A team whose tradeable capital is a couple of
  // starters (no scrub depth to sweeten with — exactly the shape of a roster that is
  // stacked at one position and thin at another) will never clear bothImprove, because
  // it has nothing spare to throw in. Real trades routinely go through on fairness
  // alone: a need-for-need swap that is roughly even by market value and doesn't
  // gut the other side's lineup, even if it doesn't strictly improve it. Demanding
  // bothImprove for every suggestion left exactly those teams with zero offers.
  const fairEnough = B.ppg_delta > -1.25 && theirValuePct >= -8;

  // Real roster-fit check: does this package actually make sense for THEM, not just
  // pencil out on lineup points? Pure value/ppg math has no idea a team has zero
  // bench at a position, or that the piece leaving is the one thing holding down a
  // spot they already can't fill — a real GM declines both instantly.
  const redFlags = [];
  const leavesHole = B.new_holes.length > 0;
  if (leavesHole) redFlags.push(`leaves them with no startable ${B.new_holes.join('/')}`);
  const bGivesPos = b.gives.map(p => p.position);
  const aGivesPos = new Set(a.gives.map(p => p.position));
  const hurtsNeed = ctx.theirNeeds
    ? [...new Set(bGivesPos.filter(pos => ctx.theirNeeds.has(pos) && !aGivesPos.has(pos)))]
    : [];
  if (hurtsNeed.length) redFlags.push(`digs into their already-thin ${hurtsNeed.join('/')}`);
  // A need-position piece can still move if it clearly helps their lineup overall
  // (real teams do sell from a weak spot for a bigger upgrade elsewhere) — it's only
  // disqualifying when it ALSO doesn't net them anything, which is exactly the
  // "why would they ever do this" shape a value-only optimizer can't see.
  const brokenForThem = leavesHole || (hurtsNeed.length > 0 && !bothImprove);

  return {
    me: A, them: B, joint_ppg: joint,
    mutual: bothImprove,
    plausible: !brokenForThem && (bothImprove || fairEnough),
    red_flags: redFlags,
    their_window: ctx.theirWindow ?? null,
    their_value_pct: +theirValuePct.toFixed(1),
    fairness: fairnessLabel(A.value_delta, A.value_out + A.value_in)
  };
}

const slim = p => ({
  id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
  espn_id: p.espn_id, sleeper_id: p.sleeper_id,
  value: p.value, proj: p.proj, ppg: p.ppg, adj_ppg: p.adj_ppg,
  age: p.age, bye: p.bye, injury: p.injury, available: p.available !== false,
  floor: p.floor, ceiling: p.ceiling, consistency: p.consistency,
  sos: p.sos, playoff_sos: p.playoff_sos,
  current_week_ppg: p.current_week_ppg, ros_ppg: p.ros_ppg, fantasy_coordinator: p.fantasy_coordinator,
  active_probability: p.active_probability, injury_status: p.injury_status,
  practice_status: p.practice_status, model_cutoff: p.model_cutoff,
  role_change: p.role_change, matchup: p.matchup
});

/**
 * Label the *shape* of a deal, not just its grade — "clears the bar" and "why
 * you'd actually make this one" are different questions, and a flat list of
 * fifteen lineup-gain numbers reads as one repetitive idea even when it isn't.
 * Every input here is already computed for the card; this just names the
 * pattern instead of making the manager infer it from raw numbers.
 */
function tagDeal(give, get, ev) {
  const tags = [];
  const avg = (list, key, fallback) => list.length
    ? list.reduce((s, p) => s + (p[key] ?? fallback), 0) / list.length : fallback;
  const youngest = list => Math.min(...list.map(p => p.age ?? 99));
  const oldest = list => Math.max(...list.map(p => p.age ?? 0));

  if (give.length + get.length >= 4) tags.push('Blockbuster');
  // playoff_sos is a multiplier already centred near 1; lower is an easier stretch.
  if (avg(get, 'playoff_sos', 1) < avg(give, 'playoff_sos', 1) - 0.05) tags.push('Playoff Push');
  if (youngest(get) <= 24 && oldest(give) >= youngest(get) + 3) tags.push('Youth Play');
  if (oldest(give) >= 29 && youngest(get) < oldest(give)) tags.push('Sell High');
  // role_change is only ever set when the weekly engine detected a real usage
  // shift — a change of role, not noise — so this is evidence, not a guess.
  if (get.some(p => p.role_change)) tags.push('Buy Low');
  if (give.some(p => p.injury) && !get.some(p => p.injury)) tags.push('Sell the Injury Risk');
  if (Math.abs(ev.their_value_pct) <= 4 && ev.me.ppg_delta > 0.4) tags.push('Fair & Clean');
  else if (ev.their_value_pct < -6 && ev.me.ppg_delta > 0.6) tags.push('Value Win');
  if (!tags.length) tags.push('Straight Upgrade');
  return tags.slice(0, 2);
}

function fairnessLabel(delta, total) {
  if (!total) return 'unpriced';
  const pct = (delta / total) * 100;
  if (pct > 12) return 'lopsided my way';
  if (pct > 4) return 'slightly my way';
  if (pct > -4) return 'even money';
  if (pct > -12) return 'slightly their way';
  return 'lopsided their way';
}

/* ------------------------------------------------------------ trade search */

/** All subsets of `list` with size 1..max, capped so the search stays bounded. */
function combos(list, max) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length) out.push(acc.slice());
    if (acc.length === max) return;
    for (let i = start; i < list.length; i++) { acc.push(list[i]); walk(i + 1, acc); acc.pop(); }
  };
  walk(0, []);
  return out;
}

/**
 * Tradeable candidates from a roster: the players a manager would actually consider
 * moving. Anyone startable is included (that's most of a trade's substance), but
 * we cut the deep bench, which nobody trades for and which explodes the search space.
 */
function candidates(team, slots, limit = 11, excludeIds = null) {
  const line = bestLineup(team.players, slots);
  const startersById = new Set(line.slots.map(s => s.player?.id).filter(Boolean));
  return team.players
    .filter(p => SCORED.has(p.position) && (p.value > 0 || p.proj > 0))
    // Untouchables never enter the search at all — not "ranked low," genuinely absent,
    // so they can never appear as a give in any suggestion.
    .filter(p => !excludeIds || !excludeIds.has(p.id))
    .map(p => ({ ...p, is_starter: startersById.has(p.id) }))
    .sort((a, b) => b.value - a.value || b.adj_ppg - a.adj_ppg)
    .slice(0, limit);
}

/**
 * Search the league for deals worth sending.
 *
 * Cached the same way assetUniverse() already is — this combinatorial search
 * (every give/get combo against every other team) measured 5-24 real seconds
 * depending on package size, on real data, which is not "instant" by any
 * definition. A hypothetical post-trade roster (teamsOverride/assetsOverride,
 * used by findTradeSequences) is never cached: it exists to answer "what if,"
 * not to be looked up again.
 *
 * @param opts.max_per_side  package size cap (2 keeps it realistic and fast)
 * @param opts.require_mutual only surface deals that also improve their lineup
 */
export function findTrades(lg, opts = {}) {
  if (opts.teamsOverride || opts.assetsOverride) return findTradesUncached(lg, opts);
  const { myTeamId, maxPerSide = 2, requireMutual = true, limit = 25, targetId = null, excludeIds = null } = opts;
  const target = tradeWeekContext();
  const { formatKey } = deriveFormat(lg);
  const excludeKey = excludeIds ? [...excludeIds].sort((a, b) => a - b).join(',') : '';
  const key = `findTrades:${lg.id}:${formatKey}:${target.season}:${target.week}:` +
    `${myTeamId ?? lg.my_team_id}:${maxPerSide}:${requireMutual}:${limit}:${targetId ?? ''}:${excludeKey}`;
  return cached(key, fingerprint([
    { table: 'players', stamp: 'id' }, { table: 'roster_players', stamp: 'id' },
    { table: 'dynasty_values', stamp: 'player_id' }, { table: 'player_week_usage', stamp: 'week' },
    { table: 'nfl_injuries', stamp: 'id' }, { table: 'game_lines', stamp: 'week' },
    { table: 'news_items', stamp: 'id' }, 'trending_players', 'player_metrics', 'schedule_games',
    // Not part of assetUniverse's own fingerprint: a manager marked "never
    // trade" or "hard" changes findTrades' own filtering directly, on top of
    // whatever assetUniverse already accounts for.
    'manager_profiles'
  ], key), () => findTradesUncached(lg, opts));
}

function findTradesUncached(lg, {
  myTeamId, maxPerSide = 2, requireMutual = true, limit = 25, targetId = null, excludeIds = null,
  // Lets findTradeSequences() re-run this exact search against a hypothetical
  // post-trade roster without duplicating any of the logic below.
  teamsOverride = null, assetsOverride = null
} = {}) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetsOverride ?? assetUniverse(lg, formatKey);
  const teams = teamsOverride ?? loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your team not found in this league' };
  const target = targetId ? resolvePlayer(targetId, assets, teams)?.id ?? null : null;
  const context = rosterContext(lg);
  const managerProfiles = new Map(rows(`SELECT roster_id,tradeability FROM manager_profiles WHERE league_id=?`, lg.id)
    .map(profile => [String(profile.roster_id), profile.tradeability]));
  const blockedManagers = new Set([...managerProfiles].filter(([, tier]) => tier === 'never').map(([id]) => id));

  const myPool = candidates(me, slots, 11, excludeIds);
  const deals = [];

  for (const them of teams) {
    if (them.roster_id === me.roster_id) continue;
    if (blockedManagers.has(String(them.roster_id))) continue;
    const theirCtx = context.get(String(them.roster_id));
    let theirPool = candidates(them, slots);
    if (target) {
      // Target mode: every package must contain the player we're after.
      const t = theirPool.find(p => p.id === target);
      if (!t) continue;
      theirPool = [t, ...theirPool.filter(p => p.id !== t.id).slice(0, 5)];
    }

    const mine = combos(myPool, maxPerSide);
    const theirs = combos(theirPool, maxPerSide)
      .filter(c => !target || c.some(p => p.id === target));

    for (const get of theirs) {
      const getValue = get.reduce((s, p) => s + Math.max(0, p.value), 0);
      for (const give of mine) {
        const giveValue = give.reduce((s, p) => s + Math.max(0, p.value), 0);
        // Nobody accepts a package worth half of what they send. Prune before the
        // expensive lineup solve — this is what keeps the search sub-second.
        const total = giveValue + getValue;
        if (!total) continue;
        const skew = (giveValue - getValue) / total;
        if (skew < -0.16 || skew > 0.30) continue;

        const ev = evaluate({ team: me, gives: give }, { team: them, gives: get }, slots,
          { theirNeeds: theirCtx?.needs, theirWindow: theirCtx?.window });
        if (ev.me.ppg_delta < 0.4) continue;
        // Never even a "closest fit" fallback candidate — no real GM accepts leaving
        // a starting slot empty, whatever the value math says.
        if (ev.them.new_holes.length > 0) continue;
        if (ev.their_value_pct < -12 || ev.their_value_pct > 18) continue;

        // Remove combinatorial noise: if deleting any one player leaves both
        // lineup deltas effectively unchanged, that player is a decorative
        // throw-in and this is not the cleanest version of the deal.
        const redundant = [
          ...give.map(player => ({ side: 'give', player })),
          ...get.map(player => ({ side: 'get', player }))
        ].some(({ side, player }) => {
          if (target && side === 'get' && player.id === target) return false;
          const leanGive = side === 'give' ? give.filter(x => x.id !== player.id) : give;
          const leanGet = side === 'get' ? get.filter(x => x.id !== player.id) : get;
          if (!leanGive.length || !leanGet.length) return false;
          const lean = evaluate({ team: me, gives: leanGive }, { team: them, gives: leanGet }, slots,
            { theirNeeds: theirCtx?.needs, theirWindow: theirCtx?.window });
          return lean.me.ppg_delta >= ev.me.ppg_delta - 0.05
            && lean.them.ppg_delta >= ev.them.ppg_delta - 0.05;
        });
        if (redundant) continue;
        const managerFactor = managerProfiles.get(String(them.roster_id)) === 'hard' ? 0.55 : 1;
        const fairnessFactor = 1 / (1 + Math.exp(-(ev.their_value_pct + 4) / 10));
        deals.push({
          partner: them.owner, partner_id: them.roster_id,
          i_give: give.map(slim), i_get: get.map(slim),
          tags: tagDeal(give, get, ev),
          ...ev,
          // Lineup gain is the point, but among deals that land the same lineup the
          // one where I surrender less market value is strictly better — without this
          // term the ranking is indifferent to throwing in a free asset.
          manager_tradeability: managerProfiles.get(String(them.roster_id)) ?? 'fair',
          score: +(managerFactor * fairnessFactor * (ev.me.ppg_delta + 0.2 * ev.joint_ppg)).toFixed(3)
        });
      }
    }
  }

  deals.sort((a, b) => b.score - a.score);
  // Collapse to distinct *ideas*. Two offers are the same idea when the headline
  // pieces match — keying on the whole package instead just surfaces ten variants of
  // one swap padded with different throwaway bench players.
  const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
  const seen = new Set();
  const unique = deals.filter(d => {
    const k = `${headline(d.i_give)}>${headline(d.i_get)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Found live, on a real league (2026-09): requireMutual=true (both sides'
  // OPTIMAL LINEUP must improve) found 1 partner out of 9 real opponents.
  // Dropping to "unique" unfiltered used to be the only alternative, which
  // included implausible and red-flagged packages nobody would ever accept —
  // not a real second option, just noise. There is a real middle tier
  // already computed by evaluate() and previously discarded here: `plausible`
  // (fair by market value, no red flags, a real GM could reasonably say yes)
  // without also requiring bothImprove. On that same real league, this tier
  // alone found 5 of 9 partners with a genuinely fair, no-red-flag trade —
  // still real, just not a lineup win for both sides specifically.
  const result = requireMutual
    ? unique.filter(d => d.mutual && d.plausible && d.red_flags.length === 0)
    : unique.filter(d => d.plausible && d.red_flags.length === 0);

  // Every deal above is computed independently against your CURRENT roster, so
  // two of them can both plan on trading away the same player — real, but only
  // one is actually executable. Rather than silently presenting both as if you
  // could do either, mark the lower-ranked one so the UI can say "pick one."
  const claimed = new Set();
  for (const d of result) {
    const overlap = d.i_give.filter(p => claimed.has(p.id)).map(p => p.name);
    d.conflicts_with_earlier = overlap.length ? overlap : null;
    if (!overlap.length) for (const p of d.i_give) claimed.add(p.id);
  }

  return { me: { roster_id: me.roster_id, owner: me.owner }, slots, model_context: assets.context, considered: deals.length,
           excluded_never_trade: [...blockedManagers], deals: result.slice(0, limit) };
}

/**
 * "Do this trade, then this one opens up." findTrades() prices every deal
 * against your roster as it is *right now* — it has no way to notice that
 * taking its own #1 suggestion changes what your #2 suggestion should even
 * be. This runs the search twice: once for real, then again against a
 * roster with the top deal already applied, so a genuinely sequential idea
 * (the throw-in you'd only have *after* the first trade, a hole the first
 * trade just opened that a second deal happens to fill) can surface instead
 * of being invisible because it didn't pencil out against the roster you
 * currently have.
 */
export function findTradeSequences(lg, opts = {}) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const first = findTrades(lg, { ...opts, limit: 50, teamsOverride: teams, assetsOverride: assets });
  if (first.error) return first;

  const step1 = first.deals.find(d => d.mutual && d.plausible && !d.conflicts_with_earlier);
  if (!step1) return { ...first, sequences: [] };

  const me = teams.find(t => t.roster_id === first.me.roster_id);
  const partner = teams.find(t => String(t.roster_id) === String(step1.partner_id));
  if (!me || !partner) return { ...first, sequences: [] };

  // Apply step1 to a cloned roster set — everyone else's roster is untouched,
  // so any *new* idea below is attributable to this one trade, not noise.
  const giveIds = new Set(step1.i_give.map(p => p.id));
  const getIds = new Set(step1.i_get.map(p => p.id));
  const hypothetical = teams.map(t => {
    if (t.roster_id === me.roster_id) {
      return { ...t, players: [...t.players.filter(p => !giveIds.has(p.id)), ...partner.players.filter(p => getIds.has(p.id))] };
    }
    if (t.roster_id === partner.roster_id) {
      return { ...t, players: [...t.players.filter(p => !getIds.has(p.id)), ...me.players.filter(p => giveIds.has(p.id))] };
    }
    return t;
  });

  const second = findTrades(lg, { ...opts, limit: 50, teamsOverride: hypothetical, assetsOverride: assets });
  const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
  const step1Key = `${step1.partner_id}:${headline(step1.i_give)}>${headline(step1.i_get)}`;
  const firstKeys = new Set(first.deals.map(d => `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`));

  // Only surface a step 2 that (a) wasn't already a standalone idea today, so
  // this list is additive, not a repeat of the main board, and (b) doesn't
  // just re-trade the same two pieces back — that isn't a second move.
  const unlocked = (second.deals ?? [])
    .filter(d => {
      const key = `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`;
      if (key === step1Key || firstKeys.has(key)) return false;
      if (d.i_give.some(p => getIds.has(p.id)) && String(d.partner_id) === String(partner.roster_id)) return false;
      return d.mutual && d.plausible;
    })
    .slice(0, 5);

  return { ...first, step1, sequences: unlocked.map(d => ({ ...d, unlocked_by: step1Key })) };
}

/**
 * Resolve a player id to the row that is actually rostered.
 *
 * A handful of players exist twice: an old seed row with no external ids, plus the
 * row the ESPN sync created. Only the synced row ever matches a roster, so a lookup
 * that lands on the seed row would report a rostered star as a free agent.
 */
export function resolvePlayer(id, assets, teams) {
  const wanted = assets.get(Number(id));
  if (!wanted) return null;
  const owned = new Set(teams.flatMap(t => t.players.map(p => p.id)));
  if (owned.has(wanted.id)) return wanted;
  const twin = [...assets.values()].find(a =>
    a.id !== wanted.id && a.position === wanted.position
    && norm(a.name) === norm(wanted.name) && owned.has(a.id));
  return twin ?? wanted;
}

/* ------------------------------------------------- "what do I offer for X" */

/**
 * Offer ladder for a specific target: the cheapest package that plausibly gets it
 * done, a fair-market version, and the point past which you are overpaying.
 */
export function offerFor(lg, { myTeamId, targetId, excludeIds = null }) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  const target = resolvePlayer(targetId, assets, teams);
  if (!target) return { error: 'player not found' };
  const owner = teams.find(t => t.players.some(p => p.id === target.id));
  if (!owner) return { error: 'that player is not on a roster in this league' };
  if (owner.roster_id === me.roster_id) return { error: 'you already own him' };
  const blocked = rows(`SELECT 1 FROM manager_profiles WHERE league_id=? AND roster_id=? AND tradeability='never'`,
    lg.id, String(owner.roster_id))[0];
  if (blocked) return { error: `${owner.owner} is marked "Never trades," so the engine did not generate fake offers for this player.` };
  const ownerCtx = rosterContext(lg).get(String(owner.roster_id));

  // How motivated is the seller? A team with surplus at his position and a hole
  // elsewhere is a much cheaper negotiation than one starting him with no cover.
  const theirLine = bestLineup(owner.players, slots);
  const withoutHim = bestLineup(owner.players.filter(p => p.id !== target.id), slots);
  const theirCost = +(theirLine.points - withoutHim.points).toFixed(2);
  const replaceable = theirCost < 1.0;

  // Ceiling on what he can possibly do for me: add him for free and re-solve. If
  // that number is zero he cannot help at any price, and the honest answer is to
  // say so rather than to hunt for a package that will never exist.
  const myLine = bestLineup(me.players, slots);
  const withHim = bestLineup([...me.players, target], slots);
  const upside = +(withHim.points - myLine.points).toFixed(2);
  const blockedBy = myLine.slots
    .map(s => s.player)
    .filter(p => p && (p.position === target.position || FLEX_ELIGIBLE.FLEX?.includes(p.position)))
    .filter(p => p.adj_ppg >= target.adj_ppg)
    .sort((a, b) => a.adj_ppg - b.adj_ppg)[0];

  const context = {
    model_context: assets.context,
    target: slim(target), owner: owner.owner, owner_id: owner.roster_id,
    their_cost: theirCost, replaceable, upside_ppg: upside,
    leverage: replaceable
      ? `${owner.owner} can cover him — losing him only costs their lineup ${theirCost} ppg. Start low.`
      : `He is load-bearing for ${owner.owner} (${theirCost} ppg of their lineup). Expect to pay a premium or get refused.`
  };

  if (upside <= 0.05) {
    return {
      ...context,
      error: `He would not crack your starting lineup.`,
      reason: blockedBy
        ? `${target.name} projects ${target.adj_ppg} ppg once his schedule is priced in; you already start ${blockedBy.name} at ${blockedBy.adj_ppg}. Buying him upgrades your bench, not your Sunday.`
        : `${target.name} projects ${target.adj_ppg} ppg, below what you already start at that spot.`,
      // The bar an acquisition has to clear to be worth anything at all.
      bar: blockedBy ? { name: blockedBy.name, position: blockedBy.position, adj_ppg: blockedBy.adj_ppg } : null
    };
  }

  const myPool = candidates(me, slots, 12, excludeIds);
  const packages = combos(myPool, 3).filter(c => c.length <= 3);

  const priced = [];
  for (const give of packages) {
    const giveValue = give.reduce((s, p) => s + Math.max(0, p.value), 0);
    const ratio = target.value ? giveValue / target.value : 0;
    if (ratio < 0.70 || ratio > 1.65) continue;
    const ev = evaluate({ team: me, gives: give }, { team: owner, gives: [target] }, slots,
      { theirNeeds: ownerCtx?.needs, theirWindow: ownerCtx?.window });
    if (ev.me.ppg_delta <= 0) continue;
    priced.push({
      i_give: give.map(slim), ratio: +ratio.toFixed(2), give_value: giveValue,
      ...ev,
      // Best offer = most lineup gain for me per unit of market value surrendered.
      efficiency: +(ev.me.ppg_delta / Math.max(1, giveValue / 100)).toFixed(3)
    });
  }
  if (!priced.length) {
    return {
      ...context,
      error: 'He would help, but nothing on your roster prices out.',
      reason: `Adding him is worth ${upside} ppg to your lineup, but every package in his price range (${Math.round(target.value * 0.7)}–${Math.round(target.value * 1.65)}) costs you more than he returns. You need a third team, or a cheaper player at the same position.`
        + (excludeIds?.size ? ` This search also left out the player(s) you've marked untouchable.` : '')
    };
  }

  const acceptable = priced.filter(p => p.them.ppg_delta > 0 || p.ratio >= 1.0);
  const pool = acceptable.length ? acceptable : priced;
  // Cheapest first, but among packages that cost the same never open with the one
  // that helps me least — that offer is dominated and only wastes the first ask.
  const byRatio = [...pool].sort((a, b) => a.ratio - b.ratio || b.me.ppg_delta - a.me.ppg_delta);
  const byEfficiency = [...pool].sort((a, b) => b.efficiency - a.efficiency);
  const ceiling = [...priced].sort((a, b) => b.ratio - a.ratio)[0];

  /**
   * "Go get him": five distinct, playable packages that would land the target —
   * not five variants of the same core piece with a different throw-in. Collapsed
   * to one representative per headline give (the most valuable piece in the
   * package) before ranking, the same technique findTrades() uses to keep a deal
   * list from being ten copies of one idea.
   */
  const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
  const seenHeadline = new Set();
  const distinctByCost = [...pool]
    .sort((a, b) => a.ratio - b.ratio || b.me.ppg_delta - a.me.ppg_delta)
    .filter(p => {
      const k = headline(p.i_give);
      if (seenHeadline.has(k)) return false;
      seenHeadline.add(k);
      return true;
    });
  const RUNG_LABEL = ['Opening offer', 'Good value', 'Fair price', 'Sweetened', 'Safest bet'];
  const offers = distinctByCost.slice(0, 5).map((p, i) => ({
    ...p, rank: i + 1, label: RUNG_LABEL[i] ?? `Offer ${i + 1}`
  }));

  return {
    ...context,
    offers,
    open_with: byRatio[0],
    fair: byEfficiency[0],
    max: { ...ceiling, note: `Past roughly ${Math.round(target.value * 1.35)} in market value you are paying a tax you will not recover.` },
    alternatives: byEfficiency.slice(1, 5)
  };
}

/* -------------------------------------- "go get them" — multiple targets */

/**
 * Same offer-ladder logic as offerFor(), generalized to a whole shopping list at
 * once. Targets are grouped by current owner — a real trade is with one team, so
 * two players on different rosters come back as two separate ladders, one per
 * owner, rather than pretending a single package could land both.
 */
export function offerForMany(lg, { myTeamId, targetIds, excludeIds = null }) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your team not found in this league' };

  const targets = [...new Set((targetIds ?? []).map(Number))]
    .map(id => resolvePlayer(id, assets, teams)).filter(Boolean);
  if (!targets.length) return { error: 'no valid players selected' };

  const byOwner = new Map();
  for (const t of targets) {
    const owner = teams.find(tm => tm.players.some(p => p.id === t.id));
    if (!owner || owner.roster_id === me.roster_id) continue;
    if (!byOwner.has(owner.roster_id)) byOwner.set(owner.roster_id, { team: owner, targets: [] });
    byOwner.get(owner.roster_id).targets.push(t);
  }
  if (!byOwner.size) {
    return { error: 'None of the selected players are on another roster in this league — check they are actually rostered, or that you do not already own them.' };
  }

  const context = rosterContext(lg);
  const myPool = candidates(me, slots, 12, excludeIds);
  const myLine = bestLineup(me.players, slots);

  const ladders = [];
  for (const { team: owner, targets: theirTargets } of byOwner.values()) {
    const blocked = rows(`SELECT 1 FROM manager_profiles WHERE league_id=? AND roster_id=? AND tradeability='never'`,
      lg.id, String(owner.roster_id))[0];
    if (blocked) {
      ladders.push({ targets: theirTargets.map(slim), owner: owner.owner, owner_id: owner.roster_id,
        error: `${owner.owner} is marked "Never trades," so no offers were generated.` });
      continue;
    }
    const ownerCtx = context.get(String(owner.roster_id));
    const targetsValue = theirTargets.reduce((s, p) => s + Math.max(0, p.value), 0);

    const withoutThem = bestLineup(owner.players.filter(p => !theirTargets.some(t => t.id === p.id)), slots);
    const theirLine = bestLineup(owner.players, slots);
    const theirCost = +(theirLine.points - withoutThem.points).toFixed(2);
    const replaceable = theirCost < 1.0 * theirTargets.length;

    const withThem = bestLineup([...me.players, ...theirTargets], slots);
    const upside = +(withThem.points - myLine.points).toFixed(2);

    const base = {
      targets: theirTargets.map(slim), owner: owner.owner, owner_id: owner.roster_id,
      their_cost: theirCost, replaceable, upside_ppg: upside,
      leverage: replaceable
        ? `${owner.owner} can cover ${theirTargets.length > 1 ? 'both' : 'him'} — losing ${theirTargets.length > 1 ? 'them' : 'him'} only costs their lineup ${theirCost} ppg. Start low.`
        : `${theirTargets.length > 1 ? 'They are' : 'He is'} load-bearing for ${owner.owner} (${theirCost} ppg of their lineup). Expect to pay a premium or get refused.`
    };

    if (upside <= 0.05) {
      ladders.push({ ...base, error: `This package would not crack your starting lineup.`,
        reason: `Adding ${theirTargets.map(t => t.name).join(' + ')} is worth ${upside} ppg to your lineup — not enough to change your best starting 9.` });
      continue;
    }

    const maxGive = Math.min(4, theirTargets.length + 2);
    const packages = combos(myPool, maxGive);
    const priced = [];
    for (const give of packages) {
      const giveValue = give.reduce((s, p) => s + Math.max(0, p.value), 0);
      const ratio = targetsValue ? giveValue / targetsValue : 0;
      if (ratio < 0.70 || ratio > 1.65) continue;
      const ev = evaluate({ team: me, gives: give }, { team: owner, gives: theirTargets }, slots,
        { theirNeeds: ownerCtx?.needs, theirWindow: ownerCtx?.window });
      if (ev.me.ppg_delta <= 0) continue;
      priced.push({
        i_give: give.map(slim), ratio: +ratio.toFixed(2), give_value: giveValue,
        ...ev,
        efficiency: +(ev.me.ppg_delta / Math.max(1, giveValue / 100)).toFixed(3)
      });
    }
    if (!priced.length) {
      ladders.push({ ...base, error: 'Nothing on your roster prices out for this package.',
        reason: `Every combination in range (${Math.round(targetsValue * 0.7)}–${Math.round(targetsValue * 1.65)}) costs you more lineup value than it returns. Try fewer targets, or a third team.`
          + (excludeIds?.size ? ` This search also left out your untouchable player(s).` : '') });
      continue;
    }

    const acceptable = priced.filter(p => p.them.ppg_delta > 0 || p.ratio >= 1.0);
    const pool = acceptable.length ? acceptable : priced;
    const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
    const seenHeadline = new Set();
    const distinctByCost = [...pool]
      .sort((a, b) => a.ratio - b.ratio || b.me.ppg_delta - a.me.ppg_delta)
      .filter(p => {
        const k = headline(p.i_give);
        if (seenHeadline.has(k)) return false;
        seenHeadline.add(k);
        return true;
      });
    const RUNG_LABEL = ['Opening offer', 'Good value', 'Fair price', 'Sweetened', 'Safest bet'];
    const offers = distinctByCost.slice(0, 5).map((p, i) => ({ ...p, rank: i + 1, label: RUNG_LABEL[i] ?? `Offer ${i + 1}` }));
    const byEfficiency = [...pool].sort((a, b) => b.efficiency - a.efficiency);

    ladders.push({ ...base, offers, fair: byEfficiency[0], alternatives: byEfficiency.slice(1, 5) });
  }

  return { me: { roster_id: me.roster_id, owner: me.owner }, model_context: assets.context, ladders };
}

/* --------------------------------------------------------------- self scout */

/**
 * Honest read on my own roster: where I'm strong, where I'm thin, what breaks if
 * someone gets hurt, and the specific moves that fix it.
 */
export function selfScout(lg, myTeamId) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your team not found' };

  const lineup = bestLineup(me.players, slots);
  const playoffLineup = bestLineup(me.players, slots, 'playoff_ppg');
  const spread = lineupSpread(lineup);

  // League context: every rival's optimal lineup, so "strong at RB" means strong
  // relative to the ten teams you actually play, not to a national average.
  const rivals = teams.filter(t => t.roster_id !== me.roster_id)
    .map(t => ({ owner: t.owner, roster_id: t.roster_id, line: bestLineup(t.players, slots) }));
  const allLineups = [lineup.points, ...rivals.map(r => r.line.points)].sort((a, b) => b - a);
  const myRank = allLineups.indexOf(lineup.points) + 1;

  // Per-position strength vs the league, measured on starters only.
  const startersAt = (team, pos, line) => line.slots
    .filter(s => s.player?.position === pos).map(s => s.player);
  const positions = {};
  for (const pos of SKILL) {
    const mineStarters = startersAt(me, pos, lineup);
    const myPts = mineStarters.reduce((s, p) => s + p.adj_ppg, 0);
    const rivalPts = rivals.map(r => startersAt(null, pos, r.line).reduce((s, p) => s + p.adj_ppg, 0));
    const avg = rivalPts.length ? rivalPts.reduce((a, b) => a + b, 0) / rivalPts.length : myPts;
    const better = rivalPts.filter(v => v > myPts).length;

    // Depth test: what the lineup loses if the best player here goes down.
    const best = mineStarters.slice().sort((a, b) => b.adj_ppg - a.adj_ppg)[0];
    const ifOut = best ? bestLineup(me.players.filter(p => p.id !== best.id), slots).points : lineup.points;
    const dropoff = +(lineup.points - ifOut).toFixed(2);

    positions[pos] = {
      starters: mineStarters.map(slim),
      depth: me.players.filter(p => p.position === pos && !mineStarters.some(s => s.id === p.id))
        .sort((a, b) => b.adj_ppg - a.adj_ppg).slice(0, 4).map(slim),
      ppg: +myPts.toFixed(2),
      league_avg: +avg.toFixed(2),
      ratio: avg ? +(myPts / avg).toFixed(2) : 1,
      rank: better + 1, of: rivalPts.length + 1,
      injury_dropoff: dropoff,
      status: myPts > avg * 1.12 ? 'strength' : myPts < avg * 0.88 ? 'weakness' : 'average'
    };
  }

  // Bye-week collisions among starters — the most common self-inflicted loss.
  const byes = {};
  for (const s of lineup.slots) {
    if (s.player?.bye) (byes[s.player.bye] ??= []).push(slim(s.player));
  }
  const byeRisk = Object.entries(byes).filter(([, list]) => list.length >= 3)
    .map(([week, list]) => ({ week: Number(week), count: list.length, players: list }))
    .sort((a, b) => b.count - a.count);

  // Whose schedule turns in the weeks that decide the title.
  const playoffSwing = lineup.slots.map(s => s.player).filter(Boolean)
    .map(p => ({ ...slim(p), swing: +(p.playoff_ppg - p.adj_ppg).toFixed(2), games: p.playoff_games }))
    .sort((a, b) => a.swing - b.swing);

  const strengths = Object.entries(positions).filter(([, v]) => v.status === 'strength')
    .sort((a, b) => b[1].ratio - a[1].ratio);
  const weaknesses = Object.entries(positions).filter(([, v]) => v.status === 'weakness')
    .sort((a, b) => a[1].ratio - b[1].ratio);

  const fixes = [];
  for (const [pos, v] of weaknesses) {
    fixes.push({ priority: 'high', area: pos,
      issue: `${pos} starters project ${v.ppg} ppg vs a league average of ${v.league_avg} — ${v.rank}${ord(v.rank)} of ${v.of}.`,
      action: `Trade from surplus (${strengths.map(s => s[0]).join('/') || 'depth'}) for a starting ${pos}.` });
  }
  for (const [pos, v] of Object.entries(positions)) {
    if (v.injury_dropoff > 4 && v.depth.length < 2) {
      fixes.push({ priority: 'medium', area: `${pos} depth`,
        issue: `Losing your top ${pos} costs ${v.injury_dropoff} ppg and you have ${v.depth.length} real backup${v.depth.length === 1 ? '' : 's'}.`,
        action: `Add a startable ${pos} as insurance — cheap in trade because it costs the seller nothing.` });
    }
  }
  for (const b of byeRisk) {
    fixes.push({ priority: 'medium', area: `Week ${b.week} bye`,
      issue: `${b.count} of your starters are on bye in Week ${b.week} (${b.players.map(p => p.name).join(', ')}).`,
      action: 'Stagger byes when two trade targets are otherwise equal, or plan the waiver claim now.' });
  }
  const badPlayoff = playoffSwing.filter(p => p.swing < -0.6);
  if (badPlayoff.length) {
    fixes.push({ priority: 'medium', area: 'Playoff schedule',
      issue: `${badPlayoff.map(p => p.name).join(', ')} ${badPlayoff.length === 1 ? 'faces' : 'face'} harder-than-normal defences in Weeks ${PLAYOFF_WEEKS.join('/')}.`,
      action: 'Prefer trade targets whose Weeks 15-17 slate is soft — same season projection, more of it lands when it matters.' });
  }
  if (spread.floor != null && spread.coverage > 0.5) {
    const rank = myRank <= 3 ? 'contender' : myRank >= rivals.length - 1 ? 'longshot' : 'bubble';
    fixes.push({ priority: 'low', area: 'Roster shape',
      issue: `Lineup floor ${spread.floor} / ceiling ${spread.ceiling} per week; you project ${myRank}${ord(myRank)} of ${allLineups.length}.`,
      action: rank === 'contender'
        ? 'You are ahead — trade ceiling for floor and consistency to protect the lead.'
        : 'You need variance — target boom-rate players over steady ones; a median week does not win you the league from here.' });
  }

  return {
    team: { roster_id: me.roster_id, owner: me.owner },
    rank: myRank, of: allLineups.length,
    lineup: { points: lineup.points, slots: lineup.slots.map(s => ({ slot: s.slot, player: s.player ? slim(s.player) : null })),
              bench: lineup.bench.map(slim), holes: lineup.holes },
    playoff_lineup_points: playoffLineup.points,
    spread,
    positions,
    strengths: strengths.map(([pos, v]) => ({ position: pos, ...v })),
    weaknesses: weaknesses.map(([pos, v]) => ({ position: pos, ...v })),
    bye_risk: byeRisk,
    playoff_swing: playoffSwing,
    fixes: fixes.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.priority] - ({ high: 0, medium: 1, low: 2 })[b.priority]),
    league_lineups: [{ owner: me.owner, roster_id: me.roster_id, points: lineup.points, me: true },
                     ...rivals.map(r => ({ owner: r.owner, roster_id: r.roster_id, points: r.line.points, me: false }))]
      .sort((a, b) => b.points - a.points)
  };
}

const ord = n => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
  : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

/* ------------------------------------------------------- player deep report */

/** Everything the engine knows about one player, for the card behind a trade. */
export function playerOutlook(lg, playerId) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const a = resolvePlayer(playerId, assets, teams);
  if (!a) return { error: 'player not found' };
  const owner = teams.find(t => t.players.some(p => p.id === a.id));
  const splits = a.team_abbr ? relevantSplits(a.id, a.team_abbr) : { upcoming: [], notable: [] };
  const news = rows(`SELECT date, headline, fantasy_impact, importance FROM news_items
                     WHERE headline LIKE ? OR body LIKE ? ORDER BY date DESC LIMIT 5`,
    `%${a.name}%`, `%${a.name}%`);
  return { ...a, owner: owner?.owner ?? 'free agent', owner_id: owner?.roster_id ?? null, splits, news };
}

/* ---------------------------------------------- submitted vs. recommended lineup */

// ESPN lineupSlotId -> our slot label, minus BENCH(20)/IR(21) — a "starter" is
// anything else. Sleeper's payload has a `starters` array instead of a per-player
// slot id; a real Sleeper version needs its own read of that shape, not this one.
const STARTER_SLOT_IDS = new Set(
  Object.entries(SLOT_NAME).filter(([, name]) => name !== 'BENCH' && name !== 'IR').map(([id]) => Number(id)));

/**
 * What's actually set on the platform right now vs. what the engine's own
 * optimal-lineup solver would start — the "what should I change before kickoff"
 * question My Team never answered before, despite already computing the optimal
 * side of it via selfScout/bestLineup.
 */
export function lineupDiff(lg, myTeamId) {
  if (lg.platform !== 'espn') return { error: 'Submitted-lineup comparison is ESPN-only for now — Sleeper stores starters in a different shape this doesn\'t read yet.' };
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your team not found in this league' };

  const payload = JSON.parse(lg.payload);
  const espnTeam = payload.teams?.find(t => String(t.id) === me.roster_id);
  const byEspnId = new Map([...assets.values()].filter(a => a.espn_id).map(a => [String(a.espn_id), a]));
  const submittedIds = new Set();
  for (const e of espnTeam?.roster?.entries ?? []) {
    if (!STARTER_SLOT_IDS.has(e.lineupSlotId)) continue;
    const p = byEspnId.get(String(e.playerPoolEntry?.player?.id));
    // K/DEF are outside SCORED — bestLineup()/lineupSlots() never touch them (see
    // this file's header: near-random week to week, deliberately unmodeled), so
    // comparing them here would flag every started K/DEF as a "should bench" false
    // positive purely because the optimizer was never going to consider them.
    if (p && SCORED.has(p.position)) submittedIds.add(p.id);
  }
  if (!espnTeam || submittedIds.size === 0) return { error: 'could not read a submitted lineup for this team — try syncing the league again' };

  const optimal = bestLineup(me.players, slots);
  const optimalIds = new Set(optimal.slots.map(s => s.player?.id).filter(Boolean));

  const submittedLineup = bestLineup(me.players.filter(p => submittedIds.has(p.id)), slots);
  const swapIn = optimal.slots.filter(s => s.player && !submittedIds.has(s.player.id)).map(s => ({ slot: s.slot, player: slim(s.player) }));
  const swapOut = [...submittedIds].filter(id => !optimalIds.has(id)).map(id => slim(me.players.find(p => p.id === id)));

  return {
    matches: swapIn.length === 0,
    submitted_points: submittedLineup.points,
    optimal_points: optimal.points,
    gain: +(optimal.points - submittedLineup.points).toFixed(2),
    swap_in: swapIn, swap_out: swapOut
  };
}
