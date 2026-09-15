/**
 * Regression coverage for the created_at receipt-clock fix in
 * nfl-news-signal.js: `playerNewsSignal` and `teamNewsSignals` cutoff
 * filters were previously checking only published_at (the article's own
 * claimed publish time), never created_at (this pipeline's own extraction
 * receipt timestamp, DEFAULT (datetime('now')) at INSERT time and never
 * touched by the upsert's ON CONFLICT DO UPDATE clause -- see the CREATE
 * TABLE in server/db/schema/nfl-n-to-z.js). A claim whose article predates a
 * decision cutoff but was not actually extracted into nfl_news_signals until
 * after that cutoff is not knowable at that cutoff, and must not be treated
 * as if it were -- the same class of look-ahead risk as news_items.ingested_at
 * (server/news/store.js), one layer over at the typed-claim/extraction layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-signal-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { playerNewsSignal, teamNewsSignals } = await import('../server/services/nfl-news-signal.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Mirrors the seedNewsSignal helper in test/nfl-replay-qualitative-segments.test.js,
// extended with an explicit created_at so each test can control the pipeline's
// own receipt timestamp independently of published_at.
function seedNewsSignal({ news_id, player_key, team, signal_type = 'availability', status,
    unavailable_probability = 0.9, confidence = 0.9, published_at, created_at, verification_state = 'verified' }) {
  db.prepare(`INSERT INTO nfl_news_signals
    (news_id, player_key, player_id, player_name, team, signal_type, status, unavailable_probability,
     confidence, published_at, source, evidence_span, extractor_version, verification_state, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'test','test evidence','test-v1',?,?)`)
    .run(news_id, player_key, player_key, player_key, team, signal_type, status, unavailable_probability,
      confidence, published_at, verification_state, created_at);
}

test('playerNewsSignal excludes a claim published before the cutoff but extracted (created_at) after it', () => {
  // Article published well before the cutoff, but this pipeline did not
  // actually turn it into a typed signal (created_at) until 4 days AFTER
  // the cutoff -- exactly the look-ahead gap this fix closes.
  seedNewsSignal({ news_id: 101, player_key: 'lateextract1', team: 'ZZZ', status: 'out',
    published_at: '2026-11-01T12:00:00Z', created_at: '2026-11-05T00:00:00Z' });

  const signal = playerNewsSignal('lateextract1', { team: 'ZZZ', before: '2026-11-02T00:00:00Z', maxAgeDays: 30 });
  assert.equal(signal, null, 'a claim not yet extracted as of the cutoff must not be treated as knowable at that cutoff');
});

test('playerNewsSignal still includes a claim published AND extracted before the cutoff (happy path preserved)', () => {
  seedNewsSignal({ news_id: 102, player_key: 'ontimeextract1', team: 'ZZZ', status: 'questionable',
    published_at: '2026-11-01T12:00:00Z', created_at: '2026-11-01T13:00:00Z' });

  const signal = playerNewsSignal('ontimeextract1', { team: 'ZZZ', before: '2026-11-02T00:00:00Z', maxAgeDays: 30 });
  assert.ok(signal, 'a claim genuinely extracted before the cutoff must still be visible');
  assert.equal(signal.availability?.status, 'questionable');
});

test('playerNewsSignal with no `before` given (defaults to now) is unaffected, since created_at can never be in the future', () => {
  seedNewsSignal({ news_id: 103, player_key: 'defaultnow1', team: 'ZZZ', status: 'doubtful',
    published_at: '2020-01-01T00:00:00Z', created_at: new Date().toISOString() });

  const signal = playerNewsSignal('defaultnow1', { team: 'ZZZ', maxAgeDays: 365 * 10 });
  assert.ok(signal, 'the default-to-now cutoff must not exclude a claim whose created_at is legitimately "now"');
  assert.equal(signal.availability?.status, 'doubtful');
});

test('teamNewsSignals excludes a claim published before the cutoff but extracted (created_at) after it', () => {
  seedNewsSignal({ news_id: 201, player_key: 'teamlate1', team: 'YYY', status: 'out',
    published_at: '2026-11-01T12:00:00Z', created_at: '2026-11-05T00:00:00Z' });

  const result = teamNewsSignals('YYY', { before: '2026-11-02T00:00:00Z', maxAgeDays: 30 });
  assert.equal(result.claims.find(c => c.player_key === 'teamlate1'), undefined,
    'team-level cutoff must also require extraction (created_at) before the cutoff, not just publication');
});

test('teamNewsSignals still includes a claim published AND extracted before the cutoff', () => {
  seedNewsSignal({ news_id: 202, player_key: 'teamontime1', team: 'YYY', status: 'out',
    published_at: '2026-11-01T12:00:00Z', created_at: '2026-11-01T13:00:00Z' });

  const result = teamNewsSignals('YYY', { before: '2026-11-02T00:00:00Z', maxAgeDays: 30 });
  assert.ok(result.claims.find(c => c.player_key === 'teamontime1'),
    'a claim genuinely extracted before the cutoff must still count toward team burden');
});

test('teamNewsSignals with no `before` given (defaults to now) is unaffected', () => {
  seedNewsSignal({ news_id: 203, player_key: 'teamdefaultnow1', team: 'YYY', status: 'out',
    published_at: '2020-01-01T00:00:00Z', created_at: new Date().toISOString() });

  const result = teamNewsSignals('YYY', { maxAgeDays: 365 * 10 });
  assert.ok(result.claims.find(c => c.player_key === 'teamdefaultnow1'),
    'the default-to-now cutoff must not exclude a claim whose created_at is legitimately "now"');
});

/*
 * R2 (2026-09-15): every test above hand-supplies created_at in ISO format
 * ('...T...Z'), which sidesteps the actual bug -- the table's own
 * `DEFAULT (datetime('now'))` writes SQLite's space-separated
 * 'YYYY-MM-DD HH:MM:SS', with no 'T' and no 'Z'. A bare `created_at<=?`
 * compared that TEXT against an ISO cutoff, and ' ' (0x20) sorts before 'T'
 * (0x54) -- so for any two timestamps on the SAME calendar date, the
 * space-formatted created_at compared as "earlier" REGARDLESS of the actual
 * time of day. Confirmed empirically against node:sqlite (this project's own
 * driver) before the fix: a row whose created_at was the literal current
 * instant still compared <= a cutoff from an hour earlier. These two tests
 * write created_at in that REAL format directly, so they actually exercise
 * the bug nfl-news-signal.js's datetime()-wrapped comparison now fixes.
 */

