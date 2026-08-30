/**
 * The half of the brain that needs nobody's permission.
 *
 * `league-brain.js` ranks moves by expected value — the gain multiplied by the
 * odds the move actually happens — and that framing exposed something the trade
 * planner could not see, because it only ever looked at trades.
 *
 * A waiver claim has an acceptance probability of roughly one. Nobody has to
 * agree. On the same scale the trade planner already uses, a free agent worth
 * +0.9 points a week outranks a trade worth +2.0 that a manager signs a third of
 * the time, and the old plan would have led with the trade and never mentioned
 * the free agent at all. That is not a small omission: in most leagues, most
 * weeks, the waiver wire is the only place a roster actually improves.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HORIZON PROBLEM, which applies to everything here and to trades too
 *
 * Season-long points per week is the wrong objective and it is the one every
 * tool in this project optimises. Nobody's goal is a good average. The goal is
 * to be alive in week 15 and then to win three games, which means:
 *
 *   - Points banked in weeks 1-14 buy a playoff berth and nothing else. Their
 *     value saturates: the difference between the best regular-season team and
 *     the fourth-best is one seed, not a title.
 *   - Points in weeks 15-17 are the ones that win it, and they are worth far
 *     more per point because there is no time left to recover from a bad one.
 *
 * `playoff_ppg` already exists on every asset — it is season ppg scaled by the
 * strength of a player's weeks 15-17 schedule — and until now nothing outside a
 * single diagnostic ever read it. `horizonValue()` blends the two on a weight
 * that moves through the season, so an October recommendation is mostly about
 * making the playoffs and a December one is entirely about winning them.
 */
import { row } from '../db/index.js';
import { deriveFormat } from './format.js';
import {
  assetUniverse, loadRosters, lineupSlots, bestLineup, tradeWeekContext
} from './trade-engine.js';
import { gameScriptFor } from './gamescript.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const SCORED = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

/** Fantasy playoffs are weeks 15-17 in the overwhelming majority of leagues. */
const PLAYOFFS_START = 15;

/**
 * How much a recommendation should care about the fantasy playoffs, given the
 * week it is being made in.
 *
 * Ramps rather than switching, because the horizon does not change on a single
 * Tuesday — a week 12 pickup is bought largely for December, and a week 3 pickup
 * mostly is not. Past the start of the playoffs the regular season is worth
 * exactly nothing, so the weight pins at 1.
 */
export function playoffWeight(week) {
  // Clamped into the real season before anything is computed. Without this a
  // caller passing week 0 — or a negative from an arithmetic slip upstream —
  // walks straight out of the intended range and returns a NEGATIVE weight,
  // which then inverts every horizon value it touches: players would be scored
  // as worth less than both of their own projections. Guarding the input is
  // cheaper than making every consumer defend against a bad weight.
  const raw = Number(week);
  const w = Number.isFinite(raw) ? Math.max(1, Math.min(18, raw)) : 1;
  if (w >= PLAYOFFS_START) return 1;
  // Linear from 0.15 in week 1 to 0.85 in week 14: never zero, because a player
  // acquired in September is still on the roster in December, and never one,
  // because you have to reach the playoffs before their schedule matters.
  return r2(0.15 + 0.7 * ((w - 1) / (PLAYOFFS_START - 2)));
}

/**
 * A player's worth on the horizon that actually matters this week.
 *
 * `playoff_ppg` is season ppg scaled by weeks 15-17 schedule strength, so this
 * is a weighted blend of "helps me get there" and "helps me win it".
 */
export function horizonValue(player, week) {
  const w = playoffWeight(week);
  const season = player.adj_ppg ?? player.ppg ?? 0;
  const playoff = player.playoff_ppg ?? season;
  return r2(season * (1 - w) + playoff * w);
}

