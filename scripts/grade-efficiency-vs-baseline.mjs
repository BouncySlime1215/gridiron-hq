/**
 * Is the EFFICIENCY half of the structural projection tested, or is it three
 * hand-set numbers?
 *
 * `projections.js:94-125` carries five shrinkage constants. One of them —
 * `int_rate: 1600` — is swept and graded, and its comment shows the method this
 * project trusts for a constant of this shape: try a geometric grid, score each
 * on held-out seasons against the population's own climatology, take the
 * winner. The other three efficiency constants are not:
 *
 *   yards_per: 34   "yards per opportunity — regress hard"
 *   catch_rate: 26  "raw targets"
 *   td_rate: 70     "the most regression-prone number in fantasy"
 *
 * Those three are the last ungraded numbers in the points path. The volume half
 * has a fitter, a walk-forward grade and a promotion gate (shrinkage-fit.js);
 * the efficiency half has a fitter whose output was tested and REJECTED
 * (`shrinkage-fit.js:465-473` — substituting it made 2025 worse, 4.773 vs
 * 4.749, because "player" is not a stable group for efficiency within a season
 * and the method-of-moments between-player variance is inflated for these
 * metrics). That rejection says the FITTER is wrong for efficiency. It says
 * nothing about whether 34, 26 and 70 are right, because nobody has swept them
 * — which is what the int_rate comment did, and what this script does.
 *
 * WHAT IS GRADED
 *
 * For each cutoff (season s, week w) the model is built with everything through
 * week w and nothing after it, and its efficiency numbers are scored against
 * what the player actually did in weeks w+1..18 of the same season:
 *
 *   yards_per_target   vs forward receiving yards / forward targets
 *   catch_rate         vs forward receptions / forward targets
 *   yards_per_carry    vs forward rushing yards / forward carries
 *   yards_per_attempt  vs forward passing yards / forward attempts
 *   rec_td_rate        vs forward receiving TDs / forward targets
 *   rush_td_rate       vs forward rushing TDs / forward carries
 *
 * WHAT MAKES IT FAIR
 *
 *   - Every arm is the REAL `buildProjections`, called with a `kOverride` that
 *     differs in one constant family and nothing else. `pickK` (`:203-206`)
 *     takes `rawN` when a fit supplies k and `hardcodedN` otherwise, but for
 *     every efficiency metric those two are the same expression, so a supplied
 *     k changes the constant and only the constant.
 *   - Every arm passes a `kOverride` object, so `activeKVectorFor` is never
 *     consulted (`projections.js:461`) and the VOLUME half is held at its
 *     hardcoded constants in all arms, whether or not this database has an
 *     active shrinkage fit. This is a study of the efficiency constants, so
 *     nothing else is allowed to move.
 *   - The gate is on FORWARD usage — at least 20 forward targets or carries,
 *     40 for the touchdown rates, 60 forward attempts for QBs. Forward usage is
 *     never an input to any arm, so the gate cannot favour one. All arms are
 *     scored on identical rows by construction: one cutoff builds one row set.
 *   - `k = 0` and `k = Infinity` are IN the grid, so the two baselines a manager
 *     has without us come out of the same machinery as the shipped arm:
 *     k = 0 is the player's own rate to date, unshrunk; k = Infinity is the
 *     positional prior alone (`shrinkSafe`, `projections.js:209`).
 *   - Significance is a paired bootstrap CLUSTERED BY PLAYER
 *     (`backtest-significance.js#pairedBootstrapDiff`): one player appears at up
 *     to ten cutoffs in a season and those errors are not independent draws. The
 *     reported interval is on `shipped_error - candidate_error`, so a POSITIVE
 *     interval means the candidate k beats the shipped literal.
 *
 * USAGE
 *
 *   GRIDIRON_DB_PATH=/tmp/scratch.sqlite node scripts/grade-efficiency-vs-baseline.mjs
 *   GRIDIRON_DB_PATH=/tmp/scratch.sqlite node scripts/grade-efficiency-vs-baseline.mjs --out eff.json
 *
 * Read-only: it activates nothing and writes nothing to the database. It is
 * still slow (one full projection build per cutoff per grid point, ~0.4 s each),
 * so it prints progress to stderr.
 */
