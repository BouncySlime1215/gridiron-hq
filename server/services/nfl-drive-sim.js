/**
 * Play-by-play game simulation.
 *
 * Every other model in this app predicts a FINAL MARGIN directly — one team
 * rating minus another, fitted against historical results. That approach has
 * been measured exhaustively here and it does not beat the closing line: none
 * of the 21 component models cleared the bar against 15,096 games.
 *
 * This is a different kind of model. It does not predict the answer, it plays
 * the game — downs, distance, field position, clock, timeouts, fourth-down
 * decisions, two-point charts, overtime — thousands of times. The final score
 * is not forecast; it is what happened in the simulation, and the distribution
 * of those outcomes is the model's output.
 *
 * WHY THAT IS WORTH DOING even though the direct approach failed:
 *
 *   1. It produces a JOINT distribution over both teams' scores rather than a
 *      point estimate with an assumed error bar. Moneyline, spread and TOTAL
 *      are all read off the same simulated games, so they cannot contradict
 *      each other the way three separately-fitted models can.
 *   2. Totals come out correctly correlated with the margin. A shootout raises
 *      both scores at once — something a margin model structurally cannot say.
 *   3. Scoring is discrete and lumpy in a way that matters for betting. Real
 *      margins pile up on 3 and 7; a simulation that scores in touchdowns and
 *      field goals reproduces those key numbers, and a normal curve never will.
 *   4. Every input is a measurable team rate rather than a fitted coefficient,
 *      so when the model is wrong you can see which rate was wrong.
 *
 * WHAT IT DOES NOT CLAIM: that it beats the market. Calibration against real
 * NFL score distributions is a floor, not an edge. `calibrationReport()` and
 * `backtest()` exist so that stays checkable rather than asserted.
 *
 * Structure: learned team rates in `nfl-sim-learn.js`, twenty strategic
 * decision modules in `nfl-sim-policy.js`, and the engine that runs them here.
 */
import { rows } from '../db/index.js';
import { randn, withRandomSeed, random } from './stats-util.js';
import { learnedProfiles, blendedProfiles, expectedPointsSurface, expectedPoints } from './nfl-sim-learn.js';
import * as P from './nfl-sim-policy.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

const HALF = 1800;

/* --------------------------------------------------------------- matchup */

/**
 * Blend one offence against one defence around the league mean.
 *
 * A rate on its own is meaningless — 5.5 yards per play is good against a great
 * defence and poor against a bad one — so each side is expressed relative to
 * league average and recombined multiplicatively.
 */
function blend(offRate, defRate, leagueRate, { lo = 0.55, hi = 1.75 } = {}) {
  if (!(leagueRate > 0) || !Number.isFinite(offRate) || !Number.isFinite(defRate)) {
    return Number.isFinite(offRate) ? offRate : leagueRate;
  }
  const ratio = (offRate / leagueRate) * (defRate / leagueRate);
  return leagueRate * clamp(ratio, lo, hi);
}

function buildContext(offProfile, defProfile, league) {
  const o = offProfile.rates, d = defProfile.rates, L = league;
  return {
    team: offProfile.team,
    rates: o,
    // efficiency, by play type
    ypa: blend(o.off_yards_per_attempt, d.def_yards_per_attempt, L.off_yards_per_attempt ?? 7.0),
    ypc: blend(o.off_yards_per_carry, d.def_yards_per_carry, L.off_yards_per_carry ?? 4.3),
    explosivePass: blend(o.off_explosive_pass_rate, d.def_explosive_pass_rate, L.off_explosive_pass_rate ?? 0.13),
    explosiveRush: blend(o.off_explosive_rush_rate, d.def_explosive_rush_rate, L.off_explosive_rush_rate ?? 0.07),
    intRate: blend(o.off_int_rate, d.def_int_rate, L.off_int_rate ?? 0.024),
    fumbleRate: blend(o.off_fumble_rate, d.def_fumble_rate, L.off_fumble_rate ?? 0.011),
    sackRate: blend(o.off_sack_rate, d.def_sack_rate, L.off_sack_rate ?? 0.066),
    stuffRate: blend(o.off_stuff_rate, d.def_stuff_rate, L.off_stuff_rate ?? 0.18),
    redZoneTd: blend(o.off_red_zone_td_rate, d.def_red_zone_td_rate, L.off_red_zone_td_rate ?? 0.222),
    // field-zone efficiency, so an offence that stalls in the red zone stalls
    zoneOwn: o.off_epa_own_territory ?? -0.03,
    zoneMid: o.off_epa_midfield ?? 0.02,
    zoneOpp: o.off_epa_opp_territory ?? 0.05,
    // Normalised against the LEAGUE's own volatility rather than a hardcoded
    // constant. The guessed 0.55 was 2.45x off the real 1.35, which inflated
    // every pass draw's spread and pushed the simulated median completion down
    // to 3 yards against a real 9.
    volatility: (o.off_epa_volatility ?? L.off_epa_volatility ?? 1.35)
      / (L.off_epa_volatility || 1.35),
    noHuddle: o.off_no_huddle_rate ?? 0.06,
    completionPct: o.off_completion_pct ?? 0.65
  };
}

/** Field-zone multiplier on yardage — offences are not equally good everywhere. */
function zoneFactor(ctx, yard) {
  const z = yard < 40 ? ctx.zoneOwn : yard < 70 ? ctx.zoneMid : ctx.zoneOpp;
  let f = 1 + clamp(z, -0.35, 0.35) * 0.5;
  // Everything compresses near the goal line: less field to work with, more
  // defenders per yard. This is why red-zone touchdown rate is its own stat.
  if (yard > 80) f *= 0.78;
  if (yard > 92) f *= 0.85;
  return f;
}

/* ------------------------------------------------------------ play outcome */

/**
 * Resolve one play — yards, whether the clock keeps running, turnover, type.
 *
 * Real NFL gains are strongly right-skewed: most plays are short, a few break
 * for forty. A symmetric draw would produce far too few explosive plays and far
 * too few losses, and a drive engine fed symmetric gains scores far too
 * consistently. This is a mixture whose explosive branch fires at the team's own
 * measured explosive rate and whose short branch is centred so the blend lands
 * on the matchup's yards per play by construction.
 */
/**
 * A right-skewed positive draw with a given mean.
 *
 * The first version of this engine used a symmetric normal for ordinary gains,
 * and auditing it against 2,901 real plays showed exactly why that is wrong:
 * it produced negative yardage on 26% of completions against a real 3.9%. A
 * caught pass essentially never loses yards, and a normal centred near 8 with
 * enough spread to make the tail work will inevitably go negative.
 *
 * Lognormal is the right shape — strictly positive, right-skewed, and its mean
 * can be pinned exactly by solving mu = ln(mean) - sigma²/2.
 */
function lognormalYards(targetMean, sigma) {
  const m = Math.max(0.4, targetMean);
  return Math.exp(Math.log(m) - (sigma * sigma) / 2 + randn() * sigma);
}

