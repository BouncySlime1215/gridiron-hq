/**
 * DRAFT-ID-MAP (ONE-PLAN section 4b row 1, night 5).
 *
 * `league_draft_picks.player_id` is the ESPN id, not `players.id`: measured on
 * the live DB, 0 of 1,738 picks join `players.id` and 1,738 of 1,738 join
 * `players.espn_id`. This unit is the one reader that joins on the right key and
 * turns a pick into draft capital (`overall_pick`) per app player, independent
 * of who owns him now; the current owner comes from the producer's roster.
 *
 * Fixtures only (made-up players, roster ids 1..10). The 170/170 headline is a
 * fixture of the live shape (10 rosters x 17 picks); the live count is under
 * "Needs local measurement" in the PR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { draftCapital, draftCapitalGuarded, draftSummary, draftIdMapEnabled, DRAFT_ID_MAP_ENV } =
  await import('../server/services/campaign/draft-capital.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

const LEAGUE = 4, SEASON = 2026, ROSTERS = 10, ROUNDS = 17;
const espnOf = i => 4000000 + i;   // ESPN ids never collide with app ids below
const appOf = i => 100 + i;

/** A db with the { row, rows } shape of server/db/index.js over an in-memory sqlite. */
function makeDb({ table = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, espn_id INTEGER, name TEXT, position TEXT)`);
  if (table) {
    raw.exec(`CREATE TABLE league_draft_picks (
      league_id INTEGER, season INTEGER, pick_id INTEGER, overall_pick INTEGER, round INTEGER,
      team_id TEXT, member_id TEXT, player_id INTEGER, auto_draft_type_id INTEGER, is_auto INTEGER)`);
  }
  return {
    raw,
    rows: (sql, ...p) => raw.prepare(sql).all(...p),
    row: (sql, ...p) => raw.prepare(sql).get(...p),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
  };
}

/** 10 rosters x 17 rounds, snake order; pick i drafts made-up player i. */
function seedDraft(db, { league = LEAGUE, season = SEASON } = {}) {
  const owners = new Map();
  for (let i = 1; i <= ROSTERS * ROUNDS; i++) {
    const round = Math.ceil(i / ROSTERS);
    const slot = (i - 1) % ROSTERS;
    const team = String(round % 2 ? slot + 1 : ROSTERS - slot);
    db.run(`INSERT OR IGNORE INTO players (id, espn_id, name, position) VALUES (?, ?, ?, 'WR')`, appOf(i), espnOf(i), `Made Up ${i}`);
    db.run(`INSERT INTO league_draft_picks VALUES (?, ?, ?, ?, ?, ?, 'MEM', ?, 0, 0)`,
      league, season, i, i, round, team, espnOf(i));
    if (!owners.has(team)) owners.set(team, []);
    owners.get(team).push(appOf(i));
  }
  return owners;   // the producer roster on draft day: roster id -> app ids
}

test('170 of 170 picks join players.espn_id; the old players.id join finds 0', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters });
  assert.equal(d.status, 'ok');
  assert.equal(d.picks, 170);
  assert.equal(d.joined, 170);
  assert.equal(d.joined_via_players_id, 0, 'the broken key is measured, not assumed');
  assert.equal(d.by_player.size, 170);
  assert.equal(d.drafting_rosters, 10);
  const first = d.by_player.get(appOf(1));
  assert.deepEqual(first, { espn_id: espnOf(1), overall_pick: 1, round: 1, drafting_roster: '1', current_roster: '1' });
  // Snake: pick 11 is round 2's first pick, by roster 10.
  assert.equal(d.by_player.get(appOf(11)).drafting_roster, '10');
});

test('draft capital is owner-independent: a traded player keeps his pick, only current_roster moves', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  const before = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters }).by_player.get(appOf(3));
  // Roster 3 trades pick 3 to roster 7.
  rosters.set('3', rosters.get('3').filter(id => id !== appOf(3)));
  rosters.get('7').push(appOf(3));
  const after = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters }).by_player.get(appOf(3));
  assert.equal(after.overall_pick, before.overall_pick);
  assert.equal(after.drafting_roster, '3');
  assert.equal(after.current_roster, '7');
});

test('a drafted player on no roster now (dropped) keeps his capital with current_roster null', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  rosters.set('1', rosters.get('1').filter(id => id !== appOf(1)));
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters });
  assert.equal(d.by_player.get(appOf(1)).current_roster, null);
  assert.equal(d.by_player.get(appOf(1)).overall_pick, 1);
});

test('espn_id 0 placeholders never join (no 2,884-way fan-out); a pick of id 0 is unjoined, named', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  for (let k = 0; k < 5; k++) db.run(`INSERT INTO players (id, espn_id, name, position) VALUES (?, 0, 'Old Placeholder', 'RB')`, 9000 + k);
  db.run(`INSERT INTO league_draft_picks VALUES (?, ?, 171, 171, 18, '1', 'MEM', 0, 0, 0)`, LEAGUE, SEASON);
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters });
  assert.equal(d.picks, 171);
  assert.equal(d.joined, 170);
  assert.equal(d.unjoined.length, 1);
  assert.deepEqual(d.unjoined[0], { overall_pick: 171, espn_id: 0, why: 'placeholder espn id' });
  for (let k = 0; k < 5; k++) assert.equal(d.by_player.has(9000 + k), false);
});

test('two players rows sharing one espn_id are ambiguous: counted, never guessed', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  db.run(`INSERT INTO players (id, espn_id, name, position) VALUES (9100, ?, 'Dup Row', 'WR')`, espnOf(5));
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters });
  assert.equal(d.joined, 169);
  assert.equal(d.by_player.has(appOf(5)), false);
  assert.equal(d.by_player.has(9100), false);
  assert.deepEqual(d.unjoined, [{ overall_pick: 5, espn_id: espnOf(5), why: 'espn id on 2 players rows' }]);
});

test('a pick whose espn id is on no players row is unjoined, named', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  db.run(`DELETE FROM players WHERE id = ?`, appOf(9));
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters });
  assert.equal(d.joined, 169);
  assert.deepEqual(d.unjoined, [{ overall_pick: 9, espn_id: espnOf(9), why: 'espn id on no players row' }]);
});

test('only this league and season: other leagues and seasons are not read', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  db.run(`INSERT INTO league_draft_picks VALUES (5, ?, 1, 1, 1, '1', 'MEM', ?, 0, 0)`, SEASON, espnOf(170));
  db.run(`INSERT INTO league_draft_picks VALUES (?, 2025, 1, 1, 1, '1', 'MEM', ?, 0, 0)`, LEAGUE, espnOf(170));
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters });
  assert.equal(d.picks, 170);
  assert.equal(d.by_player.get(appOf(170)).overall_pick, 170);
});

test('table absent: says so with a reason, does not throw', () => {
  const d = draftCapital(makeDb({ table: false }), { leagueId: LEAGUE, season: SEASON, rosters: new Map() });
  assert.equal(d.status, 'table_absent');
  assert.match(d.reason, /league_draft_picks/);
  assert.equal(d.by_player.size, 0);
});

test('no picks for this league-season: says so, not an empty ok', () => {
  const db = makeDb();
  seedDraft(db, { season: 2025 });
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters: new Map() });
  assert.equal(d.status, 'no_picks');
  assert.match(d.reason, /2026/);
});

// Review note 1 on #391: the adapter ran draftCapital unguarded, so with the flag on any SQL error
// killed the whole league entry (served plans included) for a shadow read. The guarded read records it.
function throwingDb() {
  const db = makeDb();
  seedDraft(db);
  return { ...db, rows: () => { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); } };
}

test('guarded: a SQL error becomes status "error" with the reason, never a throw and never an empty ok', () => {
  const db = throwingDb();
  assert.throws(() => draftCapital(db, { leagueId: LEAGUE, season: SEASON }), /SQLITE_CORRUPT/);
  const d = draftCapitalGuarded(db, { leagueId: LEAGUE, season: SEASON, rosters: new Map() });
  assert.equal(d.status, 'error');
  assert.match(d.reason, /SQLITE_CORRUPT/);
  assert.equal(d.by_player.size, 0);
  assert.equal(draftSummary(d).status, 'error');
});

test('guarded: with no error it returns exactly what draftCapital returns', () => {
  const db = makeDb();
  const rosters = seedDraft(db);
  assert.deepEqual(draftCapitalGuarded(db, { leagueId: LEAGUE, season: SEASON, rosters }),
    draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters }));
});

test('the adapter reads draft capital through the guarded reader only', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../scripts/campaign/league-adapter.mjs', import.meta.url), 'utf8');
  assert.match(src, /draft: draftCapitalGuarded\(svc\.db,/);
  assert.doesNotMatch(src, /draftCapital\(/);
});

test('flag is off by default; only "1" turns it on', () => {
  assert.equal(DRAFT_ID_MAP_ENV, 'GRIDIRON_DRAFT_ID_MAP');
  assert.equal(draftIdMapEnabled({}), false);
  assert.equal(draftIdMapEnabled({ GRIDIRON_DRAFT_ID_MAP: '0' }), false);
  assert.equal(draftIdMapEnabled({ GRIDIRON_DRAFT_ID_MAP: '1' }), true);
});

test('summary is counts only: no player names, no per-player rows', () => {
  const db = makeDb();
  const d = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters: seedDraft(db) });
  const s = draftSummary(d);
  assert.deepEqual(s, { status: 'ok', reason: null, season: SEASON, picks: 170, joined: 170, joined_via_players_id: 0,
    unjoined: 0, unjoined_why: {}, drafting_rosters: 10, drafted_on_rosters_now: 170, lane: 'shadow' });
  assert.doesNotMatch(JSON.stringify(s), /Made Up/);
});

const AS_OF = '2026-09-28T12:00:00.000Z';
const produce = adapter => buildPlansFile([{ id: 99, load: async () => ({ adapter }) }], { generated_at: AS_OF, clock: () => 0 });

test('producer: flag off (no adapter.draft) -> plans entry has no draft_id_map at all', async () => {
  const doc = await produce(makeAdapter());
  const [l] = doc.leagues;
  assert.equal(l.error ?? null, null);
  assert.equal('draft_id_map' in l._run.inputs, false);
});

test('producer: flag on -> only _run.inputs.draft_id_map is added; every served field is byte-identical', async () => {
  const off = (await produce(makeAdapter())).leagues[0];
  const db = makeDb();
  const draft = draftCapital(db, { leagueId: LEAGUE, season: SEASON, rosters: seedDraft(db) });
  const on = (await produce(Object.assign(makeAdapter(), { draft }))).leagues[0];
  assert.deepEqual(on._run.inputs.draft_id_map, draftSummary(draft));
  const strip = e => { const c = structuredClone(e); delete c._run; return c; };
  assert.deepEqual(strip(on), strip(off), 'shadow: no served number moves');
  delete on._run.inputs.draft_id_map;
  assert.deepEqual(on._run, off._run);
});

test('producer: flag on with a draft read error -> league entry still served, error recorded in _run.inputs', async () => {
  const off = (await produce(makeAdapter())).leagues[0];
  const draft = draftCapitalGuarded(throwingDb(), { leagueId: LEAGUE, season: SEASON, rosters: new Map() });
  const on = (await produce(Object.assign(makeAdapter(), { draft }))).leagues[0];
  assert.equal(on.error ?? null, null);
  assert.equal(on._run.inputs.draft_id_map.status, 'error');
  assert.match(on._run.inputs.draft_id_map.reason, /SQLITE_CORRUPT/);
  const strip = e => { const c = structuredClone(e); delete c._run; return c; };
  assert.deepEqual(strip(on), strip(off), 'a failed shadow read moves no served number');
});
