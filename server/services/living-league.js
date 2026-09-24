/**
 * LIVING-01b: league-mates act inside the season simulator.
 *
 * The frozen sim plays the rest of the season with every roster as it is today and
 * every manager setting his best lineup every week. Real league-mates do neither:
 * engaged managers work the waiver wire and trade, checked-out ones leave dead
 * starters in their lineups. With GRIDIRON_LIVING01B_ENABLED=1, each simulated run
 * gives every team a weekly engagement state and lets it act:
 *
 *   1. state   a Markov chain over LIVING-01a's states (engaged / drifting /
 *              checked_out), started from the team's `activity.manager` probs (or the
 *              population prior) and stepped with LIVING-01a's fitted transitions.
 *   2. trades  at the manager's own weekly trade rate, regular season only: his best
 *              bench player for a partner's best bench player (a value-neutral swap).
 *   3. adds    Poisson(rho x lam[state]) claims per week, resolved in a keyed waiver
 *              order by a simple cloned waiver policy: claim the best free agent in the
 *              simulated pool, drop the roster's lowest-valued player, and only when
 *              the claim is worth more than the drop.
 *   4. lineup  with P(dead or empty starter | state), one starter's slot scores 0
 *              (the stale lineup a checked-out manager leaves).
 *
 * Every random number is keyed by (world, team, run): the same seed gives the same
 * living season, and the player draws are the frozen sim's own (common random
 * numbers), so living minus frozen is the managers' actions and nothing else.
 *
 * The rates come from LIVING-01a (PR #220, `activity-model.js` at 60f03eaf). That
 * module imports the engine spine, which is not on this base, so its fitted constants
 * are pinned here (ACTIVITY_PARAMS) and a caller passes its `activity.manager` values
 * per team. A team without one runs on the population prior and is counted.
 */
import { random, withRandomSeed, keyedSeed, randPoisson } from './stats-util.js';

export const LIVING01B_ENV = 'GRIDIRON_LIVING01B_ENABLED';
export const LIVING_MODEL = 'living01b-1';

/** On only when set to exactly '1'. Default off: the PRE kill test has not run. */
export const livingEnabled = () => process.env[LIVING01B_ENV] === '1';

export const STATES = Object.freeze(['engaged', 'drifting', 'checked_out']);

/**
 * LIVING-01a FITTED_PARAMS (Sleeper 2021-22), copied from PR #220 activity-model.js
 * at 60f03eaf. Swap for an import once that module is on main.
 */
export const ACTIVITY_PARAMS = Object.freeze({
  pi: [0.55388, 0.37859, 0.067533],
  A: [[0.92682, 0.07262, 0.00055838], [0.11061, 0.83782, 0.051573], [0.0033083, 0.011862, 0.98483]],
  lam: [1.8257, 0.45997, 0.0077193],
  errLogit: [-2.8666, -1.5823, 2.6171],
  errBye: 5.3254,
  popAddRate: 1.2501,
  popTradeRate: 0.044608,
  popErrRate: 0.26793,
});

/** Free agents simulated as the waiver pool: the best this many by rest-of-season rate. */
export const FA_POOL_SIZE = 40;

const RHO_MIN = 0.25, RHO_MAX = 4;
const sigmoid = x => 1 / (1 + Math.exp(-x));

/** P(dead or empty starter) in state s (LIVING-01a errorProb, not bye-adjusted). */
export const errorProb = (params, s) => sigmoid(params.errLogit[s]);

/**
 * Per team: the starting state probabilities, the add-volume multiplier and the
 * weekly trade rate. `living` is Map|object roster_id -> LIVING-01a activity.manager
 * value ({ probs: {engaged, drifting, checked_out}, rates: {adds_per_week: {value},
 * trades_per_week: {value}} }). A missing or malformed value falls back to the
 * population and is counted in `source: 'population'`.
 */
