/**
 * Materialise per-game availability deficits for the Python research dataset.
 *
 * WHY A MATERIALISATION AND NOT A REIMPLEMENTATION. The player-specific injury
 * weighting lives in `server/services/nfl-availability.js`: each absence costs
 * the snap share that player was actually taking, times a replacement weight,
 * times a status factor (Out 1.0 / Doubtful 0.75 / Questionable 0.25). The
 * replacement weight is a flat positional constant (QB 4.5 down to long
 * snapper 0.05) on offense, and on defense is that same constant only as a
 * fallback -- otherwise each charted defender's own prior-weeks PFR
 * production. Writing a second copy of any of that in Python would give this
 * project two versions of the same numbers to keep in sync, which is the
 * failure pattern its own GitHub catalog documents for CLV and devig. So the
 * weights are computed here, by the one module that owns them, and exported
 * as data.
 *
 * CUTOFF. Each game is evaluated at its own kickoff day, and
 * `availabilityDeficit` is called with that cutoff so only injury rows
 * untouched since before the game are admitted. Rows revised afterwards are
 * excluded rather than read as though they were the pre-game report -- the
 * table keeps no version history, so the earlier text is genuinely gone.
 *
 * MISSINGNESS. A game with no admissible evidence is emitted with
 * `evidence: false` and null deficits. It is never emitted as zero: zero means
 * "everyone who matters is playing", which is a claim this data cannot make.
 * `defenders_pfr_matched` / `defenders_pfr_unmatched` carry the analogous
 * caveat for the defensive replacement weight specifically: a nonzero
 * unmatched count is not itself a defect (real PFR `def` rows only exist from
 * 2024 on), just the flat fallback correctly doing its job.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/path/to/read-only-copy.sqlite \
 *     node scripts/export-availability-features.mjs --out research/betting/nfl/availability.json
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.SCHEDULER_DISABLED ??= '1';

const { rows } = await import('../server/db/index.js');
const { db } = await import('../server/db/index.js');
const { availabilityDeficit } = await import('../server/services/nfl-availability.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

try {
  const out = arg('--out');
  if (!out) {
    console.error('usage: node scripts/export-availability-features.mjs --out <file.json>');
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
  // Coverage of the per-player defensive production weight `availabilityDeficit`
  // computes internally: how many of its charted defenders got their own
  // prior-weeks PFR production weight versus fell back to the flat positional
  // constant (all of 2021-2023, or any player PFR never charted). Counted
  // across every game evaluated below, not deduped by player, since the same
  // defender's match outcome can differ week to week as more PFR rows accrue.
  let defendersPfrMatched = 0;
  let defendersPfrUnmatched = 0;
  for (const g of games) {
    // The game's own day is the information boundary: an injury row still
    // untouched at that point is the report as it stood going into the game.
    const cutoffAt = `${g.gameday}T00:00:00Z`;
    const deficit = availabilityDeficit(g.season, g.week, { cutoffAt });
    const home = deficit.get(String(g.home).toUpperCase());
    const away = deficit.get(String(g.away).toUpperCase());
    const evidence = deficit.size > 0 && (home != null || away != null);
    if (evidence) withEvidence++;
    defendersPfrMatched += deficit.pfrDefenseMatched ?? 0;
    defendersPfrUnmatched += deficit.pfrDefenseUnmatched ?? 0;
    records.push({
      season: g.season, week: g.week, home: g.home, away: g.away,
      cutoff_at: cutoffAt,
      evidence,
      // Present only when the week produced admissible evidence at all. A
      // team inside such a week with no listed absences is a real zero.
      home_deficit: evidence ? (home ?? 0) : null,
      away_deficit: evidence ? (away ?? 0) : null,
    });
  }

  const payload = {
    schema: 'nfl-availability-features-v1',
    created_at: new Date().toISOString(),
    source: 'server/services/nfl-availability.js availabilityDeficit (cutoff-admitted)',
    weighting: 'prior-weeks snap share x replacement weight x report-status cost; the replacement '
      + 'weight is a flat positional constant on offense, and on defense is that same constant only '
      + 'as a fallback -- otherwise each charted defender\'s own prior-weeks PFR production '
      + '(pressures, sacks, tackles, missed tackles)',
    admission: 'injury rows with modified_at present and <= the game day; the table keeps no '
      + 'version history, so rows revised later are excluded rather than back-dated',
    missingness: 'evidence=false with null deficits; never zero, which would assert a healthy roster',
    min_season: minSeason, through_season: throughSeason,
    games: records.length,
    games_with_evidence: withEvidence,
    // How much of the defensive replacement weight above came from real PFR
    // production rather than the flat positional fallback -- summed the same
    // per-game way as games_with_evidence, across every game in this export.
    // Real nfl_pfr_adv `def` rows exist only from the 2024 season on, so
    // exports touching earlier seasons will show a real, non-zero unmatched
    // count; that is the fallback path working as intended, not a defect.
    defenders_pfr_matched: defendersPfrMatched,
    defenders_pfr_unmatched: defendersPfrUnmatched,
    records,
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), JSON.stringify(payload));
  console.log(JSON.stringify({
    out: path.resolve(out), games: records.length, games_with_evidence: withEvidence,
    coverage: records.length ? +(withEvidence / records.length).toFixed(4) : 0,
    defenders_pfr_matched: defendersPfrMatched, defenders_pfr_unmatched: defendersPfrUnmatched,
  }, null, 2));
} finally {
  db.close();
}
