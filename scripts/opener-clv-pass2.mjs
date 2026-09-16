/**
 * Opener-CLV measurement, pass 2: the forecasters that need NO ensemble fit.
 * Companion to opener-clv-measurement.mjs (pass 1: ensemble blend, its ~35
 * components, drive sim). Same row shape, same output directory; the
 * summarizer merges the two by (season, week, home).
 *
 * WHICH OTHER FORECASTERS THIS CODEBASE HAS, AND WHY EACH IS OR IS NOT HERE
 * (inventoried 2026-09-16 at Nick's request -- "make sure we are using all
 * of our models"):
 *
 *   python_football   `football_alone` from the unified_margin_audit run's
 *                     predictions.json: the Stage 3 football model, weekly
 *                     walk-forward, out-of-fold. stage3_team_strength.py
 *                     states market_spread "NEVER" enters as an input, so it
 *                     is honest against openers. Free: already on disk.
 *   python_unified    `unified` from the same file: the football blend.
 *                     unified_model.py contains no market reference. Honest.
 *   python_correction `correction` from the same file. CONTAMINATED for this
 *                     test BY CONSTRUCTION: market_correction.py's features
 *                     are ['football_prediction', 'market_spread',
 *                     'market_movement'], i.e. it is handed the closing spread
 *                     and the opener-to-close move. Recorded and flagged so
 *                     nobody mistakes its "CLV" for edge; the same applies to
 *                     the ensemble component `market_correction_research`,
 *                     which is this lookup.
 *   lineup_roster     spread-family-adapters.js's lineup family computes
 *                     predicted = market + rosterResidual where
 *                     rosterResidual = structural - market + availability, so
 *                     the market CANCELS: the family's absolute forecast is
 *                     structural (1.5 + 0.32 * roster-score gap) plus the
 *                     cutoff-safe availability adjustment. Recomputed here
 *                     from the same three underlying functions so it never
 *                     touches the closing line at all.
 *
 *   NOT gradable on 2021-2025, and why:
 *   expert council    nfl_expert_forward_predictions holds 3,633 rows, ALL
 *                     season 2026. It is a forward-capture system; there is
 *                     no historical record to grade. (Its 12 experts include
 *                     game_replay = the drive sim and player_builder = the
 *                     lineup model, both graded here directly.)
 *   online neural     a market-RESIDUAL learner trained only on forward
 *                     settled examples (also 2026). For any historical game
 *                     it is a cold-start random network.
 *   unified engine    ensembleLine(market_residual) + simulateMatchup at the
 *                     CLOSING spread -- a combiner of things graded here,
 *                     fed the number CLV measures against.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/tmp/gridiron-extract/real.sqlite SCHEDULER_DISABLED=1 \
 *     node scripts/opener-clv-pass2.mjs --out docs/evidence/2026-09-16/opener-clv
 */
import fs from 'node:fs';
import path from 'node:path';
import { rows } from '../server/db/index.js';
import { gamePlayerAvailability } from '../server/services/nfl-player-value.js';
import { teamRosterStrength } from '../server/services/nfl-roster-strength.js';
import { gameInjuryCarryover } from '../server/services/nfl-postgame-truth.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const out = arg('--out', 'docs/evidence/2026-09-16/opener-clv');
const seasons = arg('--seasons', '2022,2023,2024,2025,2021').split(',').map(Number);
fs.mkdirSync(out, { recursive: true });

// Python OOF predictions, keyed by season|week|HOME. Game key is
// "2021-w01-ATL@PHI" = season-wWW-AWAY@HOME.
const latest = JSON.parse(fs.readFileSync(
  'docs/betting-model/research/experiment-results/unified_margin_audit/LATEST.json', 'utf8'));
const preds = JSON.parse(fs.readFileSync(path.join(latest.run_dir, 'predictions.json'), 'utf8'));
const pyByKey = new Map();
for (const p of (Array.isArray(preds) ? preds : preds.predictions ?? [])) {
  const m = /^(\d{4})-w(\d{2})-([A-Z]+)@([A-Z]+)$/.exec(p.game ?? '');
  if (!m) continue;
  pyByKey.set(`${+m[1]}|${+m[2]}|${m[4]}`, p);
}
console.error(`python predictions loaded: ${pyByKey.size} games from run ${latest.run_id}`);

const r2 = v => (Number.isFinite(v) ? +v.toFixed(2) : null);

function lineupRosterForecast(season, week, home, away) {
  // Verbatim logic from lineupFamilyForecast, minus the market term (which
  // cancels in the family's own algebra). Requires the structural term: if
  // only the availability adjustment exists, the family's forecast is
  // market + adjustment, which is market-dependent and not gradable here.
  const homeRoster = teamRosterStrength(season, week, home);
  const awayRoster = teamRosterStrength(season, week, away);
  if (!(homeRoster?.available && awayRoster?.available)) return { pred: null, reason: 'roster strength unavailable' };
  const structural = 1.5 + (homeRoster.roster_score - awayRoster.roster_score) * 0.32;
  const availability = gamePlayerAvailability(season, week, home, away);
  const carryover = gameInjuryCarryover(season, week, home, away);
  const availabilityResidual = Number.isFinite(availability?.shadow_margin_adjustment)
    && availability?.home?.evidence_state !== 'availability_unknown'
    && availability?.away?.evidence_state !== 'availability_unknown'
    ? availability.shadow_margin_adjustment + (carryover?.incremental_margin_adjustment ?? 0) : 0;
  return { pred: structural + availabilityResidual, structural: r2(structural), availability: r2(availabilityResidual) };
}

const started = Date.now();
for (const season of seasons) {
  const games = rows(`
    SELECT season, week, team AS home, opponent AS away, spread, open_spread, team_score, opp_score
    FROM game_lines
    WHERE home = 1 AND season = ? AND team_score IS NOT NULL AND opp_score IS NOT NULL
      AND spread IS NOT NULL AND open_spread IS NOT NULL AND COALESCE(neutral_site, 0) = 0
    ORDER BY week, team`, season);
  const file = path.join(out, `games-pass2-${season}.jsonl`);
  fs.writeFileSync(file, '');
  let n = 0, pyHit = 0, lineupHit = 0;
  for (const g of games) {
    const py = pyByKey.get(`${season}|${g.week}|${g.home}`) ?? null;
    if (py) pyHit++;
    let lineup = { pred: null, reason: 'error' };
    try { lineup = lineupRosterForecast(season, g.week, g.home, g.away); } catch (e) { lineup = { pred: null, reason: e.message }; }
    if (Number.isFinite(lineup.pred)) lineupHit++;
    fs.appendFileSync(file, JSON.stringify({
      season, week: g.week, home: g.home, away: g.away,
      open_spread: g.open_spread, close_spread: g.spread, actual_margin: g.team_score - g.opp_score,
      models: {
        python_football: py ? r2(py.football_alone) : null,
        python_unified: py ? r2(py.unified) : null,
        python_correction: py ? r2(py.correction) : null,   // CONTAMINATED -- see header
        lineup_roster: r2(lineup.pred)
      },
      lineup_detail: Number.isFinite(lineup.pred) ? { structural: lineup.structural, availability: lineup.availability } : { reason: lineup.reason },
      python_run: py ? latest.run_id : null
    }) + '\n');
    n++;
  }
  console.error(`${season}: ${n} games, python matched ${pyHit}, lineup available ${lineupHit}, ${Math.round((Date.now() - started) / 1000)}s`);
}
console.error('ALLDONE');