/**
 * What the betting market thinks of this player's team this week, folded in.
 *
 * The two halves of this project have been separate for months. The betting side
 * fits a game-script model that turns a spread and a total into pass and rush
 * volume multipliers, validated out of sample. The fantasy side builds player
 * projections from usage and schedule. Neither has ever read the other, so a
 * receiver whose team is a nine-point home favourite in a 51-point game and one
 * in a defensive slog have been valued identically.
 *
 * They are now connected — but deliberately not everywhere, because the obvious
 * version of this is wrong. A single week's Vegas line says almost nothing about
 * a player's rest-of-season worth, and scaling a season-long trade valuation by
 * it would import a one-week signal into a fifteen-week decision. The asset
 * model already splits its value into a current-week component and a
 * rest-of-season component, and Vegas belongs on the first and not the second.
 *
 * So the lift applies to this week's share only. It moves a start/sit or a
 * streaming pickup meaningfully and barely moves a trade, which is the correct
 * relative sensitivity rather than a compromise.
 *
 * Multipliers are already clamped to [0.75, 1.3] by the game-script model, so a
 * missing or extreme line degrades to "no adjustment" rather than to nonsense.
 */
export function vegasLift(player, season, week) {
  if (!player?.team_abbr) return { multiplier: 1, line: null, applied: false };
  let gs;
  try { gs = gameScriptFor(player.team_abbr, season, week); }
  catch { return { multiplier: 1, line: null, applied: false }; }
  if (!gs?.line) return { multiplier: 1, line: null, applied: false };

  // Which multiplier a position actually lives on. A quarterback's volume is
  // passing; a running back's is mostly rushing but meaningfully receiving in
  // PPR, which is why he is blended rather than assigned to rush alone.
  const byPosition = {
    QB: gs.pass_mult,
    RB: 0.65 * gs.rush_mult + 0.35 * gs.pass_mult,
    WR: gs.pass_mult,
    TE: gs.pass_mult
  };
  const mult = byPosition[player.position] ?? 1;
  return {
    multiplier: +mult.toFixed(3),
    line: gs.line,
    applied: true,
    reading: mult >= 1.06
      ? `Vegas has ${player.team_abbr} in a ${gs.line.total}-point game at ${gs.line.spread > 0 ? '+' : ''}${gs.line.spread}, ` +
        `which the game-script model turns into ${Math.round((mult - 1) * 100)}% more volume for a ${player.position}.`
      : mult <= 0.94
        ? `Vegas expects a low-volume game for ${player.team_abbr} (${gs.line.total} total, ` +
          `${gs.line.spread > 0 ? '+' : ''}${gs.line.spread}), costing a ${player.position} about ` +
          `${Math.round((1 - mult) * 100)}% of his usual work.`
        : null
  };
}

/**
 * Horizon value with this week's market view folded into this week's share.
 *
 * `currentWeekShare` mirrors the split the asset model already uses, so the two
 * do not disagree about how much a single Sunday is worth.
 */
export function horizonValueWithVegas(player, season, week, { currentWeekShare = 0.25 } = {}) {
  const base = horizonValue(player, week);
  const lift = vegasLift(player, season, week);
  if (!lift.applied) return { value: base, base, lift: null };
  // Only the current-week slice is scaled. See vegasLift's note on why.
  const value = r2(base * (1 - currentWeekShare) + base * currentWeekShare * lift.multiplier);
  return { value, base, lift };
}

/**
 * Everyone unrostered, which is a bigger and better pool than people assume.
 *
 * Derived by subtraction rather than by a flag: anyone in the asset universe who
 * is not on one of the league's rosters is available. That is the only
 * definition that stays correct when a roster changes, and it costs one Set.
 */
export function freeAgents(lg, { limit = 400 } = {}) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const owned = new Set(teams.flatMap(t => t.players.map(p => p.id)));
  const { week } = tradeWeekContext();

  return [...assets.values()]
    .filter(p => !owned.has(p.id) && SCORED.has(p.position))
    // A free agent with no projection is not an opportunity, it is a name.
    .filter(p => (p.adj_ppg ?? 0) > 0 && p.available !== false)
    .map(p => ({ ...p, horizon_value: horizonValue(p, week) }))
    .sort((a, b) => b.horizon_value - a.horizon_value)
    .slice(0, limit);
}

