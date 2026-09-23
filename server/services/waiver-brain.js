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
 * `playoff_ppg` exists on every asset: the player's weekly rate for this league's
 * playoff weeks — his rest-of-season rate times the share of those weeks his team
 * plays, so a playoff-week bye counts. It carries no schedule STRENGTH: every
 * opponent/home adjustment failed the weekly walk-forward test (matchups.js,
 * 2026-09-17). `horizonValue()` blends it with adj_ppg on a weight that moves
 * through the season, so an October recommendation leans on this week and the
 * rest of the regular season, and a December one on the weeks that decide it.
 */
import { row, rows } from '../db/index.js';
import { playerHype, HYPE_PRODUCER } from './hype.js';
import { deriveFormat } from './format.js';
import { publishRecommendation } from '../routes/decision-inbox.js';
import {
  assetUniverse, loadRosters, lineupSlots, bestLineup, tradeWeekContext
} from './trade-engine.js';
import { gameScriptFor } from './gamescript.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

// The one unfitted number in a waiver upgrade, named so it cannot be mistaken
// for a solved one. Nobody has to agree to a waiver claim, so there is no
// counterparty to model and nothing here was fitted against outcomes; the only
// real friction is another manager claiming first, and 0.9 is a hand-set haircut
// for it. It is a claim-friction factor, NOT a confidence in the recommendation
// and NOT an acceptance rate of the kind the trade engine fits. Every use of it
// reads this constant, so the payload's two numbers cannot drift apart.
const CLAIM_FRICTION = 0.9;
// Two shapes on purpose, following this file's own rule about per-row notes
// (see the `vegas` field below: a note on every row trains a reader to skip
// them). The per-row field is one short token a surface can branch on; the
// sentence that explains it is stated once, beside `not_modelled` and
// `scored_on`, which are the other two places this payload explains itself.
const CLAIM_FRICTION_BASIS = 'hand-set';
const CLAIM_FRICTION_WHY =
  'Acceptance is not fitted on this board. A waiver claim needs nobody to agree, ' +
  'so there is no counterparty to model and nothing here was scored against ' +
  'outcomes. The 0.9 is a flat allowance for another manager claiming first, ' +
  'applied equally to every row — it lowers every expected value by a tenth and ' +
  'changes no ordering within this list. A trade\'s acceptance probability, which ' +
  'these gains are deliberately rankable against, IS fitted; that is the ' +
  'difference this field exists to make visible.';
// The positions this file will consider at all. 'DEF' is the literal every
// writer of `players.position` uses — drafts.js, draft-assist.js,
// draft-lookahead.js, nfl-roster-strength.js. This set said 'DST' and was the
// only occurrence of that spelling in the server tree, so it matched no row and
// no defense had ever reached the free-agent pool, in five leagues that all
// start one.
const SCORED = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

// The positions the LINEUP SOLVER scores, which is a smaller set and a
// different question. `bestLineup` filters its pool and its slot list to
// QB/RB/WR/TE by deliberate design (trade-engine.js: "K and D/ST are near-random
// week to week and roughly interchangeable, so including them adds noise to
// every lineup comparison").
//
// That design is not in dispute here. Its CONSEQUENCE was: a kicker or defense
// that reaches the pool changes the solved lineup by exactly zero, so it is
// dropped by every `gain > 0` threshold downstream and the surface shows an
// absence with no explanation. A position nobody modelled and a position nobody
// rates are indistinguishable to a reader, and only one of them is a fact about
// the roster.
//
// Must track `bestLineup`'s own filter. If K or DEF are ever added there, this
// set moves with it and the honesty note below stops being printed on its own.
const LINEUP_MODELLED = new Set(['QB', 'RB', 'WR', 'TE']);

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
  // because you have to reach the playoffs before those weeks matter.
  return r2(0.15 + 0.7 * ((w - 1) / (PLAYOFFS_START - 2)));
}

