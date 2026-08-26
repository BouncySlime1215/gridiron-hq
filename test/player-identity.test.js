import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizePlayerName, findPlayerMatch } =
  await import('../server/services/player-identity.js');

/* ------------------------------------------------------------------ normalize */

test('curly and straight apostrophes normalize to the same name', () => {
  // The exact pair that split Ja'Marr Chase's draft picks across two player rows.
  assert.equal(normalizePlayerName('Ja’Marr Chase'), normalizePlayerName("Ja'Marr Chase"));
  assert.equal(normalizePlayerName('De’Von Achane'), normalizePlayerName("De'Von Achane"));
  assert.equal(normalizePlayerName('Wan’Dale Robinson'), normalizePlayerName("Wan'Dale Robinson"));
});

test('generational suffixes do not change identity', () => {
  assert.equal(normalizePlayerName('Marvin Harrison Jr.'), normalizePlayerName('Marvin Harrison'));
  assert.equal(normalizePlayerName('Calvin Austin III'), normalizePlayerName('Calvin Austin'));
  assert.equal(normalizePlayerName('John Metchie III'), normalizePlayerName('John Metchie'));
});

test('accents fold to their plain letters rather than vanishing', () => {
  // Dropping non-letters before stripping diacritics would give "jos" vs "jose".
  assert.equal(normalizePlayerName('José Ramírez'), 'jose ramirez');
});

test('periods and hyphens are ignored', () => {
  assert.equal(normalizePlayerName('A.J. Brown'), normalizePlayerName('AJ Brown'));
  assert.equal(normalizePlayerName('Amon-Ra St. Brown'), normalizePlayerName('Amon Ra St Brown'));
});

test('genuinely different names stay different', () => {
  assert.notEqual(normalizePlayerName('Michael Thomas'), normalizePlayerName('Michael Thompson'));
  assert.notEqual(normalizePlayerName('Josh Allen'), normalizePlayerName('Keenan Allen'));
});

/* ---------------------------------------------------------------- matching */

const ROWS = [
  { id: 1, name: "Ja'Marr Chase", position: 'WR', team_id: 4, espn_id: 4362628 },
  { id: 2, name: 'Austin Ekeler', position: 'RB', team_id: 32, espn_id: 4575131 },
  { id: 3, name: 'Austin Ekeler', position: 'RB', team_id: null, espn_id: 3068267 },
  { id: 4, name: 'Orphan Seed Guy', position: 'TE', team_id: 7, espn_id: null },
];

test('a known espn_id matches its own row even when the name is spelled differently', () => {
  const r = findPlayerMatch(ROWS, { espn_id: 4362628, name: 'Ja’Marr Chase', position: 'WR', team_id: 4 });
  assert.equal(r.match.id, 1);
  assert.equal(r.ambiguous, false);
});

test('a differently-punctuated name with no id still finds the existing row', () => {
  // This is the case that used to insert a duplicate instead of matching.
  const r = findPlayerMatch(ROWS, { espn_id: null, name: 'Ja’Marr Chase', position: 'WR', team_id: 4 });
  assert.equal(r.match.id, 1);
});

test('two real players sharing a name are told apart by their espn ids, not by row order', () => {
  const a = findPlayerMatch(ROWS, { espn_id: 4575131, name: 'Austin Ekeler', position: 'RB', team_id: 32 });
  const b = findPlayerMatch(ROWS, { espn_id: 3068267, name: 'Austin Ekeler', position: 'RB', team_id: null });
  assert.equal(a.match.id, 2);
  assert.equal(b.match.id, 3, 'must not collapse onto whichever row happened to come first');
});

test('an unknown player with an ambiguous name is reported, never silently bound', () => {
  // A third Austin Ekeler with an id we have never seen: both existing rows already
  // belong to other, distinct ESPN players, so guessing would corrupt one of them.
  const r = findPlayerMatch(ROWS, { espn_id: 999999, name: 'Austin Ekeler', position: 'RB', team_id: null });
  assert.equal(r.match, null);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
});

test('an id-less orphan row is preferred over rows already claimed by another espn player', () => {
  const rows = [
    { id: 10, name: 'Craig Reynolds', position: 'RB', team_id: 11, espn_id: 4361529 },
    { id: 11, name: 'Craig Reynolds', position: 'RB', team_id: 11, espn_id: null },
  ];
  const r = findPlayerMatch(rows, { espn_id: 5555555, name: 'Craig Reynolds', position: 'RB', team_id: 11 });
  assert.equal(r.match.id, 11, 'the unclaimed row is the only one safe to bind');
  assert.equal(r.ambiguous, false);
});

test('same name, different position is a different player', () => {
  const r = findPlayerMatch(ROWS, { espn_id: null, name: "Ja'Marr Chase", position: 'RB', team_id: 4 });
  assert.equal(r.match, null);
  assert.equal(r.ambiguous, false);
});

test('team is used to break a tie when neither row is claimed', () => {
  const rows = [
    { id: 20, name: 'Mike Williams', position: 'WR', team_id: 5, espn_id: null },
    { id: 21, name: 'Mike Williams', position: 'WR', team_id: 9, espn_id: null },
  ];
  const r = findPlayerMatch(rows, { espn_id: 777, name: 'Mike Williams', position: 'WR', team_id: 9 });
  assert.equal(r.match.id, 21);
});

test('nothing matching returns a clean miss so the caller inserts', () => {
  const r = findPlayerMatch(ROWS, { espn_id: 123, name: 'Brand New Rookie', position: 'WR', team_id: 1 });
  assert.equal(r.match, null);
  assert.equal(r.ambiguous, false);
});
