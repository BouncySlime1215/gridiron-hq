#!/usr/bin/env node
/**
 * Historical league backfill: weekly scores and final standings, on demand.
 *
 * This is step 1 of the what-wins study (docs/WHAT-WINS-STUDY.md). It supplies
 * the two things simulation cannot: the ground truth the replay has to
 * reproduce, and the calibration for what Nick's actual leaguemates do.
 *
 * **The work itself now lives in server/services/league-history.js**, and this
 * is a CLI over it. That is the point of the move: the two tables had exactly
 * one writer, this script, so they only ever filled when a person remembered
 * to run it — and `league_season_teams` is read on the trades surface
 * (manager-archetypes.js:243, :819, :831). scheduler.js's `league_history` job
 * now runs the same code on a timer; this stays for a forced, immediate or
 * narrowed run.
 *
 * Read-only against ESPN with Nick's own cookies. Never prints them.
 * Usage: node --env-file-if-exists=.env scripts/backfill-league-history.mjs \
 *          [--league N] [--seasons 2023,2024] [--force]
 *
 * Without --force, a PRIOR season already stored is not re-fetched (it is final
 * and cannot change); the current season always is. --force re-reads every
 * season in the window, which is what the original always did.
 */
process.env.SCHEDULER_DISABLED = '1';
const { backfillLeagueHistory } = await import('../server/services/league-history.js');
const { rows } = await import('../server/db/index.js');

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const ONLY_LEAGUE = argOf('--league');
const SEASONS = argOf('--seasons')?.split(',').map(Number) ?? null;

const out = await backfillLeagueHistory({
  leagueIds: ONLY_LEAGUE ? [Number(ONLY_LEAGUE)] : null,
  seasons: SEASONS,
  force: argv.includes('--force'),
  // A person typing this has decided to read ESPN now; the scheduled job is
  // what has to hold off during a draft, not a deliberate command. The risk
  // is real either way, so it is stated rather than hidden.
  checkLiveDraft: false,
  log: console.log,
});

// The draft picks beside these rows come from a different collector entirely
// (see league-history.js, note 3); printing what is already held keeps the
// what-wins study's step 1 readable as one picture rather than two.
for (const r of out.league_seasons.filter(r => !r.missing && !r.error)) {
  // Guarded: that collector creates its own table at run time, so on a box
  // where it has never run there is nothing to count and that is not a reason
  // to fail a backfill that has already written its rows.
  let picks = null;
  try {
    picks = rows('SELECT COUNT(*) n FROM league_draft_picks WHERE league_id=? AND season=?',
      r.league_id, r.season)[0]?.n ?? 0;
  } catch { picks = null; }
  console.log(`  ${r.league_id}/${r.season} picks(existing) ${picks == null ? 'n/a' : String(picks).padStart(4)}`);
}

console.log(`\nbackfill: ${out.ok} league-seasons | ${out.team_weeks} team-weeks | `
  + `${out.teams} team rows | ${out.not_existing} not-existing | ${out.failed} failed`);
process.exit(out.failed ? 1 : 0);
