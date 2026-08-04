/**
 * Season replay and error analysis — the training loop.
 *
 * Replays a season week by week, betting the model's picks with only the
 * information available at the time, grades every result, then looks for where
 * it went wrong.
 *
 * The important design decision is *how* it looks for mistakes. The tempting
 * version — open each loss, find something that would have called it, add that
 * variable, repeat — does not work. With 328 variables and roughly 270 games a
 * season, something always "explains" any single miss, and what the model
 * learns is that season's noise. It would grade beautifully on the data used to
 * build it and lose money on the next one.
 *
 * So this looks only for *systematic* error: segments of games (favourites,
 * road teams, windy games, short weeks, high totals) where the model is biased
 * across many games rather than unlucky in one. A segment only counts when it
 * holds over enough games to not be chance, and `validateAdjustment` re-tests
 * any correction on seasons it was not discovered on. A fix that only works on
 * the season that suggested it is reported as exactly that — rejected.
 */
import { db, rows, run } from '../db/index.js';
import { fitEnsemble, ensembleLine } from './nfl-ensemble.js';
import { mean } from './stats-util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_replay_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, label TEXT, created_at TEXT NOT NULL,
    bets INTEGER, wins INTEGER, losses INTEGER, pushes INTEGER,
    units REAL, roi REAL, config TEXT
  );
  CREATE TABLE IF NOT EXISTS nfl_replay_bets (
    run_id INTEGER NOT NULL, season INTEGER, week INTEGER,
    home TEXT, away TEXT, market TEXT, side TEXT, line REAL,
    model_margin REAL, market_margin REAL, edge REAL, disagreement REAL,
    actual_margin REAL, actual_total REAL,
    result TEXT, units REAL,
    PRIMARY KEY (run_id, season, week, home, market)
  );