function runPlay(ctx, { yard, isPass, varianceMult, preventMult }) {
  const zf = zoneFactor(ctx, yard);

  if (isPass) {
    if (random() < ctx.sackRate) return { yards: -(5 + random() * 5), clockRuns: true, type: 'sack' };
    if (random() < ctx.intRate) return { yards: 0, turnover: 'interception', clockRuns: false, type: 'interception' };

    // Incompletion stops the clock, which is most of why passing is the
    // trailing team's instrument.
    const cp = clamp(ctx.completionPct, 0.45, 0.78);
    if (random() >= cp) return { yards: 0, clockRuns: false, type: 'incompletion' };
    if (random() < ctx.fumbleRate * 0.4) return { yards: 0, turnover: 'fumble', clockRuns: true, type: 'fumble' };

    // Screens and checkdowns behind the line. Measured at 3.9% of completions in
    // the real play log — small, but the only legitimate source of negative
    // passing yardage once sacks are handled separately.
    const LOSS_SHARE = 0.039, LOSS_MEAN = -2.5;
    if (random() < LOSS_SHARE) {
      return { yards: -(1 + random() * 3), clockRuns: true, type: 'pass' };
    }

    // `off_explosive_pass_rate` is measured per ATTEMPT, but we are already past
    // the completion check, so it has to be re-expressed per completion or the
    // engine throws far too few big plays.
    const expl = clamp((ctx.explosivePass / cp) * preventMult.explosive, 0.01, 0.45);
    if (random() < expl) {
      return { yards: (20 + -Math.log(1 - random()) * 11) * zf * preventMult.yards,
        clockRuns: true, type: 'explosive_pass' };
    }
    // Solve the ordinary-completion mean so the three branches together land on
    // this matchup's yards per completion.
    const explMean = 20 + 11;
    const rest = 1 - expl - LOSS_SHARE;
    const shortMean = (ctx.ypa / cp - expl * explMean - LOSS_SHARE * LOSS_MEAN) / Math.max(0.05, rest);
    const y = lognormalYards(shortMean, 0.62 * varianceMult * ctx.volatility);
    return { yards: y * zf * preventMult.yards, clockRuns: true, type: 'pass' };
  }

  if (random() < ctx.fumbleRate) return { yards: 0, turnover: 'fumble', clockRuns: true, type: 'fumble' };
  // A stuffed run is a gain of zero or less, which is what `off_stuff_rate`
  // measures — not a guaranteed loss. Treating every stuff as negative yardage
  // was doubling the real rate of losing carries.
  if (random() < ctx.stuffRate) {
    // Centred at -0.9 rather than -0.4: against 57,051 real carries the engine
    // was producing losses on 8.3% of runs versus a true 13.0%, because too many
    // "stuffed" runs were coming out at zero or better.
    return { yards: clamp(Math.round(randn() * 1.3 - 0.9), -7, 1), clockRuns: true, type: 'stuff' };
  }

  // An explosive RUSH is a 10+ yard carry, not a 20+ yard one — which is why
  // this rate (0.111 league-wide) sits ABOVE the explosive pass rate. Paying it
  // out at pass-sized yardage was inflating scoring badly.
  const expl = clamp(ctx.explosiveRush * preventMult.explosive, 0.005, 0.3);
  if (random() < expl) {
    // Scale 8, not 6: the real 99th-percentile carry goes 29 yards and the
    // shorter tail was topping out near 23. Breakaway runs are rare but they are
    // long, and truncating them quietly removes scoring the engine should have.
    return { yards: (10 + -Math.log(1 - random()) * 8) * zf * preventMult.yards,
      clockRuns: true, type: 'explosive_rush' };
  }
  // Ordinary carries: positive and right-skewed. The stuff branch above already
  // accounts for every run that fails, so this one solves for the mean that
  // makes all three branches average out to this matchup's yards per carry.
  const explMean = 10 + 8;
  const stuffMean = -0.9;
  const rest = 1 - expl - ctx.stuffRate;
  const shortMean = (ctx.ypc - expl * explMean - ctx.stuffRate * stuffMean) / Math.max(0.05, rest);
  const y = lognormalYards(shortMean, 0.60 * varianceMult);
  return { yards: y * zf * preventMult.yards, clockRuns: true, type: 'rush' };
}

/* ------------------------------------------------------------------- drive */

/**
 * Simulate one drive with full down-and-distance state.
 *
 * `yard` counts from the offence's own goal line, so 100 is a touchdown. The
 * policy modules are consulted at the points where a real coach faces a real
 * choice.
 */
