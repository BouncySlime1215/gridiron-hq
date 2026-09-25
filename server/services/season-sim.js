/**
 * Season simulator.
 *
 * Plays the rest of the fantasy season ten thousand times and counts how often each
 * team makes the playoffs and wins the title. This is the number the whole engine was
 * built to produce: it values depth, bye weeks, weekly variance and playoff schedule
 * simultaneously, without any of them needing a rule of their own.
 *
 * It is also what finally makes trades comparable. "+2.3 points a week" is an input;
 * "your title odds go from 14% to 21%" is the answer.
 *
 * Each simulated week:
 *   1. draw correlated weekly scores for every rostered player (copula over the
 *      projection model's distributions, times that week's game script and
 *      matchups.js#gameMultiplier, which is 1 while matchups carry no validated signal)
 *   2. set each fantasy team's optimal lineup from what it drew
 *   3. resolve that week's head-to-head fixtures
 * then seed the bracket by the league's own rules (league-rules.js: division winners,
 * tiebreaker, playoff teams, weeks per round, fixed or re-seeded) and play it out.
 */
import { rows } from '../db/index.js';
import { PPR, scoringFor } from './scoring.js';
import { SENSE_CHECK_SIM_RUNS } from './trade-verify.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { correlatedSampler, GAME_SHOCK_NU, GAME_SHOCKS_ENV, gameShocksFlag, gameShockFields } from './correlation.js';
import { gameMultiplier, matchupModel } from './matchups.js';
import { leagueRules, seedStandings, simRulesProblem } from './league-rules.js';
import { deriveFormat } from './format.js';
import { gameScriptFor } from './gamescript.js';
import { loadRosters, assetUniverse, lineupSlots, tradeWeekContext } from './trade-engine.js';
import { random, withRandomSeed, keyedSeed, keyedNormal } from './stats-util.js';
import { weeklyAvailability } from './contingency.js';
import { leagueCurrentWeek } from './league-week.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';
import { oneWorldFlag, oneWorldSeed, rosFactor } from './one-world.js';
import { projectionAsOf } from './projection-asof.js';
import { basis02Flag, applyBasis02, poolBasisFor } from './sim-basis.js';
import { availHorizonFlag, availHorizonPreviewFields } from './availability-return.js';
import { rbTitleMode, conditionalTitle, RB_SE_BATCHES, batchOf, batchSe, batchPairedSe, batchInterval } from './rb-title.js';
import { standingsCheckField } from './standings-reconcile.js';
import { espnProjections } from './espn-league-projections.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
// SIM-KDST: kicker and team defence. Scored at their ESPN projection (kdstPoints),
// never drawn from the skill copula, and only when simKdstFlag() is on.
const KDST = new Set(['K', 'DEF']);
const FLEX_ELIGIBLE = {
  FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE']
};
// Size of each player's pre-generated outcome pool. The copula indexes into it, so this
// is the resolution of every marginal distribution in the simulation.
const POOL = 600;

/*
 * Wilson interval on hits/runs. Read it as RUN-TO-RUN Monte Carlo error ONLY.
 *
 * It treats the runs as independent draws from the model, but every run indexes
 * the same fixed POOL-sized outcome pool per player-week and the same Cholesky
 * factor. The pools' own sampling error is therefore a bias shared by every run —
 * at 600 draws a WR1's p90 has sd ~1.5-1.7 and his mean sd ~0.6 across pool
 * regenerations — and it does not shrink as runs grows. So the stated interval is
 * narrower than the real uncertainty in the odds, and re-running the same league
 * with a different seed can move the point estimate by more than the interval.
 * To report the full error, regenerate the pools per batch and pool the variance
 * across regenerations. The payload says which interval this is.
 */
const binomial95 = (hits, n) => {
  if (!n) return [null, null];
  const z = 1.96, p = hits / n, den = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / den;
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / den;
  return [+(Math.max(0, center - half)).toFixed(4), +(Math.min(1, center + half)).toFixed(4)];
};

/* ------------------------------------------------------------ league shape */

/** Regular-season fixtures by week, from whichever platform the league lives on. */
function fixtures(lg, rules) {
  const payload = JSON.parse(lg.payload);
  const out = new Map();
  // Unreachable until league-rules.js has a Sleeper reader: simulateSeason
  // returns simRulesProblem's named error for every non-ESPN league first. Kept
  // for that follow-up (see league-rules.js header), not deleted.
  if (lg.platform === 'sleeper') {
    // Sleeper stores matchups per week keyed by a shared matchup_id.
    for (const [week, list] of Object.entries(payload.matchups ?? {})) {
      const byId = new Map();
      for (const m of list) (byId.get(m.matchup_id) ?? byId.set(m.matchup_id, []).get(m.matchup_id)).push(String(m.roster_id));
      out.set(Number(week), [...byId.values()].filter(p => p.length === 2));
    }
    return out;
  }
  const regularWeeks = rules.schedule.regular_season_weeks;
  for (const m of payload.schedule ?? []) {
    const wk = m.matchupPeriodId;
    if (!wk || wk > regularWeeks) continue;
    if (m.home?.teamId == null || m.away?.teamId == null) continue;
    (out.get(wk) ?? out.set(wk, []).get(wk)).push([String(m.home.teamId), String(m.away.teamId)]);
  }
  return out;
}

/**
 * Lineup total with the decision made from pre-kickoff expectations.
 *
 * `expected` decides who starts; `drawn` decides what those starters score. The
 * previous implementation sorted on `drawn`, which let every manager see the
 * future and retroactively start the highest-scoring bench players each week.
 */
function lineupPoints(roster, slots, drawn, expected, kdst = null) {
  // SIM-KDST: a K / D/ST scores his projected points that week (`kdst`, absent on a
  // bye); without `kdst` he is not in the pool and his slot plays empty.
  const pool = roster
    .filter(p => SCORED.has(p.position) || (kdst && KDST.has(p.position)))
    .map(p => {
      const fixed = KDST.has(p.position) ? (kdst.get(p.id) ?? 0) : null;
      return {
        id: p.id, position: p.position,
        expected: fixed ?? expected.get(p.id) ?? 0,
        pts: fixed ?? drawn.get(p.id) ?? 0
      };
    })
    .sort((a, b) => b.expected - a.expected);
  const used = new Set();
  let total = 0;
  for (const slot of slots) {
    if (!SCORED.has(slot) && !KDST.has(slot)) continue;
    const pick = pool.find(p => !used.has(p.id) && p.position === slot);
    if (pick) { used.add(pick.id); total += pick.pts; }
  }
  for (const slot of slots) {
    const ok = FLEX_ELIGIBLE[slot];
    if (!ok) continue;
    const pick = pool.find(p => !used.has(p.id) && ok.includes(p.position));
    if (pick) { used.add(pick.id); total += pick.pts; }
  }
  return total;
}

/** Real record and points already earned before the simulated window. */
function initialRecords(lg, teams, fromWeek, medianGame = false) {
  const out = new Map(teams.map(t => [t.roster_id, { w: 0, pf: 0 }]));
  if (fromWeek <= 1) return out;
  const payload = JSON.parse(lg.payload);

  // Unreachable until league-rules.js has a Sleeper reader (see fixtures()).
  if (lg.platform === 'sleeper') {
    for (const [week, list] of Object.entries(payload.matchups ?? {})) {
      if (Number(week) >= fromWeek) continue;
      const groups = new Map();
      for (const m of list ?? []) {
        if (m.matchup_id == null) continue;
        const a = groups.get(m.matchup_id) ?? [];
        a.push(m); groups.set(m.matchup_id, a);
        const r = out.get(String(m.roster_id));
        if (r) r.pf += Number(m.points) || 0;
      }
      for (const pair of groups.values()) {
        if (pair.length !== 2) continue;
        const a = out.get(String(pair[0].roster_id)), b = out.get(String(pair[1].roster_id));
        if (!a || !b) continue;
        const ap = Number(pair[0].points) || 0, bp = Number(pair[1].points) || 0;
        if (ap > bp) a.w++; else if (bp > ap) b.w++; else { a.w += 0.5; b.w += 0.5; }
      }
    }
    return out;
  }

  const weekScores = new Map();
  for (const m of payload.schedule ?? []) {
    if (!m.matchupPeriodId || m.matchupPeriodId >= fromWeek) continue;
    const hid = m.home?.teamId == null ? null : String(m.home.teamId);
    const aid = m.away?.teamId == null ? null : String(m.away.teamId);
    const h = out.get(hid), a = out.get(aid);
    if (!h || !a) continue;
    const hp = Number(m.home?.totalPoints ?? m.home?.cumulativeScore?.score);
    const ap = Number(m.away?.totalPoints ?? m.away?.cumulativeScore?.score);
    if (!Number.isFinite(hp) || !Number.isFinite(ap)) continue;
    h.pf += hp; a.pf += ap;
    if (hp > ap) h.w++; else if (ap > hp) a.w++; else { h.w += 0.5; a.w += 0.5; }
    const wk = weekScores.get(m.matchupPeriodId) ?? weekScores.set(m.matchupPeriodId, new Map()).get(m.matchupPeriodId);
    wk.set(hid, hp); wk.set(aid, ap);
  }
  if (medianGame) for (const wk of weekScores.values()) addMedianResults(wk, out);
  return out;
}

