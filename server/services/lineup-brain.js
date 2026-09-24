/**
 * Who to start this week, and how sure that is.
 *
 * The single most-used decision in fantasy football, and until now the only
 * major one with no page. The pieces existed and answered narrower questions:
 * `bestLineup` solves the optimum, `lineupDiff` compares it to what you
 * submitted, `gameScriptFor` prices the betting market's view, `weekly-trends`
 * measures role changes. None of them met.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A RANKING IS NOT AN ANSWER
 *
 * Every start/sit tool ranks players by projected points and calls the top N
 * your lineup. That is right on average and it hides the only thing a manager
 * actually needs, which is how close the call was. Starting an 11.4 over an 11.2
 * and starting a 16.0 over a 6.0 are rendered identically, and they are not the
 * same decision: the first is a coin flip where the projection's own error
 * dwarfs the gap, and treating it as a real edge is how people talk themselves
 * into agonising over noise.
 *
 * So every call here carries a margin and an honest confidence derived from it,
 * and the near-ties are labelled as ties rather than dressed up as decisions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VARIANCE POINT, which most tools get backwards
 *
 * The highest-expectation lineup is not always the right lineup. If you are a
 * heavy underdog this week, playing the safe option maximises your average score
 * and your average score is not what you need — you need a tail. If you are a
 * heavy favourite the reverse holds: variance can only hurt you. `ceiling-lineup`
 * already implements this properly and nothing surfaced it, so the objective is
 * exposed here as a choice with the reason attached.
 */
import { row, rows } from '../db/index.js';
import { deriveFormat } from './format.js';
import {
  assetUniverse, loadRosters, lineupSlots, pinnedBestLineup, tradeWeekContext, lineupDiff
} from './trade-engine.js';
import { rosterLocks, lockPins, kickoffLabel } from './lineup-lock.js';
import { vegasLift } from './waiver-brain.js';
import { fantasyContext } from './nfl-spread-context.js';
import { playerCase } from './player-case.js';
import { careerLine } from './player-career.js';
import { preseasonProjection } from './preseason-model.js';
import { offseasonAdjustment } from './offseason-model.js';
import { availabilityDegradation } from './contingency.js';
import { deadStarters } from './dead-starters.js';
import { espnZeroInactive } from './espn-zero-inactive.js';

const r1 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(1));
const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/* ───────────────────────────────────────────────────────────────────────────
 * PLAYER EVIDENCE
 *
 * The weekly number that decides a start/sit is `week_points`, and it stays the
 * coordinator's validated projection. What was missing is the record behind the
 * two names: how often each man actually posted a startable week last season,
 * where his floor sits, what his career says, what the preseason model's band
 * is, and whether his situation changed over the summer. None of that
 * re-projects anything — it explains a margin and flags a risk.
 *
 * Every source is optional and every read is guarded. A missing module, a
 * missing table or a player with no record degrades to null for that layer,
 * never to a broken lineup.
 * ────────────────────────────────────────────────────────────────────────── */

/** The fewest recorded weeks before a floor/ceiling means anything. */
export const MIN_WEEKS = 4;
/** A "startable" week: the line most managers use for a starter's floor. */
export const STARTABLE_WEEK = 15;

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const idx = q * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * The shape of one season's weekly scoring, from `player_gamelog`.
 *
 * Floor and ceiling are the 20th and 80th percentile weeks rather than the
 * single worst and best: a one-off injury week or a 40-point outlier is not the
 * floor or the ceiling a manager should plan around. `games_15plus` is the count
 * that most directly answers "how often was he a starter".
 */
export function weeklyShape(playerId, season) {
  if (playerId == null || !Number.isFinite(Number(season))) return null;
  let pts;
  try {
    pts = rows(`SELECT fantasy_points FROM player_gamelog WHERE player_id = ? AND season = ? ORDER BY week`,
      playerId, season).filter(r => r.fantasy_points != null).map(r => Number(r.fantasy_points)).filter(Number.isFinite);
  } catch { return null; }   // table absent — it is created lazily by the edge routes
  if (pts.length < MIN_WEEKS) return null;
  const sorted = [...pts].sort((a, b) => a - b);
  return {
    season,
    games: pts.length,
    ppg: r1(pts.reduce((s, v) => s + v, 0) / pts.length),
    floor: r1(quantile(sorted, 0.2)),
    ceiling: r1(quantile(sorted, 0.8)),
    games_15plus: pts.filter(v => v >= STARTABLE_WEEK).length,
    worst: r1(sorted[0]),
    best: r1(sorted[sorted.length - 1])
  };
}

/**
 * The live sources. Injectable so a caller (or a test) can swap any of them for
 * a stub or for null and prove the page still renders.
 */
export const DEFAULT_PROVIDERS = Object.freeze({
  career: (id, season) => careerLine(id, { season }),
  preseason: (id, season) => preseasonProjection(id, season),
  offseason: (id, season) => offseasonAdjustment(id, season),
  weekly: (id, season) => weeklyShape(id, season - 1)
});

/** A meaningful offseason read: it either has drivers or moved the multiplier. */
const offseasonMatters = o =>
  !!o && ((o.drivers?.length ?? 0) > 0 || Math.abs((o.opportunity_multiplier ?? 1) - 1) >= 0.05);

/**
 * The one-line, number-first case. Same construction as the draft room's
 * `evidenceHeadline` (draft-assist.js), rebuilt here rather than imported
 * because that module pulls in route files this service should not depend on.
 */
