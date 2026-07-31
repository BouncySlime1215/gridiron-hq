/**
 * Volume x efficiency projection model.
 *
 * The central idea: separate *opportunity* from *conversion*, because they behave
 * completely differently. How many targets a receiver gets is a stable property of his
 * role — it persists week to week and year to year. What he does with them is mostly
 * noise around a talent level, and touchdown rate is the noisiest thing in the sport.
 *
 * So volume is forecast with light regression and efficiency with heavy regression,
 * and the two are recombined. Modelling them as one blended number — which is what a
 * scraped "projected points" column is — makes it impossible to express the single most
 * common real forecast: this player's role is safe and his scoring rate is a mirage.
 *
 * Volume itself is decomposed once more, into share x team volume:
 *
 *     targets = target_share  x  team pass attempts
 *     carries = carry_share   x  team rush attempts
 *
 * Share is the player's property and team volume is the game's, which is what lets the
 * Vegas game-script layer move a whole offense without touching anyone's role.
 *
 * Output is a distribution, not a number. Every projection can emit percentiles and
 * feed the simulator.
 */
import { rows } from '../db/index.js';
import { PPR, scoreSim } from './scoring.js';
import {
  shrink, mean, quantile, percentiles,
  randGamma, randNegBinomial, randBinomial, randPoisson, randn, randBeta
} from './stats-util.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const GAMES = 17;

/* ------------------------------------------------------------------ priors */

/**
 * Regression strengths, in effective games. These encode the whole thesis of the
 * model, so they are worth reading as a statement rather than as constants:
 * a role stabilises in a handful of games, efficiency takes most of a season,
 * and touchdown rate essentially never stabilises.
 */
const K = {
  share: 6,          // target/carry share — stable, trust it early
  team_volume: 10,   // team pass/rush rate — stable
  yards_per: 34,     // yards per opportunity — regress hard
  catch_rate: 26,
  td_rate: 70,       // the most regression-prone number in fantasy
  games: 8           // availability
};

// Recency weights. A role two years ago is weak evidence about this year's role.
const SEASON_WEIGHT = (s, through) => ({ 0: 1, 1: 0.55, 2: 0.28 })[through - s] ?? 0.12;

/* --------------------------------------------------------------- histories */

/** Every weekly usage line up to and including `through`, so backtests can't peek ahead. */
function history(through) {
  return rows(`SELECT u.*, p.name, p.position AS pos, p.espn_id, p.sleeper_id
               FROM player_week_usage u JOIN players p ON p.id = u.player_id
               WHERE u.season <= ? AND p.position IN ('QB','RB','WR','TE')`, through);
}

/**
 * Team pass and rush volume per game. Derived by summing player lines rather than read
 * from a team table, which keeps it consistent with the shares computed off the same rows.
 */
function teamVolume(log, through) {
  const byTeamWeek = new Map();
  for (const u of log) {
    const k = `${u.team}|${u.season}|${u.week}`;
    const t = byTeamWeek.get(k) ?? { season: u.season, team: u.team, att: 0, car: 0 };
    t.att += u.attempts ?? 0;
    t.car += u.carries ?? 0;
    byTeamWeek.set(k, t);
  }
  const agg = new Map();
  for (const t of byTeamWeek.values()) {
    if (!t.team) continue;
    const w = SEASON_WEIGHT(t.season, through);
    const a = agg.get(t.team) ?? { w: 0, att: 0, car: 0 };
    a.w += w; a.att += w * t.att; a.car += w * t.car;
    agg.set(t.team, a);
  }
  const passLg = mean([...agg.values()].filter(a => a.w).map(a => a.att / a.w)) || 33;
  const rushLg = mean([...agg.values()].filter(a => a.w).map(a => a.car / a.w)) || 26;

  const out = new Map();
  for (const [team, a] of agg) {
    if (!a.w) continue;
    out.set(team, {
      pass_att: +shrink(a.att / a.w, passLg, a.w, K.team_volume).toFixed(2),
      rush_att: +shrink(a.car / a.w, rushLg, a.w, K.team_volume).toFixed(2)
    });
  }
  return { teams: out, league: { pass_att: +passLg.toFixed(2), rush_att: +rushLg.toFixed(2) } };
}

