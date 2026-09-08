import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Package E's impact/timing model: reaction pairing against the raw quote
// tape (never against a simulator's own output — independent conclusion #6),
// the news-only/price-only/combined comparison, and the three negative
// controls run against the exact same code path real claims use.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-impact-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db, run, rows } = await import('../server/db/index.js');
const impact = await import('../server/services/nfl-news-event-impact.js');
await import('../server/services/nfl-quote-tape.js'); // creates nfl_quote_batches/nfl_quote_tape

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (1,'KC','Kansas City Chiefs','AFC','West')`);
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (2,'DEN','Denver Broncos','AFC','West')`);
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (3,'BUF','Buffalo Bills','AFC','East')`);
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (4,'MIA','Miami Dolphins','AFC','East')`);

let quoteSeq = 0;
function insertQuoteBatch(batchId, snapshotAt) {
  run(`INSERT OR IGNORE INTO nfl_quote_batches (batch_id, provider, requested_at, snapshot_at, mode, markets,
      source_ref, events, quotes, raw_hash, tape_version, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  batchId, 'the-odds-api', snapshotAt, snapshotAt, 'current', 'spreads', 'test', 1, 1, `hash_${batchId}`, 'test-v1', snapshotAt);
}
function insertQuote({ homeTeam, awayTeam, commenceTime, snapshotAt, line, americanPrice, impliedProbability,
  book = 'draftkings', side = 'home' }) {
  quoteSeq++;
  const batchId = `batch_${snapshotAt}_${book}`;
  insertQuoteBatch(batchId, snapshotAt);
  run(`INSERT INTO nfl_quote_tape (quote_id, batch_id, provider, provider_event_id, commence_time, snapshot_at,
      bookmaker_key, market, period, side_key, side_name, home_team, away_team, line, american_price,
      implied_probability, raw_json, tape_version, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  `q${quoteSeq}`, batchId, 'the-odds-api', 'evt1', commenceTime, snapshotAt, book, 'spreads', 'full_game',
  side, side, homeTeam, awayTeam, line, americanPrice, impliedProbability, '{}', 'test-v1', snapshotAt);
}

// A KC @ DEN game kicking off well after every snapshot below. Price drifts
// gently, then jumps right after the claim's first_seen_time.
const KICKOFF = '2026-09-21T17:00:00.000Z';
insertQuote({ homeTeam: 'Denver Broncos', awayTeam: 'Kansas City Chiefs', commenceTime: KICKOFF,
  snapshotAt: '2026-09-18T12:00:00.000Z', line: -3, americanPrice: -150, impliedProbability: 0.60 });
insertQuote({ homeTeam: 'Denver Broncos', awayTeam: 'Kansas City Chiefs', commenceTime: KICKOFF,
  snapshotAt: '2026-09-19T12:00:00.000Z', line: -3, americanPrice: -145, impliedProbability: 0.59 });
// first_seen_time for the real claim below sits right here:
const FIRST_SEEN = '2026-09-20T09:00:00.000Z';
insertQuote({ homeTeam: 'Denver Broncos', awayTeam: 'Kansas City Chiefs', commenceTime: KICKOFF,
  snapshotAt: '2026-09-20T10:00:00.000Z', line: -1, americanPrice: 105, impliedProbability: 0.49 });
insertQuote({ homeTeam: 'Denver Broncos', awayTeam: 'Kansas City Chiefs', commenceTime: KICKOFF,
  snapshotAt: '2026-09-20T20:00:00.000Z', line: -1, americanPrice: 108, impliedProbability: 0.48 });

// A completely unrelated BUF @ MIA game that also happens to straddle the same pivot time with real
// movement — exists purely so the irrelevant-team control below has something concrete to (wrongly) pick
// up, demonstrating that "a measured reaction" is not proof a given claim caused it.
insertQuote({ homeTeam: 'Miami Dolphins', awayTeam: 'Buffalo Bills', commenceTime: '2026-09-27T17:00:00.000Z',
  snapshotAt: '2026-09-19T12:00:00.000Z', line: -2, americanPrice: -120, impliedProbability: 0.55, book: 'irrelevant-book' });
insertQuote({ homeTeam: 'Miami Dolphins', awayTeam: 'Buffalo Bills', commenceTime: '2026-09-27T17:00:00.000Z',
  snapshotAt: '2026-09-20T18:00:00.000Z', line: -3.5, americanPrice: -160, impliedProbability: 0.61, book: 'irrelevant-book' });

test('reactionPairs finds the last quote before, and first quote after, a pivot time', () => {
  const pairs = impact.reactionPairs('KC', FIRST_SEEN, { market: 'spreads' });
  assert.equal(pairs.length, 1, JSON.stringify(pairs));
  assert.equal(pairs[0].had_before, true);
  assert.equal(pairs[0].before.snapshot_at, '2026-09-19T12:00:00.000Z');
  assert.equal(pairs[0].after.snapshot_at, '2026-09-20T10:00:00.000Z');
  assert.ok(Math.abs(pairs[0].prob_move - (0.49 - 0.59)) < 1e-9);
});

test('preClaimVolatility uses only prior price history, never the claim itself', () => {
  const vol = impact.preClaimVolatility('KC', FIRST_SEEN, { market: 'spreads', lookbackHours: 72 });
  assert.equal(vol.n_deltas, 1); // one delta between the two pre-claim snapshots
  assert.ok(vol.volatility >= 0);
});

test('fitOLS recovers known coefficients on a noiseless linear relationship', () => {
  // y = 2*x1 - 1*x2 + 3
  const X = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [3, 2]];
  const y = X.map(([x1, x2]) => 2 * x1 - 1 * x2 + 3);
  const beta = impact.fitOLS(X, y, { ridge: 1e-9 });
  assert.ok(Math.abs(beta[0] - 2) < 1e-4, `slope1 ${beta[0]}`);
  assert.ok(Math.abs(beta[1] - -1) < 1e-4, `slope2 ${beta[1]}`);
  assert.ok(Math.abs(beta[2] - 3) < 1e-4, `intercept ${beta[2]}`);
});