function simulateDrive(ctx, state, ep) {
  const { secondsLeft, lead, timeouts, oppTimeouts, isHalfEnd, spread } = state;
  let yard = state.yard;
  let down = 1, toGo = 10, elapsed = 0, plays = 0;
  const decisions = [];

  // Modules 5/6, 7/8, 17 and 11: risk preference, pace, air yards, prevent —
  // all functions of leverage rather than constants.
  const variance = P.varianceProfile({ lead, secondsLeft, spread });
  const pace = P.paceProfile({ lead, secondsLeft, noHuddleRate: ctx.noHuddle, timeouts });
  const deep = P.deepShotPolicy({ rates: ctx.rates, varianceBonus: variance.deep_shot_bonus });
  const prevent = P.preventDefense({ lead: -lead, secondsLeft, oppYard: yard });
  const preventMult = { yards: prevent.yards_allowed_multiplier, explosive: prevent.explosive_allowed_multiplier };

  // Module 9: a state where snapping the ball at all is strictly negative.
  const kneel = P.kneelDecision({ lead, secondsLeft, timeouts: oppTimeouts, yard, isHalfEnd });
  if (kneel.call === 'kneel') {
    return { points: 0, seconds: secondsLeft, endYard: yard, kneel: true, plays: 0, decisions: [kneel] };
  }

  // Modules 14 and 15, evaluated once per drive: measured game-script pass rate
  // plus the capped under-passing lean.
  const script = P.gameScriptPassRate({ lead, secondsLeft, rates: ctx.rates });
  const lean = P.minimaxLean({ rates: ctx.rates });
  const basePassRate = clamp(script.pass_rate + lean.adjustment + deep.deep_rate * 0.15, 0.15, 0.94);

  while (elapsed < secondsLeft && plays < 30) {
    plays++;

    // Module 18: spend a down to stop the clock, but only inside the window
    // where that trade actually pays.
    const spike = P.spikeDecision({ secondsLeft: secondsLeft - elapsed, timeouts, yard, down });
    if (spike.call === 'spike') { elapsed += 2; down++; decisions.push(spike); continue; }

    // Down and distance dominate every other consideration: third-and-9 is a pass.
    let passRate = basePassRate;
    if (down === 3 && toGo >= 7) passRate = Math.max(passRate, 0.82);
    if (down === 3 && toGo <= 2) passRate = Math.min(passRate, 0.45);
    if (yard > 95) passRate = Math.min(passRate, 0.55);

    const isPass = random() < passRate;
    const play = runPlay(ctx, { yard, isPass, varianceMult: variance.variance_multiplier, preventMult });

    // Clock: a running play burns the play clock, an incompletion or sideline
    // throw stops it.
    const sideline = isPass && random() < pace.sideline_preference;
    elapsed += (play.clockRuns && !sideline) ? pace.seconds_running : pace.seconds_stopped;

    if (play.turnover) {
      // Roughly one in eighteen interceptions and one in forty lost fumbles is
      // returned for a score. Small rates, outsized effect: a defensive
      // touchdown is a 14-point swing in one play, and leaving them out is part
      // of why a naive drive simulator produces margins that are too narrow.
      const returnTd = play.turnover === 'interception'
        ? random() < 0.055 : random() < 0.025;
      return { points: 0, seconds: elapsed, endYard: clamp(yard, 1, 99),
        turnover: play.turnover, defensive_touchdown: returnTd, plays, decisions };
    }

    yard += play.yards;
    if (yard >= 100) return { points: 6, seconds: elapsed, endYard: 100, touchdown: true, plays, decisions };
    if (yard <= 0) return { points: 0, seconds: elapsed, endYard: 20, safety: true, plays, decisions };

    toGo -= play.yards;
    if (toGo <= 0) { down = 1; toGo = Math.min(10, 100 - yard); continue; }
    down++;
    if (down <= 4) continue;

    /* ------------------------------------------------------- fourth down */
    const need = Math.max(1, Math.ceil(toGo));

    // Module 2 first: inside seven minutes, win probability overrides points.
    const wp = P.fourthDownByWinProbability({ yard, toGo: need, lead,
      secondsLeft: secondsLeft - elapsed, spread });
    // Module 1 otherwise, shifted by module 16 for this staff's real aggression.
    const epCall = P.fourthDownByExpectedPoints({ yard, toGo: need, ep });
    const aggression = P.coachAggression({ rates: ctx.rates });
    // Module 13: the band where punt value collapses.
    const nml = P.noMansLand({ yard, toGo: need, ep });
    // Module 19: rare, but real.
    const safety = P.intentionalSafety({ lead, secondsLeft: secondsLeft - elapsed, yard, down: 4 });

    let call = wp?.call ?? epCall.call;
    if (!wp) {
      if (epCall.call !== 'go' && nml?.call === 'go') call = 'go';
      if (epCall.call === 'punt' && epCall.margin_over_next < aggression.ep_threshold_shift) call = 'go';
    }
    if (safety.call === 'safety') call = 'safety';
    decisions.push(wp ?? epCall);

    if (call === 'safety') {
      return { points: 0, seconds: elapsed + 5, endYard: 20, safety: true, plays, decisions };
    }
    if (call === 'field_goal') {
      const dist = (100 - yard) + 17;
      const made = random() < P.fieldGoalProbability(dist);
      return { points: made ? 3 : 0, seconds: elapsed + 6,
        endYard: made ? 25 : clamp(100 - yard, 1, 99),
        field_goal: { distance: Math.round(dist), made }, plays, decisions };
    }
    if (call === 'punt') {
      const net = 40 + randn() * 8;
      return { points: 0, seconds: elapsed + 12,
        endYard: clamp(100 - Math.min(yard + net, 99), 1, 99), punt: true, plays, decisions };
    }
    // Going for it: resolve the conversion here rather than letting the loop
    // silently hand out a fifth down.
    if (random() < P.conversionProbability(need)) {
      yard = Math.min(99, yard + need); down = 1; toGo = Math.min(10, 100 - yard);
      elapsed += pace.seconds_running;
      continue;
    }
    return { points: 0, seconds: elapsed + 5, endYard: clamp(100 - yard, 1, 99),
      turnover_on_downs: true, plays, decisions };
  }
  return { points: 0, seconds: elapsed, endYard: clamp(yard, 1, 99), clock_expired: true, plays, decisions };
}

/* -------------------------------------------------------------------- game */

/**
 * Draw this game's form for one team.
 *
 * A season profile is a team's AVERAGE, and no team plays its average every
 * Sunday — the same offence puts up 34 one week and 13 the next against
 * comparable defences. Simulating from season means alone treats that week-to-
 * week swing as if it did not exist, and the result is a margin distribution
 * far too narrow: the first version of this engine produced a standard
 * deviation of 10.7 against a real 14.2, which would have made every cover
 * probability it reported overconfident.
 *
 * `off_epa_volatility` is exactly the quantity being missed, and it is measured
 * per team, so a boom-bust offence swings more than a metronomic one.
 */
function drawGameForm(ctx) {
  const vol = clamp(ctx.volatility, 0.6, 1.6);
  // Lognormal so efficiency stays positive and the upside tail is fatter than
  // the downside, which is how offensive outbursts actually look.
  // Sigma solved the same way as the clock constants: it is the value that
  // makes simulated margin dispersion land on the real 14.16 without pushing
  // the mean total off. Too small and every cover probability is overconfident;
  // too large and the model has no opinion about anything.
  const shock = Math.exp(randn() * 0.100 * vol);
  return {
    ...ctx,
    ypa: ctx.ypa * shock,
    ypc: ctx.ypc * shock,
    explosivePass: clamp(ctx.explosivePass * shock, 0.01, 0.4),
    explosiveRush: clamp(ctx.explosiveRush * shock, 0.01, 0.35),
    // A team playing badly also turns it over more, so the shock runs the other
    // way on mistakes. This correlation is why blowouts compound.
    intRate: clamp(ctx.intRate / shock, 0.002, 0.12),
    fumbleRate: clamp(ctx.fumbleRate / shock, 0.001, 0.08)
  };
}