/** Positional priors — what an unknown player at this position looks like. */
function positionalPriors(log) {
  const byPos = {};
  for (const u of log) {
    const p = (byPos[u.pos] ??= {
      tgtShare: [], carShare: [], ypt: [], ypc: [], ypa: [],
      catchRate: [], recTd: [], rushTd: [], passTd: [], intRate: []
    });
    if (u.target_share != null && u.target_share > 0) p.tgtShare.push(u.target_share);
    if (u.targets > 0) {
      p.ypt.push((u.receiving_yards ?? 0) / u.targets);
      p.catchRate.push((u.receptions ?? 0) / u.targets);
      p.recTd.push((u.receiving_tds ?? 0) / u.targets);
    }
    if (u.carries > 0) {
      p.ypc.push((u.rushing_yards ?? 0) / u.carries);
      p.rushTd.push((u.rushing_tds ?? 0) / u.carries);
    }
    if (u.attempts > 0) {
      p.ypa.push((u.passing_yards ?? 0) / u.attempts);
      p.passTd.push((u.passing_tds ?? 0) / u.attempts);
      p.intRate.push((u.interceptions ?? 0) / u.attempts);
    }
  }
  const out = {};
  for (const [pos, p] of Object.entries(byPos)) {
    out[pos] = {
      ypt: mean(p.ypt) || 7.5, ypc: mean(p.ypc) || 4.3, ypa: mean(p.ypa) || 7.0,
      catch_rate: mean(p.catchRate) || 0.63,
      rec_td_rate: mean(p.recTd) || 0.05,
      rush_td_rate: mean(p.rushTd) || 0.025,
      pass_td_rate: mean(p.passTd) || 0.045,
      int_rate: mean(p.intRate) || 0.024
    };
  }
  return out;
}

/* ------------------------------------------------------------- the model */

/**
 * Build a projection for every player with usage history.
 *
 * @param through   last season allowed as evidence (exclusive of the season being predicted)
 * @param scoring   league scoring rules
 * @returns Map<player_id, projection>
 */