/**
 * The week a page-facing simulation starts from — the one producer for it.
 *
 * A payload that is last season's (the pre-draft fallback in syncEspnLeague
 * stamps `payload_season`) starts at week 1, whatever week was asked for: its
 * scored weeks are last year's games and must not become this season's
 * standings. Otherwise an explicit week (a caller's `?from_week=`, passed through
 * raw as simulateSeason/tradeImpact's `fromWeek` option) wins; else the league's own
 * current week (leagueCurrentWeek), so the completed weeks before it are
 * carried in as the real record by initialRecords(). Defaulting to 1 simulated
 * a 5-0 team in week 6 as 0-0 (B-01, 2026-09-22).
 *
 * Callers outside this file pass only the raw client week (or nothing) as
 * `fromWeek`; simulateSeason/tradeImpact resolve it here, so this function is
 * the one producer (source guard: test/b-01-real-record-odds.test.js).
 */
export function simStartWeek(lg, requested = null) {
  // Checked first, so a client's explicit week cannot turn last season's scored
  // weeks back into this season's record (INT-162-1).
  const payloadSeason = Number(lg?.payload_season), season = Number(lg?.season);
  if (payloadSeason && season && payloadSeason !== season) return 1;
  const explicit = Number(requested);
  if (Number.isInteger(explicit) && explicit >= 1) return explicit;
  return leagueCurrentWeek(lg);
}

/**
 * BASIS-02: is this sim at the league's current week (so the finder's served ros_ppg
 * is the right level)? Judged on the SAME clock simStartWeek uses (the league's
 * scoring period, league-week.js), never the NFL calendar: on a Tuesday when the NFL
 * week has advanced but ESPN's scoring period has not, the two clocks disagree and
 * the old `fromWeek >= tradeWeekContext().week` silently switched BASIS-02 off.
 * A past-season payload or another season's league is never "current" (no leak of
 * today's ros_ppg into a replay); an explicit earlier week is a replay.
 */
export function basis02AtCurrentWeek(lg, fromWeek, nowSeason = tradeWeekContext().season) {
  const payloadSeason = Number(lg?.payload_season), season = Number(lg?.season);
  if (payloadSeason && season && payloadSeason !== season) return false;
  if (season && Number(nowSeason) && season !== Number(nowSeason)) return false;
  return Number(fromWeek) >= leagueCurrentWeek(lg);
}

/**
 * The league-median game (a win for every team above that week's median score,
 * half a win at it). Only runs when league-rules says the league plays it.
 */
function addMedianResults(weekScore, record) {
  const vals = [...weekScore.values()].sort((a, b) => a - b);
  if (!vals.length) return;
  const n = vals.length;
  const mid = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  for (const [id, s] of weekScore) {
    const r = record.get(id);
    if (!r) continue;
    if (s > mid) r.w++; else if (s === mid) r.w += 0.5;
  }
}

/** Standard bracket positions for a power-of-two field: 1,8,4,5,2,7,3,6 for 8. */
function bracketOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap(seed => [seed, n + 1 - seed]);
  }
  return order;
}

/**
 * Single-elimination bracket in the league's format.
 *
 * `field` is in seed order. Bracket positions past the field size are byes, so
 * the top seeds rest in round 1 when the field is not a power of two. With
 * `reseed: false` (all five synced leagues) the bracket is fixed: in a 6-team
 * field the 1 seed meets the 4/5 winner and the 2 seed the 3/6 winner. With
 * `reseed: true` each later round pairs the best remaining seed with the worst.
 * Each round is scored over all of its NFL weeks (`playoff_weeks[round]`), so a
 * two-week round sums both weeks. A tie goes to the better seed.
 *
 * @param scoreFor (rosterId, weeks[]) -> points
 */
function playBracket(field, { playoff_weeks: roundWeeks, reseed }, scoreFor) {
  const seedOf = id => field.indexOf(id);
  let slots = bracketOrder(2 ** roundWeeks.length).map(seed => (seed <= field.length ? field[seed - 1] : null));
  const byes = [];
  for (let i = 0; i < slots.length; i += 2) {
    if (slots[i] && !slots[i + 1]) byes.push(slots[i]);
    else if (!slots[i] && slots[i + 1]) byes.push(slots[i + 1]);
  }
  const rounds = [];
  let finalists = [];
  for (let r = 0; r < roundWeeks.length; r++) {
    const weeks = roundWeeks[r];
    if (reseed && r > 0) {
      const alive = slots.filter(Boolean).sort((a, b) => seedOf(a) - seedOf(b));
      slots = [];
      while (alive.length > 1) slots.push(alive.shift(), alive.pop());
      if (alive.length) slots.push(alive[0], null);
    }
    if (r === roundWeeks.length - 1) finalists = slots.filter(Boolean);
    const pairs = [];
    const next = [];
    for (let i = 0; i < slots.length; i += 2) {
      const a = slots[i], b = slots[i + 1];
      if (!a || !b) { next.push(a ?? b ?? null); continue; }
      pairs.push([a, b]);
      const sa = scoreFor(a, weeks), sb = scoreFor(b, weeks);
      next.push(sa === sb ? (seedOf(a) < seedOf(b) ? a : b) : (sa > sb ? a : b));
    }
    rounds.push({ weeks, pairs });
    slots = next;
  }
  return { champion: slots.filter(Boolean)[0] ?? null, finalists, byes, rounds };
}

// Narrowly exposed for deterministic regression tests. These helpers contain
// the decision-timing rules whose accidental reversal creates hindsight bias.
/* ======================= AVAIL-HORIZON-2 PRE-REGISTRATION (change B) =======================
 * Written 2026-09-24 before change B was implemented or run.
 *
 * Change. A team-mean uncertainty term: in each simulated season (run) every fantasy team
 * draws ONE strength offset d ~ Normal(0, TEAM_MEAN_SD) points per week, added to each of
 * its weekly lineup totals (regular season and bracket). Keyed by (world, roster, run), so
 * both arms of a paired trade share it. Behind GRIDIRON_AVAIL_HORIZON (preview on).
 * Why: the sim's pools are fixed per sync, so a team's rest-of-season mean is treated as
 * known exactly; E3-ESPN's reliability slope 0.41 (<1) says the odds are over-confident
 * and longshots under-called (evidence/title-zero.md "over-confidence").
 *
 * The SD is BOUNDED, not fitted, and fixed here at 8 points/week, with no sweep:
 *   - Upper bound: the week-2 league-4 ESPN residual (actual - ESPN best lineup) has SD 32.0
 *     over n = 10 teams; the sim's team-week SD is 24-29 (title-zero.md). The team-mean
 *     share is sqrt(32.0^2 - sigma^2): 13.5 at sigma 29, 21.2 at sigma 24.
 *   - Lower bound: 0 (with n = 10 the residual SD's 90% interval reaches below 24).
 *   - 8 is title-zero.md row 3b's value, below the lowest point estimate (13.5):
 *     the conservative end of the bound.
 * Metrics (B on top of A, same probe as A2): (B1) Nick's league-4 playoff / title odds,
 * target the ESPN-baseline range 12-21% / 0.7-1.6%; (B2) league mean points per week shift
 * vs A alone (expected ~0: the offset is mean zero); (B3) every team's title odds sum to 1
 * and playoff odds to the league's playoff spots (6).
 * ==========================================================================================
 */
export const TEAM_MEAN_SD = 8;

/**
 * Change B: the per-week team-mean SD this season is played with. 0 (no term, the
 * pre-AVAIL-HORIZON-2 sim exactly) unless GRIDIRON_AVAIL_HORIZON is on (or preview).
 */
export function teamMeanSd(flag = availHorizonFlag()) {
  return flag.on ? TEAM_MEAN_SD : 0;
}

/**
 * Each team's strength offset for one run: TEAM_MEAN_SD x a standard normal keyed by
 * (world, roster, run), so every configuration of the same world (both arms of a paired
 * trade, the fast rescore and the full run) gives a team the same offset in the same run.
 */