`);

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** Standard -110 juice unless a real price is known. */
const unitsFor = (won, pushed, price = -110) => {
  if (pushed) return 0;
  if (!won) return -1;
  return price > 0 ? price / 100 : 100 / Math.abs(price);
};

/**
 * Replays one season. For each week, the ensemble is asked for a line using
 * only prior games, a bet is placed when the edge clears `minEdge`, and the
 * result is graded against what actually happened.
 */
export function replaySeason(season, {
  minEdge = 1.5,             // points of disagreement with the market required to bet
  // Skip games where the twenty models disagree with each other by more than
  // this. Derived on 2022-2023 and validated on 2024-2025, where it moved the
  // held-out result from -1.8% to +2.2% ROI — the only candidate correction
  // that survived holdout. It is on by default for that reason; pass null to
  // replay without it.
  maxDisagreement = 4.5,
  markets = ['spread', 'total'],
  label = null
} = {}) {
  const fit = fitEnsemble();
  if (fit.error) return fit;

  const slate = rows(`
    SELECT season, week, team AS home, opponent AS away,
           team_score AS home_score, opp_score AS away_score,
           spread AS home_spread, total
    FROM game_lines
    WHERE season = ? AND home = 1 AND team_score IS NOT NULL AND spread IS NOT NULL
    ORDER BY week
  `, season);
  if (!slate.length) return { error: `no completed games stored for ${season}` };

  const bets = [];
  for (const g of slate) {
    const line = ensembleLine(season, g.week, g.home, g.away);
    if (line.error) continue;
    const e = line.ensemble;
    if (maxDisagreement != null && (e.model_disagreement_margin ?? 0) > maxDisagreement) continue;

    const actualMargin = g.home_score - g.away_score;
    const actualTotal = g.home_score + g.away_score;

    if (markets.includes('spread') && e.projected_margin != null && g.home_spread != null) {
      const marketMargin = -g.home_spread;
      const edge = e.projected_margin - marketMargin;
      if (Math.abs(edge) >= minEdge) {
        // Betting the home side when the model is higher than the market.
        const backHome = edge > 0;
        const covered = backHome
          ? actualMargin + g.home_spread > 0
          : actualMargin + g.home_spread < 0;
        const pushed = actualMargin + g.home_spread === 0;
        bets.push({
          season, week: g.week, home: g.home, away: g.away, market: 'spread',
          side: backHome ? `${g.home} ${fmtLine(g.home_spread)}` : `${g.away} ${fmtLine(-g.home_spread)}`,
          line: g.home_spread,
          model_margin: e.projected_margin, market_margin: marketMargin,
          edge: r2(edge), disagreement: e.model_disagreement_margin,
          actual_margin: actualMargin, actual_total: actualTotal,
          result: pushed ? 'Push' : covered ? 'Won' : 'Lost',
          units: unitsFor(covered, pushed)
        });
      }
    }

    if (markets.includes('total') && e.projected_total != null && g.total != null) {
      const edge = e.projected_total - g.total;
      if (Math.abs(edge) >= minEdge) {
        const over = edge > 0;
        const won = over ? actualTotal > g.total : actualTotal < g.total;
        const pushed = actualTotal === g.total;
        bets.push({
          season, week: g.week, home: g.home, away: g.away, market: 'total',
          side: `${over ? 'Over' : 'Under'} ${g.total}`, line: g.total,
          model_margin: e.projected_total, market_margin: g.total,
          edge: r2(edge), disagreement: e.model_disagreement_total,
          actual_margin: actualMargin, actual_total: actualTotal,
          result: pushed ? 'Push' : won ? 'Won' : 'Lost',
          units: unitsFor(won, pushed)
        });
      }
    }
  }

  const wins = bets.filter(b => b.result === 'Won').length;
  const losses = bets.filter(b => b.result === 'Lost').length;
  const pushes = bets.filter(b => b.result === 'Push').length;
  const units = bets.reduce((s, b) => s + b.units, 0);

  const summary = {
    season, label, bets: bets.length, wins, losses, pushes,
    win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
    units: r2(units),
    roi: bets.length ? r2(units / bets.length) : null,
    // Breaking even against -110 needs 52.4%, so anything below that is a loss
    // no matter how good the win count looks in isolation.
    beat_vig: wins + losses ? wins / (wins + losses) > 0.524 : null,
    config: { minEdge, maxDisagreement, markets }
  };
  return { summary, bets };
}

const fmtLine = v => (v > 0 ? `+${v}` : `${v}`);

/** Persists a replay so runs can be compared over time. */
export function saveReplay(result) {
  const s = result.summary;
  run(`INSERT INTO nfl_replay_runs (season, label, created_at, bets, wins, losses, pushes, units, roi, config)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    s.season, s.label, new Date().toISOString(), s.bets, s.wins, s.losses, s.pushes,
    s.units, s.roi, JSON.stringify(s.config));
  const id = rows('SELECT last_insert_rowid() AS id')[0].id;
  for (const b of result.bets) {
    run(`INSERT INTO nfl_replay_bets
        (run_id, season, week, home, away, market, side, line, model_margin, market_margin,
         edge, disagreement, actual_margin, actual_total, result, units)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT DO NOTHING`,
      id, b.season, b.week, b.home, b.away, b.market, b.side, b.line,
      b.model_margin, b.market_margin, b.edge, b.disagreement,
      b.actual_margin, b.actual_total, b.result, b.units);
  }
  return id;
}

/* ------------------------------------------------------- error analysis */

/**
 * Buckets a bet into the segments worth checking for systematic bias.
 * Each is a hypothesis about *when* the model might be wrong, not about any
 * individual game.
 */