export function statHeadline({ career, preseason, offseason }) {
  const bits = [];
  if (career?.headline) bits.push(career.headline);
  else if (career?.streaks?.length) {
    const s = career.streaks[0];
    bits.push(`${Number(s.threshold).toLocaleString('en-US')}+ ${String(s.stat).replace('_', ' ')} × ${s.seasons} straight`);
  }
  if (preseason?.drivers?.length) bits.push(preseason.drivers[0]);
  if (offseason?.drivers?.length && Math.abs((offseason.opportunity_multiplier ?? 1) - 1) >= 0.08) bits.push(offseason.drivers[0]);
  return bits.join(' · ') || null;
}

const SEASON_KEYS = ['season', 'games', 'ppr_points', 'ppg', 'pos_rank', 'rush_att', 'rush_yds', 'rush_td',
  'targets', 'rec', 'rec_yds', 'rec_td', 'pass_att', 'pass_yds', 'pass_td', 'int'];
const pickSeason = s => {
  const out = {};
  for (const k of SEASON_KEYS) if (s[k] != null) out[k] = s[k];
  // The draft components read `carries`; the career line calls it rush_att.
  if (s.rush_att != null) out.carries = s.rush_att;
  return out;
};

/**
 * Everything the page can say about one player, from whichever layers answer.
 *
 * Returns null when no layer has anything — a rookie with no gamelog, no career
 * and no projection renders nothing rather than a strip of dashes.
 */
export function candidateEvidence(playerId, season, providers = DEFAULT_PROVIDERS) {
  if (playerId == null) return null;
  const safe = fn => { try { return fn() ?? null; } catch { return null; } };
  const career = safe(() => providers.career?.(playerId, season));
  const preseason = safe(() => providers.preseason?.(playerId, season));
  const offseasonRaw = safe(() => providers.offseason?.(playerId, season));
  const weekly = safe(() => providers.weekly?.(playerId, season));
  const offseason = offseasonMatters(offseasonRaw) ? offseasonRaw : null;

  const last = career?.seasons?.[0] ?? null;
  const headline = statHeadline({ career, preseason, offseason });
  const out = {
    headline,
    career: career?.seasons?.length ? {
      headline: career.headline ?? null,
      seasons: career.seasons.slice(0, 3).map(pickSeason),
      consistency: career.consistency ?? null,
      streaks: (career.streaks ?? []).filter(s => (s.seasons ?? 0) >= 2).slice(0, 4),
      trend: career.trend ?? null
    } : null,
    last_season: last ? {
      season: last.season, games: last.games ?? null, points: r1(last.ppr_points),
      ppg: r1(last.ppg), pos_rank: last.pos_rank ?? null
    } : null,
    weekly,
    preseason: preseason?.points != null ? {
      points: r1(preseason.points), ppg: r2(preseason.ppg),
      expected_games: r1(preseason.expected_games),
      p20: r1(preseason.p20), p80: r1(preseason.p80),
      drivers: (preseason.drivers ?? []).slice(0, 3)
    } : null,
    // Evidence and a risk flag only. The offseason multiplier is documented as
    // not additive over a depth-aware projection, so it is never multiplied
    // into week_points here — it is shown, with its confidence, and that is all.
    offseason: offseason ? {
      opportunity_multiplier: r2(offseason.opportunity_multiplier),
      confidence: offseason.confidence ?? null,
      drivers: (offseason.drivers ?? []).slice(0, 3),
      risk: (offseason.opportunity_multiplier ?? 1) < 0.92
    } : null
  };
  if (!out.headline && !out.career && !out.last_season && !out.weekly && !out.preseason && !out.offseason) return null;
  return out;
}

/** The evidence without the season table — for lists that show many players. */
export function compactEvidence(ev) {
  if (!ev) return null;
  const { career, ...rest } = ev;
  return {
    ...rest,
    consistency: career?.consistency
      ? { seasons_counted: career.consistency.seasons_counted ?? null,
        seasons_top24: career.consistency.seasons_top24 ?? null,
        seasons_top12: career.consistency.seasons_top12 ?? null }
      : null
  };
}

/**
 * The number that decides it, as a sentence: "Last year A hit 15+ in 12 of 17
 * games (floor 8.1) vs B 6 of 16 (floor 4.3)." Falls back through the layers
 * so two players with no gamelog are still compared on something real, and
 * says nothing rather than something vague when there is nothing to compare.
 */
export function deciderText(a, b, nameA, nameB) {
  if (!a || !b) return null;
  if (a.weekly && b.weekly) {
    return `Last year ${nameA} hit ${STARTABLE_WEEK}+ in ${a.weekly.games_15plus} of ${a.weekly.games} games ` +
      `(floor ${a.weekly.floor}) vs ${nameB} ${b.weekly.games_15plus} of ${b.weekly.games} (floor ${b.weekly.floor}).`;
  }
  if (a.preseason?.p20 != null && b.preseason?.p20 != null) {
    return `Preseason range ${Math.round(a.preseason.p20)}–${Math.round(a.preseason.p80)} pts for ${nameA} ` +
      `vs ${Math.round(b.preseason.p20)}–${Math.round(b.preseason.p80)} for ${nameB}.`;
  }
  if (a.last_season?.ppg != null && b.last_season?.ppg != null) {
    return `${nameA} ${a.last_season.ppg} ppg over ${a.last_season.games} games last year vs ` +
      `${nameB} ${b.last_season.ppg} over ${b.last_season.games}.`;
  }
  return null;
}

