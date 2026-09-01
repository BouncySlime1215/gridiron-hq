import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weekly-state-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { __test: featureTest } = await import('../server/services/nfl-weekly-feature-store.js');
const { ingestQuoteSnapshot, quoteTapeCoverage, bestExecutableQuote } =
  await import('../server/services/nfl-quote-tape.js');
const { learnedProfiles, clearLearnCache } = await import('../server/services/nfl-sim-learn.js');
const { __test: specialistTest } = await import('../server/services/nfl-orthogonal-specialists.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('weekly transforms preserve trend, volatility, coverage, and missingness separately', () => {
  const history = [4, 3, 2, 1].map((value, index) => ({ season: 2025, week: 4 - index,
    values: { epa: value, sparse: index === 0 ? 9 : null } }));
  const result = featureTest.transforms(history, new Map([['epa', [1, 2, 3, 4]]]));
  assert.equal(result.vector.epa__latest, 4);
  assert.equal(result.vector.epa__mean_3, 3);
  assert.ok(result.vector.epa__slope_6 > 0);
  assert.equal(result.vector.sparse__coverage_12, 0.083333);
  assert.equal(result.vector.sparse__missing, 0);
  assert.ok(result.missing.includes('sparse__delta_1'));
});

test('quote tape keeps books, points, prices, and source timestamps as separate immutable quotes', () => {
  const event = { id: 'event-1', commence_time: '2026-09-10T20:00:00Z',
    home_team: 'Home', away_team: 'Away', bookmakers: [
      { key: 'a', title: 'A', last_update: '2026-09-10T12:00:00Z', markets: [
        { key: 'spreads', outcomes: [{ name: 'Home', point: -3, price: -110 },
          { name: 'Away', point: 3, price: -110 }] }] },
      { key: 'b', title: 'B', last_update: '2026-09-10T12:01:00Z', markets: [
        { key: 'spreads', outcomes: [{ name: 'Home', point: -2.5, price: -105 },
          { name: 'Away', point: 2.5, price: -115 }] }] }
    ] };
  const first = ingestQuoteSnapshot([event], { requestedAt: '2026-09-10T12:02:00Z' });
  const duplicate = ingestQuoteSnapshot([event], { requestedAt: '2026-09-10T12:02:00Z' });
  assert.equal(first.quotes, 4);
  assert.equal(duplicate.existing, true);
  assert.equal(quoteTapeCoverage().books, 2);
  const best = bestExecutableQuote('event-1', { market: 'spreads', sideKey: 'home' });
  assert.equal(best.bookmaker_key, 'b');
  assert.equal(best.line, -2.5);
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_quote_tape')[0].n, 4);
});

test('simulator weekly profiles cannot see the target week or any later week', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_team_week_features (
    season INTEGER NOT NULL,week INTEGER NOT NULL,team TEXT NOT NULL,opponent TEXT,home INTEGER,
    features TEXT NOT NULL,PRIMARY KEY(season,week,team))`);
  for (let team = 0; team < 32; team++) for (let week = 1; week <= 4; week++) {
    const completion = week === 4 ? 0.99 : 0.55 + team / 1000;
    run(`INSERT INTO nfl_team_week_features(season,week,team,features) VALUES (?,?,?,?)`,
    2025, week, `T${team}`, JSON.stringify({ off_completion_pct: completion }));
  }
  clearLearnCache();
  const beforeWeek4 = learnedProfiles({ season: 2025, throughWeek: 4 });
  const complete = learnedProfiles({ season: 2025 });
  assert.equal(beforeWeek4.teams.get('T0').weeks, 3);
  assert.equal(complete.teams.get('T0').weeks, 4);
  assert.ok(beforeWeek4.teams.get('T0').rates.off_completion_pct
    < complete.teams.get('T0').rates.off_completion_pct);
  assert.equal(beforeWeek4.cutoff, '2025-before-W4');
});

test('the trusted 2022 reconstruction never falls backward into quarantined 2021 rows', () => {
  for (let team = 0; team < 32; team++) {
    for (let week = 1; week <= 3; week++) run(`INSERT OR IGNORE INTO nfl_team_week_features
      (season,week,team,features) VALUES (?,?,?,?)`, 2021, week, `Q${team}`,
    JSON.stringify({ off_completion_pct: 0.99 }));
    run(`INSERT OR IGNORE INTO nfl_team_week_features(season,week,team,features) VALUES (?,?,?,?)`,
    2022, 1, `T${team}`, JSON.stringify({ off_completion_pct: 0.55 }));
  }
  clearLearnCache();
  const profile = learnedProfiles({ season: 2022, throughWeek: 2 });
  assert.equal(profile.season, 2022);
  assert.equal(profile.fell_back, false);
  assert.equal(profile.teams.get('T0').weeks, 1);
});

test('orthogonal specialist artifacts persist by their content-addressed result id', () => {
  const artifact = { artifact_id: 'artifact-test-id', data_hash: 'data-test-hash',
    training_games: 400, validation_games: 80, families: [] };
  specialistTest.persistArtifact(artifact, 2025, 12);
  const saved = rows(`SELECT artifact_id,data_hash FROM nfl_orthogonal_specialist_artifacts
    WHERE artifact_id=?`, artifact.artifact_id)[0];
  assert.equal(saved.artifact_id, artifact.artifact_id);
  assert.equal(saved.data_hash, artifact.data_hash);
});