/**
 * Free agents who would actually change your lineup, and who they replace.
 *
 * The test is deliberately not "is this player good". It is whether adding him
 * changes the optimal lineup, which is the only definition of an upgrade that
 * survives contact with roster construction: the best available running back is
 * worth nothing to a team that already starts three better ones, and a mediocre
 * tight end is worth a lot to a team starting nobody there.
 *
 * So each candidate is dropped into the roster and the lineup re-solved. That is
 * the same machinery the trade evaluator uses, pointed at a cheaper move.
 */
export function waiverUpgrades(leagueId, { myTeamId = null, limit = 10, pool = 120 } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  if (!teams.length) return { error: 'league sync contains no rosters yet' };
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };

  const { season, week } = tradeWeekContext();
  const weight = playoffWeight(week);

  // Solve the lineup on the horizon that matters, not on season average.
  //
  // `bestLineup` takes the key it optimises, and every caller in this project
  // has passed `adj_ppg` — a season-long average. That silently made the whole
  // analysis answer the wrong question: it ranks a player who is great in
  // September and on bye-adjacent garbage in December above one whose weeks
  // 15-17 schedule is the reason you would want him. Annotating each player with
  // a horizon value and optimising on THAT is a one-line change to the solve and
  // a real change to what comes out of it.
  //
  // The same annotation is where the betting model enters: the Vegas game-script
  // multiplier scales this week's slice of each player's value. See vegasLift.
  const annotate = p => {
    const hv = horizonValueWithVegas(p, season, week);
    return { ...p, horizon_ppg: hv.value, horizon_base: hv.base, vegas: hv.lift };
  };
  const myPlayers = me.players.map(annotate);
  const available = freeAgents(lg, { limit: pool }).map(annotate);

  const before = bestLineup(myPlayers, slots, 'horizon_ppg');
  const starters = new Set(before.slots.map(s => s.player?.id).filter(Boolean));

  // Who comes off the roster to make room. Never a current starter, and never
  // the last body at a position — dropping your only kicker to add a fourth
  // receiver is a lineup hole, not an upgrade.
  const countAt = pos => myPlayers.filter(p => p.position === pos).length;
  const droppable = myPlayers
    .filter(p => !starters.has(p.id))
    .filter(p => countAt(p.position) > 1)
    .sort((a, b) => a.horizon_ppg - b.horizon_ppg);

  const worstBench = droppable[0] ?? null;

  const upgrades = [];
  for (const fa of available) {
    // Re-solve the lineup with this player on the roster. Adding without
    // dropping is the honest test of whether he helps at all; the drop is a
    // roster-space question answered separately below.
    const after = bestLineup([...myPlayers, fa], slots, 'horizon_ppg');
    const gain = after.points - before.points;
    if (gain <= 0.05) continue;

    // Who he actually displaces, which is the sentence a manager needs.
    const nowStarting = new Set(after.slots.map(s => s.player?.id).filter(Boolean));
    const displaced = before.slots
      .map(s => s.player).filter(p => p && !nowStarting.has(p.id))[0] ?? null;

    upgrades.push({
      player: slim(fa),
      horizon_value: fa.horizon_ppg,
      season_value: fa.adj_ppg ?? null,
      ppg_gain: r2(gain),
      // Same units as a trade's gain, so the two can be ranked against each
      // other. Acceptance is ~1 because nobody has to agree to a waiver claim —
      // the only real friction is another manager claiming first.
      accept_probability: 0.9,
      expected_value: r2(gain * 0.9),
      replaces: displaced ? slim(displaced) : null,
      drop_candidate: worstBench ? slim(worstBench) : null,
      trending: fa.trending ?? null,
      // Only surfaced when the market actually moved him. A "no adjustment"
      // note on every row is noise that trains you to stop reading them.
      vegas: fa.vegas?.reading ?? null,
      vegas_multiplier: fa.vegas?.multiplier ?? null,
      why: displaced
        ? `Starts over ${displaced.name} immediately, worth ${r2(gain)} points a week.`
        : `Slots straight into the lineup for ${r2(gain)} points a week.`,
      // Stated because it changes the decision: a pickup for December is worth
      // holding a bench spot for, and one for this Sunday is not.
      horizon: weight >= 0.6
        ? `Priced mostly on his weeks 15-17 schedule, which is what matters from here.`
        : `Priced mostly on the rest of the regular season; his playoff schedule is a secondary factor.`
    });
  }

  upgrades.sort((a, b) => b.expected_value - a.expected_value);

  return {
    league: lg.name, owner: me.owner, season, week,
    playoff_weight: weight,
    pool_size: available.length,
    vegas_lines_available: available.filter(p => p.vegas?.applied).length,
    scored_on: `Lineups are solved on a horizon value that is ${Math.round(weight * 100)}% weeks 15-17 ` +
      'and the rest of the regular season, with this week\'s share scaled by the betting market\'s ' +
      'game script for each player\'s team.',
    upgrades: upgrades.slice(0, limit),
    drop_candidates: droppable.slice(0, 4).map(p => ({
      ...slim(p),
      horizon_value: p.horizon_ppg,
      why: `Lowest value on your bench on the horizon that matters, and you carry ` +
        `${countAt(p.position)} at ${p.position}.`
    })),
    note: upgrades.length
      ? 'Ranked on the same scale as trades. A waiver claim needs nobody to agree, so a smaller ' +
        'gain here often outranks a larger trade nobody will sign.'
      : 'No free agent would crack your lineup. That is a good sign about the roster, not a failure ' +
        'of the search.'
  };
}