/**
 * A player's worth on the horizon that actually matters this week.
 *
 * A weighted blend of "helps me get there" (adj_ppg: 25% this week, 75% the
 * rest-of-season rate) and "helps me win it" (playoff_ppg: the same rate over the
 * playoff weeks, byes counted). Both halves are points per week on the same
 * rest-of-season basis; what separates them is timing — this week's injuries and
 * byes against playoff-week byes — not any read on opponents, which is not
 * validated (matchups.js).
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
 *
 * SWITCHED OFF (S-03, 2026-09-22). S-02 graded the lift as a fantasy multiplier for
 * the first time, pre-registered, on the 2025 season held out: it made weekly numbers
 * less accurate (weeks 2-4 ΔMAE +0.030 [+0.014, +0.047]; weeks 5-17 +0.009
 * [−0.001, +0.019], worse once DNPs count), so it failed its rule
 * (docs/evidence/2026-09-22/weekly-construction-grade.md). S-03's walk-forward grade
 * failed it again in 2023 and 2024, both windows. It does win slightly more start/sit
 * calls than it loses (52-57% of the calls it changes): a ranking-only version is a
 * separate idea with its own pre-registration. BETTING_LINE_LIFT below is the
 * one switch. Start/Sit (lineup-brain.js#startSitWeekPoints), the League Hub card
 * (trade-engine.js#lineupDiffWeekPoints) and the waiver horizon (horizonValueWithVegas)
 * all read vegasLift, so all three now apply 1 without an edit of their own. The
 * multiplier itself is gameScriptLift, kept for the studies that grade it; no served
 * module calls it (test/served-weekly-construction.test.js pins that).
 *
 * NOT covered by this switch, and said so: two fantasy producers multiply sampled volume
 * by gameScriptFor's multipliers directly, the Ceiling tab (ceiling-lineup.js:108-110) and
 * the season simulation behind title/playoff odds and trade impact (season-sim.js:224-225).
 * Their owners are S-06 and S-05. test/served-weekly-construction.test.js lists every
 * caller of gameScriptFor, so a third one cannot appear unlisted and a fixed one has to
 * leave the list.
 */
export const BETTING_LINE_LIFT = Object.freeze({
  on: false,
  decided_by: 'S-02 pre-registered grade, 2025 held out (the lift arm failed in weeks 2-4 and 5-17); ' +
    'S-03 walk-forward, 2023 and 2024 (failed in all four season-windows); applied by S-03',
  evidence: 'docs/evidence/2026-09-22/weekly-construction-grade.md; docs/evidence/2026-09-22/weekly-construction-walk-forward.md',
  reason: 'Graded as a fantasy multiplier, it never made weekly projections more accurate in 2023-2025, and in ' +
    '2025 it made weeks 2-4 worse and weeks 5-17 worse once missed games count.'
});

/**
 * The served betting-line lift for one player this week: gameScriptLift when
 * BETTING_LINE_LIFT is on, otherwise multiplier 1 with `applied: false`. When the market
 * has something notable to say, the reading still says it (Start/Sit shows it as
 * "Betting market"), and says the number leaves it out. The result carries only what the
 * served callers read (multiplier, applied, line, reading).
 */
export function vegasLift(player, season, week) {
  const market = gameScriptLift(player, season, week);
  if (BETTING_LINE_LIFT.on) return market;
  return { multiplier: 1, line: market.line, applied: false, reading: liftOffReading(player, market) };
}

/** The Start/Sit sentence for a notable line while the lift is off: the fact, and that the number leaves it out. */
function liftOffReading(player, market) {
  // Exactly when the lift used to speak: gameScriptLift writes a reading only for a
  // multiplier of 1.06 or more, or 0.94 or less.
  if (!market.applied || !market.line || market.reading == null) return null;
  const { total, spread } = market.line;
  const at = `${spread > 0 ? '+' : ''}${spread}`;
  const leftOut = 'This week\'s number does not add a betting-line adjustment for it: in testing, that adjustment ' +
    'made weekly projections less accurate.';
  return market.multiplier > 1
    ? `Vegas has ${player.team_abbr} in a ${total}-point game at ${at}. ${leftOut}`
    : `Vegas expects a low-scoring game for ${player.team_abbr} (${total} total, ${at}). ${leftOut}`;
}

/**
 * The betting-line game-script multiplier for one player this week: the code vegasLift
 * applied before S-03, unchanged. Studies that grade the lift read it here
 * (scripts/weekly-construction-walk-forward.mjs); served code reads vegasLift, which is
 * the switch.
 */
