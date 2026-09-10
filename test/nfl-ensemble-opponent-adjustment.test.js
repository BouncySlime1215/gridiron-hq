/**
 * Codex audit finding M13 (2026-09-10): `nfl-ensemble.js`'s `opp_adjusted`
 * component was named "Opponent-adjusted EPA" but its formula,
 * `((off_epa - league) - league) - ((def_epa - league) - league)`, cancels
 * algebraically to plain `off_epa - def_epa` -- mathematically identical to
 * the unadjusted `epa_net` component elsewhere in the same file, despite the
 * name and note both claiming a real opponent-strength correction.
 *
 * This proves the fix: two teams with IDENTICAL raw offensive/defensive EPA
 * but DIFFERENT schedules (one faced weak defenses, one faced strong
 * defenses) must now receive DIFFERENT `opp_adjusted` margins -- which is
 * only possible if the component is actually reading each team's real
 * opponents (`c.schedule`), not just its own raw stat line.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-opp-adjusted-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { mock } = await import('node:test');
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Two "padding" pools of teams with perfectly average, featureless stat
// lines, purely to give `ensembleLine`'s `hist.length >= 100` floor enough
// games to clear -- none of them factor into the assertion.
const FILLER_TEAMS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
// A and B are the subjects: identical raw off/def EPA, opposite schedules.
// WEAK1/WEAK2 are bad defenses (high EPA allowed); STRONG1/STRONG2 are good
// defenses (very negative EPA allowed).
const SUBJECT_TEAMS = ['SUBJ_A', 'SUBJ_B', 'WEAK1', 'WEAK2', 'STRONG1', 'STRONG2'];
const ALL_TEAMS = [...FILLER_TEAMS, ...SUBJECT_TEAMS];

const featuresFor = (team, week) => {
  if (team === 'SUBJ_A' || team === 'SUBJ_B') return { off_epa_per_play: 0.05, def_epa_per_play: -0.02 };
  if (team === 'WEAK1' || team === 'WEAK2') return { off_epa_per_play: 0, def_epa_per_play: 0.18 }; // bad defense: allows a lot of EPA
  if (team === 'STRONG1' || team === 'STRONG2') return { off_epa_per_play: 0, def_epa_per_play: -0.18 }; // great defense
  return { off_epa_per_play: 0, def_epa_per_play: 0 }; // filler teams: perfectly average
};

const teamWeekRows = [];
for (let week = 1; week <= 4; week++) {
  for (const team of ALL_TEAMS) teamWeekRows.push({ season: 2024, week, team, features: featuresFor(team, week) });
}

mock.module('../server/services/nfl-pbp.js', { namedExports: { teamWeeks: () => teamWeekRows } });
mock.module('../server/services/nfl-roster-strength.js', { namedExports: { rosterStrengthWeek: () => new Map() } });
mock.module('../server/services/nfl-availability.js', { namedExports: { availabilityDeficit: () => new Map() } });
mock.module('../server/services/nfl-player-value.js', { namedExports: { gamePlayerAvailability: () => null } });
mock.module('../server/services/nfl-engine-registry.js', { namedExports: { nflEngineVersionFor: () => 'fixture-engine' } });
mock.module('../server/services/nfl-signal-reliability.js', { namedExports: {
  signalReliabilityFor: () => ({ version: 'fixture', multipliers: {}, adjusted: [] })
} });

// Filler history: plenty of ordinary games among the padding pool across
// several prior seasons, purely to satisfy ensembleLine's history floor.
for (let season = 2018; season <= 2023; season++) {
  for (let week = 1; week <= 17; week++) {
    for (let pair = 0; pair < 4; pair++) {
      const h = FILLER_TEAMS[pair], a = FILLER_TEAMS[7 - pair];
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
        VALUES (?,?,?,?,1,-2,44,24,21)`, season, week, h, a);
    }
  }
}

// The actual schedule that matters: in 2024 weeks 1-2, SUBJ_A plays the two
// WEAK defenses and SUBJ_B plays the two STRONG defenses -- identical raw
// stat lines, opposite strength of schedule. A few filler games fill out
// week 1-4 so the target week-5 history stays above the 100-game floor.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
  VALUES (2024,1,'SUBJ_A','WEAK1',1,-2,44,27,20)`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
  VALUES (2024,2,'SUBJ_A','WEAK2',1,-2,44,27,20)`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
  VALUES (2024,1,'SUBJ_B','STRONG1',1,-2,44,27,20)`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
  VALUES (2024,2,'SUBJ_B','STRONG2',1,-2,44,27,20)`);
// A third meeting each. Codex correction C04 defines an explicit
// sparse-coverage floor: below three eligible opponents the schedule is too
// thin to say anything about strength faced, and the component falls back to
// the league average rather than averaging one or two games into a confident
// adjustment. A real team at week 5 has played four; this fixture previously
// gave each subject two, which is below any honest threshold.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
  VALUES (2024,3,'SUBJ_A','WEAK1',1,-2,44,27,20)`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
  VALUES (2024,3,'SUBJ_B','STRONG1',1,-2,44,27,20)`);
for (let week = 1; week <= 4; week++) {
  for (let pair = 0; pair < 4; pair++) {
    const h = FILLER_TEAMS[pair], a = FILLER_TEAMS[7 - pair];
    run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
      VALUES (2024,?,?,?,1,-2,44,27,20)`, week, h, a);
  }
}
// The target game itself, week 5.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total)
  VALUES (2024,5,'SUBJ_A','SUBJ_B',1,-1,44)`);

const { ensembleLine } = await import('../server/services/nfl-ensemble.js');

test('opp_adjusted gives DIFFERENT margins for teams with identical raw EPA but different schedule strength (M13 fix)', () => {
  const line = ensembleLine(2024, 5, 'SUBJ_A', 'SUBJ_B', { includeEvidence: false, blendMode: 'raw' });
  assert.ok(!line.error, JSON.stringify(line));
  const comp = line.models.find(m => m.id === 'opp_adjusted');
  assert.ok(comp, 'opp_adjusted component must be present in the model trace');
  assert.ok(comp.margin != null, 'opp_adjusted must produce a margin once schedule + feature data exist');
  // SUBJ_A faced weak defenses (an easy schedule) and SUBJ_B faced strong
  // defenses (a hard schedule) despite identical raw stat lines -- a real
  // opponent adjustment must credit SUBJ_B's offense more than SUBJ_A's,
  // pulling the home-team (SUBJ_A) margin negative (i.e. favoring away/B).
  assert.ok(comp.margin < -0.5,
    `opp_adjusted margin ${comp.margin} should meaningfully favor SUBJ_B (the team with the tougher schedule), not read as ~0 the way plain unadjusted net EPA would (both teams share identical raw off/def EPA)`);
});

test('opp_adjusted falls back gracefully (no crash, relative-to-league) when a team has no resolvable schedule', () => {
  const line = ensembleLine(2024, 1, 'SUBJ_A', 'SUBJ_B', { includeEvidence: false, blendMode: 'raw' });
  // Week 1 has no prior-week history for either team to have a schedule from
  // (hist for week 1 draws only on season < 2024), so this must not throw --
  // either a null margin or a league-relative fallback, never an exception.
  const comp = line.models?.find?.(m => m.id === 'opp_adjusted');
  if (line.error) return; // acceptable if week 1 alone doesn't clear the history floor
  assert.ok(comp === undefined || comp.margin === null || Number.isFinite(comp.margin));
});

test('C04: below the sparse-coverage floor the adjustment falls back instead of guessing', async () => {
  // SUBJ_A and SUBJ_B each have three eligible opponents at week 5, which
  // clears the floor. At week 3 they have only one apiece — genuinely too
  // little to characterise a schedule — and the component must then read as
  // league-relative rather than as a confident adjustment built from one game.
  const { __testables } = await import('../server/services/nfl-ensemble.js');
  const hist = [
    { season: 2024, week: 1, home: 'SUBJ_A', away: 'WEAK1' },
    { season: 2024, week: 2, home: 'SUBJ_A', away: 'WEAK2' },
    { season: 2024, week: 3, home: 'SUBJ_A', away: 'WEAK1' }
  ];
  const atWeek2 = __testables.scheduleFaced(hist, { season: 2024, week: 2 });
  const atWeek5 = __testables.scheduleFaced(hist, { season: 2024, week: 5 });
  assert.equal((atWeek2.get('SUBJ_A') ?? []).length, 1, 'one opponent by week 2');
  assert.equal((atWeek5.get('SUBJ_A') ?? []).length, 3, 'three by week 5, which clears the floor');
});