/**
 * Players on your roster whose value has run ahead of their situation.
 *
 * The mirror of buy-low, and the one nobody does. A manager will happily buy a
 * player whose price has dropped and will almost never sell one whose price has
 * risen, which is exactly backwards — the second is the profitable half, because
 * you are trading a name for production.
 *
 * The signal is a gap between market value and the horizon that matters: someone
 * priced on reputation and a hot month, whose remaining schedule and role do not
 * support it.
 */
export function sellHigh(leagueId, { myTeamId = null, limit = 5 } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };
  const { week } = tradeWeekContext();

  // Fit what this league pays for production, POSITION BY POSITION and on a log
  // scale, then look at who sits above their own curve.
  //
  // The obvious version of this — value divided by points, compared to the
  // median ratio — is wrong, and wrong in a way that produces confident
  // nonsense. Fantasy value is steeply convex in production because it prices
  // scarcity, not points: the best running back is worth several times the
  // twentieth while scoring perhaps twice as much. Measured against a median
  // ratio computed over a pool that includes waiver-wire depth, every elite
  // player is "overpriced" by hundreds of percent. The first run of this
  // function duly recommended selling Jonathan Taylor and Saquon Barkley — the
  // two best players on the roster — at a 535% and 460% premium.
  //
  // A power law (log value on log points) is the right shape for a convex
  // market, and the residual from it is the real question: expensive *for a
  // player who scores what he scores*. Fitting per position matters for the
  // same reason — a tight end and a running back at 12 points a week are not
  // priced alike anywhere.
  const byPosition = new Map();
  for (const p of assets.values()) {
    if (!((p.value ?? 0) > 0 && (p.adj_ppg ?? 0) > 0)) continue;
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }

  /** Least squares on (log points, log value). Returns a predictor. */
  const fitCurve = list => {
    const pts = list.map(p => [Math.log(Math.max(0.5, horizonValue(p, week))), Math.log(p.value)]);
    const n = pts.length;
    const mx = pts.reduce((s, [x]) => s + x, 0) / n;
    const my = pts.reduce((s, [, y]) => s + y, 0) / n;
    let sxy = 0, sxx = 0;
    for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const slope = sxx > 1e-9 ? sxy / sxx : 0;
    const intercept = my - slope * mx;
    // Residual spread, so "above the curve" can be stated in standard
    // deviations rather than in a raw percentage that means nothing on its own.
    const resid = pts.map(([x, y]) => y - (intercept + slope * x));
    const sd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / n) || 1;
    // How much of the price this curve actually explains. It matters a great
    // deal and is easy to omit: at tight end, production explains far less of
    // value than it does at running back, so the same residual means something
    // much weaker there. A finding off a curve that explains a third of the
    // variance is a hint, not a recommendation, and it should say so.
    const ssTot = pts.reduce((s, [, y]) => s + (y - my) ** 2, 0);
    const ssRes = resid.reduce((s, r) => s + r * r, 0);
    const r2Fit = ssTot > 1e-9 ? 1 - ssRes / ssTot : 0;
    return { slope, intercept, sd, n, r2: +r2Fit.toFixed(3) };
  };

  const curves = new Map();
  for (const [pos, list] of byPosition) {
    // Too few players at a position to fit anything trustworthy — a two-point
    // regression will happily declare one of them a sell.
    if (list.length >= 12) curves.set(pos, fitCurve(list));
  }

  const candidates = me.players
    .filter(p => (p.value ?? 0) > 0 && (p.adj_ppg ?? 0) > 0 && curves.has(p.position))
    .map(p => {
      const hv = horizonValue(p, week);
      const c = curves.get(p.position);
      const expected = Math.exp(c.intercept + c.slope * Math.log(Math.max(0.5, hv)));
      const z = (Math.log(p.value) - Math.log(expected)) / c.sd;
      return { p, hv, expected: r2(expected), z: r2(z), fit: c.r2,
        premium: r2((p.value / expected - 1) * 100) };
    })
    // A full standard deviation above the curve for his own position. Anything
    // less is valuation noise rather than a market to sell into.
    .filter(x => x.z >= 1.0)
    .sort((a, b) => b.z - a.z);

  return {
    league: lg.name, week,
    candidates: candidates.slice(0, limit).map(x => ({
      ...slim(x.p),
      market_value: x.p.value,
      fair_value: x.expected,
      horizon_ppg: x.hv,
      premium_pct: x.premium,
      standard_deviations: x.z,
      curve_explains: x.fit,
      confidence: x.fit >= 0.6 ? 'solid' : x.fit >= 0.35 ? 'weak' : 'barely a signal',
      playoff_schedule: x.p.playoff_sos ?? null,
      why: `Other ${x.p.position}s scoring ${x.hv} a week in this league price around ${x.expected}. ` +
        `He is at ${x.p.value} — ${x.premium}% above his own position's curve. ` +
        (x.fit < 0.6
          ? `Treat that loosely: production only explains ${Math.round(x.fit * 100)}% of what ` +
            `${x.p.position}s cost in this league, so the curve is a rough guide rather than a price.`
          : (x.p.playoff_sos ?? 1) < 0.95
            ? 'His weeks 15-17 schedule is below average on top of that, so the premium is being paid for the wrong months.'
            : 'Sell the name while it still carries one.')
    })),
    method: 'Value is fitted per position as a power law on production (log value against log points), ' +
      'and a candidate is a player at least one standard deviation above his own position\'s curve. ' +
      'A flat value-per-point ratio does not work here: fantasy pricing is convex because it prices ' +
      'scarcity, so against a league-wide median every elite player reads as massively overpriced.',
    note: 'The mirror of buy-low, and the half almost nobody plays. Selling a player whose price has ' +
      'run ahead of his situation is trading a reputation for production.'
  };
}

const slim = p => ({
  id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
  espn_id: p.espn_id, ppg: p.ppg, adj_ppg: p.adj_ppg,
  playoff_ppg: p.playoff_ppg, value: p.value, bye: p.bye,
  injury: p.injury ?? null
});
