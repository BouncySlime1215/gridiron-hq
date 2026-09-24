/**
 * BRIEF-PEOPLE: the morning brief's "what they said overnight" and "who is
 * credible" lines, read from their producers through the producers' own readers.
 *
 * Pinned here:
 *   - statements come from PULSE-01's people_pulse via people/pulse.js#recentPulse;
 *     each line cites its row (ledger table people_pulse), credible ones first
 *   - who is credible comes from CRED-01's people_credibility via
 *     people/credibility.js#readCredibility, newest run at or before the brief,
 *     7-day rows whose weight clears PULSE-01's CREDIBLE_LIFT; each line cites its row
 *   - typed unknown only when the producer has no row for the league and window:
 *     no table, never run, or not run since the window opened
 *   - a quiet night after a pulse run says so and cites the run
 *   - every line grounds (nothing dropped); no team or manager name appears
 * In-memory SQLite; the plans come from main's producer fixture (FIX-03).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const brief = await import('../server/services/coach/brief.js');
const inputs = await import('../server/services/coach/brief-inputs.js');
const { claimsFor, MAX_STATEMENT_LINES, MAX_CREDIBILITY_LINES } = await import('../server/services/coach/brief-claims.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { CREDIBLE_LIFT } = await import('../server/services/people/pulse.js');
const { METHOD_VERSION } = await import('../server/services/people/credibility.js');
const mig098 = await import('../server/migrations/098_people_pulse.js');
const mig099 = await import('../server/migrations/099_people_credibility.js');
const mig101 = await import('../server/migrations/101_coach_briefs.js');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PLANS = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/warroom-contract/producer-plans.json'), 'utf8'));
const plans = () => structuredClone(PLANS);
const l4 = file => file.leagues.find(e => e.league === 4);

const ON = { GRIDIRON_COACH_BRIEF_ENABLED: '1' };
const MORNING = new Date('2026-09-24T11:00:00.000Z');
const UNTIL = MORNING.toISOString();
const SINCE = '2026-09-23T23:00:00.000Z'; // the default 12-hour window
const SECRET_TEAM = 'Zzsecret Franchise';

function peopleDb({ pulse = true, cred = true, runAt = '2026-09-24T10:30:00.000Z' } = {}) {
  const db = new DatabaseSync(':memory:');
  mig101.up(db);
  db.exec(`CREATE TABLE league_member_identity (league_id INTEGER, roster_id INTEGER, team_name TEXT);
    CREATE TABLE players (espn_id INTEGER, name TEXT, position TEXT);`);
  db.prepare('INSERT INTO league_member_identity VALUES (4, 2, ?), (4, 5, ?)').run(SECRET_TEAM, SECRET_TEAM);
  db.prepare("INSERT INTO players VALUES (101, 'Alpha Receiver', 'WR'), (102, 'Beta Runner', 'RB')").run();
  if (pulse) {
    mig098.up(db);
    const add = db.prepare(`INSERT INTO people_pulse (league_id, roster_id, msg_id, as_of, statement_type, stmt_key,
      player_ids_json, pos, credible, weight, labeller_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pulse-1')`);
    add.run(4, 2, 1, '2026-09-24T02:00:00.000Z', 'WANT_PLAYER', 'k1', '[101]', null, 1, 17);
    add.run(4, 5, 2, '2026-09-24T06:00:00.000Z', 'SHOP', 'k2', '[102]', null, 0, null);
    add.run(4, 5, 3, '2026-09-24T07:00:00.000Z', 'FRUSTRATED', 'k3', '[102]', null, 0, 1);
    add.run(4, 2, 4, '2026-09-23T20:00:00.000Z', 'HYPE', 'k4', '[101]', null, 0, null); // before the window
    add.run(9, 2, 5, '2026-09-24T03:00:00.000Z', 'SHOP', 'k5', '[102]', null, 0, null); // another league
    if (runAt) {
      db.prepare(`INSERT INTO people_pulse_runs (league_id, ran_at, messages_read, statements, credible, labeller_version)
        VALUES (4, ?, 10, 3, 1, 'pulse-1')`).run(runAt);
    }
  }
  if (cred) {
    mig099.up(db);
    const add = db.prepare(`INSERT INTO people_credibility (league_id, as_of, method_version, roster_id, stmt_type,
      window_days, outcome, n_statements, status, weight, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const asOf = '2026-09-24T07:00:00Z';
    add.run(4, asOf, METHOD_VERSION, '2', 'WANT_PLAYER', 7, 'acquired', 12, 'proven', 19.5, asOf);
    add.run(4, asOf, METHOD_VERSION, '5', 'SHOP', 7, 'left_roster', 9, 'manager_split', 3.4, asOf);
    add.run(4, asOf, METHOD_VERSION, '5', 'SHOP', 21, 'left_roster', 9, 'manager_split', 4, asOf); // other window
    add.run(4, asOf, METHOD_VERSION, '6', 'SHOP', 7, 'left_roster', 9, 'manager_split', 0.4, asOf); // under the bar
    add.run(4, asOf, METHOD_VERSION, '7', 'HYPE_OWN', 7, 'left_roster', 20, 'noise', 1, asOf); // noise
    add.run(4, asOf, METHOD_VERSION, '*', 'WANT_PLAYER', 7, 'acquired', 40, 'proven', 17.9, asOf); // league pool
    add.run(9, asOf, METHOD_VERSION, '3', 'WANT_PLAYER', 7, 'acquired', 12, 'proven', 30, asOf); // another league
    // A later run the brief must not see (as-of safe).
    add.run(4, '2026-09-24T12:00:00Z', METHOD_VERSION, '8', 'WANT_PLAYER', 7, 'acquired', 5, 'proven', 50, '2026-09-24T12:00:00Z');
  }
  return db;
}

/** The ledger tables a claim's cites land in. */
function citedTables(r, claim) {
  const q = id => r.ledger.queries.find(x => x.id === id.split('#')[0]);
  return new Set(claim.cites.map(c => q(c)?.tables?.[0]).filter(Boolean));
}
function cell(r, cite) {
  const [id, rest] = cite.split('#');
  const [i, col] = rest.split('.');
  return r.ledger.queries.find(q => q.id === id).rows[Number(i)][col];
}

