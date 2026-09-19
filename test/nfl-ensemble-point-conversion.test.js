/**
 * v15 point conversion (2026-09-16). Each game's component conversion is fit
 * only on seasons before its own, and opp_adjusted is fitted rather than
 * multiplied by a hand-picked 65.
 */
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-point-conversion-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const TEAMS = Array.from({ length: 16 }, (_, i) => `T${String(i).padStart(2, '0')}`);
const strength = (team, season) => ((TEAMS.indexOf(team) * 7 + season * 3) % 16 - 7.5) / 50;
const teamWeekRows = [];
for (let season = 2019; season <= 2023; season++) {
  for (let week = 1; week <= 17; week++) {
    for (const team of TEAMS) {
      const s = strength(team, season);
      teamWeekRows.push({ season, week, team, features: {
        off_epa_per_play: s / 2, def_epa_per_play: -s / 2, net_epa_per_play: s } });
    }
  }
}
mock.module('../server/services/nfl-pbp.js', { namedExports: { teamWeeks: () => teamWeekRows } });
mock.module('../server/services/nfl-availability.js', { namedExports: { availabilityDeficit: () => new Map() } });
mock.module('../server/services/nfl-roster-strength.js', { namedExports: { rosterStrengthWeek: () => new Map() } });
mock.module('../server/services/nfl-player-value.js', { namedExports: { gamePlayerAvailability: () => null } });
mock.module('../server/services/nfl-engine-registry.js', { namedExports: { nflEngineVersionFor: () => 'fixture-engine' } });
mock.module('../server/services/nfl-signal-reliability.js', { namedExports: {
  signalReliabilityFor: () => ({ version: 'fixture', multipliers: {}, adjusted: [] }) } });

// 8 games a week; margin tracks the strength gap so a real slope exists.
for (let season = 2019; season <= 2023; season++) {
  for (let week = 1; week <= 17; week++) {
    for (let i = 0; i < 8; i++) {
      const h = TEAMS[(i + week) % 16], a = TEAMS[(15 - i + week) % 16];
      if (h === a) continue;
      const margin = Math.round((strength(h, season) - strength(a, season)) * 60) + ((week + i) % 5) - 2;
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
        VALUES (?,?,?,?,1,-2,44,?,?)`, season, week, h, a, 20 + Math.max(margin, 0), 20 + Math.max(-margin, 0));
    }
  }
}

const ensemble = await import('../server/services/nfl-ensemble.js');

test('opp_adjusted receives a fitted conversion once enough earlier games exist', () => {
  const { calFor } = ensemble.ensembleReplayInputs({ minSeason: 2019 });
  const fit = calFor(2022).opp_adjusted;
  assert.ok(fit, 'opp_adjusted must be calibrated like the other efficiency components');
  assert.ok(Number.isFinite(fit.b1) && fit.b1 > 0, JSON.stringify(fit));
  assert.ok(fit.n >= 100);
});

test('a season with too little earlier history falls back rather than fitting on thin data', () => {
  const { calFor } = ensemble.ensembleReplayInputs({ minSeason: 2019 });
  assert.equal(calFor(2020).opp_adjusted, undefined);
});

test('later cutoffs learn from more seasons, earlier ones never see them', () => {
  const { calFor } = ensemble.ensembleReplayInputs({ minSeason: 2019 });
  assert.ok(calFor(2021).epa_net.n < calFor(2022).epa_net.n);
  assert.ok(calFor(2022).epa_net.n < calFor(2023).epa_net.n);
});

test('changing results in season S moves conversions for later seasons but never for S itself', () => {
  const before = ensemble.ensembleReplayInputs({ minSeason: 2019 });
  const c2022 = JSON.stringify(before.calFor(2022));
  const c2023 = JSON.stringify(before.calFor(2023));
  run(`UPDATE game_lines SET team_score = team_score + 40 WHERE season = 2022 AND home = 1`);
  ensemble.invalidateEnsembleCaches();
  const after = ensemble.ensembleReplayInputs({ minSeason: 2019 });
  assert.equal(JSON.stringify(after.calFor(2022)), c2022, '2022 conversion must not depend on 2022 results');
  assert.notEqual(JSON.stringify(after.calFor(2023)), c2023, '2023 conversion must learn from 2022 results');
});