export function buildProjections({ through = SEASON - 1, scoring = PPR } = {}) {
  const log = history(through);
  if (!log.length) return new Map();
  const { teams: teamVol, league: leagueVol } = teamVolume(log, through);
  const priors = positionalPriors(log);

  // Accumulate weighted per-player usage.
  const acc = new Map();
  for (const u of log) {
    const w = SEASON_WEIGHT(u.season, through);
    if (w <= 0) continue;
    const a = acc.get(u.player_id) ?? {
      id: u.player_id, name: u.name, pos: u.pos, espn_id: u.espn_id, sleeper_id: u.sleeper_id,
      team: null, lastSeason: -1, w: 0, games: 0, seasons: new Set(), gamesBySeason: new Map(), attemptsBySeason: new Map(),
      tgtShareW: 0, tgtShare: 0, carW: 0, car: 0, attW: 0, att: 0,
      targets: 0, receptions: 0, recYds: 0, recTd: 0,
      carries: 0, rushYds: 0, rushTd: 0,
      attempts: 0, passYds: 0, passTd: 0, ints: 0,
      weekly: []
    };
    // Most recent team wins — players move.
    if (u.season > a.lastSeason || (u.season === a.lastSeason && u.team)) {
      if (u.team) { a.team = u.team; a.lastSeason = u.season; }
    }
    a.w += w; a.games += 1; a.seasons.add(u.season);
    a.gamesBySeason.set(u.season, (a.gamesBySeason.get(u.season) ?? 0) + 1);
    a.attemptsBySeason.set(u.season, (a.attemptsBySeason.get(u.season) ?? 0) + (u.attempts ?? 0));
    if (u.target_share != null) { a.tgtShareW += w; a.tgtShare += w * u.target_share; }
    a.targets += w * (u.targets ?? 0);
    a.receptions += w * (u.receptions ?? 0);
    a.recYds += w * (u.receiving_yards ?? 0);
    a.recTd += w * (u.receiving_tds ?? 0);
    a.carries += w * (u.carries ?? 0);
    a.rushYds += w * (u.rushing_yards ?? 0);
    a.rushTd += w * (u.rushing_tds ?? 0);
    a.attempts += w * (u.attempts ?? 0);
    a.passYds += w * (u.passing_yards ?? 0);
    a.passTd += w * (u.passing_tds ?? 0);
    a.ints += w * (u.interceptions ?? 0);
    // Raw weekly opportunity counts, for estimating how variable the role is.
    a.weekly.push({ season: u.season, targets: u.targets ?? 0, carries: u.carries ?? 0, attempts: u.attempts ?? 0 });
    acc.set(u.player_id, a);
  }

  const out = new Map();
  for (const a of acc.values()) {
    const prior = priors[a.pos] ?? priors.WR ?? {};
    const tv = teamVol.get(a.team) ?? leagueVol;
    const n = a.w;                       // effective games of evidence
    const perGame = x => (n ? x / n : 0);

    /* ---- volume: share x team volume ---- */
    const tgtShareObs = a.tgtShareW ? a.tgtShare / a.tgtShareW : 0;
    const tgtShare = shrink(tgtShareObs, 0.06, a.tgtShareW, K.share);
    const carShareObs = tv.rush_att ? perGame(a.carries) / tv.rush_att : 0;
    const carShare = shrink(carShareObs, a.pos === 'RB' ? 0.25 : 0.02, n, K.share);

    const targets = a.pos === 'QB' ? 0 : Math.max(0, tgtShare * tv.pass_att);
    const carries = Math.max(0, carShare * tv.rush_att);
    // Quarterback attempts are the team's, so they don't decompose into a share.
    const attempts = a.pos === 'QB' ? shrink(perGame(a.attempts), tv.pass_att * 0.92, n, K.share) : 0;

    /* ---- efficiency: heavy regression toward the positional norm ---- */
    const ypt = shrink(a.targets > 0 ? a.recYds / a.targets : prior.ypt, prior.ypt, a.targets / 5, K.yards_per / 5);
    const catchRate = shrink(a.targets > 0 ? a.receptions / a.targets : prior.catch_rate,
      prior.catch_rate, a.targets / 5, K.catch_rate / 5);
    const recTdRate = shrink(a.targets > 0 ? a.recTd / a.targets : prior.rec_td_rate,
      prior.rec_td_rate, a.targets / 5, K.td_rate / 5);
    const ypc = shrink(a.carries > 0 ? a.rushYds / a.carries : prior.ypc, prior.ypc, a.carries / 8, K.yards_per / 8);
    const rushTdRate = shrink(a.carries > 0 ? a.rushTd / a.carries : prior.rush_td_rate,
      prior.rush_td_rate, a.carries / 8, K.td_rate / 8);
    const ypa = shrink(a.attempts > 0 ? a.passYds / a.attempts : prior.ypa, prior.ypa, a.attempts / 10, K.yards_per / 10);
    const passTdRate = shrink(a.attempts > 0 ? a.passTd / a.attempts : prior.pass_td_rate,
      prior.pass_td_rate, a.attempts / 10, K.td_rate / 10);
    const intRate = shrink(a.attempts > 0 ? a.ints / a.attempts : prior.int_rate,
      prior.int_rate, a.attempts / 10, K.td_rate / 10);

    /* ---- how variable is the role, week to week ---- */
    const recent = a.weekly.filter(x => x.season === through);
    const opp = recent.map(x => (a.pos === 'QB' ? x.attempts : x.targets + x.carries));
    const oppMean = mean(opp) || (targets + carries + attempts) || 1;
    const oppVar = opp.length > 1 ? mean(opp.map(x => (x - oppMean) ** 2)) : oppMean * 1.6;
    // Negative binomial dispersion implied by the observed over-dispersion. Clamped:
    // a tiny sample can imply an absurd shape in either direction.
    const dispersion = Math.min(30, Math.max(1.2, oppVar > oppMean ? (oppMean ** 2) / (oppVar - oppMean) : 12));

    /* ---- expected availability ----
     *
     * This is a *role* forecast, not an injury forecast, and it is the single biggest
     * source of error when it is missing. A backup quarterback's per-game numbers look
     * like a starter's, because the only games in his record are the ones he started.
     * Projecting those rates across a full season turns a clipboard-holder into a QB12.
     *
     * So availability is modelled as the share of his team's games he actually played,
     * across every season since he entered the league — not as an average of the games
     * he happened to appear in. */
    const firstSeason = Math.min(...a.seasons);
    let availW = 0, availPlayed = 0;
    for (let s = firstSeason; s <= through; s++) {
      const w = SEASON_WEIGHT(s, through);
      availW += w * GAMES;
      availPlayed += w * (a.gamesBySeason.get(s) ?? 0);
    }
    const playRate = availW ? availPlayed / availW : 0;
    // Prior and evidence weight chosen by sweeping both against two held-out seasons
    // (2024 and 2025) rather than by intuition — see the backtest harness. The surface
    // is flat, so these are a reasonable point on a plateau, not a tuned optimum.
    let rate = shrink(playRate, 0.66, availW / GAMES, 0.8);

    // Quarterback is winner-take-all: there is one football, and the man holding it
    // plays every snap. So a passer's share of his team's attempts *is* his share of
    // starts, and it separates a starter from a backup far more sharply than games
    // played does — a backup who started three games looks nearly full-time on games
    // alone, and looks like a backup on attempt share.
    if (a.pos === 'QB') {
      const teamAtt = (teamVol.get(a.team) ?? leagueVol).pass_att * GAMES;
      let shareW = 0, shareSum = 0;
      for (const s of a.seasons) {
        const w = SEASON_WEIGHT(s, through);
        const own = a.attemptsBySeason.get(s) ?? 0;
        if (teamAtt > 0) { shareW += w; shareSum += w * Math.min(1, own / teamAtt); }
      }
      const attShare = shareW ? shareSum / shareW : 0;
      rate = Math.min(rate, shrink(attShare, 0.45, shareW, 0.5));
    }
    const expectedGames = Math.min(GAMES, Math.max(1, rate * GAMES));

    const params = {
      position: a.pos, targets, carries, attempts, dispersion,
      ypt, catch_rate: catchRate, rec_td_rate: recTdRate,
      ypc, rush_td_rate: rushTdRate,
      ypa, pass_td_rate: passTdRate, int_rate: intRate
    };

    // Deterministic expectation, used for ranking and as the point estimate.
    const meanPpg = scoreSim({
      passYd: attempts * ypa, passTd: attempts * passTdRate, int: attempts * intRate,
      rushYd: carries * ypc, rushTd: carries * rushTdRate,
      rec: targets * catchRate, recYd: targets * ypt, recTd: targets * recTdRate
    }, scoring);

    out.set(a.id, {
      player_id: a.id, name: a.name, position: a.pos, team: a.team,
      espn_id: a.espn_id, sleeper_id: a.sleeper_id,
      evidence_games: a.games, evidence_weight: +n.toFixed(1), seasons: [...a.seasons].sort(),
      expected_games: +expectedGames.toFixed(1),
      volume: {
        target_share: +tgtShare.toFixed(4), targets_per_game: +targets.toFixed(2),
        carry_share: +carShare.toFixed(4), carries_per_game: +carries.toFixed(2),
        attempts_per_game: +attempts.toFixed(2),
        team_pass_att: tv.pass_att, team_rush_att: tv.rush_att
      },
      efficiency: {
        yards_per_target: +ypt.toFixed(2), catch_rate: +catchRate.toFixed(3),
        rec_td_rate: +recTdRate.toFixed(4), yards_per_carry: +ypc.toFixed(2),
        rush_td_rate: +rushTdRate.toFixed(4), yards_per_attempt: +ypa.toFixed(2),
        pass_td_rate: +passTdRate.toFixed(4)
      },
      params,
      ppg: +meanPpg.toFixed(2),
      points: +(meanPpg * expectedGames).toFixed(1)
    });
  }
  return out;
}