import fs from 'node:fs';
import { buildProjections } from '../server/services/projections.js';
import { PPR } from '../server/services/scoring.js';
import { rows } from '../server/db/index.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

const SEASONS = [2024, 2025];
const CUTOFFS = { from: 5, to: 14 };   // forward window is w+1..18, so 4 weeks minimum
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * The three ungraded constants, each with a geometric grid straddling the
 * shipped literal, and 0 / Infinity as the two no-model bookends.
 */
const FAMILIES = {
  yards_per:  { literal: 34, metrics: ['ypt', 'ypc', 'ypa'],
                grid: [0, 4, 9, 17, 34, 68, 136, 300, Infinity] },
  catch_rate: { literal: 26, metrics: ['catch_rate'],
                grid: [0, 3, 6.5, 13, 26, 52, 104, 250, Infinity] },
  td_rate:    { literal: 70, metrics: ['rec_td_rate', 'rush_td_rate', 'pass_td_rate'],
                grid: [0, 9, 17.5, 35, 70, 140, 280, 600, Infinity] },
};

/** graded metric -> which family's constant drives it, where to read the
 *  prediction, and what the realized value is made of. */
const GRADED = {
  ypt:          { family: 'yards_per',  field: 'yards_per_target',
                  num: 'recYds', den: 'targets',  minDen: 20 },
  catch_rate:   { family: 'catch_rate', field: 'catch_rate',
                  num: 'receptions', den: 'targets', minDen: 20 },
  ypc:          { family: 'yards_per',  field: 'yards_per_carry',
                  num: 'rushYds', den: 'carries', minDen: 20 },
  ypa:          { family: 'yards_per',  field: 'yards_per_attempt',
                  num: 'passYds', den: 'attempts', minDen: 60 },
  rec_td_rate:  { family: 'td_rate',    field: 'rec_td_rate',
                  num: 'recTds', den: 'targets',  minDen: 40 },
  rush_td_rate: { family: 'td_rate',    field: 'rush_td_rate',
                  num: 'rushTds', den: 'carries', minDen: 40 },
};

const mae = xs => xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length;
const kLabel = k => (k === Infinity ? 'prior only' : k === 0 ? 'own rate' : String(k));

/** A kOverride that supplies ONE family's constant at every position, and nothing else. */
function overrideFor(family, k) {
  const out = {};
  for (const metric of FAMILIES[family].metrics) {
    out[metric] = Object.fromEntries(POSITIONS.map(p => [p, k]));
  }
  return out;
}

/** What each player actually did after the cutoff, aggregated over weeks w+1..18. */
function forwardActuals(season, week) {
  const out = new Map();
  for (const u of rows(
    `SELECT player_id, targets, carries, attempts, receptions,
            receiving_yards, rushing_yards, passing_yards, receiving_tds, rushing_tds
       FROM player_week_usage WHERE season = ? AND week > ?`, season, week)) {
    let a = out.get(u.player_id);
    if (!a) out.set(u.player_id, a = { targets: 0, carries: 0, attempts: 0, receptions: 0,
      recYds: 0, rushYds: 0, passYds: 0, recTds: 0, rushTds: 0 });
    a.targets += u.targets ?? 0;       a.carries += u.carries ?? 0;
    a.attempts += u.attempts ?? 0;     a.receptions += u.receptions ?? 0;
    a.recYds += u.receiving_yards ?? 0; a.rushYds += u.rushing_yards ?? 0;
    a.passYds += u.passing_yards ?? 0;
    a.recTds += u.receiving_tds ?? 0;  a.rushTds += u.rushing_tds ?? 0;
  }
  return out;
}