export function livingInputs(teams, living = null, params = ACTIVITY_PARAMS) {
  const byTeam = living instanceof Map ? living : new Map(Object.entries(living ?? {}));
  const out = new Map();
  for (const t of teams) {
    const v = byTeam.get(t.roster_id) ?? byTeam.get(Number(t.roster_id));
    const probs = v?.probs ? STATES.map(s => Number(v.probs[s])) : null;
    const valid = probs && probs.every(p => Number.isFinite(p) && p >= 0)
      && Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-3;
    if (!valid) {
      out.set(t.roster_id, { probs: [...params.pi], rho: 1, tradeRate: params.popTradeRate, source: 'population' });
      continue;
    }
    const adds = Number(v.rates?.adds_per_week?.value);
    const trades = Number(v.rates?.trades_per_week?.value);
    out.set(t.roster_id, {
      probs,
      // His shrunk add rate relative to the population's: the volume multiplier.
      rho: Number.isFinite(adds) && adds >= 0
        ? Math.min(RHO_MAX, Math.max(RHO_MIN, adds / params.popAddRate)) : 1,
      tradeRate: Number.isFinite(trades) && trades >= 0 ? Math.min(1, trades) : params.popTradeRate,
      source: 'activity'
    });
  }
  return out;
}

/** A world's cache key for the caller's `living` inputs: the same inputs, the same string. */
export function livingKey(living) {
  const entries = living instanceof Map ? [...living] : Object.entries(living ?? {});
  return JSON.stringify(entries.map(([k, v]) => [String(k), v]).sort(([a], [b]) => (a > b) - (a < b)));
}

function sampleIndex(probs) {
  const u = random();
  let acc = 0;
  for (let i = 0; i < probs.length; i++) { acc += probs[i]; if (u < acc) return i; }
  return probs.length - 1;
}

/**
 * One team's actions for one run, week by week: its state, how many claims it makes,
 * whether it leaves a dead starter (and which), whether it trades (and with whom).
 * Keyed by (world, team, run), so it does not depend on the rosters or other teams.
 */
export function livingScript(world, rosterId, run, weeks, input, params = ACTIVITY_PARAMS) {
  return withRandomSeed(keyedSeed(world, 'living', rosterId, run), () => {
    let s = sampleIndex(input.probs);
    return weeks.map(() => {
      s = sampleIndex(params.A[s]);
      const adds = randPoisson(input.rho * params.lam[s]);
      const err = random() < errorProb(params, s);
      const errU = random();
      const trade = random() < input.tradeRate;
      const tradeU = random();
      return { state: s, adds, err, errU, trade, tradeU };
    });
  });
}

/**
 * The simulated waiver pool: the best FA_POOL_SIZE players no team rosters, by the
 * finder's rest-of-season rate (ros_ppg, else ppg), then id. `scored` filters positions.
 */
export function freeAgentPool(assets, teams, scored, size = FA_POOL_SIZE) {
  const rostered = new Set(teams.flatMap(t => t.players.map(p => p.id)));
  const rate = p => Number(p.ros_ppg ?? p.ppg) || 0;
  return [...assets.values()]
    .filter(p => scored.has(p.position) && !rostered.has(p.id) && p.available !== false)
    .sort((a, b) => rate(b) - rate(a) || a.id - b.id)
    .slice(0, size)
    .map(p => p.id);
}

/** Each simulated player's mean expected points over the weeks he has a game. */
function playerValues(weekData) {
  const acc = new Map();
  for (const { expected } of weekData.values()) {
    for (const [id, m] of expected) {
      const a = acc.get(id) ?? { s: 0, n: 0 };
      a.s += m; a.n++; acc.set(id, a);
    }
  }
  return new Map([...acc].map(([id, a]) => [id, a.s / a.n]));
}

const byId = (a, b) => (a > b) - (a < b);

/**
 * Every team's lineup points in every run and week, frozen and living, off the same
 * draws. `drawsFor(run, week)` -> { drawn: {get(id)}, expected: Map, kdst } is the frozen
 * sim's own; `starters(players, expected, kdst)` is its lineup rule (a K / D/ST pick
 * carries its projected points as `fixed`, SIM-KDST). Weeks are walked in
 * order inside a run, so rosters carry forward; runs start from today's rosters.
 */