/* --------------------------------------------------------------- sampling */

/**
 * One simulated week for a player.
 *
 * Built up from its parts rather than drawn from a bell curve: touches are an
 * over-dispersed count, yards per touch is a positive skewed rate, and touchdowns are
 * rare binomial events. Composing them reproduces the real right skew of fantasy
 * scoring — which a Gaussian cannot, and which is exactly where start/sit and
 * playoff decisions live.
 *
 * @param mult optional matchup multiplier applied to opportunity
 */
export function sampleWeek(params, scoring = PPR, mult = 1) {
  const p = params;
  // A scalar applies to everything (a pure matchup adjustment); an object lets the
  // game-script layer move passing and rushing volume in opposite directions, which is
  // the entire point of it — a favourite runs more *and* throws less.
  const mPass = typeof mult === 'object' ? (mult.pass ?? 1) : mult;
  const mRush = typeof mult === 'object' ? (mult.rush ?? 1) : mult;
  let passYd = 0, passTd = 0, int = 0, rushYd = 0, rushTd = 0, rec = 0, recYd = 0, recTd = 0;

  if (p.attempts > 0) {
    const att = randNegBinomial(p.attempts * mPass, p.dispersion);
    // Yards per attempt varies game to game; a gamma keeps it positive and right-skewed.
    passYd = att > 0 ? randGamma(att * 0.9, p.ypa / 0.9) : 0;
    passTd = randBinomial(att, Math.min(0.35, p.pass_td_rate));
    int = randBinomial(att, Math.min(0.2, p.int_rate));
  }
  if (p.carries > 0) {
    const car = randNegBinomial(p.carries * mRush, p.dispersion);
    rushYd = car > 0 ? randGamma(car * 0.75, p.ypc / 0.75) : 0;
    rushTd = randBinomial(car, Math.min(0.3, p.rush_td_rate));
  }
  if (p.targets > 0) {
    const tgt = randNegBinomial(p.targets * mPass, p.dispersion);
    rec = randBinomial(tgt, Math.min(0.95, p.catch_rate));
    recYd = rec > 0 ? randGamma(rec * 0.8, (p.ypt / Math.max(0.05, p.catch_rate)) / 0.8) : 0;
    recTd = randBinomial(tgt, Math.min(0.35, p.rec_td_rate));
  }
  return scoreSim({ passYd, passTd, int, rushYd, rushTd, rec, recYd, recTd }, scoring);
}