/** One full game: two halves, the two-minute warning, kickoffs, overtime. */
function simulateGame(homeCtxBase, awayCtxBase, ep, { homeFieldPoints, spread, collectLog = false }) {
  // Each team's form for THIS game, drawn once and held for all four quarters —
  // a team having a bad day has it for sixty minutes, not play by play.
  const homeCtx = drawGameForm(homeCtxBase);
  const awayCtx = drawGameForm(awayCtxBase);
  let home = 0, away = 0;
  const timeouts = { home: 3, away: 3 };
  const drives = [];
  const receivingSecondHalf = random() < 0.5 ? 'home' : 'away';
  let possession = receivingSecondHalf === 'home' ? 'away' : 'home';

  for (const half of [1, 2]) {
    let clock = HALF;
    timeouts.home = 3; timeouts.away = 3;
    if (half === 2) possession = receivingSecondHalf;
    let yard = 25;

    while (clock > 0) {
      const off = possession === 'home' ? homeCtx : awayCtx;
      const lead = possession === 'home' ? home - away : away - home;

      // Module 20: a free stoppage that reshapes the four minutes before it.
      const tmw = P.twoMinuteWarning({ lead, secondsLeft: clock,
        timeouts: timeouts[possession], hasBall: true });
      // Module 10: timeouts are a finite resource, spent or held deliberately.
      const to = P.timeoutPolicy({ lead, secondsLeft: clock, timeouts: timeouts[possession],
        onDefense: false });

      const d = simulateDrive(off, {
        yard, secondsLeft: clock, lead, timeouts: timeouts[possession],
        oppTimeouts: timeouts[possession === 'home' ? 'away' : 'home'],
        isHalfEnd: clock < 120, spread
      }, ep);

      let scored = d.points;
      if (d.touchdown) {
        // Module 3: the two-point chart, evaluated on the score AFTER the six.
        const leadAfter = (possession === 'home' ? home + 6 - away : away + 6 - home);
        const tp = P.twoPointDecision({ leadAfterTd: leadAfter, secondsLeft: clock });
        scored = 6 + (tp.call === 'two' ? (random() < 0.475 ? 2 : 0) : (random() < 0.945 ? 1 : 0));
      }
      if (d.safety) {
        // A safety scores for the DEFENCE, which is the whole point of module 19.
        if (possession === 'home') away += 2; else home += 2;
        scored = 0;
      }
      if (d.defensive_touchdown) {
        // The takeaway goes the other way and lands in the end zone.
        const six = 6 + (random() < 0.945 ? 1 : 0);
        if (possession === 'home') away += six; else home += six;
      }
      if (possession === 'home') home += Math.max(0, scored); else away += Math.max(0, scored);

      if (collectLog) {
        drives.push({ half, possession, start_yard: Math.round(yard), points: Math.max(0, scored),
          result: d.touchdown ? 'touchdown'
            : d.field_goal ? (d.field_goal.made ? `field goal ${d.field_goal.distance}yd` : `missed FG ${d.field_goal.distance}yd`)
              : d.turnover ? d.turnover
                : d.turnover_on_downs ? 'turnover on downs'
                  : d.safety ? 'safety' : d.kneel ? 'kneel' : d.punt ? 'punt' : 'clock expired',
          plays: d.plays, seconds: Math.round(d.seconds),
          two_minute_warning: tmw.approaching,
          decisions: (d.decisions ?? []).filter(x => x?.module).map(x => x.module) });
      }

      clock -= Math.max(15, d.seconds);
      if (clock <= 0) break;

      // Module 4: onside only when the clock genuinely cannot supply possessions.
      if (d.touchdown && half === 2 && clock < 360) {
        const myLead = possession === 'home' ? home - away : away - home;
        const on = P.onsideDecision({ lead: myLead, secondsLeft: clock,
          timeouts: timeouts[possession], spread });
        if (on.call === 'onside' && random() < 0.12) { yard = 45; continue; }
      }
      possession = possession === 'home' ? 'away' : 'home';
      yard = (d.points > 0 || d.kneel) ? 25 : clamp(d.endYard, 1, 99);
    }
  }

  // Overtime: both teams get a possession, then sudden death. Ties are possible.
  if (home === away) {
    let otClock = 600;
    let otPossession = random() < 0.5 ? 'home' : 'away';
    let had = 0;
    while (otClock > 0 && had < 8) {
      const off = otPossession === 'home' ? homeCtx : awayCtx;
      const lead = otPossession === 'home' ? home - away : away - home;
      const d = simulateDrive(off, { yard: 25, secondsLeft: otClock, lead, timeouts: 2,
        oppTimeouts: 2, isHalfEnd: false, spread }, ep);
      let pts = d.points;
      if (d.touchdown) pts = 6 + (random() < 0.945 ? 1 : 0);
      if (otPossession === 'home') home += Math.max(0, pts); else away += Math.max(0, pts);
      otClock -= Math.max(15, d.seconds);
      otPossession = otPossession === 'home' ? 'away' : 'home';
      had++;
      if (had >= 2 && home !== away) break;
    }
  }

  // Home-field advantage, applied as a scoring nudge rather than baked into the
  // rates, so it stays one visible knob that can be checked against reality.
  if (homeFieldPoints > 0 && random() < homeFieldPoints / 7) home += 7;

  return { home, away, drives };
}

/* -------------------------------------------------------------- public API */

let _epSurface = null;
/**
 * The expected-points surface, computed once by value iteration on this engine.
 *
 * A league-average offence plays a league-average defence from every field
 * position; what it scores IS the EP table. That makes EP self-consistent with
 * the simulator consuming it — stronger than borrowing a table fitted on a
 * different generative process.
 */
function epFor(league) {
  if (_epSurface) return _epSurface;
  const avg = { team: 'LEAGUE', rates: league };
  const ctx = buildContext(avg, avg, league);
  _epSurface = expectedPointsSurface(startYard => {
    const d = simulateDrive(ctx, { yard: startYard, secondsLeft: 900, lead: 0, timeouts: 3,
      oppTimeouts: 3, isHalfEnd: false, spread: null }, () => 0);
    return { points: d.points, endYard: d.endYard, turnover: !!d.turnover };
  }, { trials: 200 });
  return _epSurface;
}
export function clearSimCache() { _epSurface = null; }

/**
 * Run the simulation N times and read every market off the same games.
 *
 * @param spread  home-side spread, ESPN convention (negative = home favoured)
 * @param total   the posted over/under
 */
