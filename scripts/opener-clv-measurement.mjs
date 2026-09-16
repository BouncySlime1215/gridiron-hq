/**
 * The measurement Nick asked for on 2026-09-16: grade what we already have
 * against the RIGHT target.
 *
 * Every negative result in this project was measured against the CLOSING
 * line -- "can we forecast the final margin better than the market". Answered
 * no, 30+ ways. But nobody bets into a closing line. You bet into an OPENING
 * number that then moves, and the professional test of a bet is not whether
 * it won but whether the line moved TOWARD you afterwards: closing-line value
 * (CLV). It is continuous, so it has a fraction of win/loss's variance and
 * gives a verdict in hundreds of bets where ATS needs thousands.
 *
 * HONEST CONFIGURATION, and why each piece matters:
 *   - Ensemble: `ensembleLine(season, week, ...)` fits with a cutoff at that
 *     game's own week (nfl-ensemble.js:2375), so no future game is seen.
 *   - `blendMode: 'raw'`, NOT 'market_residual'. The residual blend returns
 *     the closing market VERBATIM whenever the joint gate fails, which it does
 *     -- measuring that against openers would be the close predicting itself.
 *   - `marketOverride: { home_spread: open_spread, total: open_total }`.
 *     Several components (market_anchor, market_regression) read the market
 *     line as an input. With the override, every component sees the OPENING
 *     line -- what a bettor actually sees at bet time -- and cannot see the
 *     close. Without this the "forecast" would be contaminated by the very
 *     number CLV measures against.
 *   - Sim: `simulateMatchup` with `season - 1` (complete prior-season
 *     profiles, the backtest's established configuration) and `spread:
 *     open_spread` so its situational modules also see only the opener.
 *   - Neutral-site games excluded (no home field to model), per 2026-09-16.
 *
 * 2021 IS REPORTED SEPARATELY AND MUST NOT BE POOLED. All openers come from
 * nflverse `initial_lines.csv`, but 2021's show mean |open-close| moves of
 * 3-5.6 points in weeks 7-18 with maxima of 12-15 points, against 1.1-1.8
 * in every other season. A 15-point opener-to-close move is not a real
 * market move; those are stale or look-ahead numbers. CLV against a garbage
 * opener looks spectacular and means nothing.
 *
 * Writes one JSONL row per game so partial progress is usable, then a
 * summary. Read-only against game_lines; fitEnsemble persists its usual
 * artifacts.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/tmp/gridiron-extract/real.sqlite SCHEDULER_DISABLED=1 \
 *     node scripts/opener-clv-measurement.mjs --out docs/evidence/2026-09-16/opener-clv \
 *       [--seasons 2022,2023,2024,2025,2021] [--trials 300] [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { rows } from '../server/db/index.js';
import { ensembleLine } from '../server/services/nfl-ensemble.js';
import { simulateMatchup } from '../server/services/nfl-drive-sim.js';
import { signedClvPoints } from '../server/services/clv-core.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const out = arg('--out', 'docs/evidence/2026-09-16/opener-clv');
const seasons = arg('--seasons', '2022,2023,2024,2025,2021').split(',').map(Number);
const trials = Number(arg('--trials', '300'));
const limit = Number(arg('--limit', '0'));
fs.mkdirSync(out, { recursive: true });

const r2 = v => (Number.isFinite(v) ? +v.toFixed(2) : null);

/**
 * One row per game per model. `ourLine`/`closeLine` are expressed from the
 * BACKED side's perspective, which is what clv-core's canonical
 * `signedClvPoints` expects -- so the home-favourite/underdog sign flip is
 * handled once, here, and never re-derived downstream.
 */