export function gameScriptLift(player, season, week) {
  if (!player?.team_abbr) return { multiplier: 1, line: null, applied: false };
  let gs;
  try { gs = gameScriptFor(player.team_abbr, season, week); }
  catch (error) {
    // No multiplier is a safe number to serve, but the failure is logged rather than
    // swallowed: no served payload carries a lift error, so the log is where it shows.
    console.error(`[waiver-brain] game-script model failed for ${player.team_abbr}, ${season} W${week}; ` +
      `the lift reads as no adjustment: ${error.message}`);
    return { multiplier: 1, line: null, applied: false };
  }
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
 * do not disagree about how much a single Sunday is worth. While BETTING_LINE_LIFT is
 * off, vegasLift reports `applied: false` and this is the plain horizon value.
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
    // Whether the lineup solver can put a number on this player at all. Carried
    // on the row so every consumer of this pool — waiverUpgrades here, and
    // byePatches in roster-risk.js — can tell "no gain" apart from "not
    // modelled" without re-deriving the position rules.
    .map(p => ({ ...p, horizon_value: horizonValue(p, week), lineup_modelled: LINEUP_MODELLED.has(p.position) }))
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
  // analysis answer the wrong question: it weighs this week the same in week 13
  // as in week 3, and cannot see a playoff-week bye. Annotating each player with
  // a horizon value and optimising on THAT is a one-line change to the solve and
  // a real change to what comes out of it. (It used to also claim to read each
  // player's weeks 15-17 schedule strength; that multiplier failed validation and
  // is 1 — see horizonValue.)
  //
  // The same annotation is where the betting model would enter: the Vegas game-script
  // multiplier scales this week's slice of each player's value when BETTING_LINE_LIFT
  // is on. It is off (S-03); see vegasLift.
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
  // Positions that were in the pool and could never have produced a gain,
  // because the solver does not score them. Collected rather than inferred from
  // an empty list, so the note below states a fact about the model instead of
  // leaving the reader to conclude one about the roster.
  const unmodelled = [...new Set(available.filter(fa => !fa.lineup_modelled).map(fa => fa.position))].sort();
  for (const fa of available) {
    // Dropped here, named below. Falling out at `gain <= 0.05` instead would be
    // the same list and a different meaning: a structural zero read as a verdict.
    if (!fa.lineup_modelled) continue;
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
      // Same units as a trade's gain, so the two can be ranked against each other.
      // The basis travels with the number, because that is the one thing a page
      // ranking a fitted acceptance probability beside an unfitted one cannot
      // otherwise know. One token here; the sentence is on the payload.
      accept_probability: CLAIM_FRICTION,
      accept_probability_basis: CLAIM_FRICTION_BASIS,
      expected_value: r2(gain * CLAIM_FRICTION),
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
        ? `Priced mostly on his weekly rate for the fantasy playoff weeks (byes counted), which is what matters from here.`
        : `Priced mostly on this week and the rest of the regular season; the playoff weeks are a secondary factor.`
    });
  }

  upgrades.sort((a, b) => b.expected_value - a.expected_value);

  // Decision Inbox publish (additive — everything returned below this point is
  // unchanged for every existing caller). "Add a free-agent RB before waivers
  // process" is the audit's own lead waiver example. Gated at 0.75 expected
  // points/week: acceptance here is ~1 (nobody has to agree to a waiver claim,
  // per this file's own header), so the bar for "worth a recommendation" is
  // lower than a trade's, but a near-zero gain still shouldn't spam the inbox.
  // See server/routes/decision-inbox.js for publishRecommendation() and
  // server/migrations/019_decision_recommendations.js for the schema.
  try {
    const top = upgrades[0];
    if (top && top.expected_value >= 0.75) {
      const teamKey = String(myTeamId ?? lg.my_team_id ?? me.roster_id);
      publishRecommendation({
        dedupKey: `waiver:${lg.id}:${teamKey}`,
        leagueId: lg.id, sport: 'NFL', type: 'waiver',
        subjectIds: [top.player.id, ...(top.replaces ? [top.replaces.id] : [])],
        title: `Add ${top.player.name} before waivers process`,
        rationale: top.why + (top.drop_candidate ? ` Drop candidate: ${top.drop_candidate.name}.` : ''),
        expectedValue: top.expected_value,
        // Deliberately null, and NOT top.accept_probability. This column is
        // shared: the trade publisher writes `headline.p_right` into it
        // (trade-engine.js:2874) — a fitted estimate of how often that model is
        // right. A waiver's 0.9 is a different quantity entirely, a hand-set
        // claim-friction haircut, and writing it here would put two unlike
        // numbers under one heading where nothing downstream could separate
        // them. An absent confidence is a smaller lie than a borrowed one.
        // Whether a waiver recommendation is right is answerable — it wants a
        // walk-forward over past claims — and until it is answered this stays
        // null. The friction factor is still on the upgrade itself, with its
        // basis, for anything that wants it.
        confidence: null,
        urgency: top.expected_value >= 2 ? 'high' : top.expected_value >= 1.2 ? 'medium' : 'low',
        // This league's actual waiver-processing day isn't threaded into this
        // module today, so this is a judgment-call heuristic (72h) rather than
        // a computed processing deadline — flagged rather than silently assumed.
        expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
        sourceModel: 'waiver-brain', sourceVersion: 'v1', link: '/brain'
      });
    }
  } catch { /* Decision Inbox publish is a side effect; never break waiverUpgrades over it. */ }

  return {
    league: lg.name, owner: me.owner, season, week,
    playoff_weight: weight,
    pool_size: available.length,
    // Not a warning and not an error: a statement of what this list does not
    // cover, printed whenever the pool held such a player. Empty when it did
    // not, so it never becomes the sort of note that appears on every page and
    // trains a reader to skip it.
    not_modelled: unmodelled.length
      ? { positions: unmodelled, in_pool: available.filter(fa => !fa.lineup_modelled).length,
          why: `${unmodelled.join(' and ')} are not scored by the lineup solver, so no ${unmodelled.join(' or ')} ` +
            'can appear above however well he is playing. Their absence here is a limit of the model, not a read on them.' }
      : null,
    // Stated once rather than per row, like `not_modelled` above and `scored_on`
    // below: it is the same sentence for every upgrade in the list. Named for the
    // thing rather than for the row's field, so one name never carries two shapes
    // in one response — `acceptance` is an object here, and each upgrade's
    // `accept_probability_basis` is the bare token.
    acceptance: { basis: CLAIM_FRICTION_BASIS, value: CLAIM_FRICTION, why: CLAIM_FRICTION_WHY },
    vegas_lines_available: available.filter(p => p.vegas?.applied).length,
    scored_on: `Lineups are solved on a horizon value: ${Math.round(weight * 100)}% the fantasy playoff weeks ` +
      `(weekly rate, byes counted, no matchup adjustment) and ${100 - Math.round(weight * 100)}% this week plus ` +
      'the rest of the regular season, with this week\'s share scaled by the betting market\'s ' +
      'game script for each player\'s team.',
    upgrades: upgrades.slice(0, limit),
    drop_candidates: droppable.slice(0, 4).map(p => ({
      ...slim(p),
      horizon_value: p.horizon_ppg,
      why: `Lowest value on your bench on the horizon that matters, and you carry ` +
        `${countAt(p.position)} at ${p.position}.`
    })),
    // The reassuring branch is a claim about the roster, so it may only be made
    // when there was actually a search to fail. With an empty or unpriceable
    // pool it reported a total data outage as good news, which is the most
    // literal form of the app telling you something it does not know.
    note: upgrades.length
      ? 'Ranked on the same scale as trades. A waiver claim needs nobody to agree, so a smaller ' +
        'gain here often outranks a larger trade nobody will sign.'
      : available.length === 0
        ? 'No free agent could be priced, so nothing was searched. That is missing data, not a verdict ' +
          'on your roster.'
        : 'No free agent would crack your lineup. That is a good sign about the roster, not a failure ' +
          'of the search.' + (unmodelled.length
            ? ` It does not cover ${unmodelled.join(' or ')}, which this model does not score at all.`
            : '')
  };
}