function teamOffsets(world, ids, run, sd) {
  return new Map(ids.map(id => [id, sd * keyedNormal(keyedSeed(world, 'team-mean', id), run)]));
}

export const __test = { lineupPoints, initialRecords, playBracket, addMedianResults, asofScale, teamOffsets, playSeasons, gameShockFor };
// FIX-322-1: the E3-ESPN grader replays brackets with the sim's own rules (a named export, not __test).
export { playBracket, addMedianResults };

/* ------------------------------------------------- the projection basis */

/**
 * RL-17-3: which per-player rate the simulated season is centred on.
 *
 * The sim's outcome pools come from buildProjections({ through: SEASON - 1 }):
 * LAST season's shape. The trade finder prices the same players on ros_ppg
 * (trade-engine.js, from ros-projection.js#buildRosProjections: this season's
 * games updating the preseason prior). The two orders agreed at Spearman 0.796,
 * so the Title tab disagreed with the finder about who helps (BROKEN-NUMBERS row A).
 *
 * With the flag on, each player's pools keep last season's shape (target/carry/
 * attempt mix, efficiency, dispersion) but their volume is scaled so the mean per
 * game played is the finder's ros_ppg: expected points are linear in the volume
 * multiplier sampleWeeks applies (projections.js#WEEKLY_LEVEL), so a factor
 * ros_ppg / ppg moves the mean there and nothing else. It reads ros_ppg off the
 * same assetUniverse the finder serves, so there is one ROS producer, not two.
 * A player with no ros_ppg or no positive ppg keeps last season's rate and is
 * counted in `ros_unscaled`, never silently.
 *
 * GRIDIRON_RL17_3_ENABLED: '1' on, '0' off, unset = off unless preview mode.
 * EA-07: the one world (one-world.js) always reads proj.ros, so with the one world
 * on the basis is on too; an explicit '0' here still vetoes it (kill switch).
 */
export const RL17_3_ENV = 'GRIDIRON_RL17_3_ENABLED';
const RL17_3_PREVIEW_REASON =
  'Title odds centred on the finder\'s rest-of-season rate (RL-17-3); default off until measured on 2026 leagues';