test('statements: each line cites its people_pulse row, credible first, window and league respected', () => {
  const db = peopleDb();
  const s = inputs.readStatements(db, { leagueId: 4, since: SINCE, until: UNTIL });
  assert.equal(s.status, 'ok');
  assert.deepEqual(s.rows.map(x => x.type).sort(), ['FRUSTRATED', 'SHOP', 'WANT_PLAYER']);
  assert.ok(s.rows.every(x => !('team_name' in x)), 'no team name leaves the reader');
  assert.deepEqual(s.keys.length, 3);

  const r = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.dropped, [], JSON.stringify(r.dropped));
  const lines = r.claims.filter(c => c.section === 'statements');
  assert.equal(lines[0].text, 'League-mates made 3 labelled statements in this window; 1 credible.');
  assert.match(lines[1].text, /^Team 2, 9h ago: in-market for Alpha Receiver \(credible: it has followed through at 17\.0x the base rate\)\.$/);
  assert.match(lines[2].text, /^Team 5, 4h ago: down on Beta Runner \(follow-through 1\.0x the base rate, under the 2\.0x bar\)\.$/);
  assert.match(lines[3].text, /^Team 5, 5h ago: shopping Beta Runner \(the pulse gives this kind of talk no weight yet\)\.$/);
  for (const c of lines.slice(1)) assert.ok(citedTables(r, c).has('people_pulse'), c.text);
  assert.equal(cell(r, lines[1].cites[0]), 2, 'Team 2 cites roster 2');
  assert.ok(r.reported.filter(k => k.startsWith('p:')).length === 3);
  assert.doesNotMatch(r.text, new RegExp(SECRET_TEAM));
});

test('who is credible: CRED-01 rows over the pulse bar, 7-day window, as of the brief, each cited', () => {
  const db = peopleDb();
  const s = inputs.readCredibility(db, { leagueId: 4, until: UNTIL });
  assert.equal(s.status, 'ok');
  assert.equal(s.credible_lift, CREDIBLE_LIFT);
  assert.equal(s.as_of, '2026-09-24T07:00:00Z', 'the later run is not visible to this brief');
  assert.deepEqual(s.rows.map(x => [x.roster_id, x.stmt_type, x.window_days]), [[2, 'WANT_PLAYER', 7], [5, 'SHOP', 7]]);

  const r = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.deepEqual(r.dropped, []);
  const lines = r.claims.filter(c => c.section === 'credibility');
  assert.equal(lines[0].text, 'Follow-through (run of 2026-09-24T07:00:00Z): 2 manager-and-statement pairs clear the 2.0x bar within 7 days.');
  assert.equal(lines[1].text, 'Team 2 is credible when he says he wants a player: within 7 days he gets that player at 19.5x his base rate (proven league-wide; 12 statements).');
  assert.equal(lines[2].text, 'Team 5 is credible when he shops his own player: within 7 days that player leaves his roster at 3.4x his base rate (proven for him alone; 9 statements).');
  for (const c of lines) assert.ok(citedTables(r, c).has('people_credibility'), c.text);
  assert.equal(cell(r, lines[2].cites[0]), 5);
});