function run() {
  // graded metric -> k label -> array of signed errors, aligned with keys/players/seasons
  const errors = {};
  const meta = {};
  for (const metric of Object.keys(GRADED)) { errors[metric] = {}; meta[metric] = []; }

  for (const season of SEASONS) {
    for (let week = CUTOFFS.from; week <= CUTOFFS.to; week++) {
      const after = forwardActuals(season, week);
      for (const [family, spec] of Object.entries(FAMILIES)) {
        const metrics = Object.entries(GRADED).filter(([, g]) => g.family === family);
        for (const k of spec.grid) {
          // The row set is identical across k within a family, so each metric's
          // per-row identity is recorded once, on its own family's first grid
          // point. Recording it once GLOBALLY is the bug this replaced: it left
          // `players` empty for every family after the first, which silently
          // un-clusters the bootstrap and makes the intervals too narrow.
          const fillMeta = k === spec.grid[0];
          const built = buildProjections({
            through: season, throughWeek: week, scoring: PPR, kOverride: overrideFor(family, k),
          });
          for (const [metric, g] of metrics) {
            const bucket = errors[metric][kLabel(k)] ??= [];
            for (const p of built.values()) {
              const was = after.get(p.player_id);
              if (!was || was[g.den] < g.minDen) continue;
              const actual = was[g.num] / was[g.den];
              const predicted = p.efficiency?.[g.field];
              if (!Number.isFinite(predicted)) continue;
              bucket.push(predicted - actual);
              if (fillMeta) meta[metric].push({ player: String(p.player_id), season, week, den: was[g.den] });
            }
          }
        }
      }
      process.stderr.write(`  ${season} w${week} done\n`);
    }
  }
  return { errors, meta };
}

function report({ errors, meta }) {
  for (const [metric, g] of Object.entries(GRADED)) {
    const literal = FAMILIES[g.family].literal;
    const shipped = errors[metric][kLabel(literal)];
    const players = meta[metric].map(m => m.player);
    if (!shipped?.length) { console.log(`\n${metric}: no graded rows\n`); continue; }
    console.log(`\n=== ${metric}  (K.${g.family} = ${literal})  n = ${shipped.length} rows, ` +
                `${new Set(players).size} players, gate: ${g.minDen}+ forward ${g.den} ===`);
    const shippedAbs = shipped.map(Math.abs);
    for (const k of FAMILIES[g.family].grid) {
      const arm = errors[metric][kLabel(k)];
      if (arm?.length !== shipped.length) { console.log(`  ${kLabel(k).padStart(11)}  (row mismatch, skipped)`); continue; }
      const armAbs = arm.map(Math.abs);
      const bias = arm.reduce((s, v) => s + v, 0) / arm.length;
      const mark = k === literal ? ' <- shipped' : '';
      if (k === literal) {
        console.log(`  ${kLabel(k).padStart(11)}  MAE ${mae(armAbs).toFixed(4)}  bias ${bias >= 0 ? '+' : ''}${bias.toFixed(4)}${mark}`);
        continue;
      }
      // Positive interval => the candidate k has LESS error than the shipped literal.
      const d = pairedBootstrapDiff(armAbs, shippedAbs, { groups: players });
      const beats = d.ci90[0] > 0 ? '  BEATS SHIPPED' : d.ci90[1] < 0 ? '  loses' : '';
      console.log(`  ${kLabel(k).padStart(11)}  MAE ${mae(armAbs).toFixed(4)}  bias ${bias >= 0 ? '+' : ''}${bias.toFixed(4)}` +
                  `  shipped-minus-this 90% CI ${JSON.stringify(d.ci90.map(x => +x.toFixed(4)))}${beats}`);
    }
  }
}

const out = process.argv.indexOf('--out');
const result = run();
if (out >= 0) {
  fs.writeFileSync(process.argv[out + 1], JSON.stringify(result));
  process.stderr.write(`raw errors -> ${process.argv[out + 1]}\n`);
}
report(result);