/** { on, preview }: read per call, so a test or a run can flip it. */
export function rosBasisFlag() {
  const v = process.env[RL17_3_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const world = oneWorldFlag();
  if (world.on) return world;
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/**
 * Per-player volume factor onto the finder's ros_ppg, and what the result
 * should say about it. Empty `scale` when the flag is off (old numbers exactly).
 */
function rosScale(roster, proj, flag) {
  const scale = new Map();
  if (!flag.on) return { scale, fields: null };
  let unscaled = 0;
  for (const p of roster) {
    const f = rosFactor(p.ros_ppg, proj.get(p.id)?.ppg);
    if (f !== undefined) scale.set(p.id, f);
    else if (proj.get(p.id)) unscaled++;
  }
  return {
    scale,
    fields: {
      projection_basis: 'ros', ros_scaled: scale.size, ros_unscaled: unscaled,
      ...(flag.preview ? previewFields(RL17_3_PREVIEW_REASON) : {})
    }
  };
}

const basisKey = (flag, asof = simAsofFlag(), b02 = basis02Flag()) =>
  (asof.on ? 'ros_asof' : flag.on ? 'ros' : 'last_season') + (b02.on ? '+basis02' : '');

/* ------------------------------------------- SIM-CALIB: as-of projection level */

/**
 * SIM-CALIB (BROKEN-NUMBERS row R/A, last piece): the pools' level is each player's
 * rate AS OF the simulation's first week (projection-asof.js#projectionAsOf): the
 * preseason projection at week 1, the in-season rest-of-season rate from week 2 on,
 * built only from games before that week. RL-17-3's scale read ros_ppg, which is
 * empty at week 1 (so pools stayed on last season's level, ~0.93x) and is built for
 * the current week (so a replay of an earlier week read its own results).
 *
 * Every simulated week uses the rate as of the start week: a run from week w knows
 * nothing from week w on. The pool's shape and the availability (contingency.js
 * #weeklyAvailability, the fitted role rates) are unchanged; only the volume scale
 * moves, exactly as RL-17-3 does. A player the as-of model has no rate for keeps last
 * season's level and is counted in `ros_unscaled`.
 *
 * It is the RL-17-3 ROS basis made strictly as-of, not a second basis: the result
 * still says projection_basis 'ros' (plus `ros_asof_week` and how many players were on
 * the preseason vs the in-season rate), and for every player who has played it equals
 * RL-17-3's ros_ppg when the sim starts at the current week.
 *
 * GRIDIRON_SIM_ASOF_PROJ: '1' on, '0' off, unset = off unless preview mode.
 * GRIDIRON_RL17_3_ENABLED=0 (the ROS basis kill switch) vetoes it too.
 */
export const SIM_ASOF_ENV = 'GRIDIRON_SIM_ASOF_PROJ';
const SIM_ASOF_PREVIEW_REASON =
  'Season sim centred on the as-of projection (preseason at week 1, rest-of-season after; SIM-CALIB); default off until confirmed on 2026 weeks';

/** { on, preview }: read per call, so a test or a run can flip it. */
export function simAsofFlag() {
  if (process.env[RL17_3_ENV] === '0') return { on: false, preview: false };
  const v = process.env[SIM_ASOF_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/** Per-player volume factor onto the as-of rate for a simulation starting at `fromWeek`. */
function asofScale(roster, proj, { season, fromWeek, scoring, flag, basisFlag = { on: false }, asOf = projectionAsOf }) {
  const scale = new Map();
  if (!flag.on) return null;
  const rates = asOf({ season, week: fromWeek, scoring });
  let unscaled = 0, preseason = 0, inSeason = 0;
  for (const p of roster) {
    const r = rates.get(p.id);
    const f = rosFactor(r?.ppg, proj.get(p.id)?.ppg);
    if (f === undefined) { if (proj.get(p.id)) unscaled++; continue; }
    scale.set(p.id, f);
    if (r.source === 'preseason') preseason++; else inSeason++;
  }
  return {
    scale,
    fields: {
      projection_basis: 'ros', ros_asof_week: fromWeek,
      ros_scaled: scale.size, ros_unscaled: unscaled, ros_preseason: preseason, ros_in_season: inSeason,
      // On only because of preview mode: name every reason that applies.
      ...(flag.preview ? previewFields(basisFlag.preview
        ? `${RL17_3_PREVIEW_REASON}; ${SIM_ASOF_PREVIEW_REASON}` : SIM_ASOF_PREVIEW_REASON) : {})
    }
  };
}

const scaled = (mult, f) => f === undefined ? mult : { pass: mult.pass * f, rush: mult.rush * f };

/**
 * Each simulated player's mean points per week over the simulated weeks he has a
 * game, from a world's own pools (tradeImpactWorld). The number the RL-17-3
 * contract compares with the finder's ros_ppg.
 */
export function simPlayerMeans(world) {
  const acc = new Map();
  for (const { expected } of world.draws.values()) {
    for (const [id, m] of expected) {
      const a = acc.get(id) ?? { s: 0, n: 0 };
      a.s += m; a.n++;
      acc.set(id, a);
    }
  }
  return new Map([...acc].map(([id, a]) => [id, a.s / a.n]));
}

/* ------------------------------------------------------ SIM-KDST: K and D/ST */

/**
 * SIM-KDST (BROKEN-NUMBERS row R): the sim used to play only the QB/RB/WR/TE and
 * flex slots, so a league whose lineup also starts a K and a D/ST simulated 8 of
 * its 10 starters (about 14 points a week short per team) and a K or D/ST swap
 * was worth exactly 0.
 *
 * With the flag on, the sim keeps the league's real slots (trade-engine.js
 * #lineupSlots with `kdst`) and each K / D/ST scores his ESPN projection, in the
 * league's own scoring, from the synced league payload: that NFL week's projection
 * when ESPN has published one, else his season projection per game. A bye (no NFL
 * game that week) is 0. There is no K / D/ST weekly history on file to fit a
 * spread from, so these slots add their mean and no variance (known limit).
 * A K / D/ST with no ESPN projection in the payload (a free agent) falls back to
 * his asset ros_ppg and is counted in `kdst_unprojected`.
 *
 * GRIDIRON_SIM_KDST: '1' on, '0' off, unset = off unless preview mode.
 */
export const SIM_KDST_ENV = 'GRIDIRON_SIM_KDST';
const SIM_KDST_PREVIEW_REASON =
  'Season sim scores K and D/ST at their ESPN projection (SIM-KDST); default off until confirmed on 2026 weeks';

/** { on, preview }: read per call, so a test or a run can flip it. */
export function simKdstFlag() {
  const v = process.env[SIM_KDST_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

const kdstKey = flag => (flag.on ? 'kdst' : 'skill');

/**
 * GAME-SHOCKS (ONE-PLAN §4d block 1): the sampler's shock options for one simulated
 * week, null when the flag is off. Keyed by (world, week) here and by fixture and run
 * inside the sampler, never by roster, so both arms of a paired trade share it.
 */
function gameShockFor(world, week, flag) {
  return flag.on ? { nu: GAME_SHOCK_NU, key: keyedSeed(world, 'game-shock', week) } : null;
}

// GAME-SHOCKS: the flag lives beside the copula (correlation.js) so league-world.js can
// read it without importing this module; re-exported here for the sim's callers.
export { GAME_SHOCKS_ENV, gameShocksFlag, gameShockFields };

// ESPN's per-player projections from the league payload live in espn-league-projections.js
// (trade-engine.js reads them too, PROJ-ESPN); re-exported here for existing callers.
export { espnProjections };

/**
 * Each K / D/ST's projected points per simulated week (week -> Map<id, pts>); a
 * bye week has no entry (0). Empty weeks when the flag is off.
 */
function kdstPoints(lg, players, simWeeks, nflSchedule, flag) {
  const byWeek = new Map(simWeeks.map(w => [w, new Map()]));
  if (!flag.on) return { byWeek, fields: null };
  const espn = espnProjections(lg);
  let projected = 0, unprojected = 0;
  for (const p of players) {
    if (!KDST.has(p.position)) continue;
    const e = p.espn_id != null ? espn.get(String(p.espn_id)) : undefined;
    const perGame = e?.perGame ?? (Number.isFinite(p.ros_ppg) ? p.ros_ppg : null);
    if (e?.perGame != null) projected++; else unprojected++;
    const games = nflSchedule.get(p.team_abbr);
    for (const week of simWeeks) {
      // Unknown team schedule: no game on file is treated like a bye, as weekPool does.
      if (!games?.some(g => g.week === week)) continue;
      const pts = e?.weeks.get(week) ?? perGame;
      if (Number.isFinite(pts)) byWeek.get(week).set(p.id, pts);
    }
  }
  return {
    byWeek,
    fields: { kdst_scored: true, kdst_projected: projected, kdst_unprojected: unprojected,
      ...(flag.preview ? previewFields(SIM_KDST_PREVIEW_REASON) : {}) }
  };
}

/* -------------------------------------------------------------- the sim */

/**
 * @param opts.overrides  Map<roster_id, player_id[]> replacing a team's roster, which
 *                        is how a proposed trade is evaluated: simulate the league as
 *                        it would be after the deal and diff the title odds.
 * @param opts.universe   extra asset ids to simulate even when no roster holds them.
 *                        A paired comparison passes the SAME universe to both arms
 *                        (every id either arm rosters), so the copula's same-game
 *                        blocks, and therefore every player's draws, are identical
 *                        in both. Without it, a new player in a same-game block
 *                        changes the Cholesky rows of everyone sorted after him.
 */
export function simulateSeason(lg, {
  runs = 2000, fromWeek: requestedWeek = null, scoring = PPR, overrides = null, projections = null,
  keepRuns = false, universe = null, worldId = null
} = {}) {
  const prep = prepareSeason(lg, { requestedWeek, scoring, overrides, projections, universe, worldId });
  if (prep.fail) return prep.fail;
  // A run's draws for a week, made once and shared by every team and by the
  // bracket (the draw is keyed by run, so a repeat call would give the same values).
  let cachedRun = -1, cache = new Map();
  const drawnFor = (run, week) => {
    if (run !== cachedRun) { cachedRun = run; cache = new Map(); }
    let got = cache.get(week);
    if (got) return got;
    const wd = prep.weekData.get(week);
    const drawn = new Map();
    const vals = wd.draw(run);
    for (let i = 0; i < wd.ids.length; i++) drawn.set(wd.ids[i], vals[i]);
    got = { drawn, expected: wd.expected, kdst: wd.kdst };
    cache.set(week, got);
    return got;
  };
  return playSeasons(prep, prep.teams, runs, keepRuns, (t, run, week) => {
    const { drawn, expected, kdst } = drawnFor(run, week);
    return lineupPoints(t.players, prep.slots, drawn, expected, kdst);
  });
}

/**
 * Everything a simulated season is built from before a single run is played:
 * the league's rules and fixtures, the rosters (with `overrides` applied), and
 * each player-week's outcome pool and copula sampler. It draws the one number
 * that names the simulated world from the caller's random stream, exactly once,
 * unless `worldId` names it (EA-07: the week's world, oneWorldSeed).
 */
function prepareSeason(lg, { requestedWeek = null, scoring = PPR, overrides = null, projections = null, universe = null,
  basisFlag = rosBasisFlag(), worldId = null, kdstFlag = simKdstFlag(), asofFlag = simAsofFlag(),
  horizonFlag = availHorizonFlag(), rbTitle = rbTitleMode(), basis02 = basis02Flag(), shockFlag = gameShocksFlag() }) {
  const fromWeek = simStartWeek(lg, requestedWeek);
  // The league's own rules, never a hard-coded default: a missing field is a
  // named error with its payload path (league-rules.js#simRulesProblem).
  const rules = leagueRules(lg);
  const problem = simRulesProblem(rules);
  if (problem) return { fail: problem };
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  let teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg, { kdst: kdstFlag.on });
  const proj = projections ?? buildProjections({ through: SEASON - 1, scoring });

  if (overrides) teams = applyOverrides(teams, overrides, assets);

  const sched = fixtures(lg, rules);
  const weeks = [...sched.keys()].filter(w => w >= fromWeek).sort((a, b) => a - b);
  if (!weeks.length) return { fail: { error: 'no remaining fixtures in this league schedule' } };

  // The bracket is played on the league's own playoff weeks: the NFL weeks after its
  // regular season, `playoffMatchupPeriodLength` weeks per round. Two of the five
  // synced leagues play two-week rounds and one has a 13-week regular season, so
  // the old fixed 15-17 applied the wrong NFL byes and opponents to their brackets.
  const bracketWeeks = rules.schedule.playoff_weeks;
  const simWeeks = [...new Set([...weeks, ...bracketWeeks.flat()])].sort((a, b) => a - b);

  // Every player who could be started by anyone, deduplicated, in id order.
  // RL-6-3: the order is by identity, never by roster position. A trade rebuilds
  // both rosters as `kept + received`, and the copula's Cholesky factor is
  // order-dependent, so a positional order made the "after" season different
  // random football for the whole league (up to 6.5pp on a pure reorder).
  const extra = [...(universe ?? [])].map(id => assets.get(Number(id))).filter(Boolean);
  const everyone = [...new Map([...teams.flatMap(t => t.players), ...extra].map(p => [p.id, p])).values()];
  const roster = everyone
    .filter(p => SCORED.has(p.position))
    .sort((a, b) => (a.id > b.id) - (a.id < b.id));
  // RL-17-3: the finder's ros_ppg as each pool's mean (empty when the flag is off).
  // SIM-CALIB: with the as-of flag on, the level is the as-of rate instead.
  const basis0 = asofScale(roster, proj, { season: SEASON, fromWeek, scoring, flag: asofFlag, basisFlag })
    ?? rosScale(roster, proj, basisFlag);
  // BASIS-02 (sim-basis.js): at the current week the level is the finder's ros_ppg,
  // and a player with no last-season projection borrows a pool at his rate.
  const basis = basis02.on
    ? applyBasis02(basis0, roster, proj, { atCurrentWeek: basis02AtCurrentWeek(lg, fromWeek) })
    : basis0;
  // One draw from the caller's stream names this simulated world. Every random
  // number below is addressed by (world, player, week[, run]) off it, so under
  // one seed the same player gets the same football in every configuration.
  // EA-07: a named world (the NFL week's) takes no draw from the stream.
  const world = worldId != null ? Number(worldId) >>> 0 : Math.floor(random() * 0x100000000) >>> 0;
  const { schedule: nflSchedule } = matchupModel();
  // SIM-KDST: K / D/ST projected points per week, outside the copula (empty when off).
  const kdst = kdstPoints(lg, everyone, simWeeks, nflSchedule, kdstFlag);

  /* --- pre-generate each player's outcome pool per week ---------------------
   * Sampling is by far the most expensive part, and a player's distribution only
   * changes across weeks through his opponent. So the pool is built once per
   * (player, week) up front and the simulation just indexes into it. */
  const weekData = new Map();
  for (const week of simWeeks) {
    const entries = [];
    const activeChance = weeklyAvailability(SEASON, week);
    for (const p of roster) {
      const pool = weekPool(p, week, { world, proj, scoring, scale: basis.scale.get(p.id), activeChance, nflSchedule,
        template: basis.template?.get(p.id) });
      entries.push(pool ? { p, ...pool } : { p, samples: null, meta: null });
    }
    const active = entries.filter(e => e.samples);
    const expected = new Map(active.map(e => [
      e.p.id,
      e.samples.reduce((s, v) => s + v, 0) / e.samples.length
    ]));
    weekData.set(week, {
      // Keyed by (world, player, week); the run index is the counter, so a player's
      // week-w outcome in run r is the same wherever he is rostered.
      draw: correlatedSampler(active.map(e => e.meta), active.map(e => e.samples),
        active.map(e => keyedSeed(world, 'copula', e.p.id, week)), { gameShock: gameShockFor(world, week, shockFlag) }),
      ids: active.map(e => e.p.id), expected, kdst: kdstFlag.on ? kdst.byWeek.get(week) : null,
      // Each simulated player's chance to play this week (sim-basis.js#simPlayerRates).
      active: new Map(active.map(e => [e.p.id, e.meta.active_probability])),
      // The sorted pools themselves: a page's range.week is read off these (EA-07).
      pools: new Map(active.map(e => [e.p.id, e.samples]))
    });
  }

  return {
    lg, rules, fromWeek, assets, teams, slots, sched, weeks, simWeeks, bracketWeeks, weekData, world,
    playoffTeams: rules.schedule.playoff_teams, medianGame: rules.median_game === true,
    rosterIds: new Set(roster.map(p => p.id)), basisFields: basis.fields,
    kdstIds: new Set(everyone.filter(p => KDST.has(p.position)).map(p => p.id)),
    kdstFields: kdst.fields,
    shockFields: gameShockFields(shockFlag),
    // AVAIL-HORIZON-2 change B: 0 = no team-mean term.
    teamMeanSd: teamMeanSd(horizonFlag),
    teamMeanFields: horizonFlag.on ? { team_mean_sd: TEAM_MEAN_SD, ...availHorizonPreviewFields(horizonFlag) } : null,
    // RB-TITLE: 'off' | 'shadow' | 'on' (rb-title.js#rbTitleMode).
    rbTitle
  };
}

/**
 * One player's sorted outcome pool for one NFL week inside world `world`, and the
 * copula meta that goes with it; null on a bye or without a projection (he scores
 * nothing). The only place a pool is drawn, so any caller that passes the same
 * inputs gets the same array the title odds index (EA-07).
 */
function weekPool(p, week, { world, proj, scoring, scale, activeChance, nflSchedule, template = null }) {
  // BASIS-02: `template` is a borrowed projection for a player with none of his own.
  const own = proj.get(p.id);
  const pr = own ?? template;
  const nflWeek = nflSchedule.get(p.team_abbr)?.find(g => g.week === week);
  // On bye, or no NFL game that week, the player scores nothing.
  if (!pr || !nflWeek) return null;
  // matchups.js's one matchup multiplier: exactly 1 in its tested state (no home/away
  // or defense-vs-position arm beat no adjustment, MATCHUP_EVIDENCE). This used to
  // hard-code `dvpFor(...).mult * (home ? 1.02 : 0.98)`, a tilt matchups.js retired.
  const base = gameMultiplier(nflWeek.opponent_abbr, nflWeek.home, p.position);
  // Matchup difficulty and game script are independent effects on the same volume:
  // who you play, and how the game is expected to unfold.
  const gs = gameScriptFor(p.team_abbr, SEASON, week);
  const mult = { pass: base * gs.pass_mult, rush: base * gs.rush_mult };
  const activeProbability = activeChance.get(p.id)?.active_probability ?? 0.92;
  const samples = withRandomSeed(keyedSeed(world, 'pool', p.id, week),
    () => sampleWeeks(pr.params, POOL, scoring, scaled(mult, scale), activeProbability))
    .sort((a, b) => a - b);
  return {
    samples,
    meta: {
      id: p.id, position: p.position,
      team: p.team_abbr, opponent: nflWeek.opponent_abbr,
      target_share: own ? pr.volume?.target_share ?? null : null,
      active_probability: activeProbability
    }
  };
}

/**
 * EA-07: a player's pool in this NFL week's world without building the league's
 * whole world: the same draw (same seed address, projection, game script,
 * availability and RL-17-3 scale on `p.ros_ppg`) as the world's own. For the one
 * caller that cannot wait for a world because the world is built on it: the asset
 * universe's floor/ceiling (trade-engine.js). Everyone else reads the world
 * (league-world.js). `proj` is buildProjections({ through: SEASON - 1, scoring }),
 * passed so a caller pricing many players builds it once; `activeChance` likewise.
 */
export function worldPoolFor(p, week, { scoring, proj, world = null, activeChance = null } = {}) {
  if (!SCORED.has(p?.position)) return null;
  const ctx = tradeWeekContext();
  const b = poolBasisFor(p, proj);
  if (!b) return null;
  return weekPool(p, Number(week), {
    world: world ?? oneWorldSeed(ctx.season, ctx.week), proj, scoring,
    scale: b.scale, template: b.template ? b.pr : null,
    activeChance: activeChance ?? weeklyAvailability(SEASON, Number(week)),
    nflSchedule: matchupModel().schedule
  })?.samples ?? null;
}

/** A trade's rosters: each overridden team's players replaced by the listed ids. */
function applyOverrides(teams, overrides, assets) {
  return teams.map(t => overrides.has(t.roster_id)
    ? { ...t, players: overrides.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) }
    : t);
}

/**
 * Plays the prepared season `runs` times: regular-season fixtures, the league's
 * seeding, then its bracket. `pointsFor(team, run, week)` is that team's lineup
 * total in that run and NFL week; it is the only thing that differs between a
 * full simulation (lineups set from fresh draws) and a trade rescore (lineups
 * read from a prebuilt world), so both give the same numbers.
 */
function playSeasons(prep, teams, runs, keepRuns, rawPointsFor) {
  const { lg, rules, fromWeek, sched, weeks, bracketWeeks, playoffTeams, medianGame } = prep;
  const ids = teams.map(t => t.roster_id);
  // AVAIL-HORIZON-2 change B: each run draws each team's strength offset once and adds it
  // to every week that team plays (regular season and bracket).
  const sd = prep.teamMeanSd ?? 0;
  let offRun = -1, offsets = null;
  const pointsFor = sd > 0
    ? (t, run, week) => {
      if (run !== offRun) { offRun = run; offsets = teamOffsets(prep.world, ids, run, sd); }
      return rawPointsFor(t, run, week) + offsets.get(t.roster_id);
    }
    : rawPointsFor;
  const teamOf = new Map(teams.map(t => [t.roster_id, t]));
  const startingRecords = initialRecords(lg, teams, fromWeek, medianGame);
  const stats = new Map(ids.map(id => [id, {
    roster_id: id, owner: teams.find(t => t.roster_id === id).owner,
    playoffs: 0, title: 0, finals: 0, byes: 0, wins: 0, points: 0, best: 0, worst: Infinity
  }]));
  // Per-run indicators, kept only for a paired comparison (tradeImpact's SE).
  const perRun = keepRuns
    ? new Map(ids.map(id => [id, { title: new Uint8Array(runs), playoffs: new Uint8Array(runs) }]))
    : null;
  // RB-TITLE: each run's title as the probability of winning its bracket (rb-title.js).
  const rbMode = prep.rbTitle ?? rbTitleMode();
  const rb = rbMode === 'off' ? null : rbTitleState(prep, teams, runs, rawPointsFor, perRun);

  for (let run = 0; run < runs; run++) {
    const record = new Map(ids.map(id => [id, { ...(startingRecords.get(id) ?? { w: 0, pf: 0 }) }]));

    for (const week of weeks) {
      const weekScore = new Map();
      for (const t of teams) weekScore.set(t.roster_id, pointsFor(t, run, week));
      for (const [a, b] of sched.get(week) ?? []) {
        const sa = weekScore.get(a) ?? 0, sb = weekScore.get(b) ?? 0;
        if (sa > sb) record.get(a).w++;
        else if (sb > sa) record.get(b).w++;
        else { record.get(a).w += 0.5; record.get(b).w += 0.5; }
      }
      for (const [id, s] of weekScore) record.get(id).pf += s;
      if (medianGame) addMedianResults(weekScore, record);
    }

    // Seed by the league's rule (division winners first where there are
    // divisions, then wins, then the league's tiebreaker).
    const seeded = seedStandings([...record.entries()].map(([id, r]) => ({ id, w: r.w, pf: r.pf })), rules);
    const field = seeded.slice(0, playoffTeams);
    for (const id of field) { stats.get(id).playoffs++; if (perRun) perRun.get(id).playoffs[run] = 1; }
    for (const [id, r] of record) {
      const s = stats.get(id);
      s.wins += r.w; s.points += r.pf;
      s.best = Math.max(s.best, r.pf); s.worst = Math.min(s.worst, r.pf);
    }

    /* --- playoff bracket: the league's own format (playBracket) --- */
    const bracket = playBracket(field, rules.schedule, (id, roundWeeks) =>
      roundWeeks.reduce((sum, week) => sum + pointsFor(teamOf.get(id), run, week), 0));
    for (const id of bracket.byes) stats.get(id).byes++;
    for (const id of bracket.finalists) stats.get(id).finals++;
    if (bracket.champion) {
      stats.get(bracket.champion).title++;
      if (perRun) perRun.get(bracket.champion).title[run] = 1;
    }
    if (rb) rb.add(run, field, sd > 0 ? teamOffsets(prep.world, ids, run, sd) : null);
  }

  const out = [...stats.values()].map(s => {
    const c = rb ? rb.result(s.roster_id) : null;
    return {
      roster_id: s.roster_id, owner: s.owner,
      playoff_odds: +(s.playoffs / runs).toFixed(4),
      playoff_odds_95: binomial95(s.playoffs, runs),
      // U1c: title odds at 6 decimals (0.0001 is a whole 0.01 point, too coarse at 0.1-0.2% odds).
      title_odds: +((rbMode === 'on' ? c.mean : s.title / runs)).toFixed(TITLE_DP),
      title_odds_95: rbMode === 'on' ? c.ci : binomial95(s.title, runs),
      ...(rbMode === 'shadow' ? { title_odds_rb: +c.mean.toFixed(TITLE_DP), title_odds_rb_se: +c.se.toFixed(TITLE_DP) } : {}),
      finals_odds: +(s.finals / runs).toFixed(4),
      expected_wins: +(s.wins / runs).toFixed(2),
      expected_points: +(s.points / runs).toFixed(1)
    };
  }).sort((a, b) => b.title_odds - a.title_odds);

  return {
    runs, weeks: weeks.length, from_week: fromWeek, playoff_teams: playoffTeams,
    rules_source: rules.source, playoff_weeks: bracketWeeks, seeding_rule: rules.seeding.tiebreaker,
    reseed: rules.schedule.reseed, division_winners_first: rules.seeding.division_winners_first,
    median_game: rules.median_game, rules_unknown: rules.unknown,
    standings_carried_in: fromWeek > 1,
    odds_interval: rbMode === 'on'
      ? 'run-to-run Monte Carlo error of the conditional title estimate (normal interval); excludes the shared error of the fixed per-player outcome pools'
      : 'run-to-run Monte Carlo error only; excludes the shared error of the fixed per-player outcome pools',
    ...(rb ? { rb_title: rbMode, title_estimator: rbMode === 'on' ? 'conditional' : 'indicator' } : {}),
    teams: out,
    ...(prep.basisFields ?? {}),
    ...(prep.kdstFields ?? {}),
    ...(prep.teamMeanFields ?? {}),
    // BITEMPORAL: the carried-in record vs ESPN's official one; {} unless flagged.
    ...standingsCheckField(lg, startingRecords, fromWeek, medianGame),
    ...(prep.shockFields ?? {}),
    // Both on only under preview: name both reasons, not just the last one.
    ...(prep.basisFields?.preview && prep.kdstFields?.preview
      ? { preview_reason: `${prep.basisFields.preview_reason}; ${prep.kdstFields.preview_reason}` } : {}),
    ...(perRun ? { per_run: perRun } : {})
  };
}

/**
 * RB-TITLE state for one playSeasons call: every team's raw (offset-free) bracket-week
 * points in every run, read once run by run (simulateSeason caches draws per run), then
 * each run's conditional title probabilities summed. With 'on' and `perRun`, the
 * per-run title array holds those probabilities (the paired SE reads them); with
 * 'shadow' they sit beside it as `title_rb`.
 */
function rbTitleState(prep, teams, runs, rawPointsFor, perRun) {
  const roundWeeks = prep.rules.schedule.playoff_weeks;
  const weeks = [...new Set(roundWeeks.flat())];
  const raw = new Map(teams.map(t => [t.roster_id, new Map(weeks.map(w => [w, new Float64Array(runs)]))]));
  for (let k = 0; k < runs; k++) {
    for (const w of weeks) for (const t of teams) raw.get(t.roster_id).get(w)[k] = rawPointsFor(t, k, w);
  }
  const ids = teams.map(t => t.roster_id);
  const reseed = prep.rules.schedule.reseed;
  const ct = conditionalTitle({ ids, runs, roundWeeks, reseed, rawPoints: (id, w, k) => raw.get(id).get(w)[k] });
  // U1b RB-SE: B batches, each with its OWN playoff-week pool (its own runs only); SE from their means.
  const B = Math.min(RB_SE_BATCHES, runs);
  const starts = Array.from({ length: B + 1 }, (_, b) => Math.ceil((b * runs) / B));
  const cts = Array.from({ length: B }, (_, b) => conditionalTitle({
    ids, runs: starts[b + 1] - starts[b], roundWeeks, reseed,
    rawPoints: (id, w, k) => raw.get(id).get(w)[starts[b] + k]
  }));
  const sum = new Map(ids.map(id => [id, 0]));
  const bsum = new Map(ids.map(id => [id, new Float64Array(B)]));
  const served = (prep.rbTitle ?? rbTitleMode()) === 'on';
  const arrays = perRun ? new Map(ids.map(id => [id, new Float64Array(runs)])) : null;
  if (perRun) for (const id of ids) perRun.get(id)[served ? 'title' : 'title_rb'] = arrays.get(id);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    for (const id of ids) { const a = bsum.get(id); for (let b = 0; b < B; b++) a[b] /= starts[b + 1] - starts[b]; }
    // The batch means ride with the per-run values, so a paired delta's SE is read from them.
    if (perRun) for (const id of ids) perRun.get(id)[served ? 'title_batches' : 'title_rb_batches'] = bsum.get(id);
  };
  return {
    add(run, field, offsets) {
      for (const [id, p] of ct.probs(field, offsets)) {
        if (!p) continue;
        sum.set(id, sum.get(id) + p);
        if (arrays) arrays.get(id)[run] = p;
      }
      const b = batchOf(run, runs, B);
      for (const [id, p] of cts[b].probs(field, offsets)) if (p) bsum.get(id)[b] += p;
    },
    result: id => { finish(); return batchInterval(sum.get(id) / runs, bsum.get(id)); }
  };
}

/** U1c: decimals every title-odds number and its SE is carried at, end to end. */
export const TITLE_DP = 6;

/** A title-odds delta is shown as real only past this many paired standard errors. */
export const TRADE_DELTA_NOISE_SE = 2;

/**
 * Standard error of mean(after_i - before_i) over paired runs: the textbook
 * paired-difference SE. Both arms are indicator arrays of the same length.
 */
function pairedSe(before, after, dp = 4) {
  const n = before.length;
  if (n < 2) return null;
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { const d = after[i] - before[i]; sum += d; sq += d * d; }
  const mean = sum / n;
  const variance = Math.max(0, (sq - n * mean * mean) / (n - 1));
  return +Math.sqrt(variance / n).toFixed(dp);
}

/**
 * U1: run-to-run standard error of one arm's title odds from its per-run 0/1 indicators (flag off).
 * U1b: with RB-TITLE on, `seOf` reads the arm's batch means instead (rb-title.js#batchSe), which
 * carry the shared error of the pooled playoff-week scores that the per-run values leave out.
 */
const seOf = arm => (arm.title_batches ? +batchSe(arm.title_batches).toFixed(TITLE_DP) : levelSe(arm.title));

function levelSe(perRun) {
  const n = perRun.length;
  if (n < 2) return null;
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { sum += perRun[i]; sq += perRun[i] * perRun[i]; }
  const mean = sum / n;
  return +Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1)) / n).toFixed(TITLE_DP);
}

