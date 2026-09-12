/**
 * Real bug found tonight: run 28 crashed 22 weeks in because a live
 * scheduler job updated nfl_teams' current coaching-staff fields
 * (head_coach/oc_name/off_scheme/etc), and the blind audit's freeze check
 * hashed the WHOLE table unconditionally -- voiding a multi-hour historical
 * replay over a field that has zero bearing on it. Those columns are
 * explicitly documented elsewhere (nfl-scheme.js, nfl-offseason-change.js,
 * offseason-model.js) as "one undated current snapshot," and prediction
 * code only ever reads id/abbr/name from this table (verified:
 * nfl-expert-council.js). This mirrors the exact fix already in place for
 * `players` (fantasy draft-room churn vs the canonical NFL identity the
 * model actually depends on).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-blind-audit-team-scope-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { __test } = await import('../server/services/nfl-blind-audit.js');
const { inputDataState, frozenResultHash } = __test;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('a live coaching-staff update to nfl_teams does not change the frozen input hash', () => {
  db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division, head_coach)
    VALUES (1, 'AAA', 'Test Team', 'AFC', 'East', 'Original Coach')`);
  const before = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  db.exec(`UPDATE nfl_teams SET head_coach='New Coach', oc_name='New OC', off_scheme='Air Raid',
    analysis_updated_at=datetime('now') WHERE id=1`);
  const afterCoachChange = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  assert.equal(afterCoachChange.hash, before.hash,
    'a coaching-staff update must not void a historical audit — that data is an undated current snapshot the replay never reads');
});

test('a change to nfl_teams\' actual identity columns (abbr/name) DOES change the hash', () => {
  db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division)
    VALUES (2, 'BBB', 'Original Name', 'NFC', 'West')`);
  const before = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  db.exec(`UPDATE nfl_teams SET name='Renamed Team' WHERE id=2`);
  const after = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  assert.notEqual(after.hash, before.hash,
    'a real identity change must still be caught -- this fix narrows the scope, it does not blind the freeze check entirely');
});

/**
 * Giant Plan 8.11: `nfl_ensemble_fit_artifacts` carried no season scope at
 * all, unlike its sibling `weekly_ensemble_fits` (scoped by `through_season`
 * a few lines above it). A live production fit — cutoff 'live', or a cutoff
 * for a season the audit never touches — has zero bearing on a historical
 * replay of 2021-2025, but would still change the table's unconditional hash
 * and void the run at the next freeze check.
 */
test('a live-cutoff ensemble fit artifact does not change the frozen input hash', () => {
  const before = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  db.exec(`INSERT INTO nfl_ensemble_fit_artifacts (artifact_key, model_version, data_fingerprint, cutoff, weighting, created_at, result_json)
    VALUES ('live-key-1', 'v1', 'fp1', 'live', 'exponential', datetime('now'), '{}')`);
  const afterLiveFit = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  assert.equal(afterLiveFit.hash, before.hash,
    "a live production fit must not void a historical audit -- cutoff='live' is never in scope for any historical replay");
});

test('an ensemble fit artifact cut off at a season past the audited window does not change the hash', () => {
  const before = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  db.exec(`INSERT INTO nfl_ensemble_fit_artifacts (artifact_key, model_version, data_fingerprint, cutoff, weighting, created_at, result_json)
    VALUES ('future-key-1', 'v1', 'fp1', '2026|3', 'exponential', datetime('now'), '{}')`);
  const afterFutureFit = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  assert.equal(afterFutureFit.hash, before.hash,
    'a fit cut off in a season this audit never replays must not void the run');
});

test('an ensemble fit artifact cut off inside the audited seasons DOES change the hash', () => {
  const before = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  db.exec(`INSERT INTO nfl_ensemble_fit_artifacts (artifact_key, model_version, data_fingerprint, cutoff, weighting, created_at, result_json)
    VALUES ('in-scope-key-1', 'v1', 'fp1', '2024|10', 'exponential', datetime('now'), '{}')`);
  const after = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  assert.notEqual(after.hash, before.hash,
    'a fit artifact whose cutoff falls inside the audited seasons is a real input change and must still be caught');
});

/**
 * Giant Plan 8.11 (result_hash side of the same section): `weekLookback`
 * reads `nfl_odds_archive`, `nfl_nfelo_games` and `nfl_external_ratings` via
 * `historicalOpenerReplay` -- none of which are in INPUT_TABLES or scoped by
 * this freeze at all. Baking that into `result_hash` meant a later
 * correction to one of those archives could silently change what a
 * "frozen" week's hash was, for data the freeze contract never covered.
 */
test('frozenResultHash excludes result.lookback from what result_hash commits to', () => {
  const base = { cutoff: '2024-W9', betting: { metrics: { bets: 3 } }, expert_council: { games: [] } };
  const withLookbackA = { ...base, lookback: { beat_the_close: { historical: { nfelo_pre_vs_open: { decisions: 1, mean_clv: 0.4 } } } } };
  const withLookbackB = { ...base, lookback: { beat_the_close: { historical: { nfelo_pre_vs_open: { decisions: 9, mean_clv: -1.2 } } } } };

  assert.equal(frozenResultHash(withLookbackA), frozenResultHash(withLookbackB),
    'two different look-back payloads over the same frozen result must hash identically -- the archives they read are not in the freeze scope');
  assert.equal(frozenResultHash(withLookbackA), frozenResultHash(base),
    'a result with no lookback attached yet must hash the same as one with lookback attached, since lookback is excluded either way');
});

test('frozenResultHash still changes when the actually-frozen content changes', () => {
  const a = { cutoff: '2024-W9', betting: { metrics: { bets: 3 } }, lookback: { anything: 1 } };
  const b = { cutoff: '2024-W9', betting: { metrics: { bets: 4 } }, lookback: { anything: 1 } };

  assert.notEqual(frozenResultHash(a), frozenResultHash(b),
    'a real change to the frozen result content must still change the hash -- this fix narrows what is hashed, it does not blind it');
});