export function livingPoints({ prep, teams, runs, drawsFor, starters, inputs, params = ACTIVITY_PARAMS }) {
  const { simWeeks, world, faPool, assets, weeks: regularWeeks } = prep;
  const regular = new Set(regularWeeks);
  const value = playerValues(prep.weekData);
  const val = id => value.get(id) ?? 0;
  const ids = teams.map(t => t.roster_id).sort(byId);
  const table = () => new Map(ids.map(id => [id, new Map(simWeeks.map(w => [w, new Float64Array(runs)]))]));
  const living = table(), frozen = table();
  const totals = { claims: 0, adds: 0, trades: 0, lineup_errors: 0, checked_out_weeks: 0, team_weeks: 0 };
  const sumDrawn = (picks, drawn, skip = -1) => {
    let t = 0;
    for (let i = 0; i < picks.length; i++) if (i !== skip) t += picks[i].fixed ?? drawn.get(picks[i].id) ?? 0;
    return t;
  };
  const bestBench = (roster, expected, kdst) => {
    const start = new Set(starters(roster, expected, kdst).map(p => p.id));
    return roster.filter(p => !start.has(p.id) && value.has(p.id))
      .sort((a, b) => val(b.id) - val(a.id) || byId(a.id, b.id))[0] ?? null;
  };

  for (let run = 0; run < runs; run++) {
    const scripts = new Map(ids.map(id => [id, livingScript(world, id, run, simWeeks, inputs.get(id), params)]));
    const rosters = new Map(teams.map(t => [t.roster_id, [...t.players]]));
    const taken = new Set(teams.flatMap(t => t.players.map(p => p.id)));
    // The claimable pool, best first; a dropped player goes back into it.
    const pool = faPool.filter(id => !taken.has(id)).map(id => assets.get(id)).filter(Boolean)
      .sort((a, b) => val(b.id) - val(a.id) || byId(a.id, b.id));

    simWeeks.forEach((week, wi) => {
      const { drawn, expected, kdst = null } = drawsFor(run, week);
      if (regular.has(week)) {
        const traded = new Set();
        for (const id of ids) {
          const s = scripts.get(id)[wi];
          if (!s.trade || traded.has(id)) continue;
          const others = ids.filter(o => o !== id && !traded.has(o));
          if (!others.length) continue;
          const partner = others[Math.floor(s.tradeU * others.length)];
          const a = bestBench(rosters.get(id), expected, kdst), b = bestBench(rosters.get(partner), expected, kdst);
          if (!a || !b) continue;
          rosters.set(id, [...rosters.get(id).filter(p => p.id !== a.id), b]);
          rosters.set(partner, [...rosters.get(partner).filter(p => p.id !== b.id), a]);
          traded.add(id); traded.add(partner);
          totals.trades++;
        }
      }
      const order = [...ids].sort((a, b) => keyedSeed(world, 'waiver', run, week, a) - keyedSeed(world, 'waiver', run, week, b)
        || byId(a, b));
      for (const id of order) {
        for (let k = scripts.get(id)[wi].adds; k > 0 && pool.length; k--) {
          const roster = rosters.get(id);
          // Only simulated (scored) players are dropped; a kicker or D/ST stays.
          const drop = roster.filter(p => value.has(p.id))
            .sort((a, b) => val(a.id) - val(b.id) || byId(a.id, b.id))[0];
          if (!drop || val(pool[0].id) <= val(drop.id)) break;
          const claim = pool.shift();
          rosters.set(id, [...roster.filter(p => p.id !== drop.id), claim]);
          const at = pool.findIndex(p => val(p.id) < val(drop.id) || (val(p.id) === val(drop.id) && byId(p.id, drop.id) > 0));
          pool.splice(at < 0 ? pool.length : at, 0, drop);
          totals.adds++;
        }
      }
      for (const t of teams) {
        const s = scripts.get(t.roster_id)[wi];
        totals.team_weeks++;
        totals.claims += s.adds;
        if (s.state === 2) totals.checked_out_weeks++;
        frozen.get(t.roster_id).get(week)[run] = sumDrawn(starters(t.players, expected, kdst), drawn);
        const picks = starters(rosters.get(t.roster_id), expected, kdst);
        const dead = s.err && picks.length ? Math.floor(s.errU * picks.length) : -1;
        if (dead >= 0) totals.lineup_errors++;
        living.get(t.roster_id).get(week)[run] = sumDrawn(picks, drawn, dead);
      }
    });
  }
  const perRun = x => +(x / runs).toFixed(3);
  let fromActivity = 0;
  for (const id of ids) if (inputs.get(id).source === 'activity') fromActivity++;
  return {
    living, frozen,
    summary: {
      model: LIVING_MODEL, fa_pool: faPool.length,
      teams_from_activity: fromActivity, teams_population: ids.length - fromActivity,
      // claims the managers wanted to make; adds the waiver policy found worth making
      claims_per_run: perRun(totals.claims), adds_per_run: perRun(totals.adds), trades_per_run: perRun(totals.trades),
      lineup_errors_per_run: perRun(totals.lineup_errors),
      checked_out_share: totals.team_weeks ? +(totals.checked_out_weeks / totals.team_weeks).toFixed(4) : null
    }
  };
}