/**
 * The seed a trade is simulated under when the caller gives none: one per
 * league state, so the same deal on the same sync gives the same answer on
 * every click (it used to be a fresh random seed per request).
 */
export function tradeImpactSeed(lg) {
  // EA-07: with the one world on, every deal on every surface faces this NFL
  // week's world, which a sync does not re-roll (only a changed input moves a number).
  if (oneWorldFlag().on) {
    const { season, week } = tradeWeekContext();
    return oneWorldSeed(season, week);
  }
  return keyedSeed('trade-impact', lg.id, lg.fetched_at ?? '');
}

/** 'week' when the seed IS the world (EA-07), 'stream' when the world is drawn off it. */
const worldMode = () => (oneWorldFlag().on ? 'week' : 'stream');

/**
 * The one run count every title-odds delta is simulated at (Title-impact tab,
 * TradeCard, sense-check). With the one seed (tradeImpactSeed) and the league's
 * own scoring, the same deal on the same sync is the same number on every
 * surface. It is the sense-check's measured budget (trade-verify.js).
 */
export const TRADE_IMPACT_RUNS = SENSE_CHECK_SIM_RUNS;

/**
 * GRIDIRON_FAST_RESCORE (default on; `0` restores the old path for one release):
 * a trade is scored by rescoring only the two changed lineups inside a world
 * built once (tradeImpactWorld) instead of re-running the whole league twice.
 * Same numbers either way (test/rl-19-2-fast-rescore.test.js); this is a kill
 * switch, not a model choice.
 */
