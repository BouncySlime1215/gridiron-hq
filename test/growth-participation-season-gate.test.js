/**
 * The growth cycle gated participation ingest on `season <= 2023`, on the
 * belief that nflverse stops publishing it after 2023. It does not: 2022, 2023,
 * 2024 and 2025 all serve, and only the current season 404s. Commit 1d8f6aa
 * corrected that belief in nfl-formations.js's own doc comment; this is the
 * same wrong constant in the job that actually runs, which silently drops two
 * full seasons of a free feed the repo already knows how to ingest.
 *
 * Verified against the real assets rather than inferred — range request against
 * the release, see docs/tdd/participation-columns.tdd.md:
 *
 *   participation 2022 -> 206    2024 -> 206
 *   participation 2023 -> 206    2025 -> 206
 *   participation 2026 -> 404    (current season, never published)
 *
 * Every feed is stubbed to fail, because what is under test is whether the
 * cycle *attempts* participation for a post-2023 season, not whether the
 * download works. `attempt` records a failure under its own key either way, so
 * the key's presence is the signal and no module mocking is needed.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-growth-gate-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const FUTURE = 2099;
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// finalized_week > 0 needs a week whose every home game has both scores.
// Two seasons: 2024 is the one the old gate dropped, and a far-future season
// so that no `season <= N` constant can pass — a gate moved forward to 2025 or
// 2026 is the same bug again one year later, which is precisely how this one
// survived two seasons.
for (const season of [2024, FUTURE]) {
  for (const [team, opp] of [['BUF', 'MIA'], ['KC', 'DEN']]) {
    run(`INSERT INTO game_lines (season, week, team, opponent, home, team_score, opp_score)
         VALUES (?,?,?,?,?,?,?)`, season, 1, team, opp, 1, 24, 17);
  }
}

globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '', body: null });

const { runNflModelGrowthCycle } = await import('../server/services/nfl-model-growth.js');
const result = await runNflModelGrowthCycle({ season: 2024, force: true });
const future = await runNflModelGrowthCycle({ season: FUTURE, force: true });

test('a 2024 cycle attempts participation ingest', () => {
  assert.ok(Object.hasOwn(result.ingestion, 'formation_participation'),
    `ingestion keys: ${Object.keys(result.ingestion).join(', ')}`);
});

test('FTN charting is attempted too, which it always was', () => {
  assert.ok(Object.hasOwn(result.ingestion, 'ftn_charting'));
});

test('no season constant at all — a far-future season is attempted as well', () => {
  // Moving the gate forward instead of deleting it would pass the 2024 test and
  // reintroduce the identical bug a year later. This is what forbids that.
  assert.ok(Object.hasOwn(future.ingestion, 'formation_participation'),
    `ingestion keys for ${FUTURE}: ${Object.keys(future.ingestion).join(', ')}`);
});
