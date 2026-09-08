import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-evidence-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'KC', 'Kansas City Chiefs', 'AFC', 'West'),
  (2, 'BAL', 'Baltimore Ravens', 'AFC', 'North')`);

const { contractKey, mirrorContract, eventKey } = await import('../server/services/nfl-contract-key.js');
const { recordRevision, valueAsKnown, revisionCoverage } = await import('../server/services/nfl-bitemporal.js');
const { ingestQuoteSnapshot } = await import('../server/services/nfl-quote-tape.js');
const { buildEvidenceDataset, freezeEvidenceDataset, readFrozenRows } =
  await import('../server/services/nfl-evidence-dataset.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('contractKey refuses an unresolved team rather than guessing', () => {
  const bad = contractKey({ homeTeam: 'Springfield Isotopes', awayTeam: 'BAL',
    commenceTime: '2026-09-11T00:20:00Z', market: 'spreads', side: 'home', line: -3.5 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unresolved_team');
});

test('contractKey builds a stable key and enforces market shape', () => {
  const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-09-11T00:20:00Z', market: 'spreads', side: 'home', line: -3.5 });
  assert.equal(c.ok, true);
  assert.equal(c.event_key, 'nfl|2026-09-10|BAL@KC');
  assert.equal(c.overtime, 'included');

  const noLine = contractKey({ homeTeam: 'KC', awayTeam: 'BAL', commenceTime: '2026-09-11T00:20:00Z',
    market: 'h2h', side: 'home', line: -3.5 });
  assert.equal(noLine.ok, false);
  assert.equal(noLine.reason, 'line_forbidden');

  const badLine = contractKey({ homeTeam: 'KC', awayTeam: 'BAL', commenceTime: '2026-09-11T00:20:00Z',
    market: 'spreads', side: 'home', line: -3.3 });
  assert.equal(badLine.ok, false);
  assert.equal(badLine.reason, 'invalid_line');
});

test('mirrorContract flips the line and side to the exact opposite bet', () => {
  const c = contractKey({ homeTeam: 'KC', awayTeam: 'BAL', commenceTime: '2026-09-11T00:20:00Z',
    market: 'spreads', side: 'home', line: -3.5 });
  const m = mirrorContract(c);
  assert.equal(m.side, 'away');
  assert.equal(m.line, 3.5);
  assert.equal(m.event_key, c.event_key);
});

test('eventKey rejects a game with the same team on both sides', () => {
  const dup = eventKey({ homeTeam: 'KC', awayTeam: 'KC', commenceTime: '2026-09-11T00:20:00Z' });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'same_team_both_sides');
});

test('bitemporal store returns the value known at decision time, not the final value', () => {
  recordRevision({ entity: 'player:x', feature: 'practice_status', value: 'full',
    publishedAt: '2026-09-03T18:00:00Z', observedAt: '2026-09-03T18:05:00Z',
    provenance: 'captured', sourceId: 'team_report' });
  recordRevision({ entity: 'player:x', feature: 'practice_status', value: 'questionable',
    publishedAt: '2026-09-05T20:58:00Z', observedAt: '2026-09-05T21:00:00Z',
    provenance: 'captured', sourceId: 'team_report' });

  const early = valueAsKnown('player:x', 'practice_status', '2026-09-04T12:00:00Z');
  assert.equal(early.known, true);
  assert.equal(early.value, 'full');
  assert.equal(early.revised_after_decision, 1);

  const late = valueAsKnown('player:x', 'practice_status', '2026-09-06T12:00:00Z');
  assert.equal(late.value, 'questionable');
  assert.equal(late.revised_after_decision, 0);

  const before = valueAsKnown('player:x', 'practice_status', '2026-09-01T12:00:00Z');
  assert.equal(before.known, false);
  assert.equal(before.reason, 'no_revision_available_yet');

  const coverage = revisionCoverage();
  assert.equal(coverage.revisions, 2);
});

test('bitemporal store refuses an observation timestamped before its own publication', () => {
  assert.throws(() => recordRevision({ entity: 'player:y', feature: 'f', value: 1,
    publishedAt: '2026-09-03T18:00:00Z', observedAt: '2026-09-01T00:00:00Z',
    provenance: 'captured', sourceId: 's' }), /precedes/);
});

test('evidence dataset accepts a clean pregame quote and quarantines a post-kickoff one', () => {
  const commence = '2026-09-11T00:20:00Z';
  const good = ingestQuoteSnapshot([{
    id: 'evt-1', commence_time: commence, home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [
      { key: 'spreads', last_update: '2026-09-10T12:00:00Z',
        outcomes: [{ name: 'Kansas City Chiefs', point: -3.5, price: -110 },
                   { name: 'Baltimore Ravens', point: 3.5, price: -110 }] }
    ] }]
  }], { requestedAt: '2026-09-10T12:00:05Z', sourceRef: 'test_snapshot_1' });
  assert.equal(good.quotes, 2);

  // Captured after kickoff: the pregame decision could never have used this.
  const stale = ingestQuoteSnapshot([{
    id: 'evt-1', commence_time: commence, home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [
      { key: 'spreads', last_update: commence,
        outcomes: [{ name: 'Kansas City Chiefs', point: -3.0, price: -105 },
                   { name: 'Baltimore Ravens', point: 3.0, price: -115 }] }
    ] }]
  }], { requestedAt: '2026-09-11T01:00:00Z', sourceRef: 'test_snapshot_2' });
  assert.equal(stale.quotes, 2);

  const dataset = buildEvidenceDataset({ decisionAt: '2026-09-12T00:00:00Z' });
  assert.equal(dataset.accepted, 2);
  assert.equal(dataset.scanned, 4);
  const afterKickoff = dataset.quarantine.find(q => q.reason === 'after_kickoff');
  assert.ok(afterKickoff, 'expected the post-kickoff quote to be quarantined');
  assert.equal(afterKickoff.count, 2);
  assert.equal(dataset.duplicate_event_count, 0);

  const frozen = freezeEvidenceDataset(dataset, { outputDir: path.join(temp, 'frozen') });
  assert.equal(frozen.existing, false);
  const rows = readFrozenRows(frozen.dataset_hash, { outputDir: path.join(temp, 'frozen') });
  assert.equal(rows.length, 2);
});

test('evidence dataset excludes rows from after the stated decision time', () => {
  const future = buildEvidenceDataset({ decisionAt: '2026-09-01T00:00:00Z' });
  assert.equal(future.accepted, 0);
  const futureReason = future.quarantine.find(q => q.reason === 'future_snapshot');
  assert.ok(futureReason);
});