test('typed unknown only when the producer has no row for the league or window', () => {
  const none = peopleDb({ pulse: false, cred: false });
  assert.match(inputs.readStatements(none, { leagueId: 4, since: SINCE, until: UNTIL }).reason, /no people_pulse table/);
  assert.match(inputs.readCredibility(none, { leagueId: 4, until: UNTIL }).reason, /no people_credibility table/);

  const neverRan = peopleDb({ runAt: null });
  const s = inputs.readStatements(neverRan, { leagueId: 4, since: SINCE, until: UNTIL });
  assert.equal(s.status, 'unknown');
  assert.match(s.reason, /PULSE-01 has not run for league 4/);

  const stale = peopleDb({ runAt: '2026-09-23T22:00:00.000Z' });
  assert.match(inputs.readStatements(stale, { leagueId: 4, since: SINCE, until: UNTIL }).reason,
    /has not run since this window opened: its last run was 2026-09-23T22:00:00\.000Z/);

  const cred = inputs.readCredibility(peopleDb(), { leagueId: 5, until: UNTIL });
  assert.equal(cred.status, 'unknown');
  assert.match(cred.reason, /CRED-01 has no cred-01\.v1 run for league 5/);
  assert.equal(inputs.readCredibility(peopleDb(), { leagueId: 4, until: '2026-09-24T06:00:00.000Z' }).status, 'unknown',
    'no run at or before the cut is unknown, not the later run');

  const r = brief.morningBrief({ db: neverRan, file: plans(), env: ON, now: MORNING });
  assert.deepEqual(r.dropped, []);
  assert.match(r.text, /Statements not read: PULSE-01 has not run for league 4: no people_pulse run is recorded\./);
});

test('a quiet night after a pulse run says so and cites the run; reported rows are not repeated', () => {
  const db = peopleDb();
  const first = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.equal(first.cache, 'saved');
  db.prepare(`INSERT INTO people_pulse_runs (league_id, ran_at, messages_read, statements, credible, labeller_version)
    VALUES (4, '2026-09-25T10:30:00.000Z', 0, 0, 0, 'pulse-1')`).run();
  const next = brief.morningBrief({ db, file: plans(), env: ON, now: new Date('2026-09-25T11:00:00.000Z') });
  assert.deepEqual(next.dropped, []);
  const line = next.claims.find(c => c.section === 'statements');
  assert.equal(line.text, 'No labelled statements from league-mates in this window (the chat pulse last ran 2026-09-25T10:30:00.000Z).');
  assert.ok(citedTables(next, line).has('people_pulse_runs'));
});

test('long nights list the first lines and count the rest, still grounded', () => {
  const db = peopleDb();
  const add = db.prepare(`INSERT INTO people_pulse (league_id, roster_id, msg_id, as_of, statement_type, stmt_key,
    player_ids_json, credible, weight, labeller_version) VALUES (4, 5, ?, ?, 'HYPE', ?, '[102]', 0, null, 'pulse-1')`);
  for (let i = 0; i < 8; i++) add.run(100 + i, `2026-09-24T08:0${i}:00.000Z`, `h${i}`);
  const r = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.deepEqual(r.dropped, []);
  const lines = r.claims.filter(c => c.section === 'statements');
  assert.equal(lines.length, 1 + MAX_STATEMENT_LINES + 1);
  assert.equal(lines.at(-1).text, `${11 - MAX_STATEMENT_LINES} more not listed here.`);
  assert.ok(MAX_CREDIBILITY_LINES >= 1);
});

test('an invented number on a people line is dropped by the check', () => {
  const db = peopleDb();
  const entry = l4(plans());
  const ledger = newLedger();
  const draft = claimsFor('morning', { entry, ledger, inputs: {
    statements: inputs.readStatements(db, { leagueId: 4, since: SINCE, until: UNTIL }),
    credibility: inputs.readCredibility(db, { leagueId: 4, until: UNTIL }),
    replies: { status: 'ok', rows: [] }, injuries: { status: 'ok', rows: [] } } });
  const line = draft.find(c => c.section === 'credibility' && /^Team 2/.test(c.text));
  assert.equal(brief.checkClaim(line, ledger).ok, true);
  assert.equal(brief.checkClaim({ ...line, text: line.text.replace('19.5x', '25.0x') }, ledger).ok, false);
});