export function simulateMatchup({
  home, away, trials = 10000, season = null, spread = null, total = null,
  homeFieldPoints = 1.6, seed = null, sampleDrives = false
} = {}) {
  const prof = blendedProfiles({ season });
  const H = prof.teams.get(String(home ?? '').toUpperCase());
  const A = prof.teams.get(String(away ?? '').toUpperCase());
  if (!H || !A) {
    return { error: `no profile for ${!H ? home : away}`,
      available: [...prof.teams.keys()].sort() };
  }

  const homeCtx = buildContext(H, A, prof.league);
  const awayCtx = buildContext(A, H, prof.league);
  const surface = epFor(prof.league);
  const ep = y => expectedPoints(surface, y);

  const homeScores = new Array(trials), awayScores = new Array(trials);
  let exampleDrives = null;
  const run = () => {
    for (let i = 0; i < trials; i++) {
      const wantLog = sampleDrives && i === 0;
      const g = simulateGame(homeCtx, awayCtx, ep, { homeFieldPoints, spread, collectLog: wantLog });
      homeScores[i] = g.home; awayScores[i] = g.away;
      if (wantLog) exampleDrives = g.drives;
    }
  };
  if (seed != null) withRandomSeed(seed, run); else run();

  const margins = homeScores.map((h, i) => h - awayScores[i]);
  const totals = homeScores.map((h, i) => h + awayScores[i]);
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[clamp(Math.floor(p * s.length), 0, s.length - 1)]; };

  const homeWin = margins.filter(m => m > 0).length / trials;
  const tie = margins.filter(m => m === 0).length / trials;

  // Key numbers: the whole reason to simulate discrete scoring instead of
  // drawing from a normal. Real margins pile up on 3 and 7 and a continuous
  // curve cannot represent that.
  const keyNumbers = [1, 2, 3, 4, 6, 7, 10, 14].map(k => ({
    margin: k, probability: r4(margins.filter(m => Math.abs(m) === k).length / trials)
  }));

  const cover = spread == null ? null : (() => {
    const w = margins.filter(m => m + spread > 0).length;
    const p = margins.filter(m => m + spread === 0).length;
    return { home_cover: r4(w / trials), push: r4(p / trials), away_cover: r4((trials - w - p) / trials) };
  })();

  const ou = total == null ? null : (() => {
    const o = totals.filter(t => t > total).length;
    const p = totals.filter(t => t === total).length;
    return { over: r4(o / trials), push: r4(p / trials), under: r4((trials - o - p) / trials) };
  })();

  return {
    home: H.team, away: A.team, trials,
    season: prof.season, profile_fell_back: prof.fell_back,
    projection: {
      home_score: r2(mean(homeScores)), away_score: r2(mean(awayScores)),
      margin: r2(mean(margins)), total: r2(mean(totals)),
      margin_sd: r2(sd(margins)), total_sd: r2(sd(totals))
    },
    distribution: {
      margin: { p10: q(margins, 0.1), p25: q(margins, 0.25), p50: q(margins, 0.5),
        p75: q(margins, 0.75), p90: q(margins, 0.9) },
      total: { p10: q(totals, 0.1), p25: q(totals, 0.25), p50: q(totals, 0.5),
        p75: q(totals, 0.75), p90: q(totals, 0.9) }
    },
    key_numbers: keyNumbers,
    moneyline: { home_win: r4(homeWin), tie: r4(tie), away_win: r4(1 - homeWin - tie) },
    spread: spread == null ? null : { line: spread, ...cover },
    total: total == null ? null : { line: total, ...ou },
    example_drives: exampleDrives,
    policy_modules: P.MODULES.length,
    note: 'Scores are simulated play by play, not forecast. Moneyline, spread and total are read off ' +
      'the SAME simulated games, so they are mutually consistent by construction. Calibration ' +
      'against real NFL score distributions is a floor, not an edge.'
  };
}

/**
 * Finish a game already in progress, thousands of times.
 *
 * The pregame simulator has to start from a kickoff. Handed a live state from
 * the ESPN play feed — this score, this field position, this down, this much
 * clock — the same engine plays out only what remains, which is what makes a
 * live win probability an actual simulation rather than a curve fitted to
 * historical leads.
 */
export function simulateRemainder({
  home, away, trials = 4000, season = null, spread = null, total = null,
  state, homeFieldPoints = 0, seed = null
} = {}) {
  const prof = blendedProfiles({ season });
  const H = prof.teams.get(String(home ?? '').toUpperCase());
  const A = prof.teams.get(String(away ?? '').toUpperCase());
  if (!H || !A) return { error: `no profile for ${!H ? home : away}` };

  const homeCtx = buildContext(H, A, prof.league);
  const awayCtx = buildContext(A, H, prof.league);
  const surface = epFor(prof.league);
  const ep = y => expectedPoints(surface, y);

  const s = state ?? {};
  const startHome = s.homeScore ?? 0, startAway = s.awayScore ?? 0;
  const finalHome = new Array(trials), finalAway = new Array(trials);

  const run = () => {
    for (let i = 0; i < trials; i++) {
      // Form is drawn per trial: we know the score so far, not how the rest of
      // the game will go, so the remaining sixty minutes still carry the same
      // week-to-week uncertainty a pregame simulation does.
      const hc = drawGameForm(homeCtx), ac = drawGameForm(awayCtx);
      let h = startHome, a = startAway;
      let clock = Math.max(0, s.secondsLeft ?? 900);
      let possession = s.possession === 'away' ? 'away' : 'home';
      let yard = clamp(s.yard ?? 25, 1, 99);

      while (clock > 0) {
        const off = possession === 'home' ? hc : ac;
        const lead = possession === 'home' ? h - a : a - h;
        const d = simulateDrive(off, { yard, secondsLeft: clock, lead, timeouts: 3, oppTimeouts: 3,
          isHalfEnd: clock < 120, spread }, ep);
        let pts = d.points;
        if (d.touchdown) {
          const leadAfter = possession === 'home' ? h + 6 - a : a + 6 - h;
          const tp = P.twoPointDecision({ leadAfterTd: leadAfter, secondsLeft: clock });
          pts = 6 + (tp.call === 'two' ? (random() < 0.475 ? 2 : 0) : (random() < 0.945 ? 1 : 0));
        }
        if (d.safety) { if (possession === 'home') a += 2; else h += 2; pts = 0; }
        if (d.defensive_touchdown) {
          const six = 6 + (random() < 0.945 ? 1 : 0);
          if (possession === 'home') a += six; else h += six;
        }
        if (possession === 'home') h += Math.max(0, pts); else a += Math.max(0, pts);
        clock -= Math.max(15, d.seconds);
        possession = possession === 'home' ? 'away' : 'home';
        yard = (d.points > 0 || d.kneel) ? 25 : clamp(d.endYard, 1, 99);
      }
      finalHome[i] = h; finalAway[i] = a;
    }
  };
  if (seed != null) withRandomSeed(seed, run); else run();

  const margins = finalHome.map((h, i) => h - finalAway[i]);
  const totals = finalHome.map((h, i) => h + finalAway[i]);
  const homeWin = margins.filter(m => m > 0).length / trials;
  const tie = margins.filter(m => m === 0).length / trials;

  return {
    home: H.team, away: A.team, trials,
    current_score: { home: startHome, away: startAway },
    seconds_remaining: s.secondsLeft ?? null,
    projection: { home_score: r2(mean(finalHome)), away_score: r2(mean(finalAway)),
      margin: r2(mean(margins)), total: r2(mean(totals)), margin_sd: r2(sd(margins)) },
    live_moneyline: { home_win: r4(homeWin), tie: r4(tie), away_win: r4(1 - homeWin - tie) },
    live_spread: spread == null ? null : (() => {
      const w = margins.filter(m => m + spread > 0).length;
      const p = margins.filter(m => m + spread === 0).length;
      return { line: spread, home_cover: r4(w / trials), push: r4(p / trials),
        away_cover: r4((trials - w - p) / trials) };
    })(),
    live_total: total == null ? null : (() => {
      const o = totals.filter(t => t > total).length;
      const p = totals.filter(t => t === total).length;
      return { line: total, over: r4(o / trials), push: r4(p / trials), under: r4((trials - o - p) / trials) };
    })(),
    note: 'Simulated forward from the live state rather than fitted to historical leads, so the ' +
      'current field position and down are actually priced in.'
  };
}

/**
 * Raw play outcomes, for auditing the engine against the real play log.
 *
 * Deliberately returns the underlying yardage rather than a summary — the
 * audit's whole purpose is to compare distribution SHAPE, and a mean would
 * hide exactly the failure it is looking for.
 */