/** N simulated weeks. */
export function sampleWeeks(params, n = 2000, scoring = PPR, mult = 1) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = sampleWeek(params, scoring, mult);
  return out;
}

/**
 * Weekly distribution summary for a projection: the percentiles that answer
 * start/sit and trade questions directly.
 */
export function weeklyDistribution(projection, { runs = 2000, scoring = PPR, mult = 1 } = {}) {
  const s = sampleWeeks(projection.params, runs, scoring, mult);
  const pct = percentiles(s, [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]);
  const m = mean(s);
  return {
    ...pct,
    mean: +m.toFixed(2),
    // Boom and bust thresholds by position, matching the existing volatility view.
    boom_rate: +(s.filter(x => x >= ({ QB: 24, RB: 18, WR: 18, TE: 14 })[projection.position] ?? 18).length / s.length).toFixed(3),
    bust_rate: +(s.filter(x => x <= ({ QB: 14, RB: 8, WR: 8, TE: 6 })[projection.position] ?? 8).length / s.length).toFixed(3)
  };
}

/**
 * Season totals as a distribution: sample each week independently across the number
 * of games the player is expected to play.
 */
export function seasonDistribution(projection, { runs = 1000, scoring = PPR, mult = 1 } = {}) {
  /*
   * Two sources of uncertainty, and leaving either out makes the interval a lie.
   *
   *   week-to-week noise — the same player has good and bad games
   *   parameter uncertainty — we don't actually know his true role or talent
   *
   * Only the first was modelled originally, and averaging seventeen independent weeks
   * crushes it almost to a point: the backtester measured 33% coverage on a nominal 80%
   * interval. Real season totals move because a role changed or a player got hurt, not
   * because seventeen coin flips landed the same way.
   *
   * So each simulated season first draws a *true* level for the player and a number of
   * games, then plays the weeks out at that level.
   */
  const evidence = projection.evidence_weight ?? projection.evidence_games ?? 4;
  // Less evidence, wider prior on his true level. Bounded so a well-established
  // starter still carries real uncertainty and a rookie does not carry absurd amounts.
  const sigma = Math.max(0.30, Math.min(0.70, 1.15 / Math.sqrt(Math.max(1, evidence))));
  const availRate = Math.max(0.05, Math.min(1, (projection.expected_games ?? GAMES) / GAMES));

  const totals = new Array(runs);
  for (let i = 0; i < runs; i++) {
    // Log-normal keeps the level positive and right-skewed: breakouts run further than
    // busts do, which is how player seasons actually behave.
    const level = Math.exp(randn() * sigma - (sigma * sigma) / 2);
    // Beta-binomial rather than binomial: a season is usually "healthy" or "hurt",
    // not seventeen independent coin flips at a fixed rate.
    const CONC = 3.5;
    const games = randBinomial(GAMES, randBeta(availRate * CONC, (1 - availRate) * CONC));
    let t = 0;
    for (let g = 0; g < games; g++) t += sampleWeek(projection.params, scoring, mult * level);
    totals[i] = t;
  }
  return { ...percentiles(totals, [0.05, 0.25, 0.5, 0.75, 0.95]), mean: +mean(totals).toFixed(1), samples: totals };
}