export function fastRescoreEnabled() {
  return process.env.GRIDIRON_FAST_RESCORE !== '0';
}

/** Read-only view of one run's draws for one week, shaped like the Map lineupPoints reads. */
class RunDraws {
  constructor(vals, index) { this.vals = vals; this.index = index; }
  get(id) { const i = this.index.get(id); return i === undefined ? undefined : this.vals[i]; }
}

/**
 * Everything a trade cannot change, built once per league state: the prepared
 * season (the same prepareSeason tradeImpact's full runs use, under the same
 * seed), every run's draws for every player-week, every team's per-run lineup
 * points, and the unchanged league's result. A trade then only re-solves the two
 * changed lineups (tradeImpact with `world`). Pass it to every deal scored off
 * the same league state; it holds ~runs x weeks x players doubles (tens of MB).
 *
 * `universe`: extra asset ids (e.g. free agents a claim ladder will offer) to
 * simulate even though no roster holds them. A deal that names a player outside
 * the world's universe gets its own world, because adding a player to a
 * same-game block changes the copula rows of the players after him.
 */
export function tradeImpactWorld(lg, {
  runs = TRADE_IMPACT_RUNS, scoring = null, fromWeek: requestedWeek = null, seed = null,
  universe = [], projections = null, fastLineups = false
} = {}) {
  scoring = scoring ?? scoringFor(lg);
  projections = projections ?? buildProjections({ through: SEASON - 1, scoring });
  const pairedSeed = seed == null ? tradeImpactSeed(lg) : Number(seed);
  const universeIds = [...new Set([...universe].map(Number))].sort((a, b) => a - b);
  const basisFlag = rosBasisFlag();
  const kdstFlag = simKdstFlag();
  const asofFlag = simAsofFlag();
  const horizonFlag = availHorizonFlag();
  const mode = worldMode();
  const prep = withRandomSeed(pairedSeed,
    () => prepareSeason(lg, { requestedWeek, scoring, projections, universe: universeIds, basisFlag, kdstFlag, asofFlag,
      horizonFlag, worldId: mode === 'week' ? pairedSeed : null }));
  const key = {
    league: lg.id, fetched_at: lg.fetched_at ?? null, runs, fromWeek: simStartWeek(lg, requestedWeek),
    scoring: JSON.stringify(scoring), seed: pairedSeed, basis: basisKey(basisFlag, asofFlag), mode, kdst: kdstKey(kdstFlag),
    teamMeanSd: teamMeanSd(horizonFlag), rbTitle: rbTitleMode(),
    // U1b: a flag-on world's rescores carry batch SEs; its key (and the rescore cache's hash) says so.
    ...(rbTitleMode() !== 'off' ? { rbSe: `batch${RB_SE_BATCHES}` } : {})
  };
  if (prep.fail) return { key, projections, universe: universeIds, fail: prep.fail };

  const draws = new Map();
  for (const week of prep.simWeeks) {
    const wd = prep.weekData.get(week);
    const index = new Map(wd.ids.map((id, i) => [id, i]));
    const byRun = new Array(runs);
    for (let run = 0; run < runs; run++) byRun[run] = new RunDraws(wd.draw(run), index);
    draws.set(week, { byRun, expected: wd.expected, kdst: wd.kdst });
  }
  // Simulated players no roster holds (free agents from `universe`).
  const rostered = new Set(prep.teams.flatMap(t => t.players.map(p => p.id)));
  const extras = [...prep.rosterIds].filter(id => !rostered.has(id));
  const w = { key, projections, universe: universeIds, extras, prep, draws, runs };
  // PRODUCER-FAST: `fastLineups` scores every lineup of this world (base and deals) with teamPointsFast.
  if (fastLineups) w.teamPoints = teamPointsFast;
  w.points = new Map(prep.teams.map(t => [t.roster_id, (w.teamPoints ?? teamPoints)(w, t.players)]));
  w.base = playSeasons(prep, prep.teams, runs, true, pointsReader(w, w.points));
  return w;
}