/** One evidence lookup per player per call, however many slots he appears in. */
export function evidenceCache(season, providers = DEFAULT_PROVIDERS) {
  const memo = new Map();
  return id => {
    if (id == null) return null;
    if (!memo.has(id)) memo.set(id, candidateEvidence(id, season, providers));
    return memo.get(id);
  };
}

/**
 * How often the higher projection actually wins, measured.
 *
 * This used to be a judgement: a point and a half is inside the projection's
 * error, four points is a real gap, and the comment here said so plainly so it
 * could be argued with. It was argued with. The curve below replaces the
 * judgement with an enumeration.
 *
 * Every rate is a TAIL rate — of the calls whose margin was at least `margin`,
 * this share saw the higher projection score strictly more actual PPR. That is
 * the quantity a threshold is answerable for: put the strongest label above
 * 7.15 and you are claiming 80% of those calls are right. It is NOT the rate
 * within a band, and the two must not be read for each other.
 *
 * `n` is the number of pairs in the tail, or null where the source reports the
 * rate without the count. Null is "not published", not zero.
 */
export const DECISION_CURVE = {
  source: 'docs/evidence/2026-09-22/start-sit-decision-curve.md',
  universe: 'same-week pairs with both projections at least 8.0 PPR (startable), '
    + '656,705 pairs fully enumerated over 25,323 out-of-sample predictions, 2018-2025',
  // The caveat that governs every number above, carried with them rather than
  // left in the document: this was measured on a research-baseline projection
  // whose startable MAE is 6.085, not on production's own out-of-sample
  // week_points, and production carries a betting-line lift the baseline has no
  // term for. The curve is a property of a projection's error distribution, so
  // a better or worse projection moves all of it. Re-derive before treating any
  // boundary here as a constant of the game.
  measured_on: 'a research-baseline projection (startable MAE 6.085), not production\'s own '
    + 'out-of-sample week_points; re-derive on production before trusting a boundary',
  points: [
    { margin: 1.5, win_rate: 0.665, n: 453775 },
    { margin: 2.5, win_rate: 0.691, n: 343831 },
    { margin: 4.0, win_rate: 0.726, n: 213340 },
    { margin: 6.0, win_rate: 0.772, n: 97013 },
    { margin: 7.15, win_rate: 0.800, n: 58132 },
    { margin: 9.0, win_rate: 0.839, n: 23728 },
    { margin: 9.57, win_rate: 0.85, n: null },
    { margin: 12.71, win_rate: 0.90, n: 2617 }
  ]
};

/**
 * The measured win rate for a margin, or null when nothing was measured that low.
 *
 * The rate returned is the one belonging to the largest anchor at or below the
 * margin. Nothing is interpolated between anchors and nothing is extrapolated
 * past the last one, so every number this returns is one that was counted. A
 * margin under the smallest anchor gets null — no rate at all — rather than a
 * number invented to fill the gap.
 */
export function decisionWinRate(margin) {
  if (typeof margin !== 'number' || !Number.isFinite(margin)) return null;
  let rate = null;
  for (const point of DECISION_CURVE.points) {
    if (point.margin > margin) break;
    rate = point.win_rate;
  }
  return rate;
}

/**
 * The win rate the strongest label has to earn before it may be used.
 *
 * Stated as a rate rather than as a number of points, deliberately: the
 * boundary then follows the measurement, and re-deriving the curve on a better
 * projection moves the threshold with it instead of leaving a stale constant
 * behind a word.
 */
const CLEAR_WIN_RATE = 0.80;

/**
 * A gap of a point and a half is inside the projection's own error. The band
 * below it measures 52.9% — a coin flip, which is what the label already calls
 * it — so this one is left where it was rather than derived. Note 52.9% is the
 * rate WITHIN that band, not a tail rate, and so is not on the curve above.
 */
export const TIE_THRESHOLD = 1.5;
export const TIE_BAND_WIN_RATE = 0.529;

/**
 * A measured rate as a percentage for reading out loud. One decimal, kept only
 * when it says something: 0.726 reads "72.6" and 0.80 reads "80", because
 * rounding 72.6 to 73 throws away precision that was actually counted.
 */
const pct = rate => String(Math.round(rate * 1000) / 10);

/** The smallest measured margin whose tail rate earns the strongest label. */
export const CLEAR_THRESHOLD =
  DECISION_CURVE.points.find(p => p.win_rate >= CLEAR_WIN_RATE).margin;

const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * This week's number for one player, on the Start/Sit basis.
 *
 * current_week_ppg (trade-engine's week projection: the coordinator-corrected weekly
 * number times his chance to play, 0 on a bye) times the betting-line game-script
 * multiplier when there is a line for his game. Exported so every page that prints a
 * week total prices a player exactly as Start/Sit does: the matchup card
 * (lineup-posture.js) used to sum raw current_week_ppg, so its "You" figure and the
 * Start/Sit projection disagreed by 0.3-2.0 points on all five live leagues and, in
 * two of them, named a different FLEX. trade-engine.js#lineupDiffWeekPoints is the
 * same construction for the League Hub card.
 */