function segmentsFor(b, ctx) {
  const segs = [];
  segs.push(['market', b.market]);
  if (b.market === 'spread') {
    segs.push(['side', b.side.includes(b.home) ? 'backed home' : 'backed away']);
    segs.push(['role', b.line < 0 ? 'home favoured' : 'home underdog']);
    segs.push(['spread size', Math.abs(b.line) >= 7 ? 'big spread (7+)' : Math.abs(b.line) <= 3 ? 'short spread (<=3)' : 'mid spread']);
  } else {
    segs.push(['side', /Over/.test(b.side) ? 'took over' : 'took under']);
    segs.push(['total size', b.line >= 48 ? 'high total (48+)' : b.line <= 41 ? 'low total (<=41)' : 'mid total']);
  }
  segs.push(['edge size', Math.abs(b.edge) >= 4 ? 'large edge (4+)' : 'small edge (<4)']);
  segs.push(['model agreement',
    (b.disagreement ?? 0) <= 3.5 ? 'models agree' : (b.disagreement ?? 0) >= 5.5 ? 'models scatter' : 'mixed']);
  segs.push(['part of season', b.week <= 6 ? 'early (wk 1-6)' : b.week >= 14 ? 'late (wk 14+)' : 'mid']);
  const c = ctx.get(`${b.season}|${b.week}|${b.home}`);
  if (c) {
    if (c.roof) segs.push(['venue', c.roof === 'dome' || c.roof === 'closed' ? 'indoors' : 'outdoors']);
    if (c.wind != null) segs.push(['wind', c.wind >= 15 ? 'windy (15+ mph)' : 'calm']);
    if (c.temp != null) segs.push(['temperature', c.temp < 32 ? 'freezing' : 'mild']);
    if (c.rest_days != null) segs.push(['rest', c.rest_days <= 6 ? 'short week' : c.rest_days >= 10 ? 'off a bye' : 'normal week']);
    if (c.div_game != null) segs.push(['divisional', c.div_game === 1 ? 'divisional' : 'non-divisional']);
  }
  return segs;
}

/**
 * Finds segments where the model is systematically wrong.
 *
 * `minBets` is the guard that keeps this from being noise-chasing: a 2-8 stretch
 * in freezing games is not evidence of anything. Segments are reported with
 * their sample size so a thin one is visibly thin, and the bias direction is
 * given as average signed error so the fix is legible.
 */
export function analyzeErrors(bets, { minBets = 25 } = {}) {
  const ctx = new Map();
  for (const r of rows(`SELECT season, week, team, roof, wind, temp, rest_days, div_game
                        FROM game_lines WHERE home = 1`)) {
    ctx.set(`${r.season}|${r.week}|${r.team}`, r);
  }

  const buckets = new Map();
  for (const b of bets) {
    if (b.result === 'Push') continue;
    for (const [dim, val] of segmentsFor(b, ctx)) {
      const key = `${dim}|${val}`;
      const e = buckets.get(key) ?? { dim, val, n: 0, wins: 0, units: 0, signed: [] };
      e.n++;
      if (b.result === 'Won') e.wins++;
      e.units += b.units;
      // Signed model error: positive means the model was too high on its side.
      e.signed.push(b.market === 'spread'
        ? b.model_margin - b.actual_margin
        : b.model_margin - b.actual_total);
      buckets.set(key, e);
    }
  }

  const out = [];
  for (const e of buckets.values()) {
    if (e.n < minBets) continue;
    const winRate = e.wins / e.n;
    out.push({
      dimension: e.dim, segment: e.val, bets: e.n,
      win_rate: r2(winRate), units: r2(e.units),
      roi: r2(e.units / e.n),
      mean_signed_error: r2(avg(e.signed)),
      beats_vig: winRate > 0.524,
      // How far from break-even, in standard errors — the honest test of whether
      // a segment is a real bias or just a run of results.
      z: r2((winRate - 0.524) / Math.sqrt(0.25 / e.n))
    });
  }
  out.sort((a, b) => a.win_rate - b.win_rate);

  const weakest = out.filter(s => s.win_rate < 0.5 && Math.abs(s.z) >= 1.5);
  const strongest = out.filter(s => s.win_rate > 0.55 && s.z >= 1.5);

  return {
    segments: out,
    weakest, strongest,
    note: weakest.length
      ? 'Segments below break-even by more than 1.5 standard errors are candidates for a correction — but any correction must be validated on a season it was not found on.'
      : 'No segment is reliably below break-even at this sample size. Differences here are consistent with chance, and "fixing" them would be fitting noise.'
  };
}

