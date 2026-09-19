/**
 * Materialise the starting-QB-quality signal for the Python research dataset.
 *
 * WHY A MATERIALISATION AND NOT A REIMPLEMENTATION. Identifying the current
 * week's starter from the depth chart and matching him by name into
 * `nfl_qbr_weekly` lives in `server/services/nfl-qb-quality.js`, which reuses
 * the same `normalize`/`nameSignature` matching discipline the PFR defensive
 * weighting and the roster-value packet already established for this exact
 * cross-source id problem. Writing a second copy of that matching in Python
 * would give this project two versions of the same identity resolution to
 * keep in sync -- exactly the failure pattern this codebase's own docs call
 * out for PFR/CLV matching elsewhere. So the matching happens here, by the
 * one module that owns it, and is exported as data, the same shape
 * `scripts/export-availability-features.mjs` already established for the
 * injury/availability signal.
 *
 * CUTOFF. The starter's identity is read from the CURRENT week's own
 * `nfl_depth` row -- legitimately pregame-known, the same cutoff-safety
 * category as an injury report. That player's own trailing QBR is read from
 * STRICTLY EARLIER weeks only (same season, or any earlier season); it never
 * touches his QBR for the week being predicted, which would be reading the
 * outcome of the very game this feature is meant to help forecast.
 *
 * MISSINGNESS. A game with no admissible signal on either side is emitted
 * with `evidence: false` and both `*_qb_qbr` fields null. It is never a
 * per-side partial: a team with an identified but history-less starter (a
 * true rookie) and a team with real trailing QBR both land in the same
 * `evidence: false` record, because a correction head cannot learn from one
 * real number and one silent guess sitting in the same row.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/path/to/read-only-copy.sqlite \
 *     node scripts/export-qb-quality-features.mjs --out research/betting/nfl/qb_quality.json
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.SCHEDULER_DISABLED ??= '1';

const { rows } = await import('../server/db/index.js');
const { db } = await import('../server/db/index.js');
const { teamStartingQbQuality } = await import('../server/services/nfl-qb-quality.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

try {
  const out = arg('--out');
  if (!out) {
    console.error('usage: node scripts/export-qb-quality-features.mjs --out <file.json>');
    process.exit(2);
  }
  const minSeason = Number(arg('--min-season', '1999'));
  const throughSeason = Number(arg('--through-season', '2026'));

  const games = rows(
    `SELECT season, week, team AS home, opponent AS away, gameday
     FROM game_lines
     WHERE home = 1 AND gameday IS NOT NULL AND season BETWEEN ? AND ?
     ORDER BY season, week, team`, minSeason, throughSeason);

  const records = [];
  let withEvidence = 0;
  // Diagnostic coverage, summed across every game evaluated below: how often
  // a starter could be identified at all (nfl_depth coverage), and among
  // identified starters, how often he had at least one admissible prior QBR
  // row versus being a genuine rookie/no-history starter. A nonzero
  // "identified_no_history" count is not itself a defect -- it is the
  // rookie/new-starter case this module is explicitly required never to
  // paper over with a fabricated average.
  let homeStarterIdentified = 0, awayStarterIdentified = 0;
  let homeIdentifiedNoHistory = 0, awayIdentifiedNoHistory = 0;
  for (const g of games) {
    const home = teamStartingQbQuality(g.season, g.week, g.home);
    const away = teamStartingQbQuality(g.season, g.week, g.away);
    if (home.starter) { homeStarterIdentified++; if (!home.evidence) homeIdentifiedNoHistory++; }
    if (away.starter) { awayStarterIdentified++; if (!away.evidence) awayIdentifiedNoHistory++; }

    const evidence = home.evidence && away.evidence;
    if (evidence) withEvidence++;
    records.push({
      season: g.season, week: g.week, home: g.home, away: g.away,
      evidence,
      // Present only when BOTH sides have admissible signal. A game where
      // only one side's starter has history is not emitted as a half-real
      // row -- see MISSINGNESS above.
      home_qb_qbr: evidence ? home.qbr : null,
      away_qb_qbr: evidence ? away.qbr : null,
    });
  }

  const payload = {
    schema: 'nfl-qb-quality-features-v1',
    created_at: new Date().toISOString(),
    source: 'server/services/nfl-qb-quality.js teamStartingQbQuality',
    matching: 'current-week starter from nfl_depth (pos_abb=QB, pos_rank=1), matched by name into '
      + 'nfl_qbr_weekly (ESPN player_id shares no id space with nfl_depth.gsis_id): normalize() exact '
      + 'match first, first-initial+surname signature fallback only when it resolves to exactly one '
      + 'identity, abstain on ambiguity',
    admission: 'the starter\'s identity comes from the current week\'s own depth-chart row (pregame-'
      + 'known, like an injury report); his QBR history is read from strictly earlier weeks of the same '
      + 'season or any earlier season only -- never the week being predicted',
    missingness: 'evidence=false with both *_qb_qbr null whenever either side has no identified '
      + 'starter or no admissible prior QBR (a true rookie, or a first career start); never a '
      + 'fabricated league-average QBR',
    min_season: minSeason, through_season: throughSeason,
    games: records.length,
    games_with_evidence: withEvidence,
    home_starter_identified: homeStarterIdentified,
    away_starter_identified: awayStarterIdentified,
    home_starter_identified_no_prior_history: homeIdentifiedNoHistory,
    away_starter_identified_no_prior_history: awayIdentifiedNoHistory,
    records,
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), JSON.stringify(payload));
  console.log(JSON.stringify({
    out: path.resolve(out), games: records.length, games_with_evidence: withEvidence,
    coverage: records.length ? +(withEvidence / records.length).toFixed(4) : 0,
    home_starter_identified: homeStarterIdentified, away_starter_identified: awayStarterIdentified,
    home_starter_identified_no_prior_history: homeIdentifiedNoHistory,
    away_starter_identified_no_prior_history: awayIdentifiedNoHistory,
  }, null, 2));
} finally {
  db.close();
}