test('R2 regression: a same-day created_at in the pipeline\'s own datetime(\'now\') format compares correctly against an ISO cutoff', () => {
  seedNewsSignal({ news_id: 301, player_key: 'sameday1', team: 'XXX', status: 'out',
    published_at: '2026-11-01T12:00:00Z',
    // 18:00 the same calendar day as the cutoff below, in the REAL default
    // format -- chronologically AFTER the 06:00 cutoff, so this claim was
    // not yet extracted as of that cutoff and must be excluded.
    created_at: '2026-11-02 18:00:00' });

  const signal = playerNewsSignal('sameday1', { team: 'XXX', before: '2026-11-02T06:00:00.000Z', maxAgeDays: 30 });
  assert.equal(signal, null,
    'created_at (18:00) is genuinely AFTER the 06:00 cutoff on the same date -- a raw TEXT compare wrongly ' +
    'includes it because the space in datetime(\'now\')\'s format sorts before the ISO cutoff\'s "T"');
});

test('R2 regression: the same-format claim IS visible once its own created_at has actually passed', () => {
  seedNewsSignal({ news_id: 302, player_key: 'sameday2', team: 'XXX', status: 'out',
    published_at: '2026-11-01T12:00:00Z', created_at: '2026-11-02 06:00:00' });

  const signal = playerNewsSignal('sameday2', { team: 'XXX', before: '2026-11-02T18:00:00.000Z', maxAgeDays: 30 });
  assert.ok(signal, 'created_at (06:00) is genuinely before the 18:00 cutoff on the same date -- must be visible, ' +
    'proving the fix does not just exclude everything on a shared date');
});