export function simulatePlaySample({ trials = 20000, season = null, seed = 99 } = {}) {
  // Deliberately the UNBLENDED profiles. This sample is audited against the real
  // play log, and if the engine's rates were themselves derived from that same
  // log the audit would be checking the corpus against itself and would pass no
  // matter how wrong the engine was.
  const prof = learnedProfiles({ season });
  const avg = { team: 'LEAGUE', rates: prof.league };
  const ctx = buildContext(avg, avg, prof.league);
  const out = { pass: [], rush: [], sack: [], incompletion: 0 };
  const noPrevent = { yards: 1, explosive: 1 };
  withRandomSeed(seed, () => {
    for (let i = 0; i < trials; i++) {
      const isPass = random() < 0.575;
      // Sampled across the field, since yardage depends on field zone.
      const yard = 5 + random() * 90;
      const p = runPlay(ctx, { yard, isPass, varianceMult: 1, preventMult: noPrevent });
      if (p.type === 'incompletion') { out.incompletion++; continue; }
      if (p.type === 'sack') { out.sack.push(Math.round(p.yards)); continue; }
      if (p.turnover) continue;
      const bucket = p.type.includes('pass') ? 'pass' : p.type.includes('rush') || p.type === 'stuff' ? 'rush' : null;
      if (bucket) out[bucket].push(Math.round(p.yards));
    }
  });
  return out;
}

/**
 * Does the engine actually reproduce football?
 *
 * A simulator that scores 60 points a game is worthless however elegant its
 * internals, so this compares simulated aggregates against every completed game
 * in this database. Reported rather than asserted — and reported when it fails.
 */
export function calibrationReport({ trials = 300, games = 40, season = null } = {}) {
  const prof = blendedProfiles({ season });
  const teams = [...prof.teams.keys()];
  if (teams.length < 4) return { error: 'not enough team profiles to calibrate' };

  const simTotals = [], simMargins = [], simSds = [];
  // Deterministic by construction, and it has to be. An audit metric that moves
  // between runs can be re-rolled until it passes, which defeats the point of
  // sealing a result — and this one did move: the same call reported a total gap
  // of -1.24 and then 3.80.
  //
  // Two causes, both fixed here. Matchups were drawn with random() instead of
  // being enumerated, and each simulateMatchup internally builds the
  // expected-points surface under its OWN withRandomSeed, which resets the
  // shared stream mid-loop — so the sequence depended on whether that surface
  // happened to be cached already. Enumerating the pairings and seeding each
  // matchup independently removes both.
  const sorted = [...teams].sort();
  for (let i = 0; i < games; i++) {
    const h = sorted[i % sorted.length];
    const a = sorted[(i * 7 + 3) % sorted.length];
    if (a === h) continue;
    const r = simulateMatchup({ home: h, away: a, trials, season, seed: 1000 + i });
    if (r.error) continue;
    simTotals.push(r.projection.total);
    simMargins.push(r.projection.margin);
    simSds.push(r.projection.margin_sd);
  }

  const actual = rows(`SELECT team_score, opp_score FROM game_lines
                       WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL
                         AND season >= 2021`);
  const actTotals = actual.map(g => g.team_score + g.opp_score);
  const actMargins = actual.map(g => g.team_score - g.opp_score);

  const totalGap = mean(simTotals) - mean(actTotals);
  const marginGap = mean(simMargins) - mean(actMargins);
  const sdGap = mean(simSds) - sd(actMargins);

  const checks = [
    { check: 'mean total', simulated: r2(mean(simTotals)), actual: r2(mean(actTotals)),
      gap: r2(totalGap), tolerance: 3, pass: Math.abs(totalGap) < 3 },
    { check: 'mean home margin', simulated: r2(mean(simMargins)), actual: r2(mean(actMargins)),
      gap: r2(marginGap), tolerance: 3, pass: Math.abs(marginGap) < 3 },
    { check: 'margin dispersion', simulated: r2(mean(simSds)), actual: r2(sd(actMargins)),
      gap: r2(sdGap), tolerance: 3.5, pass: Math.abs(sdGap) < 3.5 }
  ];

  return {
    simulated_matchups: simTotals.length, trials_each: trials,
    actual_games: actual.length, season: prof.season,
    checks, calibrated: checks.every(c => c.pass),
    failing: checks.filter(c => !c.pass).map(c => c.check),
    note: 'Compared against every completed game since 2021 in this database. Passing is a FLOOR — it ' +
      'says the engine plays plausible football, not that it beats a market. A simulator can be ' +
      'perfectly calibrated to the league average and still have no edge on any single game.'
  };
}

/**
 * The only question that matters: does simulating plays beat the closing line?
 *
 * Walk-forward and cutoff-safe — every game is simulated from profiles built on
 * PRIOR seasons only, so the engine never sees the season it is predicting. An
 * honest answer here is worth more than a good-looking one, and this codebase
 * has 21 previous models that failed exactly this test.
 */
export function backtest({ season = 2025, trials = 300, maxGames = 100 } = {}) {
  const games = rows(
    `SELECT season, week, team, opponent, spread, team_score, opp_score
     FROM game_lines
     WHERE home = 1 AND season = ? AND team_score IS NOT NULL AND opp_score IS NOT NULL
       AND spread IS NOT NULL
     ORDER BY week LIMIT ?`, season, maxGames);
  if (!games.length) return { error: `no completed games with lines for ${season}` };

  // Profiles built strictly on prior seasons — the cutoff that makes this real.
  const prof = blendedProfiles({ season: season - 1 });
  const surface = epFor(prof.league);
  const ep = y => expectedPoints(surface, y);

  const simErr = [], mktErr = [];
  let simAts = 0, graded = 0;

  withRandomSeed(4242, () => {
    for (const g of games) {
      const H = prof.teams.get(g.team), A = prof.teams.get(g.opponent);
      if (!H || !A) continue;
      const hc = buildContext(H, A, prof.league), ac = buildContext(A, H, prof.league);
      let sum = 0;
      for (let i = 0; i < trials; i++) {
        const s = simulateGame(hc, ac, ep, { homeFieldPoints: 1.6, spread: g.spread });
        sum += s.home - s.away;
      }
      const simMargin = sum / trials;
      const actual = g.team_score - g.opp_score;
      const marketMargin = -g.spread;      // a -3 home spread implies a 3-point home win

      simErr.push(Math.abs(simMargin - actual));
      mktErr.push(Math.abs(marketMargin - actual));

      if (actual + g.spread !== 0) {
        graded++;
        const covered = actual + g.spread > 0;
        if ((simMargin > marketMargin) === covered) simAts++;
      }
    }
  });

  if (!simErr.length) return { error: 'no games could be simulated with prior-season profiles' };
  const simMae = mean(simErr), mktMae = mean(mktErr);
  const atsRate = graded ? simAts / graded : null;

  return {
    season, games_tested: simErr.length, trials_each: trials,
    profiles_from_season: prof.season,
    simulator_mae: r2(simMae), market_mae: r2(mktMae), difference: r2(simMae - mktMae),
    beats_market: simMae < mktMae,
    ats: graded ? { record: `${simAts}-${graded - simAts}`, rate: r4(atsRate),
      break_even_at_minus_110: 0.5238, profitable: atsRate > 0.5238 } : null,
    verdict: simMae < mktMae
      ? `Mean absolute error is ${(mktMae - simMae).toFixed(2)} points BELOW the closing line's. Real ` +
        `result, small sample — ${simErr.length} games is not enough to size anything to.`
      : `The simulator is ${(simMae - mktMae).toFixed(2)} points WORSE than the closing line on margin. ` +
        `That is the expected outcome and not a failure of the build: the market is extremely hard to ` +
        `beat on a point estimate. The value here is the JOINT distribution — totals, key numbers, ` +
        `live states — not raw margin accuracy.`,
    note: 'Walk-forward and cutoff-safe: team profiles come from seasons strictly before the one being ' +
      'predicted, so the engine never sees its own test set.'
  };
}