/**
 * PRODUCER-FAST: lineupPoints' starters, picked once. Who starts depends only on
 * `expected` (the pre-kickoff decision) and `kdst` (SIM-KDST: a K / D/ST's fixed
 * projection), never on the run's draws, so a week's lineup is the same in every
 * run. Same pool order, same slot order, same picks. Each pick is { id, fixed }:
 * `fixed` is the K / D/ST's points that week, null for a drawn player.
 */
export function lineupStarters(roster, slots, expected, kdst = null) {
  const pool = roster
    .filter(p => SCORED.has(p.position) || (kdst && KDST.has(p.position)))
    .map(p => {
      const fixed = KDST.has(p.position) ? (kdst.get(p.id) ?? 0) : null;
      return { id: p.id, position: p.position, fixed, expected: fixed ?? expected.get(p.id) ?? 0 };
    })
    .sort((a, b) => b.expected - a.expected);
  const used = new Set(), picks = [];
  for (const slot of slots) {
    if (!SCORED.has(slot) && !KDST.has(slot)) continue;
    const pick = pool.find(p => !used.has(p.id) && p.position === slot);
    if (pick) { used.add(pick.id); picks.push({ id: pick.id, fixed: pick.fixed }); }
  }
  for (const slot of slots) {
    const ok = FLEX_ELIGIBLE[slot];
    if (!ok) continue;
    const pick = pool.find(p => !used.has(p.id) && ok.includes(p.position));
    if (pick) { used.add(pick.id); picks.push({ id: pick.id, fixed: pick.fixed }); }
  }
  return picks;
}

/**
 * PRODUCER-FAST: teamPoints with each week's starters picked once (lineupStarters)
 * and summed per run in the same slot order as lineupPoints, so every total is the
 * same double, with or without SIM-KDST (the week's `kdst` map, as teamPoints passes
 * it). Opt-in: tradeImpactWorld(lg, { fastLineups: true }) (the campaign producer,
 * behind its flag); every other caller is unchanged.
 */
export function teamPointsFast(w, players) {
  const out = new Map();
  for (const [week, { byRun, expected, kdst }] of w.draws) {
    const picks = lineupStarters(players, w.prep.slots, expected, kdst);
    const idx = byRun.length ? picks.map(p => (p.fixed == null ? byRun[0].index.get(p.id) ?? -1 : -1)) : [];
    const fixed = picks.map(p => p.fixed);
    const arr = new Float64Array(w.runs);
    for (let run = 0; run < w.runs; run++) {
      const vals = byRun[run].vals;
      let total = 0;
      for (let k = 0; k < idx.length; k++) total += fixed[k] ?? (idx[k] < 0 ? undefined : vals[idx[k]]) ?? 0;
      arr[run] = total;
    }
    out.set(week, arr);
  }
  return out;
}

/** One roster's lineup total in every run and week: week -> Float64Array[run]. */
function teamPoints(w, players) {
  const out = new Map();
  for (const [week, { byRun, expected, kdst }] of w.draws) {
    const arr = new Float64Array(w.runs);
    for (let run = 0; run < w.runs; run++) arr[run] = lineupPoints(players, w.prep.slots, byRun[run], expected, kdst);
    out.set(week, arr);
  }
  return out;
}

const pointsReader = (w, points) => (t, run, week) => points.get(t.roster_id).get(week)[run];

