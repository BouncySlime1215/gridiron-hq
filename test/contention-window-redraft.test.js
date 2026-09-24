/**
 * The contention window told redraft leagues to accumulate youth (2026-09-19).
 *
 * `analyzeLeague` (server/routes/tradelab.js) classifies every team on a
 * market-capital x core-age grid. Four of its seven labels are decided by the age
 * axis — Win-now, Juggernaut, Rebuild, Reset — and every one of them is a claim
 * about seasons that have not happened yet. In a redraft league there are none: a
 * roster is dissolved in January, so a 29-year-old is worth exactly what he scores
 * between now and week 17 and a 23-year-old is worth exactly the same thing.
 *
 * Running that axis in a redraft league did not merely add noise, it inverted the
 * advice. A weak young team was told "Ascending — accumulate youth, sell aging vets
 * while they hold value", which in a league with no next season means selling the
 * players who win you games this year for assets that do not exist.
 *
 * The rule is already settled one screen up in the same file: `dynastyAgeAdjustment`
 * is applied only `if (isDynasty)`. The window now follows it. In redraft the grid
 * collapses to its capital axis and yields the three format-neutral labels it
 * already had; `core_age` is still computed and still reported, it simply decides
 * nothing, and `window.basis` says which axes were used.
 *
 * Both leagues below are built from the SAME rosters and the SAME prices, priced
 * into both format keys, so the two runs differ in exactly one input: the league's
 * type. That is what makes a label difference attributable to the gate rather than
 * to dynasty and redraft market values disagreeing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-window-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 1, abbr, 1 FROM nfl_teams`);
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');

const { analyzeLeague } = await import('../server/routes/tradelab.js');
const { deriveFormat } = await import('../server/services/format.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const POSITION_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };

// Four teams, four players each, every player distinct. The seed carries no ESPN
// ids, so `leagueRosters` resolves these entries through its name+position index —
// the same path a real ESPN league takes for any player whose id it has not learned
// yet. The assertion below is why: if the seed ever stopped supplying four of a
// position, the squads would silently share players and the grid would flatten.
const pool = Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map(pos => [pos,
  rows(`SELECT id, name FROM players
        WHERE position = ? AND fantasy_relevant = 1
        ORDER BY id LIMIT 4`, pos)]));
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  assert.equal(pool[pos].length, 4, `the seed must supply four distinct ${pos}s`);
}

// A: strong and young.  B: strong and old.  C: weak and young.  D: weak and old.
// Capital is the per-player price x 4; ages are flat within a team so core_age is
// exactly the number written here.
const SQUADS = [
  { id: 1, name: 'Strong Young', value: 50, age: 24 },
  { id: 2, name: 'Strong Old',   value: 50, age: 29 },
  { id: 3, name: 'Weak Young',   value: 10, age: 24 },
  { id: 4, name: 'Weak Old',     value: 10, age: 29 }
];

const entry = p => ({ playerPoolEntry: { player: {
  id: p.id, fullName: p.name, defaultPositionId: POSITION_ID[p.position] } } });

const teamsPayload = SQUADS.map((squad, i) => ({
  id: squad.id,
  name: squad.name,
  roster: { entries: ['QB', 'RB', 'WR', 'TE'].map(pos => entry({ ...pool[pos][i], position: pos })) }
}));

const makeLeague = (id, leagueType) => {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, league_type, connection_status)
       VALUES (?, 'espn', ?, 2026, ?, ?, 4, '1', ?, ?, 'connected')`,
    id, `window-${id}`, `Window ${leagueType}`,
    JSON.stringify({ teams: teamsPayload }), JSON.stringify(SLOTS), leagueType);
  return row('SELECT * FROM leagues WHERE id = ?', id);
};

const redraft = makeLeague(501, 'redraft');
const dynasty = makeLeague(502, 'dynasty');

// Identical prices and ages in BOTH format keys, so the two leagues see the same
// market and the same core ages. Without this the redraft league would be priced
// from `rd_*` rows and any label difference would be unattributable.
for (const lg of [redraft, dynasty]) {
  const { formatKey } = deriveFormat(lg);
  for (const [i, squad] of SQUADS.entries()) {
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const p = pool[pos][i];
      run(`INSERT OR REPLACE INTO dynasty_values (format_key, player_id, value, age, pos_rank, fetched_at)
           VALUES (?,?,?,?,?, '2026-09-19T00:00:00Z')`,
        formatKey, p.id, squad.value, squad.age, 1);
    }
  }
}

const byOwner = lg => Object.fromEntries(analyzeLeague(lg).teams.map(t => [t.owner, t]));
const AGE_LABELS = ['Win-now', 'Juggernaut', 'Rebuild', 'Reset'];

test('the fixture really does separate the four corners of the grid', () => {
  // The premise, not a behaviour. If capital or core age came out flat, every
  // assertion below would hold vacuously and this file would prove nothing.
  const d = byOwner(dynasty);
  assert.equal(d['Strong Young'].core_age, 24);
  assert.equal(d['Weak Old'].core_age, 29);
  assert.ok(d['Strong Young'].competitiveness >= 1.05, 'strong teams are above the median');
  assert.ok(d['Weak Old'].competitiveness <= 0.95, 'weak teams are below it');
});

test('a dynasty league still gets all four age-driven labels', () => {
  // The regression pin. This change removes nothing from dynasty, which is the
  // format the grid was built for.
  const d = byOwner(dynasty);
  assert.equal(d['Strong Young'].window.label, 'Juggernaut');
  assert.equal(d['Strong Old'].window.label, 'Win-now');
  assert.equal(d['Weak Young'].window.label, 'Rebuild');
  assert.equal(d['Weak Old'].window.label, 'Reset');
});

test('a redraft league is never told to accumulate youth or sell aging vets', () => {
  const r = byOwner(redraft);
  for (const t of Object.values(r)) {
    assert.ok(!AGE_LABELS.includes(t.window.label),
      `${t.owner} got "${t.window.label}", which is a claim about next season`);
    assert.doesNotMatch(t.window.stance, /youth|aging|young/i,
      `${t.owner}'s advice talks about age in a league that ends in January`);
  }
});

test('redraft falls back to the capital axis it already had', () => {
  const r = byOwner(redraft);
  assert.equal(r['Strong Young'].window.label, 'Contender');
  assert.equal(r['Strong Old'].window.label, 'Contender');
  assert.equal(r['Weak Young'].window.label, 'Retool');
  assert.equal(r['Weak Old'].window.label, 'Retool');
});

test('the two formats disagree only where age was the reason', () => {
  // Same rosters, same prices, same ages: every numeric input to the grid is
  // identical, so the label is the only thing the gate may move.
  const r = byOwner(redraft), d = byOwner(dynasty);
  for (const owner of Object.keys(r)) {
    assert.equal(r[owner].core_age, d[owner].core_age, `${owner}: core age is still computed`);
    assert.equal(r[owner].competitiveness, d[owner].competitiveness, `${owner}: capital is untouched`);
    assert.equal(r[owner].market_capital, d[owner].market_capital, `${owner}: market capital is untouched`);
  }
});

test('the payload says which axes decided the label', () => {
  // So a reader can tell a suppressed age axis from a missing core age. The two
  // look identical otherwise, and only one of them is a fact about the roster.
  assert.equal(byOwner(redraft)['Weak Young'].window.basis, 'market_capital');
  assert.equal(byOwner(dynasty)['Weak Young'].window.basis, 'market_capital_and_core_age');
});

test('a keeper league is treated as dynasty, because it keeps players', () => {
  // deriveFormat: `isDynasty = league_type === 'dynasty' || league_type === 'keeper'`.
  // The gate must follow that one definition rather than invent a second one.
  const keeper = makeLeague(503, 'keeper');
  const { formatKey } = deriveFormat(keeper);
  for (const [i, squad] of SQUADS.entries()) {
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      run(`INSERT OR REPLACE INTO dynasty_values (format_key, player_id, value, age, pos_rank, fetched_at)
           VALUES (?,?,?,?,?, '2026-09-19T00:00:00Z')`,
        formatKey, pool[pos][i].id, squad.value, squad.age, 1);
    }
  }
  assert.equal(byOwner(keeper)['Weak Young'].window.label, 'Rebuild');
});