/**
 * Sell-high on your roster, read from the one hype producer (S-19).
 *
 * This used to fit its own per-position log-log curve of FantasyCalc value on
 * projected production and flag anyone a standard deviation above it. That curve
 * had no test, no caller (its route is retired, trades.js), and on the same
 * rostered players it disagreed with players.js's momentum heuristic on 57 of its
 * 89 flags (docs/tdd/2026-09-23-s19-one-hype-producer.tdd.md). It now reads
 * services/hype.js#playerHype for each rostered player and flags only what that
 * producer calls SELL, which today is nobody: hype is default-off.
 *
 * Rosters come from trade-engine#loadRosters (the canonical roster mapper) over
 * a bare id/name/position map, because hype needs no pricing.
 */
export function sellHigh(leagueId, { myTeamId = null, limit = 5 } = {}) {
  const lg = row(`SELECT id, platform, payload, my_team_id FROM leagues WHERE id = ?`, leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };
  const assets = new Map(rows('SELECT id, name, position, sleeper_id, espn_id FROM players')
    .map(p => [p.id, p]));
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };
  const { week } = tradeWeekContext();
  const readings = me.players.map(p => ({
    id: p.id, name: p.name, position: p.position,
    hype: playerHype({ sleeperId: p.sleeper_id })
  }));
  return {
    week,
    candidates: readings.filter(x => x.hype.verdict === 'SELL').slice(0, limit),
    readings,
    method: `Hype is read from ${HYPE_PRODUCER} (TM-09 revealed trade prices, price minus value). `
      + 'It ships default-off, so no player is flagged until it passes a forward test.'
  };
}

const slim = p => ({
  id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
  espn_id: p.espn_id, ppg: p.ppg, adj_ppg: p.adj_ppg,
  value: p.value, bye: p.bye,
  injury: p.injury ?? null
});