/** Whether a prebuilt world is the one this deal's full simulation would have built. */
function worldFits(w, lg, { runs, scoring, fromWeek, seed, dealIds }) {
  if (!w || w.fail) return false;
  const k = w.key;
  if (k.league !== lg.id || k.fetched_at !== (lg.fetched_at ?? null) || k.runs !== runs
    || k.fromWeek !== fromWeek || k.scoring !== JSON.stringify(scoring) || k.seed !== seed
    || k.basis !== basisKey(rosBasisFlag()) || k.mode !== worldMode()
    || k.kdst !== kdstKey(simKdstFlag()) || (k.teamMeanSd ?? 0) !== teamMeanSd()
    || (k.rbTitle ?? 'off') !== rbTitleMode()) return false;
  // The world's copula must hold exactly the players the full runs would: every
  // rostered player plus the ones this deal names. A named player outside it, or
  // an extra free agent the deal does not name, would change his game-mates' draws.
  const named = new Set(dealIds);
  // SIM-KDST: a K / D/ST sits outside the copula, but his projection must be in the world.
  return w.extras.every(id => named.has(id)) && dealIds.every(id => {
    const p = w.prep.assets.get(id);
    if (p && KDST.has(p.position) && w.key.kdst === 'kdst') return w.prep.kdstIds.has(id);
    return !p || !SCORED.has(p.position) || w.prep.rosterIds.has(id);
  });
}

/**
 * Title-odds impact of a proposed trade.
 *
 * Runs the league twice — as it is, and as it would be — with the same projection set
 * and the same simulated football (common random numbers keyed to each player, not to
 * his roster position), so the difference is the trade and nothing else. Each delta
 * carries its paired standard error, and `*_clears_noise` says whether it is past
 * TRADE_DELTA_NOISE_SE of them.
 *
 * RL-19-2: by default the "as it is" league and every player's draws come from a
 * world built once (tradeImpactWorld; pass `world` to reuse one across deals) and
 * only the two changed lineups are re-solved. The numbers are the same as two full
 * runs; GRIDIRON_FAST_RESCORE=0 runs them the old way.
 */
export function tradeImpact(lg, {
  myTeamId, theirTeamId, iGive = [], iGet = [], runs = TRADE_IMPACT_RUNS,
  scoring = null, fromWeek: requestedWeek = null, seed = null, world = null, universe: extraUniverse = []
}) {
  // Callers no longer pick these: one seed, one run count and the league's own
  // scoring, so every surface shows the same delta for the same deal.
  scoring = scoring ?? scoringFor(lg);
  const fromWeek = simStartWeek(lg, requestedWeek);
  // A world from this same league sync already holds its rosters.
  const sameSync = fastRescoreEnabled() && world?.prep && world.key.league === lg.id
    && world.key.fetched_at === (lg.fetched_at ?? null);
  const teams = sameSync ? world.prep.teams : loadRosters(lg, assetUniverse(lg, deriveFormat(lg).formatKey));
  const me = teams.find(t => t.roster_id === String(myTeamId));
  const them = teams.find(t => t.roster_id === String(theirTeamId));
  if (!me || !them) return { error: 'both teams required' };

  const give = new Set(iGive.map(Number)), get = new Set(iGet.map(Number));
  const overrides = new Map([
    [me.roster_id, [...me.players.filter(p => !give.has(p.id)).map(p => p.id), ...get]],
    [them.roster_id, [...them.players.filter(p => !get.has(p.id)).map(p => p.id), ...give]]
  ]);

  const pairedSeed = seed == null ? tradeImpactSeed(lg) : Number(seed);
  // One shared player universe for both arms: a received player nobody rosters
  // today (a free agent in a claim ladder) is simulated in the "before" arm too.
  // SEARCH-WIDE (#406, integration-9): a caller rescoring on a world built with extra free agents
  // (the claim universe) names them here, so that world is reused instead of silently rebuilt
  // without them on every call (worldFits refuses a world whose extras the deal does not name).
  const universe = [...new Set([...give, ...get, ...[...extraUniverse].map(Number)])];
  let before, after, reused = null;
  if (fastRescoreEnabled()) {
    let w = world;
    if (!worldFits(w, lg, { runs, scoring, fromWeek, seed: pairedSeed, dealIds: universe })) {
      w = tradeImpactWorld(lg, {
        runs, scoring, fromWeek, seed: pairedSeed, universe,
        // A world from this league state and scoring already paid for the projections.
        projections: w?.key?.scoring === JSON.stringify(scoring) ? w.projections : null
      });
    }
    if (w.fail) return w.fail;
    reused = w === world;
    before = w.base;
    const afterTeams = applyOverrides(w.prep.teams, overrides, w.prep.assets);
    const points = new Map(w.points);
    for (const t of afterTeams) if (overrides.has(t.roster_id)) points.set(t.roster_id, (w.teamPoints ?? teamPoints)(w, t.players));
    after = playSeasons(w.prep, afterTeams, runs, true, pointsReader(w, points));
  } else {
    // One projection build shared by both runs — rebuilding would introduce noise that
    // has nothing to do with the trade.
    const projections = buildProjections({ through: SEASON - 1, scoring });
    const worldId = worldMode() === 'week' ? pairedSeed : null;
    before = withRandomSeed(pairedSeed,
      () => simulateSeason(lg, { runs, fromWeek, scoring, projections, keepRuns: true, universe, worldId }));
    after = withRandomSeed(pairedSeed,
      () => simulateSeason(lg, { runs, fromWeek, scoring, projections, overrides, keepRuns: true, universe, worldId }));
  }
  if (before.error || after.error) return before.error ? before : after;

  const pick = (sim, id) => sim.teams.find(t => t.roster_id === id);
  const delta = id => {
    const b = pick(before, id), a = pick(after, id);
    const rb = before.per_run.get(id), ra = after.per_run.get(id);
    const title_delta = +(a.title_odds - b.title_odds).toFixed(TITLE_DP);
    const playoff_delta = +(a.playoff_odds - b.playoff_odds).toFixed(4);
    // U1b: under RB-TITLE the paired SE comes from the batch means (the pooled-score error included).
    const title_delta_se = rb.title_batches && ra.title_batches
      ? +batchPairedSe(rb.title_batches, ra.title_batches).toFixed(TITLE_DP) : pairedSe(rb.title, ra.title, TITLE_DP);
    const playoff_delta_se = pairedSe(rb.playoffs, ra.playoffs);
    return {
      roster_id: id, owner: b.owner,
      title_before: b.title_odds, title_after: a.title_odds,
      // U1: each arm's own SE (the served title_now reads title_before_se).
      title_before_se: seOf(rb), title_after_se: seOf(ra),
      title_delta, title_delta_se,
      title_delta_clears_noise: title_delta_se != null && Math.abs(title_delta) > TRADE_DELTA_NOISE_SE * title_delta_se,
      playoff_before: b.playoff_odds, playoff_after: a.playoff_odds,
      playoff_delta, playoff_delta_se,
      playoff_delta_clears_noise: playoff_delta_se != null && Math.abs(playoff_delta) > TRADE_DELTA_NOISE_SE * playoff_delta_se,
      wins_delta: +(a.expected_wins - b.expected_wins).toFixed(2),
      // RB-TITLE shadow: the conditional delta beside the served one, never served.
      ...(rb.title_rb && ra.title_rb ? {
        title_delta_rb: +(a.title_odds_rb - b.title_odds_rb).toFixed(TITLE_DP),
        title_delta_rb_se: rb.title_rb_batches && ra.title_rb_batches
          ? +batchPairedSe(rb.title_rb_batches, ra.title_rb_batches).toFixed(TITLE_DP) : pairedSe(rb.title_rb, ra.title_rb, TITLE_DP)
      } : {})
    };
  };
  return { runs, from_week: fromWeek, seed: pairedSeed, paired_simulation: true,
    // U1: which title estimator every title number and SE here is on (GRIDIRON_RB_TITLE=1: 'conditional').
    title_estimator: before.title_estimator === 'conditional' ? 'conditional' : 'indicator',
    ...(before.projection_basis ? { projection_basis: before.projection_basis,
      ...(before.preview ? previewFields(before.preview_reason) : {}) } : {}),
    // EA-07: whether this deal was priced on the caller's world (the snapshot's one
    // title.odds) or needed its own (it names a player outside that world).
    ...(before.kdst_scored ? { kdst_scored: true,
      ...(before.preview ? previewFields(before.preview_reason) : {}) } : {}),
    ...(worldMode() === 'week' ? { world_id: pairedSeed, world_reused: reused } : {}),
    me: delta(me.roster_id), them: delta(them.roster_id) };
}