export function startSitWeekPoints(p, season, week) {
  // BROKEN-G flag on: the asset already carries blend.week (blend-week.js), built
  // this same way once per universe; read it instead of lifting a second time.
  if (Number.isFinite(p?.blend_week)) {
    return { week_points: p.blend_week, vegas: p.blend_week_vegas ?? { multiplier: 1, line: null, applied: false } };
  }
  const lift = vegasLift(p, season, week);
  // adj_ppg is a 25%-current/75%-rest-of-season blend built for the trade horizon, not
  // this decision, so it is only a fallback for a player with no week number at all.
  // current_week_ppg is 0 (not null) on a bye, so a real bye is never masked.
  const base = p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0;
  // Unlike the trade horizon, this is the full multiplier: the whole decision IS this week.
  return { week_points: r2(base * (lift.applied ? lift.multiplier : 1)), vegas: lift };
}

/** ESPN's lineup slot id for IR (trade-engine.js SLOT_NAME). */
const ESPN_IR_SLOT = 21;

/**
 * Who on one roster is on IR, with why — the rule every other lineup surface already
 * uses: waiver-wire.js (never a drop), lineup-posture.js#rosterAssets (never in the
 * matchup lineup) and trade-engine.js#lineupDiff, the League Hub card (never
 * recommended in). ESPN's IR slot (lineupSlotId 21), or ESPN injury status
 * INJURY_RESERVE. A player in the IR slot cannot score for this team until he is moved
 * out of it; one ESPN lists on injured reserve is out for weeks.
 *
 * Sleeper keeps IR as the roster's `reserve` list. Returns Map<player id, reason>.
 */
export function irOnRoster(lg, rosterId, players) {
  const out = new Map();
  let payload;
  try { payload = JSON.parse(lg.payload); } catch { return out; }
  if (lg.platform === 'sleeper') {
    const ro = (payload.rosters ?? []).find(r => String(r.roster_id) === String(rosterId));
    const reserve = new Set((ro?.reserve ?? []).map(String));
    for (const p of players) {
      if (p.sleeper_id != null && reserve.has(String(p.sleeper_id))) {
        out.set(p.id, 'In your IR slot: he cannot start until you move him out of it.');
      }
    }
    return out;
  }
  const team = (payload.teams ?? []).find(t => String(t.id) === String(rosterId));
  for (const e of team?.roster?.entries ?? []) {
    const pl = e.playerPoolEntry?.player;
    if (!pl) continue;
    const inSlot = e.lineupSlotId === ESPN_IR_SLOT;
    if (!inSlot && pl.injuryStatus !== 'INJURY_RESERVE') continue;
    // Matched the way loadRosters() put him on the roster: ESPN id first, then name.
    const p = players.find(x => x.espn_id != null && String(x.espn_id) === String(pl.id))
      ?? players.find(x => norm(x.name) === norm(pl.fullName));
    if (!p) continue;
    out.set(p.id, inSlot
      ? 'In your IR slot: he cannot start until you move him out of it.'
      : 'ESPN lists him on IR (injured reserve), so he is not expected to play.');
  }
  return out;
}


/**
 * The week's lineup, with every call explained and graded by how close it was.
 *
 * @param objective 'mean' for the highest average, 'ceiling' when you need a
 *   tail because you are an underdog, 'floor' when you are favoured and only
 *   variance can hurt you.
 */
