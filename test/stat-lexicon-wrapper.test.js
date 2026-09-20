/**
 * One catalogue of what the numbers mean, reached without copying any of it.
 *
 * `server/services/stat-lexicon.js` is a wrapper over
 * `server/services/coach/stat-names.js`, which is the single source of truth for
 * every stat's display name and explanation. The rule it exists to keep: a
 * stat's name is the same on every screen, so a second copy of a name is a
 * second name waiting to drift.
 *
 * The Coach namespace has not merged yet (#82), so the wrapper's import fails
 * and every accessor reports that rather than returning a shape that looks like
 * an answer. The tests below are in two halves: the absent half runs today, and
 * the present half is skipped with its reason stated and activates the moment
 * the module lands. A skipped test is not a passing one, which is why the skip
 * names what it is waiting for.
 *
 * The shape the present half pins was taken from a READ of the module at
 * commit f5406ee, not from a description of it. That distinction earned itself
 * today: a concept entry was described to this thread as `{ label, unit,
 * direction, plain, why }` and is in fact `{ name, unit, better, plain, why,
 * source }` — three names wrong and one field missing. Asserting the described
 * shape would have rendered `entry.label` as undefined and shown a stat with no
 * name, which does not announce itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const lex = await import('../server/services/stat-lexicon.js');
const present = lex.lexiconStatus().available;
const waiting = { skip: 'the Coach namespace (#82) is not on this branch yet' };

test('L1: an absent catalogue is reported, never served as an empty one', () => {
  if (present) return;
  const out = lex.statLexicon();
  assert.equal(out.available, false);
  assert.equal(out.reason, 'catalogue_not_on_this_branch');
  // The collections are empty AND flagged. Empty alone would read as "this app
  // stores no stats", which a caller would render as a blank panel with no
  // explanation of why it is blank.
  assert.deepEqual(out.concepts, {});
  assert.deepEqual(out.not_stored, []);
});

test('L2: every accessor answers null rather than throwing while the catalogue is away', () => {
  if (present) return;
  assert.equal(lex.describeField('player_week_usage.target_share'), null);
  assert.equal(lex.conceptFor('player_week_usage.target_share'), null);
  assert.equal(lex.conceptById('target_share'), null);
});

test('L3: the wrapper carries none of the catalogue\'s text', () => {
  // Structural, so it holds whether or not the module is present: a wrapper has
  // no prose in it. Any long string literal here is a copied explanation, which
  // is the one thing this file must never grow.
  const src = fs.readFileSync(new URL('../server/services/stat-lexicon.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Newlines are excluded from the class on purpose. Without that, the matcher
  // pairs one literal's CLOSING quote with the next literal's opening one and
  // reports the code between them as a long string — which it did, on the first
  // run of this test, naming the import line and the function under it.
  const long = [...code.matchAll(/'([^'\n]{33,})'|"([^"\n]{33,})"/g)].map(m => m[1] ?? m[2]);
  assert.deepEqual(long, [],
    `the wrapper has grown text of its own, which is a second copy of a stat's words: ${long.join(' | ')}`);
});

test('L4: a concept entry is the six keys the module defines, and no others', waiting, () => {
  const { concepts } = lex.statLexicon();
  const ids = Object.keys(concepts);
  assert.ok(ids.length >= 38, `${ids.length} concepts — the catalogue shrank`);
  for (const id of ids) {
    assert.deepEqual(Object.keys(concepts[id]).sort(),
      ['better', 'name', 'plain', 'source', 'unit', 'why'],
      `concept ${id} does not carry the six keys`);
  }
});

test('L5: better has three values, and "neither" is not a rounding error', waiting, () => {
  // 8 of 38 concepts are 'neither' at f5406ee. A panel drawing an arrow from a
  // two-branch switch would point somewhere on every one of them.
  const { concepts } = lex.statLexicon();
  const seen = new Set(Object.values(concepts).map(c => c.better));
  assert.deepEqual([...seen].sort(), ['higher', 'lower', 'neither']);
  const neither = Object.values(concepts).filter(c => c.better === 'neither').length;
  assert.ok(neither >= 5, `only ${neither} concepts have no good direction — check before trusting an arrow`);
});

test('L6: conceptById returns the same shape as conceptFor', waiting, () => {
  const { fields } = lex.statLexicon();
  const [field, id] = Object.entries(fields)[0];
  const byField = lex.conceptFor(field);
  const byId = lex.conceptById(id);
  assert.deepEqual(Object.keys(byId).sort(), Object.keys(byField).sort(),
    'the two lookups return different shapes, which is what conceptById exists to prevent');
  assert.equal(byId.id, id);
  assert.equal(lex.conceptById('no_such_concept_id'), null);
});