test('buildImpactDataset reports insufficient_data honestly below the minimum row count', () => {
  run(`INSERT INTO nfl_news_events (event_id, source_kind, source_ref, content_hash, player_key, player_name,
      team, claim_type, claim_text, evidence_span, published_at, first_seen_time, certainty, certainty_label,
      novelty_score, novelty_label, extractor_version, verification_state, verification_reason)
    VALUES ('claim1','news_item','1','h1','patrick mahomes','Patrick Mahomes','KC','injury_status','x',
      'questionable','2026-09-20T08:00:00.000Z',?,0.8,'stated',1,'new','v1','verified','ok')`, FIRST_SEEN);
  const dataset = impact.buildImpactDataset({ market: 'spreads', minRows: 20 });
  assert.equal(dataset.rows.length, 1);
  assert.equal(dataset.insufficient_data, true);
  assert.equal(dataset.rows[0].event_id, 'claim1');
  assert.ok(dataset.rows[0].label_abs_move > 0);

  const evaluation = impact.evaluateModels(dataset);
  assert.equal(evaluation.insufficient_data, true);
  assert.match(evaluation.verdict, /below 20/);
});

test('evaluateModels runs a real chronological comparison once enough rows exist, and reports MAE for every baseline', () => {
  // Build 24 synthetic claims across time, each paired against its own quote-tape reaction, so the
  // dataset clears MIN_ROWS without needing real production data.
  for (let i = 0; i < 24; i++) {
    const day = 22 + i; // spread across distinct dates so first_seen_time is strictly increasing
    const seenAt = new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + i * 86400000).toISOString();
    const kickoff = new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + i * 86400000 + 10 * 86400000).toISOString();
    const before = new Date(new Date(seenAt).getTime() - 3600000).toISOString();
    const after = new Date(new Date(seenAt).getTime() + 3600000).toISOString();
    const homeTeam = i % 2 === 0 ? 'Buffalo Bills' : 'Miami Dolphins';
    const awayTeam = i % 2 === 0 ? 'Miami Dolphins' : 'Buffalo Bills';
    const team = i % 2 === 0 ? 'BUF' : 'MIA';
    const move = 0.01 + (i % 5) * 0.01; // varies so the models have something to fit
    insertQuote({ homeTeam, awayTeam, commenceTime: kickoff, snapshotAt: before, line: -2,
      americanPrice: -110, impliedProbability: 0.5, book: `book${i}` });
    insertQuote({ homeTeam, awayTeam, commenceTime: kickoff, snapshotAt: after, line: -2,
      americanPrice: -110, impliedProbability: +(0.5 + move).toFixed(3), book: `book${i}` });
    run(`INSERT INTO nfl_news_events (event_id, source_kind, source_ref, content_hash, player_key, player_name,
        team, claim_type, claim_text, evidence_span, published_at, first_seen_time, certainty, certainty_label,
        novelty_score, novelty_label, extractor_version, verification_state, verification_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `synthclaim${i}`, 'news_item', String(i), `hsynth${i}`, `player${i}`, `Player ${i}`, team,
    i % 3 === 0 ? 'injury_status' : 'role_change', 'x', 'y', seenAt, seenAt, 0.5 + (i % 5) * 0.05, 'stated',
    +(0.2 + (i % 6) * 0.13).toFixed(2), i % 4 === 0 ? 'restatement' : 'new', 'v1', 'verified', 'ok');
  }
  const dataset = impact.buildImpactDataset({ market: 'spreads', minRows: 20 });
  assert.equal(dataset.insufficient_data, false, JSON.stringify(dataset.rows.length));
  const evaluation = impact.evaluateModels(dataset);
  assert.equal(evaluation.insufficient_data, false);
  assert.ok(evaluation.n_train > 0 && evaluation.n_test > 0);
  for (const key of ['no_move', 'news_only', 'price_only', 'combined']) {
    assert.equal(typeof evaluation.mae[key], 'number');
    assert.ok(evaluation.mae[key] >= 0);
  }
});

// ------------------------------------------------------ negative controls --

test('irrelevant-team control reports whatever it measures, honestly, for a team the claim never mentioned', () => {
  const claim = { team: 'KC', first_seen_time: FIRST_SEEN };
  const report = impact.irrelevantTeamControl(claim, 'BUF', { market: 'spreads' });
  assert.equal(report.control, 'irrelevant_team');
  assert.equal(report.substituted_team, 'BUF');
  // BUF has real synthetic quote activity in this fixture (from the previous test), so this MUST show a
  // measurable "reaction" despite the claim never mentioning Buffalo — the exact leak this control exists
  // to expose: an observed post-pivot move is not proof of causation.
  assert.ok(report.pairs_found > 0, 'the fixture deliberately gives the unrelated team real quote activity');
  assert.match(report.interpretation, /not proof of causation/);
});

test('duplicate-article control: a second identical extraction pass must be a strict no-op', async () => {
  let calls = 0;
  const extractOnce = async () => {
    calls++;
    return calls === 1 ? { candidates: 1, accepted: 1 } : { candidates: 0, accepted: 0 };
  };
  const report = await impact.duplicateArticleControl(extractOnce, {});
  assert.equal(report.leak, false);
  assert.equal(report.second_pass.candidates, 0);
  assert.equal(calls, 2);
});

test('duplicate-article control flags a leak if the second pass is NOT a no-op', async () => {
  const extractOnce = async () => ({ candidates: 1, accepted: 1 }); // simulates a cache that never dedupes
  const report = await impact.duplicateArticleControl(extractOnce, {});
  assert.equal(report.leak, true);
  assert.match(report.interpretation, /not deduping/);
});

test('time-shifted future news control is caught by the provenance rule before it reaches the impact model', () => {
  const claim = { team: 'KC', published_at: '2026-09-20T08:00:00.000Z', first_seen_time: FIRST_SEEN };
  const report = impact.timeShiftedFutureControl(claim, { market: 'spreads' });
  assert.equal(report.provenance_flag, true, 'observing a claim a day before it was published must be flagged');
  assert.equal(report.shifted_first_seen_time < report.real_published_at, true);
  assert.match(report.interpretation, /caught by the published_at/);
});

test('freezeImpactRun writes a manifest under a content hash and is idempotent on the same content', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-impact-freeze-'));
  const report = { hello: 'world', n: 1 };
  const first = impact.freezeImpactRun(report, { outputDir });
  const second = impact.freezeImpactRun(report, { outputDir });
  assert.equal(first.existing, false);
  assert.equal(second.existing, true);
  assert.equal(first.run_hash, second.run_hash);
  const manifest = JSON.parse(fs.readFileSync(path.join(first.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.hello, 'world');
  fs.rmSync(outputDir, { recursive: true, force: true });
});