export function lineupCall(leagueId, { myTeamId = null, objective = 'mean', providers = DEFAULT_PROVIDERS,
  now = Date.now(), inactive = null } = {}) {
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

  // IR players are out of the call entirely: not started, not the benched
  // alternative a starter "beat", not on the bench list. This page used to be the
  // one lineup surface that ignored IR, so on the 2026-W2 sync it listed Jordyn Tyson
  // (IR slot, leagues 2 and 3) as a bench option and, under "Protect the floor",
  // STARTED Zach Charbonnet (IR slot, OUT) and A.J. Brown (ESPN injured reserve) in
  // league 4 — while the League Hub card refused both. They are reported in `on_ir`.
  const irReason = irOnRoster(lg, me.roster_id, me.players);

  // RL-4-2: a player whose game has kicked off (or ESPN already locked) cannot move.
  // A locked starter keeps his slot and is not re-solved; a locked bench player is
  // never started, never the alternative a starter "beat", never a bench option.
  // The same rule and the same pinned solve as the League Hub card (lineup-lock.js,
  // trade-engine.js#pinnedBestLineup). It used to solve every slot all Sunday.
  const locks = rosterLocks(lg, me.roster_id, me.players, { season, week, now });
  const pins = lockPins(locks);

  // Annotate every player with this week's market view before solving. The
  // betting model already prices how much volume a team's game script implies,
  // and a start/sit call is exactly the horizon where that matters most — it is
  // a decision about one Sunday, which is the only thing a single week's line
  // describes. startSitWeekPoints() is the one construction, shared with the
  // matchup card.
  // RL-10-1: the one inactive producer (ESPN projects 0; default-off) unless the caller
  // supplies a hook. Read once: the dead-starter card AND the solver use the same flag, so
  // the card can never say "likely inactive" about a player the lineup below still starts.
  const inactiveHook = inactive ?? espnZeroInactive(lg.id, { season, week });
  const flaggedInactive = p => !!(inactiveHook?.covered && inactiveHook.ids?.has(p.id));
  const annotated = me.players.filter(p => !irReason.has(p.id)).map(p => {
    const { week_points: weekPoints, vegas } = startSitWeekPoints(p, season, week);
    // A flagged player is held out of the solve the way season-ending players are
    // (available: false): not started, not the alternative, not on the bench list.
    return flaggedInactive(p)
      ? { ...p, vegas, week_points: weekPoints, available: false, inactive_flag: true }
      : { ...p, vegas, week_points: weekPoints };
  });

  // SS-01: what is SET on ESPN that will score zero, with the best healthy bench
  // replacement priced on this same week_points basis (dead-starters.js).
  const deadStarterCheck = deadStarters(lg, me.roster_id, me.players, {
    season, week, weekPoints: new Map(annotated.map(p => [p.id, p.week_points])),
    accepts: slotAccepts, now,
    inactive: inactiveHook
  });

  /*
   * The ceiling/floor objective used to be dead. The guard compared the players
   * carrying the requested key against EVERY rostered player, and kickers and
   * defences never carry a ceiling (95 of the 102 missing values across all 46
   * synced rosters were K/DEF), so it failed on essentially every roster and
   * silently solved on week_points — while the response still said
   * objective: 'ceiling'. The underdog's "give me variance" request was answered
   * with the mean lineup, labelled as the ceiling lineup. (Its fallback was also a
   * ternary with two identical branches, the tell that it was never finished.)
   *
   * Now: coverage is measured over the skill players the solver can actually
   * start. Skill players without the requested field are held out of the solve
   * and reported by name, rather than mixed in on a different basis. If holding
   * them out would leave a slot unfillable, the whole solve falls back to
   * week_points and SAYS so — the response carries the objective actually used.
   */
  const requestedKey = objective === 'ceiling' ? 'ceiling' : objective === 'floor' ? 'floor' : 'week_points';
  const skill = annotated.filter(p => SKILL_POSITIONS.has(p.position));
  const lacking = skill.filter(p => !Number.isFinite(p[requestedKey]));
  let key = requestedKey;
  // bestLineup's sort is stable, so an exact tie on the key keeps this order: highest
  // week_points first, never roster order. Distinct key values are unaffected.
  const byWeekPoints = pool => [...pool].sort((a, b) => (b.week_points ?? 0) - (a.week_points ?? 0));
  // A locked starter holds his slot whatever the objective: when the pool holds him
  // out (no ceiling/floor on file) he is added back, pinned, rather than letting the
  // solve hand his slot to someone who can no longer move into it.
  const solve = (pool, k) => pinnedBestLineup(
    [...pool, ...annotated.filter(p => pins.has(p.id) && !pool.includes(p))], slots, k, pins);
  let solvePool = byWeekPoints(requestedKey === 'week_points' ? annotated : annotated.filter(p => !lacking.includes(p)));
  // A key on which every startable skill player has the same value ranks no one. At
  // 2026 week 2 every floor is 0 (a did-not-play week scores 0 and no live chance to
  // play exceeds 0.9, so each p10 is 0): optimising it returned roster order as "the
  // floor lineup", projection 0, every margin a +0 coin flip.
  const rankable = new Set(solvePool.filter(p => SKILL_POSITIONS.has(p.position) && p.available !== false)
    .map(p => p[requestedKey]));
  let optimal = requestedKey !== 'week_points' && rankable.size <= 1 ? null : solve(solvePool, key);
  let objectiveFallback = null;
  if (!optimal) {
    objectiveFallback = `every player's ${requestedKey} is ${[...rankable][0] ?? 'missing'} this week, so it cannot ` +
      'rank anyone; the lineup was solved on week_points instead';
    key = 'week_points';
    solvePool = byWeekPoints(annotated);
    optimal = solve(solvePool, key);
  } else if (requestedKey !== 'week_points' && optimal.holes?.length) {
    objectiveFallback = `holding out the ${lacking.length} player(s) with no ${requestedKey} would leave ` +
      `${optimal.holes.join('/')} unfilled, so the lineup was solved on week_points instead`;
    key = 'week_points';
    solvePool = annotated;
    optimal = solve(solvePool, key);
  }
  const objectiveUsed = key;

  const startingIds = new Set(optimal.slots.map(s => s.player?.id).filter(Boolean));
  // The alternative must come from the pool the solver could actually have
  // chosen from. `bestLineup` excludes anyone flagged unavailable — season-ending
  // injury, released — and the first version of this did not, so it offered an
  // out-for-the-year running back as the man being beaten and printed NEGATIVE
  // margins: "Tony Pollard over Jonathan Taylor by -2.56", which reads as the
  // optimiser contradicting itself when it was right all along.
  const startable = annotated.filter(p => p.available !== false && !pins.has(p.id));
  const bench = startable.filter(p => !startingIds.has(p.id) && (p.week_points ?? 0) > 0)
    .sort((a, b) => b.week_points - a.week_points);
  // Who each start "beat" has to be chosen on the SAME basis the lineup was solved
  // on, and the margin computed on that basis only. It used to pick the alternative
  // by week_points and then subtract `(p[key] ?? p.week_points)`, so under a ceiling
  // objective a starter's p90 could be compared against a benched player's MEAN.
  // For the default week_points objective this is the same list as `bench`.
  const alternatives = startable
    .filter(p => !startingIds.has(p.id) && Number.isFinite(p[key]) && (p.week_points ?? 0) > 0)
    .sort((a, b) => b[key] - a[key] || (b.week_points ?? 0) - (a.week_points ?? 0));
  // Bench players who could legally start but carry no weekly projection. Both
  // lists above filter on `week_points > 0`, so when the projection pipeline
  // yields nothing these players vanish from the comparison and every slot
  // comes back "only option" — which then printed "Nobody else on the roster
  // can fill FLEX" with three benched flex-eligible players sitting there. An
  // empty alternatives list for want of a number is not the same fact as a
  // roster with one eligible player, and only this list can tell them apart.
  const unpricedBench = startable
    .filter(p => !startingIds.has(p.id) && !((p.week_points ?? 0) > 0));
  // Kept separately and reported, because "why is my best back on the bench" is
  // the first question this page has to answer.
  const unavailable = annotated
    .filter(p => p.available === false && (p.inactive_flag || (p.adj_ppg ?? 0) > 4))
    .map(p => ({ name: p.name, position: p.position, team_abbr: p.team_abbr,
      adj_ppg: p.adj_ppg, injury: p.injury_status ?? null,
      why: p.inactive_flag
        ? `${inactiveHook.sentence ?? 'Likely gameday inactive'}, so the solver will not start him.` +
          (inactiveHook.label ? ` ${inactiveHook.label}` : '')
        : 'Flagged out for the season or released, so the solver will not start him.' }));

  // No touchdown-luck flag (RL-8-1). "Running hot" / "Due to score" read a board the
  // consensus rest-of-season rank already prices (R&D r8, 2021-24), joined by display
  // name; it moved no lineup and told the reader something the market already knew.

  // Situational context per team, computed once rather than per player.
  //
  // This is the same module the betting audit reads, pointed at a lineup. Wind
  // above about 15 mph is the clearest example of why it belongs here: it moves
  // passing volume enough to change a start/sit and barely moves a spread,
  // because the market prices it into the total while the fantasy projection
  // never saw it at all.
  const teamCtx = new Map();
  for (const p of annotated) {
    if (!p.team_abbr || teamCtx.has(p.team_abbr)) continue;
    try { teamCtx.set(p.team_abbr, fantasyContext(p.team_abbr, season, week)); }
    catch { teamCtx.set(p.team_abbr, null); }
  }

  // Every start, with what it beat and by how much.
  // One failure must not take the lineup down with it — a missing opponent or a
  // thin week should cost the football case, not the page.
  const safeCase = (p, yr, wk) => {
    try { return playerCase(p, yr, wk); } catch { return null; }
  };

  // The record behind each name — career, last season's weekly shape, the
  // preseason band, the offseason read. Looked up once per player.
  const record = evidenceCache(season, providers);

  const lockedWhy = id => {
    const l = locks.byId.get(id);
    const at = kickoffLabel(l?.kickoff);
    return l?.reason === 'espn_locked'
      ? 'Locked on ESPN: his game has started, so he cannot be moved out of this slot.'
      : `Locked: his game kicked off${at ? ` (${at})` : ''}, so he cannot be moved out of this slot.`;
  };
  // Bench players who could fill a slot but are locked out of it.
  const lockedOut = slot => annotated.filter(b => pins.has(b.id) && !startingIds.has(b.id)
    && b.available !== false && slotAccepts(slot, b.position)).length;
  const calls = optimal.slots.filter(s => s.player).map(s => {
    const p = s.player;
    const locked = pins.has(p.id);
    // The best benched player who could legally fill this slot. None for a locked
    // slot: nobody can take it.
    const alt = locked ? null : alternatives.find(b => slotAccepts(s.slot, b.position));
    const margin = alt ? r2(p[key] - alt[key]) : null;
    const unpricedHere = alt ? [] : unpricedBench.filter(b => slotAccepts(s.slot, b.position));
    // The labels' thresholds and the win-rate curve were measured on week_points
    // gaps. Under "Chase the ceiling" / "Protect the floor" the margin is a gap
    // between two p90s (or p10s): a wider, differently shaped quantity nobody has
    // measured a hit rate for. It used to go through both anyway, so a 15-point
    // ceiling gap printed "Clear" and "has won about 90%" (RL-3-4).
    const calibrated = objectiveUsed === 'week_points';
    const confidence = locked ? 'locked' : margin == null
      ? (unpricedHere.length ? 'no projection' : 'only option')
      : !calibrated ? 'not measured'
        : margin >= CLEAR_THRESHOLD ? 'clear'
          : margin >= TIE_THRESHOLD ? 'lean'
            : 'coin flip';
    // What that margin actually measured. Null below the smallest anchor, which
    // is every coin flip — the band has its own rate, and it is not a tail rate.
    // Null on any other objective: the curve does not describe that margin.
    const winRate = calibrated ? decisionWinRate(margin) : null;
    const mine = record(p.id);
    const theirs = alt ? record(alt.id) : null;
    const decider = alt ? deciderText(mine, theirs, p.name, alt.name) : null;

    return {
      slot: s.slot,
      player: { id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
        adj_ppg: p.adj_ppg, week_points: p.week_points, bye: p.bye,
        injury: p.injury_status ?? null, active_probability: p.active_probability ?? null,
        evidence: mine },
      over: alt ? { id: alt.id, name: alt.name, position: alt.position, week_points: alt.week_points,
        evidence: theirs } : null,
      margin, confidence,
      // How often a call at this margin has actually been right, measured rather
      // than implied by the label. The word alone overclaims at every threshold a
      // real lineup reaches, so the number travels with it.
      confidence_win_rate: winRate,
      // The deciding number, stated separately so the UI can set it apart from
      // the margin sentence and so a test can check it without parsing prose.
      decider,
      vegas: p.vegas?.reading ?? null,
      vegas_multiplier: p.vegas?.applied ? p.vegas.multiplier : null,
      // The football case: who is throwing, what defence he faces, what his own
      // staff calls, who else is hurt, the weather and his usage trend — ordered by
      // how much each actually moves the decision.
      // The whole reason this page was shallow is that it had none of this.
      football: safeCase(p, season, week),
      // Only flags that touch this player's position, so a receiver is not told
      // about a running back's game script.
      conditions: (teamCtx.get(p.team_abbr)?.flags ?? [])
        .filter(f => f.affects === 'everyone' || f.affects === p.position
          || (f.affects === 'passing' && ['QB', 'WR', 'TE'].includes(p.position)))
        .map(f => ({ kind: f.kind, severity: f.severity, note: f.note })),
      why: locked ? lockedWhy(p.id) : margin == null
        ? (unpricedHere.length
          ? `${unpricedHere.length} other player${unpricedHere.length === 1 ? '' : 's'} could fill ` +
            `${s.slot}, but none of them has a weekly projection, so nothing was compared. ` +
            'This is missing data, not a clear call.'
          : lockedOut(s.slot)
            ? `Nobody else who can still move can fill ${s.slot}: ${lockedOut(s.slot)} bench ` +
              `player${lockedOut(s.slot) === 1 ? '\'s game has' : 's\' games have'} already kicked off.`
            : `Nobody else on the roster can fill ${s.slot}.`)
        : !calibrated
          ? `${margin} points ahead of ${alt.name} on ${objectiveUsed === 'ceiling'
            ? 'good-week ceilings' : 'bad-week floors'}, not projections. No win rate has been ` +
            'measured for a gap like this, so none is shown.' +
            (decider ? ` ${decider}` : '')
          : confidence === 'coin flip'
            ? `Only ${margin} points ahead of ${alt.name}. That gap is inside the projection's own ` +
              `error — below ${TIE_THRESHOLD} points the higher projection has won ` +
              `${pct(TIE_BAND_WIN_RATE)}% of the time, so this is a tie. Start whichever you ` +
              'prefer and do not spend the afternoon on it.' +
              (decider ? ` If you want a tiebreaker, the record is the honest one: ${decider}` : '')
            : `${margin} points ahead of ${alt.name}.` +
              (winRate ? ` At a gap this size the higher projection has won about ${pct(winRate)}% ` +
                'of the time.' : '') +
              (decider ? ` ${decider}` : '')
    };
  });

  const coinFlips = calls.filter(c => c.confidence === 'coin flip');
  // Slots where an eligible bench player existed but carried no projection.
  const unprojected = calls.filter(c => c.confidence === 'no projection');
  const risky = calls.filter(c => (c.player.active_probability ?? 1) < 0.75 || c.player.bye === week);

  // Which availability model priced every chance to play on this page, and — when it is
  // not the validated role layer — why not. Honest degradation over a confident wrong
  // number: on the pooled path these percentages are systematically low for healthy
  // starters, so every one of them travels with that fact attached rather than reading
  // like the fitted number. `availability_basis` alone was not enough; it was served
  // from here since review-fixes-2 and no page ever read it.
  const availabilityBasis = assets.context?.availability_basis ?? null;
  const availabilityNote = availabilityDegradation(availabilityBasis);

  // What you actually submitted, when the platform exposes it.
  let submitted = null;
  try { const d = lineupDiff(lg, myTeamId ?? lg.my_team_id, { assets, now }); if (!d.error) submitted = d; }
  catch { /* ESPN only, and not always readable */ }

  return {
    league: lg.name, owner: me.owner, season, week, objective,
    // What week_points is built from: the one produced basis the matchup card and the
    // League Hub card carry (fantasy-coordinator.js#weekConstructionBasis, FIX-166-4).
    week_basis: assets.context?.week_basis ?? null,
    // Starters set on ESPN who are Out, Doubtful, IR, on bye or inactive, each with a
    // one-tap bench replacement (suggested, never applied). The page shows it first.
    dead_starters: deadStarterCheck,
    // What was actually optimised, which is not always what was asked for.
    objective_used: objectiveUsed,
    objective_fallback: objectiveFallback,
    objective_held_out: objectiveUsed === requestedKey && requestedKey !== 'week_points'
      ? lacking.map(p => ({ name: p.name, position: p.position, week_points: p.week_points,
        why: `no ${requestedKey} distribution on file, so he could not be ranked on it` }))
      : [],
    // The curve behind those labels was measured on the point projection — the
    // MEAN weekly points analogue. A margin between two ceilings (or two floors) is
    // a wider, differently shaped quantity, so neither the labels nor the win rates
    // are calibrated for it, and `confidence_win_rate` must not be read as measured
    // on anything but week_points.
    confidence_basis: objectiveUsed === 'week_points' ? 'calibrated_on_week_points'
      : `uncalibrated_for_${objectiveUsed}`,
    // Where every `confidence_win_rate` above comes from, including the caveat that
    // it was measured on a research baseline rather than on this projection. A page
    // printing the rate has to be able to say so.
    confidence_curve: DECISION_CURVE,
    // Which availability model priced every chance to play in this call ('role' |
    // 'pooled' | 'constants', plus the missing fit tables), so the page can say so.
    availability_basis: availabilityBasis,
    // null when that model is the validated role layer; otherwise the inert layer with
    // its reason, effect and fix, for the page to print above the percentages.
    availability_note: availabilityNote,
    projected_points: r2(optimal.points),
    lineup: calls,
    // Starting slots the solver could not fill. `calls` filters these out, so a
    // lineup with an empty tight end spot rendered as a complete lineup and the
    // page said nothing — while the user had a hole on ESPN. bestLineup has
    // computed this all along and lineupCall only read it inside the objective
    // fallback branch.
    holes: optimal.holes ?? [],
    bench: bench.slice(0, 8).map(p => ({
      id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
      week_points: p.week_points, vegas: p.vegas?.reading ?? null,
      evidence: compactEvidence(record(p.id))
    })),
    submitted,
    unavailable,
    // On IR (ESPN IR slot or injured-reserve status): never started, never the
    // alternative, never on the bench list. Named here so the page can say why.
    on_ir: me.players.filter(p => irReason.has(p.id)).map(p => ({
      name: p.name, position: p.position, team_abbr: p.team_abbr, why: irReason.get(p.id)
    })),
    team_conditions: [...teamCtx.entries()]
      .filter(([, c]) => c && !c.insufficient && c.flags.length)
      .map(([team, c]) => ({ team, opponent: c.opponent, home: c.home,
        market: c.market, conditions: c.conditions, flags: c.flags })),
    coin_flips: coinFlips.length,
    // Slots where an eligible bench player existed but carried no weekly
    // projection, so no comparison happened. Counted separately from coin
    // flips: one is a close call, the other is no call at all.
    not_compared: unprojected.length,
    warnings: risky.map(c => ({
      player: c.player.name,
      issue: c.player.bye === week ? 'on bye this week'
        // active_probability is THIS week's chance to play (the injury report and the
        // availability model, contingency.js; its role layer adds recent missed games),
        // not a share of weeks. "Only plays about 19% of weeks" would misdescribe a
        // starter who has missed his last two games.
        // ...and it is not "plays" either. The fitted model's event is RECORDED USAGE
        // — a target, a carry or an attempt (scripts/fit-availability.mjs, "WHAT
        // 'AVAILABLE' MEANS HERE"): deliberately not "dressed", because a player who
        // suits up and touches the ball zero times scores zero and this number feeds a
        // fantasy projection. The fit's own header warns that this puts its levels
        // BELOW published "percent who played" figures. So "likely to play" overstates
        // what the number knows, and it overstates it most for exactly the players
        // carrying a designation — the band where the fit moves furthest, and the only
        // one that moves DOWN. Said plainly instead, which is true on every basis:
        // the durability prior behind the constants path is also a usage rate.
        : `about ${Math.round((c.player.active_probability ?? 0.9) * 100)}% likely to suit up and see the ball this week` +
          // A bye is a fact; a chance to play is a model output, and it is only allowed
          // to be stated bare when the model that produced it is the validated one.
          // UX-08: plain words. `availabilityNote.reason` names tables and a doc path;
          // this string is rendered on the Start/Sit card (Lineup.tsx "Check before
          // kickoff"), so it says what is true without the operator detail, which
          // stays on availability_note for the console.
          (availabilityNote ? ' — but that is not the fitted number: the role layer is not running, so this is a fallback estimate' : ''),
      // 'role' | 'pooled' | 'constants', so a reader of one warning can see it too.
      availability_basis: c.player.bye === week ? null : availabilityBasis?.basis ?? null,
      slot: c.slot
    })),
    objectives: [
      { id: 'mean', label: 'Highest average',
        when: 'The default, and right when the matchup is close.' },
      { id: 'ceiling', label: 'Chase the ceiling',
        when: 'You are a heavy underdog. Your average score is not what you need — you need a tail, ' +
          'and the safe lineup maximises exactly the wrong thing.' },
      { id: 'floor', label: 'Protect the floor',
        when: 'You are a heavy favourite. Variance can only cost you the game from here.' }
    ],
    // "Every call has a real margin behind it" was said whenever there were no
    // coin flips — including when there were no margins at all, because nothing
    // had a projection to compare. A claim about the quality of the calls may
    // only be made about calls that were actually made.
    note: coinFlips.length
      ? `${coinFlips.length} of these calls are inside the projection's own error and are labelled ` +
        'as ties rather than dressed up as decisions. Weekly projections miss by five or six points ' +
        'on a starter; a gap of one is not a finding.'
      : unprojected.length
        ? `${unprojected.length} of these slots had other eligible players on the bench with no weekly ` +
          'projection, so no comparison was made for them. That is missing data, not a clear call.'
        : 'Every call this week has a real margin behind it.'
  };
}

/** Which positions a slot will accept, matching the solver's own rules. */
function slotAccepts(slot, position) {
  const s = String(slot).toUpperCase();
  if (s === position) return true;
  if (s === 'FLEX' || s === 'W/R/T') return ['RB', 'WR', 'TE'].includes(position);
  if (s === 'W/R') return ['RB', 'WR'].includes(position);
  if (s === 'W/T') return ['WR', 'TE'].includes(position);
  if (s === 'SUPERFLEX' || s === 'OP') return ['QB', 'RB', 'WR', 'TE'].includes(position);
  return false;
}

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