/**
 * Where, if anywhere, does simulating plays actually beat the market?
 *
 * The margin backtest answers one narrow question and answers it badly: the
 * simulator is worse than the closing line on spreads, as 21 models before it
 * were. But a joint score distribution prices things a margin model cannot, and
 * those have never been tested here. This checks all of them on the same games
 * so the comparison is apples to apples:
 *
 *   SIDES    the known-hard market, included as the control.
 *   TOTALS   priced off the same simulated games. Totals are widely believed to
 *            be softer than sides, and a play-level engine has a real structural
 *            claim here — it models both offences scoring at once, which is what
 *            a total actually is.
 *   CONFIDENCE BUCKETS  does the model do better where it disagrees with the
 *            market most? If skill exists it should concentrate there, and if
 *            the model is merely noisy the biggest disagreements will be its
 *            worst bets. That distinction is the whole ballgame.
 *
 * Walk-forward and cutoff-safe throughout.
 */
export function edgeHunt({ season = 2025, trials = 300, maxGames = 140 } = {}) {
  const games = rows(
    `SELECT season, week, team, opponent, spread, total, team_score, opp_score
     FROM game_lines
     WHERE home = 1 AND season = ? AND team_score IS NOT NULL AND opp_score IS NOT NULL
       AND spread IS NOT NULL AND total IS NOT NULL
     ORDER BY week LIMIT ?`, season, maxGames);
  if (!games.length) return { error: `no completed games with lines and totals for ${season}` };

  const prof = blendedProfiles({ season: season - 1 });
  const surface = epFor(prof.league);
  const ep = y => expectedPoints(surface, y);

  const recs = [];
  withRandomSeed(8181, () => {
    for (const g of games) {
      const H = prof.teams.get(g.team), A = prof.teams.get(g.opponent);
      if (!H || !A) continue;
      const hc = buildContext(H, A, prof.league), ac = buildContext(A, H, prof.league);
      let mSum = 0, tSum = 0;
      const margins = [], totals = [];
      for (let i = 0; i < trials; i++) {
        const s = simulateGame(hc, ac, ep, { homeFieldPoints: 1.6, spread: g.spread });
        const m = s.home - s.away, t = s.home + s.away;
        margins.push(m); totals.push(t); mSum += m; tSum += t;
      }
      const simMargin = mSum / trials, simTotal = tSum / trials;
      const actMargin = g.team_score - g.opp_score, actTotal = g.team_score + g.opp_score;
      const mktMargin = -g.spread, mktTotal = g.total;

      recs.push({
        week: g.week, matchup: `${g.opponent} at ${g.team}`,
        sim_margin: simMargin, mkt_margin: mktMargin, act_margin: actMargin,
        sim_total: simTotal, mkt_total: mktTotal, act_total: actTotal,
        margin_disagreement: Math.abs(simMargin - mktMargin),
        total_disagreement: Math.abs(simTotal - mktTotal),
        // Did the side the model preferred actually cover / go over?
        side_correct: actMargin + g.spread === 0 ? null
          : (simMargin > mktMargin) === (actMargin + g.spread > 0),
        total_correct: actTotal === mktTotal ? null
          : (simTotal > mktTotal) === (actTotal > mktTotal)
      });
    }
  });
  if (!recs.length) return { error: 'no games could be simulated with prior-season profiles' };

  const mae = (a, f) => mean(a.map(f));
  const record = (list, key) => {
    const g = list.filter(r => r[key] != null);
    const w = g.filter(r => r[key]).length;
    return { n: g.length, wins: w, losses: g.length - w,
      rate: g.length ? r4(w / g.length) : null,
      profitable: g.length ? (w / g.length) > 0.5238 : null };
  };

  // Bucketed by how strongly the model disagrees with the market. If the model
  // has real skill it should show up strongest here; if it is noise, this is
  // where it will be worst.
  const buckets = (key, correctKey, edges) => edges.map(([lo, hi]) => {
    const list = recs.filter(r => r[key] >= lo && r[key] < hi);
    return { disagreement: `${lo}-${hi === Infinity ? '+' : hi}`, ...record(list, correctKey) };
  });

  const sideMae = mae(recs, r => Math.abs(r.sim_margin - r.act_margin));
  const sideMkt = mae(recs, r => Math.abs(r.mkt_margin - r.act_margin));
  const totMae = mae(recs, r => Math.abs(r.sim_total - r.act_total));
  const totMkt = mae(recs, r => Math.abs(r.mkt_total - r.act_total));

  const sides = record(recs, 'side_correct');
  const totalsRec = record(recs, 'total_correct');

  const findings = [];
  if (totMae < totMkt) findings.push(`Totals: simulator MAE ${r2(totMae)} beats the market's ${r2(totMkt)}.`);
  if (sideMae < sideMkt) findings.push(`Sides: simulator MAE ${r2(sideMae)} beats the market's ${r2(sideMkt)}.`);
  if (totalsRec.profitable) findings.push(`Totals record ${totalsRec.wins}-${totalsRec.losses} clears the 52.38% break-even.`);
  if (sides.profitable) findings.push(`Sides record ${sides.wins}-${sides.losses} clears the 52.38% break-even.`);

  return {
    season, games_tested: recs.length, trials_each: trials,
    profiles_from_season: prof.season,
    sides: { simulator_mae: r2(sideMae), market_mae: r2(sideMkt), difference: r2(sideMae - sideMkt),
      beats_market: sideMae < sideMkt, record: sides,
      by_disagreement: buckets('margin_disagreement', 'side_correct',
        [[0, 2], [2, 4], [4, 7], [7, Infinity]]) },
    totals: { simulator_mae: r2(totMae), market_mae: r2(totMkt), difference: r2(totMae - totMkt),
      beats_market: totMae < totMkt, record: totalsRec,
      by_disagreement: buckets('total_disagreement', 'total_correct',
        [[0, 2], [2, 4], [4, 7], [7, Infinity]]) },
    findings: findings.length ? findings : ['Nothing here beats the market on this sample.'],
    biggest_disagreements: [...recs].sort((a, b) => b.total_disagreement - a.total_disagreement)
      .slice(0, 6).map(r => ({ week: r.week, matchup: r.matchup,
        sim_total: r2(r.sim_total), market_total: r.mkt_total, actual_total: r.act_total,
        model_was_right: r.total_correct })),
    caveat: `One season is ${recs.length} games. At that sample a 55% record has a standard error near ` +
      `4 points, so anything short of about 58% is indistinguishable from luck. Treat a positive ` +
      `result here as a reason to test more seasons, never as a reason to size a bet.`
  };
}