function grade({ pred, openSpread, closeSpread, actualMargin }) {
  if (!Number.isFinite(pred)) return null;
  const openMargin = -openSpread, closeMargin = -closeSpread;
  const lean = pred - openMargin;                 // + = we like HOME more than the open
  if (Math.abs(lean) < 1e-9) return null;         // no opinion, nothing to grade
  const backHome = lean > 0;
  // The line we bet (opener) and the line we could have got at close, both
  // from the backed side's perspective: home side takes the home spread,
  // away side takes its negation.
  const ourLine = backHome ? openSpread : -openSpread;
  const closeLine = backHome ? closeSpread : -closeSpread;
  const clvPoints = signedClvPoints({ market: 'spread', ourLine, closeLine });
  const lineMove = closeMargin - openMargin;      // + = market moved toward home
  const pushOpen = actualMargin + openSpread === 0;
  const coverHomeOpen = actualMargin + openSpread > 0;
  return {
    pred: r2(pred), lean: r2(lean), abs_lean: r2(Math.abs(lean)), back_home: backHome,
    line_move: r2(lineMove),
    clv_points: r2(clvPoints),
    clv_direction: Math.abs(lineMove) < 0.5 ? null : (Math.sign(lean) === Math.sign(lineMove)),
    ats_open: pushOpen ? null : (backHome === coverHomeOpen)
  };
}

const started = Date.now();
for (const season of seasons) {
  const games = rows(`
    SELECT season, week, team AS home, opponent AS away, spread, open_spread, total, open_total,
           team_score, opp_score
    FROM game_lines
    WHERE home = 1 AND season = ? AND team_score IS NOT NULL AND opp_score IS NOT NULL
      AND spread IS NOT NULL AND open_spread IS NOT NULL AND COALESCE(neutral_site, 0) = 0
    ORDER BY week, team ${limit ? `LIMIT ${limit}` : ''}`, season);
  const file = path.join(out, `games-${season}.jsonl`);
  fs.writeFileSync(file, '');
  let n = 0;
  for (const g of games) {
    const actualMargin = g.team_score - g.opp_score;
    let ens = null, ensErr = null, components = null, ensTotal = null, simExtra = null;
    try {
      const line = ensembleLine(season, g.week, g.home, g.away, {
        includeEvidence: false, blendMode: 'raw',
        marketOverride: { home_spread: g.open_spread, total: g.open_total, source: 'opening_line' }
      });
      if (line.error) ensErr = line.error;
      else {
        ens = grade({ pred: line.ensemble.projected_margin, openSpread: g.open_spread,
          closeSpread: g.spread, actualMargin });
        // Every one of the ~35 components is itself a model, and the blend
        // hides them. Record each one's raw margin (graded in the summarizer)
        // so "which single model, if any, has opener edge" is answerable from
        // the same pass rather than a second multi-hour run. Challengers are
        // included and flagged -- they are exactly the ones never graded live.
        components = line.models.map(m => ({ id: m.id, challenger: m.challenger_only === true, pred: m.margin, total: m.total ?? null }));
        ensTotal = line.ensemble.projected_total ?? null;
      }
    } catch (e) { ensErr = e.message; }

    let sim = null, simErr = null;
    try {
      const s = simulateMatchup({ home: g.home, away: g.away, season: season - 1, week: null,
        trials, spread: g.open_spread, total: g.open_total, seed: 20260916 });
      if (s.error) simErr = s.error;
      else {
        sim = grade({ pred: s.projection?.margin, openSpread: g.open_spread,
          closeSpread: g.spread, actualMargin });
        simExtra = { total: s.projection?.total ?? null, margin_sd: s.projection?.margin_sd ?? null,
          total_sd: s.projection?.total_sd ?? null };
      }
    } catch (e) { simErr = e.message; }

    fs.appendFileSync(file, JSON.stringify({
      season, week: g.week, home: g.home, away: g.away,
      open_spread: g.open_spread, close_spread: g.spread, actual_margin: actualMargin,
      open_total: g.open_total, close_total: g.total, actual_total: g.team_score + g.opp_score,
      ensemble: ens, ensemble_total: ensTotal, ensemble_error: ensErr, components, sim, sim_extra: simExtra, sim_error: simErr
    }) + '\n');
    n++;
    if (n % 25 === 0) console.error(`${season}: ${n}/${games.length} games, ${Math.round((Date.now() - started) / 1000)}s elapsed`);
  }
  console.error(`${season}: done, ${n} games`);
}
console.error('ALLDONE');
