/**
 * WAIVERS PERISHABLE (plan item 13; research R10; ONE-PLAN 4d spot-check row 9).
 *
 * League 4 (and every synced ESPN league) resets the waiver order every week, in
 * reverse standings (acquisitionSettings.waiverOrderReset, read by
 * league-rules.js#leagueRules, the one producer of league rules). Priority not
 * spent this week is gone, so it is perishable. Three rules follow; the evidence
 * record is docs/tdd/2026-09-25-waivers-perishable.tdd.md.
 *
 *   (a) Never advise "save priority" in a weekly-reset league. assertPerishable
 *       throws rather than let such text be served; it is always on, because it
 *       only refuses wording and moves no number.
 *   (b) Handcuff advice needs a workload test. handcuffWorkload reads the
 *       contingency.js#cascades evidence: the backup must have carried a real
 *       workload in games his starter actually missed.
 *   (c) D/ST streaming reads points allowed. paTier maps the market's expected
 *       points allowed (the opponent's implied total, streaming-board.js) to the
 *       ESPN points-allowed tier and the league's own points for it.
 *
 * The new served fields (the perishable block on claim_priority, the points-allowed
 * fields on the streaming board) appear only with GRIDIRON_WAIVERS_PERISHABLE=1,
 * and are labelled shadow: they move no ranking, suggestion or number.
 */

/** This unit's own switch; the shared preview switch never turns it on. */
export const PERISHABLE_ENV = 'GRIDIRON_WAIVERS_PERISHABLE';

/** Read per call so a test or a run can flip it. */
export function perishableEnabled(env = process.env) {
  return env[PERISHABLE_ENV] === '1';
}

/* ------------------------------------------------------------ (a) priority */

// "save / hold / keep / conserve / protect / bank / don't burn / don't waste /
// don't use ... priority (or waiver position/spot)", within a few words.
const SAVE_VERB = String.raw`(?:save|saving|hold(?:ing)?|keep(?:ing)?|conserv(?:e|ing)|protect(?:ing)?|bank(?:ing)?|preserv(?:e|ing)|sit on|`
  + String.raw`(?:do not|don't|dont|never|no need to)\s+(?:burn|waste|spend|use|blow))`;
const PRIORITY = String.raw`(?:priority|waiver (?:position|spot|order|rank))`;
const SAVE_PRIORITY_RE = new RegExp(String.raw`\b${SAVE_VERB}\b(?:\s+\S+){0,3}?\s+${PRIORITY}\b`, 'i');

/** True when a sentence tells the reader to hold on to waiver priority. */
export function advisesSavingPriority(text) {
  return typeof text === 'string' && SAVE_PRIORITY_RE.test(text);
}

/**
 * Refuse served text that advises saving priority in a weekly-reset league.
 * Throws: a hard rule is enforced by failing, never by quietly rewriting.
 */
export function assertPerishable(text, { resets_weekly } = {}) {
  if (resets_weekly === true && advisesSavingPriority(text)) {
    throw new Error(`waiver priority is perishable in this league (weekly reset); refused text: ${JSON.stringify(text)}`);
  }
  return text;
}

export const PERISHABLE_ADVICE = 'Priority resets every week, so a spot you do not use this week is gone. '
  + 'Claim a real upgrade before the reset rather than waiting.';

/**
 * The perishable block for claim_priority (waiver-wire.js#claimPriority). Says
 * something only for a weekly-reset league; a rolling or budget league gets
 * `perishable: false` and no advice, and an unknown rule gets null.
 */
export function perishableBlock({ resets_weekly, uses_budget } = {}) {
  const perishable = uses_budget === true ? false : resets_weekly ?? null;
  const advice = perishable === true ? assertPerishable(PERISHABLE_ADVICE, { resets_weekly: true }) : null;
  return { perishable, advise_save_priority: false, advice, shadow: true };
}

/* ---------------------------------------------------------- (b) handcuffs */

/**
 * The workload test, pre-registered (guess, chosen not fitted): a backup counts as a
 * handcuff only if, in at least MIN_WORKLOAD_GAMES games his starter missed, he
 * averaged at least MIN_WORKLOAD_OPPORTUNITIES[position] opportunities (targets +
 * carries + pass attempts, contingency.js#cascades `opportunity_without`).
 */
export const MIN_WORKLOAD_GAMES = 2;
export const MIN_WORKLOAD_OPPORTUNITIES = Object.freeze({ RB: 12, WR: 6, TE: 4, QB: 25 });

/** Test one handcuffValue entry ({ position, paths: [...] }) on its best path. */
export function handcuffWorkload(entry) {
  const floor = MIN_WORKLOAD_OPPORTUNITIES[entry?.position] ?? null;
  const paths = Array.isArray(entry?.paths) ? entry.paths : [];
  if (floor == null) return { passes: false, reason: `no workload bar for position ${entry?.position ?? 'unknown'}` };
  if (!paths.length) return { passes: false, reason: 'no game on record where his starter missed' };
  const best = [...paths].sort((a, b) => (b.opportunity_without ?? 0) - (a.opportunity_without ?? 0))[0];
  const games = best.games_observed ?? 0;
  const opp = best.opportunity_without ?? 0;
  const base = { starter: best.starter ?? null, games_observed: games, opportunity_without: opp,
    min_games: MIN_WORKLOAD_GAMES, min_opportunities: floor };
  if (games < MIN_WORKLOAD_GAMES) {
    return { ...base, passes: false, reason: `only ${games} game(s) without his starter; need ${MIN_WORKLOAD_GAMES}` };
  }
  if (opp < floor) {
    return { ...base, passes: false, reason: `averaged ${opp} opportunities a game without his starter; the workload bar is ${floor}` };
  }
  return { ...base, passes: true, reason: `averaged ${opp} opportunities over ${games} games without his starter` };
}

/** The one handcuff wording (roster-risk.js#fragility). Conditional on the workload test. */
export const HANDCUFF_READING = 'That is not a downgrade, it is an empty slot. A backup off the wire only covers it '
  + 'if he has already carried the workload in games the starter missed; check that before spending a roster spot.';

/* ------------------------------------------------------ (c) points allowed */

/** ESPN points-allowed tiers (espn-stat-ids.js): [upper bound inclusive, label, stat id]. */
const PA_TIERS = [
  [0, '0', 89], [6, '1-6', 90], [13, '7-13', 91], [17, '14-17', 92], [21, '18-21', 121],
  [27, '22-27', 122], [34, '28-34', 123], [45, '35-45', 124], [Infinity, '46+', 125]
];

/**
 * The points-allowed tier at the market's expected score (rounded to a whole point,
 * as a real score is) and what this league pays for it. `points` is
 * scoringFor(lg, { slot: 16 }).espn.points. A tier the league does not pay is null.
 */
export function paTier(expected, points = {}) {
  if (expected == null || !Number.isFinite(+expected)) return null;
  const pa = Math.max(0, Math.round(+expected));
  const [, tier, statId] = PA_TIERS.find(([hi]) => pa <= hi);
  const p = points?.[statId];
  return { tier, stat_id: statId, points: typeof p === 'number' ? p : null };
}