/**
 * Closing-line value: does our disagreement with the OPENING line predict which
 * way the number then moves?
 *
 * This is the test that has been impossible here until opening lines were
 * sourced, and it is a different question from every other backtest in this
 * file. Those ask "do we forecast the game better than the closing line", and
 * the answer is a settled no. This asks "do we see something the market has not
 * priced YET" — and those two can both be true, because a closing line is the
 * market's final word while an opening line is its first guess.
 *
 * Why it matters more than win rate: line movement is far less noisy than game
 * outcomes. A model with a genuine 2% edge needs thousands of settled bets
 * before that edge separates from variance, but the same model shows up in CLV
 * within a couple of hundred games, because the market is aggregating
 * information rather than flipping coins. CLV is how professionals grade a bet
 * they have already placed, and it is the only edge measurement that returns a
 * verdict on a useful timescale.
 *
 * Walk-forward and cutoff-safe: profiles come from seasons strictly earlier.
 */
export function clvReport({ season = 2021, trials = 300, maxGames = 300 } = {}) {
  const games = rows(
    `SELECT season, week, team, opponent, spread, open_spread, total, open_total,
            team_score, opp_score
     FROM game_lines
     WHERE home = 1 AND season = ? AND open_spread IS NOT NULL AND spread IS NOT NULL
       AND team_score IS NOT NULL AND opp_score IS NOT NULL
     ORDER BY week LIMIT ?`, season, maxGames);
  if (games.length < 20) {
    return { error: `only ${games.length} games with both opening and closing lines for ${season}`,
      hint: 'Run ingestOpeningLines() in nfl-opening-lines.js first.' };
  }

  const prof = blendedProfiles({ season: season - 1 });
  const surface = epFor(prof.league);
  const ep = y => expectedPoints(surface, y);

  const recs = [];
  withRandomSeed(2468, () => {
    for (const g of games) {
      const H = prof.teams.get(g.team), A = prof.teams.get(g.opponent);
      if (!H || !A) continue;
      const hc = buildContext(H, A, prof.league), ac = buildContext(A, H, prof.league);
      let sum = 0;
      for (let i = 0; i < trials; i++) {
        const s = simulateGame(hc, ac, ep, { homeFieldPoints: 1.6, spread: g.open_spread });
        sum += s.home - s.away;
      }
      const simMargin = sum / trials;
      // Market-implied margins. A -3 home spread implies a 3-point home win.
      const openMargin = -g.open_spread, closeMargin = -g.spread;
      const lineMove = closeMargin - openMargin;          // + = moved toward home
      const ourLean = simMargin - openMargin;             // + = we like home more than the open
      const actual = g.team_score - g.opp_score;

      recs.push({
        week: g.week, matchup: `${g.opponent} at ${g.team}`,
        open: g.open_spread, close: g.spread,
        sim_margin: r2(simMargin), our_lean: r2(ourLean), line_move: r2(lineMove),
        // Did the line move the way we leaned? Games where it did not move are
        // excluded rather than scored as wrong — there was nothing to be right about.
        clv_correct: Math.abs(lineMove) < 0.5 ? null
          : (Math.sign(ourLean) === Math.sign(lineMove)),
        // How many points of CLV the bet actually captured.
        clv_points: r2(Math.sign(ourLean) * lineMove),
        // ATS against the OPENING number — the one a bettor actually faces.
        ats_open: actual + g.open_spread === 0 ? null : ((simMargin > openMargin) === (actual + g.open_spread > 0)),
        ats_close: actual + g.spread === 0 ? null : ((simMargin > closeMargin) === (actual + g.spread > 0))
      });
    }
  });
  if (!recs.length) return { error: 'no games could be simulated from prior-season profiles' };

  const rate = (list, key) => {
    const g = list.filter(r => r[key] != null);
    const w = g.filter(r => r[key]).length;
    const n = g.length;
    const p = n ? w / n : null;
    // Standard error on a proportion, so a result is never read without its noise.
    const se = n ? Math.sqrt(0.25 / n) : null;
    return { n, wins: w, losses: n - w, rate: r4(p),
      standard_error: r4(se), z_vs_coinflip: p != null && se ? r2((p - 0.5) / se) : null };
  };

  const clv = rate(recs, 'clv_correct');
  const atsOpen = rate(recs, 'ats_open');
  const atsClose = rate(recs, 'ats_close');
  const clvPoints = recs.filter(r => r.clv_points != null).map(r => r.clv_points);
  const meanClv = mean(clvPoints);

  // Does the size of our disagreement predict the size of the move? A real
  // signal should show a positive slope, not just a coin-flip beating rate.
  const xs = recs.map(r => r.our_lean), ys = recs.map(r => r.line_move);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : null;
  const rsq = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : null;

  return {
    season, games_tested: recs.length, trials_each: trials,
    profiles_from_season: prof.season,
    clv: { ...clv, mean_points_captured: r2(meanClv),
      beat_the_close: meanClv != null && meanClv > 0 },
    ats_vs_opening_line: atsOpen,
    ats_vs_closing_line: atsClose,
    lean_predicts_move: { slope: r4(slope), r_squared: r4(rsq) },
    verdict: clv.z_vs_coinflip != null && clv.z_vs_coinflip > 2
      ? `Our lean predicts line movement ${(clv.rate * 100).toFixed(1)}% of the time ` +
        `(z=${clv.z_vs_coinflip}), capturing ${r2(meanClv)} points of CLV per game. That is a real ` +
        `signal and the first positive edge measurement in this project — worth capturing lines ` +
        `prospectively to confirm on a larger sample.`
      : `Our lean predicts line movement ${(clv.rate * 100).toFixed(1)}% of the time ` +
        `(z=${clv.z_vs_coinflip}), capturing ${r2(meanClv)} points per game. Not distinguishable ` +
        `from chance at this sample size.`,
    biggest_leans: [...recs].sort((a, b) => Math.abs(b.our_lean) - Math.abs(a.our_lean)).slice(0, 8),
    note: 'CLV is graded only on games where the line actually moved half a point or more — a game ' +
      'that never moved offered nothing to be right or wrong about. ATS is reported against BOTH ' +
      'the opening and closing number, because the opening line is what a bettor faces and the ' +
      'closing line is what measures forecasting skill. Sample is one season; a positive result is ' +
      'a reason to capture lines going forward, not a reason to size a bet.'
  };
}

