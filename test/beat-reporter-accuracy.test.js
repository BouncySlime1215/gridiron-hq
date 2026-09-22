/**
 * Beat reporter source map — historical accuracy for the injury_status slice.
 *
 * Nick's ask: "Score sources historically: whose reports actually predicted
 * outcomes vs. who cried wolf." This is the first claim_type (injury_status,
 * the one with a clean ground truth: player_week_snaps says who actually
 * played). Three things are asserted:
 *
 *  - classifyInjuryDirection is a deterministic keyword read of the claim
 *    text, not a second LLM call — one hallucination surface (the extractor)
 *    is enough.
 *  - resolveInjuryClaim only ever answers confirmed/contradicted when it has
 *    real snap-count evidence for a game that has already been played; every
 *    other case is 'unresolved' with a printed reason, never a guess.
 *  - sourceTrustScore never lets an unscored or thin-sample handle read as
 *    "measured and bad": zero resolved claims is the 'none' state, not a low
 *    number, and a thin sample is 'pooled' toward a claim-type baseline, not
 *    reported as its own raw (and possibly 100%-off-one-claim) rate.
 *  - orderByTrust keeps an unscored item at its own index rather than sorting
 *    an absent score to the top or bottom.
 *
 * No real historical news/snap data is reachable from this environment
 * (server/data.sqlite is an empty pre-migration fixture — no nfl_news_events
 * table, zero schedule_games/player_week_usage rows). Every fixture below is
 * therefore constructed by hand, not sampled from production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-beat-reporter-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { rows, row, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const {
  classifyInjuryDirection, resolveInjuryClaim, resolveInjuryClaims, sourceTrustScore, orderByTrust
} = await import('../server/services/beat-reporter-accuracy.js');

// ---- fixtures ---------------------------------------------------------

const KC = row(`SELECT id FROM nfl_teams WHERE abbr='KC'`)?.id
  ?? (run(`INSERT INTO nfl_teams (abbr,name,conference,division) VALUES ('KC','Kansas City Chiefs','AFC','West')`), row(`SELECT id FROM nfl_teams WHERE abbr='KC'`).id);

function makePlayer(name, position = 'WR') {
  run(`INSERT INTO players (name, position, team_id) VALUES (?, ?, ?)`, name, position, KC);
  return row(`SELECT id FROM players WHERE name=?`, name).id;
}

function makeGame(season, week, date) {
  run(`INSERT INTO schedule_games (season, team_id, week, date, opponent_abbr, home)
       VALUES (?, ?, ?, ?, 'BUF', 1)`, season, KC, week, date);
}

function setSnaps(playerId, season, week, offenseSnaps) {
  run(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
       VALUES (?,?,?,?,?)
       ON CONFLICT(player_id, season, week) DO UPDATE SET offense_snaps=excluded.offense_snaps`,
    playerId, season, week, offenseSnaps, offenseSnaps > 0 ? 0.7 : 0);
}

let eventSeq = 0;
function makeEvent({ playerName, team = 'KC', claimText, publishedAt, handle = 'RotoRealist' }) {
  const event_id = `ev-${++eventSeq}`;
  run(`INSERT INTO nfl_news_events
       (event_id, source_kind, source_ref, content_hash, player_key, player_id, player_name, team,
        claim_type, claim_text, evidence_span, source_name, source_url, reporter_handle,
        published_at, first_seen_time, extractor_version)
       VALUES (?,'news_item',?,?,?,?,?,?,'injury_status',?,?,?,?,?,?,?,'test-1')`,
    event_id, event_id, `hash-${event_id}`, playerName.toLowerCase(), null, playerName, team,
    claimText, claimText, 'Test Wire', 'https://example.test', handle, publishedAt, publishedAt);
  return event_id;
}

function insertResolution({ handle, claimType = 'injury_status', state }) {
  const event_id = `manual-${++eventSeq}`;
  // beat_reporter_claim_resolutions.event_id references nfl_news_events, so a
  // sourceTrustScore-only fixture still needs a (minimal) parent row.
  run(`INSERT INTO nfl_news_events
       (event_id, source_kind, source_ref, content_hash, claim_type, claim_text, evidence_span,
        published_at, first_seen_time, extractor_version)
       VALUES (?,'news_item',?,?,?,?,?,?,?,'test-1')`,
    event_id, event_id, `hash-${event_id}`, claimType, 'fixture claim', 'fixture claim',
    '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
  run(`INSERT INTO beat_reporter_claim_resolutions
       (event_id, reporter_handle, claim_type, predicted_direction, resolved_state, resolved_reason, resolved_at)
       VALUES (?,?,?,?,?,?,datetime('now'))`,
    event_id, handle, claimType, state === 'confirmed' ? 'sidelined' : 'clear', state,
    `fixture row for sourceTrustScore`);
}

// ---- classifyInjuryDirection -------------------------------------------

test('classifyInjuryDirection reads sidelined language', () => {
  assert.equal(classifyInjuryDirection('Ruled out for Sunday with a hamstring injury.'), 'sidelined');
  assert.equal(classifyInjuryDirection('He is doubtful and unlikely to suit up.'), 'sidelined');
  assert.equal(classifyInjuryDirection('Listed as inactive on the final report.'), 'sidelined');
});

test('classifyInjuryDirection reads clear language', () => {
  assert.equal(classifyInjuryDirection('He has been cleared to play this week.'), 'clear');
  assert.equal(classifyInjuryDirection('Active for today\'s game, no injury designation.'), 'clear');
  assert.equal(classifyInjuryDirection('Expected to play after a full practice.'), 'clear');
});

test('classifyInjuryDirection reads questionable/day-to-day as uncertain, not a guess', () => {
  assert.equal(classifyInjuryDirection('Listed as questionable with a knee issue.'), 'uncertain');
  assert.equal(classifyInjuryDirection('Day-to-day, game-time decision expected.'), 'uncertain');
});

test('classifyInjuryDirection returns null when the text carries no injury-status signal', () => {
  assert.equal(classifyInjuryDirection('Signed a two-year contract extension.'), null);
});

// ---- resolveInjuryClaim -------------------------------------------------

test('resolveInjuryClaim: sidelined claim confirmed by zero snaps in the next game', () => {
  const player = makePlayer('Sidelined Confirmed WR');
  makeGame(2026, 3, '2026-09-21');
  setSnaps(player, 2026, 3, 0);
  const eventId = makeEvent({
    playerName: 'Sidelined Confirmed WR', claimText: 'Ruled out for Sunday with a hamstring injury.',
    publishedAt: '2026-09-19T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-09-22T00:00:00Z' });
  assert.equal(res.predicted_direction, 'sidelined');
  assert.equal(res.resolved_state, 'confirmed');
  assert.equal(res.season, 2026);
  assert.equal(res.week, 3);
});

test('resolveInjuryClaim: sidelined claim confirmed when the player has no snap row at all but teammates do', () => {
  // Real nflverse snap-count data only carries a row for a player who logged at
  // least one snap — a player ruled out has NO row, not a zero row. Confirmed by
  // hand-checking against real 2025 week-1 data (Will Hernandez, ARI, "Out": no
  // snap_counts row while 47 ARI teammates have one for that same game).
  const player = makePlayer('No Row At All WR');
  const teammate = makePlayer('Row Present Teammate');
  makeGame(2026, 12, '2026-11-23');
  setSnaps(teammate, 2026, 12, 40); // proves the team's week-12 box score exists
  const eventId = makeEvent({
    playerName: 'No Row At All WR', claimText: 'Ruled out for this week\'s game.',
    publishedAt: '2026-11-21T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-11-24T00:00:00Z' });
  assert.equal(res.resolved_state, 'confirmed');
  assert.match(res.resolved_reason, /no offensive-snap row/i);
});

test('resolveInjuryClaim: sidelined claim contradicted when the player actually played', () => {
  const player = makePlayer('Sidelined Contradicted WR');
  makeGame(2026, 8, '2026-10-26');
  setSnaps(player, 2026, 8, 45);
  const eventId = makeEvent({
    playerName: 'Sidelined Contradicted WR', claimText: 'Doubtful for this week\'s matchup.',
    publishedAt: '2026-10-24T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-10-27T00:00:00Z' });
  assert.equal(res.resolved_state, 'contradicted');
});

test('resolveInjuryClaim: clear claim confirmed when the player played', () => {
  const player = makePlayer('Clear Confirmed WR');
  makeGame(2026, 4, '2026-09-28');
  setSnaps(player, 2026, 4, 50);
  const eventId = makeEvent({
    playerName: 'Clear Confirmed WR', claimText: 'Cleared to play, no injury designation.',
    publishedAt: '2026-09-26T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-09-29T00:00:00Z' });
  assert.equal(res.resolved_state, 'confirmed');
});

test('resolveInjuryClaim: clear claim contradicted when the player did not play', () => {
  const player = makePlayer('Clear Contradicted WR');
  makeGame(2026, 9, '2026-11-02');
  setSnaps(player, 2026, 9, 0);
  const eventId = makeEvent({
    playerName: 'Clear Contradicted WR', claimText: 'Expected to play after practicing fully.',
    publishedAt: '2026-10-31T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-11-03T00:00:00Z' });
  assert.equal(res.resolved_state, 'contradicted');
});

test('resolveInjuryClaim: unresolved when the game has not been played yet, not a guess', () => {
  const player = makePlayer('Future Game WR');
  makeGame(2026, 5, '2026-10-05');
  const eventId = makeEvent({
    playerName: 'Future Game WR', claimText: 'Ruled out for the upcoming game.',
    publishedAt: '2026-10-01T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-10-02T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /not.*played|no snap/i);
});

test('resolveInjuryClaim: unresolved when the claim text does not commit to a direction', () => {
  const player = makePlayer('Uncertain WR');
  makeGame(2026, 10, '2026-11-09');
  setSnaps(player, 2026, 10, 30);
  const eventId = makeEvent({
    playerName: 'Uncertain WR', claimText: 'Listed as questionable, a game-time decision.',
    publishedAt: '2026-11-07T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-11-10T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /questionable|day-to-day|direction/i);
});

test('resolveInjuryClaim: unresolved when the reporter\'s team abbreviation is not recognized', () => {
  const eventId = makeEvent({
    playerName: 'No Team Player', team: 'ZZ', claimText: 'Ruled out this week.',
    publishedAt: '2026-09-19T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-09-22T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /team/i);
});

test('resolveInjuryClaim: unresolved when the player name does not resolve to a roster row', () => {
  makeGame(2026, 11, '2026-11-16');
  const eventId = makeEvent({
    playerName: 'Nobody On The Roster', claimText: 'Ruled out this week.',
    publishedAt: '2026-11-14T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-11-17T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /player/i);
});

test('resolveInjuryClaim: unresolved for a defensive position, since offense_snaps cannot speak for it', () => {
  // Confirmed by hand-checking against real 2025 week-1 nflverse data: a CB (Jaire
  // Alexander) cleared to play read as "confirmed... 0 offensive snaps" before this
  // guard existed, which would have called a real, correct claim contradicted purely
  // because cornerbacks don't record offensive snaps.
  const player = makePlayer('Shutdown CB', 'CB');
  makeGame(2026, 13, '2026-11-30');
  const eventId = makeEvent({
    playerName: 'Shutdown CB', claimText: 'Cleared to play, full practice all week.',
    publishedAt: '2026-11-28T12:00:00Z',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveInjuryClaim(ev, { asOf: '2026-12-01T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /position.*not covered/i);
});

// ---- resolveInjuryClaims (batch) ----------------------------------------

test('resolveInjuryClaims writes one upserted row per injury_status event', () => {
  const player = makePlayer('Batch WR');
  makeGame(2026, 6, '2026-10-12');
  setSnaps(player, 2026, 6, 0);
  const eventId = makeEvent({
    playerName: 'Batch WR', claimText: 'Ruled out with a hamstring injury.',
    publishedAt: '2026-10-10T12:00:00Z', handle: 'BatchReporter',
  });
  const result = resolveInjuryClaims({ asOf: '2026-10-13T00:00:00Z' });
  assert.ok(result.resolved >= 1);
  const stored = row(`SELECT * FROM beat_reporter_claim_resolutions WHERE event_id=?`, eventId);
  assert.equal(stored.resolved_state, 'confirmed');
  assert.equal(stored.reporter_handle, 'BatchReporter');

  // Re-running does not duplicate the row (upsert on event_id).
  resolveInjuryClaims({ asOf: '2026-10-13T00:00:00Z' });
  const count = row(`SELECT COUNT(*) AS n FROM beat_reporter_claim_resolutions WHERE event_id=?`, eventId).n;
  assert.equal(count, 1);
});

// ---- sourceTrustScore -----------------------------------------------------

test('sourceTrustScore: a handle with zero resolved claims is "none", never a low number', () => {
  const res = sourceTrustScore('NeverScoredHandle');
  assert.equal(res.state, 'none');
  assert.equal(res.score, null);
  assert.equal(res.sample_size, 0);
});

test('sourceTrustScore: a handle past the sample floor is "measured" at its raw rate', () => {
  const handle = 'MeasuredHandle';
  for (let i = 0; i < 8; i++) insertResolution({ handle, state: i < 6 ? 'confirmed' : 'contradicted' });
  const res = sourceTrustScore(handle);
  assert.equal(res.state, 'measured');
  assert.equal(res.sample_size, 8);
  assert.equal(res.score, 0.75);
});

test('sourceTrustScore: a thin sample is "pooled" and NOT reported as its own raw rate', () => {
  const handle = 'ThinSampleHandle';
  // Also give the pool a non-trivial baseline below 100% so the test cannot
  // pass by coincidence (pooled score equal to raw would happen if the
  // baseline were also 1.0).
  for (let i = 0; i < 20; i++) insertResolution({ handle: 'PoolFillerHandle', state: i < 12 ? 'confirmed' : 'contradicted' });
  insertResolution({ handle, state: 'confirmed' }); // one claim, 100% raw
  const res = sourceTrustScore(handle);
  assert.equal(res.state, 'pooled');
  assert.equal(res.sample_size, 1);
  assert.ok(res.score < 1, 'a single confirmed claim must not read as a measured 100%');
  assert.ok(res.score > 0.6, 'pooling toward the baseline should not have implied the worst thing either');
});

test('sourceTrustScore: claimType filter scopes the sample', () => {
  const handle = 'MultiClaimHandle';
  for (let i = 0; i < 8; i++) insertResolution({ handle, claimType: 'injury_status', state: 'confirmed' });
  for (let i = 0; i < 8; i++) insertResolution({ handle, claimType: 'role_change', state: 'contradicted' });
  const injury = sourceTrustScore(handle, { claimType: 'injury_status' });
  const role = sourceTrustScore(handle, { claimType: 'role_change' });
  assert.equal(injury.score, 1);
  assert.equal(role.score, 0);
});

// ---- orderByTrust -----------------------------------------------------

test('orderByTrust: an unscored item keeps its exact original index', () => {
  const items = [
    { id: 'a', score: 0.9 },
    { id: 'b', score: null },
    { id: 'c', score: 0.3 },
    { id: 'd', score: null },
    { id: 'e', score: 0.6 },
  ];
  const ordered = orderByTrust(items, { scoreOf: (it) => it.score });
  assert.equal(ordered[1].id, 'b');
  assert.equal(ordered[3].id, 'd');
});

test('orderByTrust: scored items sort descending within their own slots', () => {
  const items = [
    { id: 'a', score: 0.9 },
    { id: 'b', score: null },
    { id: 'c', score: 0.3 },
    { id: 'd', score: null },
    { id: 'e', score: 0.6 },
  ];
  const ordered = orderByTrust(items, { scoreOf: (it) => it.score });
  // Scored slots are indices 0, 2, 4 with scores 0.9, 0.3, 0.6 — sorted
  // descending (0.9, 0.6, 0.3) and dropped back into those same three slots.
  assert.equal(ordered[0].id, 'a');
  assert.equal(ordered[2].id, 'e');
  assert.equal(ordered[4].id, 'c');
});

test('orderByTrust: ties break by original order', () => {
  const items = [
    { id: 'x', score: 0.5 },
    { id: 'y', score: 0.5 },
  ];
  const ordered = orderByTrust(items, { scoreOf: (it) => it.score });
  assert.equal(ordered[0].id, 'x');
  assert.equal(ordered[1].id, 'y');
});