/**
 * Tests a proposed correction honestly.
 *
 * The adjustment is discovered on `discoverySeasons` and applied on
 * `holdoutSeasons`. If it only helps where it was found, it was noise — and
 * this says so rather than reporting the flattering number.
 */
export function validateAdjustment({ discoverySeasons, holdoutSeasons, adjust, config = {} }) {
  // Replays are deterministic, so each season is run once and the adjustment is
  // applied to the same bets — otherwise this replays every season four times.
  const cache = new Map();
  const betsFor = seasons => seasons.flatMap(s => {
    if (!cache.has(s)) {
      const r = replaySeason(s, config);
      cache.set(s, r.error ? [] : r.bets);
    }
    return cache.get(s);
  });

  const score = list => {
    const w = list.filter(b => b.result === 'Won').length;
    const l = list.filter(b => b.result === 'Lost').length;
    const u = list.reduce((s, b) => s + b.units, 0);
    return {
      bets: list.length, wins: w, losses: l,
      win_rate: w + l ? r2(w / (w + l)) : null,
      units: r2(u), roi: list.length ? r2(u / list.length) : null
    };
  };

  const discBets = betsFor(discoverySeasons);
  const holdBets = betsFor(holdoutSeasons);
  const discBase = score(discBets);
  const discAdj = score(discBets.map(adjust).filter(Boolean));
  const holdBase = score(holdBets);
  const holdAdj = score(holdBets.map(adjust).filter(Boolean));

  const helpedDiscovery = (discAdj.roi ?? -9) > (discBase.roi ?? -9);
  const helpedHoldout = (holdAdj.roi ?? -9) > (holdBase.roi ?? -9);

  return {
    discovery: { seasons: discoverySeasons, before: discBase, after: discAdj },
    holdout: { seasons: holdoutSeasons, before: holdBase, after: holdAdj },
    helped_discovery: helpedDiscovery,
    helped_holdout: helpedHoldout,
    verdict: helpedDiscovery && helpedHoldout
      ? 'Keep — the correction helped on seasons it was not derived from.'
      : helpedDiscovery && !helpedHoldout
        ? 'Reject — it only helps on the data that suggested it. This is overfitting, and shipping it would make the model worse on new games.'
        : !helpedDiscovery && helpedHoldout
          ? 'Inconclusive — it helps out of sample but not in sample, which usually means the sample is too small to tell.'
          : 'Reject — it does not help anywhere.'
  };
}

/**
 * One full training iteration: replay, grade, look for systematic bias, and
 * report what is worth acting on.
 */
export function trainingIteration(seasons, config = {}) {
  const perSeason = [];
  const allBets = [];
  for (const s of seasons) {
    const r = replaySeason(s, config);
    if (r.error) { perSeason.push({ season: s, error: r.error }); continue; }
    perSeason.push(r.summary);
    allBets.push(...r.bets);
  }
  const analysis = analyzeErrors(allBets, { minBets: config.minBets ?? 25 });

  const wins = allBets.filter(b => b.result === 'Won').length;
  const losses = allBets.filter(b => b.result === 'Lost').length;
  const units = allBets.reduce((s, b) => s + b.units, 0);

  return {
    seasons, config,
    overall: {
      bets: allBets.length, wins, losses,
      win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
      units: r2(units), roi: allBets.length ? r2(units / allBets.length) : null,
      break_even_needed: 0.524,
      beat_vig: wins + losses ? wins / (wins + losses) > 0.524 : null
    },
    per_season: perSeason,
    analysis
  };
}
