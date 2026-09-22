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
  classifyInjuryDirection, resolveInjuryClaim, resolveInjuryClaims,
  classifyRoleDirection, resolveRoleChangeClaim, resolveRoleChangeClaims,
  classifyReturnDirection, resolveReturnFromInjuryClaim, resolveReturnFromInjuryClaims,
  sourceTrustScore, orderByTrust
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

/** Role-change ground truth is read from offense_pct, not offense_snaps, so
 * this fixture controls the share directly rather than deriving it. */
function setSnapsPct(playerId, season, week, offensePct) {
  run(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
       VALUES (?,?,?,?,?)
       ON CONFLICT(player_id, season, week) DO UPDATE SET offense_pct=excluded.offense_pct, offense_snaps=excluded.offense_snaps`,
    playerId, season, week, Math.round(offensePct * 65), offensePct);
}

let eventSeq = 0;
function makeEvent({ playerName, team = 'KC', claimText, publishedAt, handle = 'RotoRealist', claimType = 'injury_status' }) {
  const event_id = `ev-${++eventSeq}`;
  run(`INSERT INTO nfl_news_events
       (event_id, source_kind, source_ref, content_hash, player_key, player_id, player_name, team,
        claim_type, claim_text, evidence_span, source_name, source_url, reporter_handle,
        published_at, first_seen_time, extractor_version)
       VALUES (?,'news_item',?,?,?,?,?,?,?,?,?,?,?,?,?,?,'test-1')`,
    event_id, event_id, `hash-${event_id}`, playerName.toLowerCase(), null, playerName, team, claimType,
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

// ---- classifyRoleDirection -----------------------------------------------

test('classifyRoleDirection reads a confirmed-starter or expanded-role claim as role_up', () => {
  assert.equal(classifyRoleDirection('He will be the starting running back this week.'), 'role_up');
  assert.equal(classifyRoleDirection('Expects an expanded role in the passing game.'), 'role_up');
});

test('classifyRoleDirection reads a benched or reduced-role claim as role_down', () => {
  assert.equal(classifyRoleDirection('He has been benched and loses the starting job.'), 'role_down');
  assert.equal(classifyRoleDirection('Now in a committee with a reduced role.'), 'role_down');
});

test('classifyRoleDirection returns null when the text carries no role-change signal', () => {
  assert.equal(classifyRoleDirection('Signed a two-year contract extension.'), null);
});

// ---- resolveRoleChangeClaim ------------------------------------------------
//
// Weeks/dates below are deliberately pushed out to 2027, distinct from every
// week already used above and from each other: the game lookup is
// `date >= claimDate ORDER BY date ASC LIMIT 1` across ALL of this team's
// scheduled games (not scoped to a season/week), and fixtures accumulate
// across the whole file as tests run in order, so a colliding date would let
// an earlier or later test's game answer this one's query.

test('resolveRoleChangeClaim: role_up confirmed by a real snap-share jump', () => {
  const player = makePlayer('Role Up Confirmed RB', 'RB');
  setSnapsPct(player, 2026, 1, 0.30);
  makeGame(2026, 2, '2027-02-01');
  setSnapsPct(player, 2026, 2, 0.55);
  const eventId = makeEvent({
    playerName: 'Role Up Confirmed RB', claimText: 'He will be the starting running back this week.',
    publishedAt: '2027-01-30T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-02-02T00:00:00Z' });
  assert.equal(res.predicted_direction, 'role_up');
  assert.equal(res.resolved_state, 'confirmed');
  assert.equal(res.season, 2026);
  assert.equal(res.week, 2);
});

test('resolveRoleChangeClaim: role_up contradicted when the share actually fell', () => {
  const player = makePlayer('Role Up Contradicted WR', 'WR');
  setSnapsPct(player, 2026, 1, 0.50);
  makeGame(2026, 7, '2027-02-08');
  setSnapsPct(player, 2026, 7, 0.20);
  const eventId = makeEvent({
    playerName: 'Role Up Contradicted WR', claimText: 'Expects an expanded role in the passing game.',
    publishedAt: '2027-02-06T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-02-09T00:00:00Z' });
  assert.equal(res.resolved_state, 'contradicted');
});

test('resolveRoleChangeClaim: role_down confirmed by a real snap-share drop', () => {
  const player = makePlayer('Role Down Confirmed WR', 'WR');
  setSnapsPct(player, 2026, 6, 0.65);
  makeGame(2026, 14, '2027-02-15');
  setSnapsPct(player, 2026, 14, 0.25);
  const eventId = makeEvent({
    playerName: 'Role Down Confirmed WR', claimText: 'He has been benched and loses the starting job.',
    publishedAt: '2027-02-13T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-02-16T00:00:00Z' });
  assert.equal(res.predicted_direction, 'role_down');
  assert.equal(res.resolved_state, 'confirmed');
});

test('resolveRoleChangeClaim: unresolved when the share barely moved, not forced either way', () => {
  const player = makePlayer('Flat Share WR', 'WR');
  setSnapsPct(player, 2026, 1, 0.40);
  makeGame(2026, 15, '2027-02-22');
  setSnapsPct(player, 2026, 15, 0.45);
  const eventId = makeEvent({
    playerName: 'Flat Share WR', claimText: 'Expects an expanded role in the passing game.',
    publishedAt: '2027-02-20T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-02-23T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /not a big enough move/i);
});

test('resolveRoleChangeClaim: unresolved when there is no prior-week snap share to compare against', () => {
  const player = makePlayer('No Baseline WR', 'WR');
  makeGame(2026, 21, '2027-03-01');
  setSnapsPct(player, 2026, 21, 0.50);
  const eventId = makeEvent({
    playerName: 'No Baseline WR', claimText: 'He will be the starting wide receiver this week.',
    publishedAt: '2027-02-27T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-03-02T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /no prior-week/i);
});

test('resolveRoleChangeClaim: unresolved for a defensive position, same offense-snap guard as injury_status', () => {
  const player = makePlayer('Role Change LB', 'LB');
  makeGame(2026, 16, '2027-03-08');
  const eventId = makeEvent({
    playerName: 'Role Change LB', claimText: 'He will be the starting linebacker this week.',
    publishedAt: '2027-03-06T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-03-09T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /position.*not covered/i);
});

test('resolveRoleChangeClaim: unresolved when the game has not been played yet, same guard as injury_status', () => {
  const player = makePlayer('Role Change Future WR', 'WR');
  makeGame(2026, 17, '2027-03-15');
  const eventId = makeEvent({
    playerName: 'Role Change Future WR', claimText: 'He will be the starting wide receiver this week.',
    publishedAt: '2027-03-13T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-03-14T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /not.*played/i);
});

test('resolveRoleChangeClaim: unresolved when no role direction classifies from the claim text', () => {
  const player = makePlayer('No Direction WR', 'WR');
  makeGame(2026, 18, '2027-03-22');
  const eventId = makeEvent({
    playerName: 'No Direction WR', claimText: 'Practiced fully and is on track for Sunday.',
    publishedAt: '2027-03-20T12:00:00Z', claimType: 'role_change',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveRoleChangeClaim(ev, { asOf: '2027-03-23T00:00:00Z' });
  assert.equal(res.predicted_direction, null);
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /no role direction/i);
});

// ---- resolveRoleChangeClaims (batch) ---------------------------------------

test('resolveRoleChangeClaims writes one upserted row per role_change event, and leaves injury_status alone', () => {
  const injuryPlayer = makePlayer('Untouched Injury WR', 'WR');
  makeGame(2026, 19, '2027-03-29');
  setSnaps(injuryPlayer, 2026, 19, 0);
  const injuryEventId = makeEvent({
    playerName: 'Untouched Injury WR', claimText: 'Ruled out this week.',
    publishedAt: '2027-03-27T12:00:00Z',
  });

  const rolePlayer = makePlayer('Batch Role RB', 'RB');
  setSnapsPct(rolePlayer, 2026, 19, 0.20);
  makeGame(2026, 20, '2027-04-05');
  setSnapsPct(rolePlayer, 2026, 20, 0.55);
  const roleEventId = makeEvent({
    playerName: 'Batch Role RB', claimText: 'He will be the starting running back this week.',
    publishedAt: '2027-04-03T12:00:00Z', claimType: 'role_change', handle: 'RoleReporter',
  });

  const result = resolveRoleChangeClaims({ asOf: '2027-04-06T00:00:00Z' });
  assert.ok(result.resolved >= 1);
  const stored = row(`SELECT * FROM beat_reporter_claim_resolutions WHERE event_id=?`, roleEventId);
  assert.equal(stored.resolved_state, 'confirmed');
  assert.equal(stored.reporter_handle, 'RoleReporter');
  assert.equal(row(`SELECT * FROM beat_reporter_claim_resolutions WHERE event_id=?`, injuryEventId), undefined,
    'resolveRoleChangeClaims must not touch injury_status events');

  // Re-running does not duplicate the row (upsert on event_id).
  resolveRoleChangeClaims({ asOf: '2027-04-06T00:00:00Z' });
  const count = row(`SELECT COUNT(*) AS n FROM beat_reporter_claim_resolutions WHERE event_id=?`, roleEventId).n;
  assert.equal(count, 1);
});

// ---- classifyReturnDirection -----------------------------------------------

test('classifyReturnDirection reads activation/return language as returning', () => {
  assert.equal(classifyReturnDirection('He has been activated from injured reserve.'), 'returning');
  assert.equal(classifyReturnDirection('Cleared to return and expected to play this week.'), 'returning');
});

test('classifyReturnDirection reads not-yet-ready language as still_out', () => {
  assert.equal(classifyReturnDirection('He remains on injured reserve and will not return this week.'), 'still_out');
  assert.equal(classifyReturnDirection('Not yet ready to return, will miss another week.'), 'still_out');
});

test('classifyReturnDirection returns null when the text carries no return-from-injury signal', () => {
  assert.equal(classifyReturnDirection('Signed a two-year contract extension.'), null);
});

// ---- resolveReturnFromInjuryClaim ------------------------------------------
//
// Same date-collision discipline as the role_change block above: fresh weeks
// (22-29) and dates continuing forward from where that block left off, so no
// earlier or later test's game can answer this one's "next game on/after the
// claim date" lookup.

test('resolveReturnFromInjuryClaim: returning confirmed when the player actually played', () => {
  const player = makePlayer('Return Confirmed RB', 'RB');
  makeGame(2026, 22, '2027-04-12');
  setSnaps(player, 2026, 22, 40);
  const eventId = makeEvent({
    playerName: 'Return Confirmed RB', claimText: 'He has been activated from injured reserve.',
    publishedAt: '2027-04-10T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-04-13T00:00:00Z' });
  assert.equal(res.predicted_direction, 'returning');
  assert.equal(res.resolved_state, 'confirmed');
});

test('resolveReturnFromInjuryClaim: returning contradicted when the player still did not play', () => {
  const player = makePlayer('Return Contradicted WR', 'WR');
  makeGame(2026, 23, '2027-04-19');
  setSnaps(player, 2026, 23, 0);
  const eventId = makeEvent({
    playerName: 'Return Contradicted WR', claimText: 'Cleared to return and expected to play this week.',
    publishedAt: '2027-04-17T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-04-20T00:00:00Z' });
  assert.equal(res.resolved_state, 'contradicted');
});

test('resolveReturnFromInjuryClaim: still_out confirmed when the player really did not play', () => {
  const player = makePlayer('Still Out Confirmed WR', 'WR');
  makeGame(2026, 24, '2027-04-26');
  setSnaps(player, 2026, 24, 0);
  const eventId = makeEvent({
    playerName: 'Still Out Confirmed WR', claimText: 'Not yet ready to return, will miss another week.',
    publishedAt: '2027-04-24T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-04-27T00:00:00Z' });
  assert.equal(res.predicted_direction, 'still_out');
  assert.equal(res.resolved_state, 'confirmed');
});

test('resolveReturnFromInjuryClaim: still_out contradicted when the player actually played', () => {
  const player = makePlayer('Still Out Contradicted RB', 'RB');
  makeGame(2026, 25, '2027-05-03');
  setSnaps(player, 2026, 25, 35);
  const eventId = makeEvent({
    playerName: 'Still Out Contradicted RB', claimText: 'Remains on injured reserve and will not return this week.',
    publishedAt: '2027-05-01T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-05-04T00:00:00Z' });
  assert.equal(res.resolved_state, 'contradicted');
});

test('resolveReturnFromInjuryClaim: unresolved when no snap data exists yet for that week', () => {
  const player = makePlayer('Return No Data WR', 'WR');
  makeGame(2026, 26, '2027-05-10');
  const eventId = makeEvent({
    playerName: 'Return No Data WR', claimText: 'He has been activated from injured reserve.',
    publishedAt: '2027-05-08T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-05-11T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /no snap data/i);
});

test('resolveReturnFromInjuryClaim: unresolved for a defensive position, same offense-snap guard reused', () => {
  const player = makePlayer('Return Defensive CB', 'CB');
  makeGame(2026, 27, '2027-05-17');
  const eventId = makeEvent({
    playerName: 'Return Defensive CB', claimText: 'He has been activated from injured reserve.',
    publishedAt: '2027-05-15T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-05-18T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /position.*not covered/i);
});

test('resolveReturnFromInjuryClaim: unresolved when the game has not been played yet, same guard reused', () => {
  const player = makePlayer('Return Future WR', 'WR');
  makeGame(2026, 28, '2027-05-24');
  const eventId = makeEvent({
    playerName: 'Return Future WR', claimText: 'He has been activated from injured reserve.',
    publishedAt: '2027-05-22T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-05-23T00:00:00Z' });
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /not.*played/i);
});

test('resolveReturnFromInjuryClaim: unresolved when no return direction classifies from the claim text', () => {
  const player = makePlayer('Return No Direction WR', 'WR');
  makeGame(2026, 29, '2027-06-07');
  const eventId = makeEvent({
    playerName: 'Return No Direction WR', claimText: 'Practiced fully and is on track for Sunday.',
    publishedAt: '2027-06-05T12:00:00Z', claimType: 'return_from_injury',
  });
  const ev = row(`SELECT * FROM nfl_news_events WHERE event_id=?`, eventId);
  const res = resolveReturnFromInjuryClaim(ev, { asOf: '2027-06-08T00:00:00Z' });
  assert.equal(res.predicted_direction, null);
  assert.equal(res.resolved_state, 'unresolved');
  assert.match(res.resolved_reason, /no return-from-injury direction/i);
});

// ---- resolveReturnFromInjuryClaims (batch) ---------------------------------

test('resolveReturnFromInjuryClaims writes one upserted row per return_from_injury event, and leaves other claim types alone', () => {
  const injuryPlayer = makePlayer('Untouched Injury WR 2', 'WR');
  makeGame(2026, 1, '2027-06-14');
  setSnaps(injuryPlayer, 2026, 1, 0);
  const injuryEventId = makeEvent({
    playerName: 'Untouched Injury WR 2', claimText: 'Ruled out this week.',
    publishedAt: '2027-06-12T12:00:00Z',
  });

  const returnPlayer = makePlayer('Batch Return RB', 'RB');
  makeGame(2026, 30, '2027-06-21');
  setSnaps(returnPlayer, 2026, 30, 38);
  const returnEventId = makeEvent({
    playerName: 'Batch Return RB', claimText: 'He has been activated from injured reserve.',
    publishedAt: '2027-06-19T12:00:00Z', claimType: 'return_from_injury', handle: 'ReturnReporter',
  });

  const result = resolveReturnFromInjuryClaims({ asOf: '2027-06-22T00:00:00Z' });
  assert.ok(result.resolved >= 1);
  const stored = row(`SELECT * FROM beat_reporter_claim_resolutions WHERE event_id=?`, returnEventId);
  assert.equal(stored.resolved_state, 'confirmed');
  assert.equal(stored.reporter_handle, 'ReturnReporter');
  assert.equal(row(`SELECT * FROM beat_reporter_claim_resolutions WHERE event_id=?`, injuryEventId), undefined,
    'resolveReturnFromInjuryClaims must not touch injury_status events');

  // Re-running does not duplicate the row (upsert on event_id).
  resolveReturnFromInjuryClaims({ asOf: '2027-06-22T00:00:00Z' });
  const count = row(`SELECT COUNT(*) AS n FROM beat_reporter_claim_resolutions WHERE event_id=?`, returnEventId).n;
  assert.equal(count, 1);
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
