/**
 * The teams page stops giving hand-written prose the authority of a measurement.
 *
 * The page has two kinds of content side by side and, until now, in identical
 * cards at identical weight:
 *
 *   - "Measured identity", computed by nfl-team-tendencies.js from thousands of
 *     team-weeks of play-by-play, every number a percentile against the other 31
 *     teams in the same season;
 *   - the scheme note and the coach outlook, which are prose somebody typed.
 *     server/db/seed/teams.js says so in its own header: "Schemes/analyses are
 *     editorial seed content."
 *
 * The prose is also stale in a way the page could not express: thirteen values
 * in that file are still placeholders, several reading "TBD (camp)" — and camp
 * is over. Rendering "TBD (camp)" where a person's name goes is the page
 * asserting a fact it does not have.
 *
 * Two things are therefore pinned here, and one thing is deliberately NOT done:
 * the prose is not rewritten. Who each team's coordinator actually is cannot be
 * answered from anything in this repository, and filling those in from memory
 * would replace a visible placeholder with an invisible invention, which is
 * strictly worse.
 *
 * Honest limit, as with the rest of this vocabulary: node:test, no DOM, source
 * text only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const page = read('client/src/pages/TeamDetail.tsx');
const seed = read('server/db/seed/teams.js');

test('a coaching slot that still says TBD renders as an absence, not as a name', () => {
  assert.match(page, /const PLACEHOLDER = \/\\bTBD\\b\/i/, 'the placeholder test is gone');
  assert.match(page, /const coachName = \(v\?: string \| null\) =>/, 'the guard is gone');
  // Each coordinator appears TWICE — once as the guard that decides whether the
  // slot renders at all, once as the name inside it — and a whole-file match
  // cannot tell them apart: dropping the guard left this green, because the
  // render still carried the call. A raw guard renders "· OC " with nothing
  // after it, which is the empty-space-where-a-name-belongs case this test
  // exists to prevent. Both positions are pinned, and the count is the pin.
  for (const slot of ['oc_name', 'dc_name']) {
    assert.match(page, new RegExp(`\\{coachName\\(team\\.${slot}\\) && `),
      `${slot} is guarded by the raw value, so a placeholder renders an empty slot`);
    assert.equal((page.match(new RegExp(`coachName\\(team\\.${slot}\\)`, 'g')) ?? []).length, 2,
      `${slot}: the guard and the name it guards must both go through coachName`);
  }
  // And the head coach, which always renders, says so rather than going blank —
  // an empty space where a name belongs reads as a layout bug, not as a fact.
  assert.match(page, /coachName\(team\.head_coach\) \?\? 'not recorded'/,
    'an unrecorded head coach now renders as nothing at all');
});

test('the placeholders this guards against are really in the data', () => {
  // If the seed is ever cleaned up, this test should be the thing that says so
  // rather than the guard silently protecting against nothing.
  const tbd = (seed.match(/\bTBD\b/g) ?? []).length;
  assert.ok(tbd > 0, 'no placeholders remain in the seed — the guard can be reconsidered');
  assert.match(seed, /editorial seed content/,
    'the seed no longer states that its analyses are editorial');
});

test('the prose says it is prose, beside the measurement that outranks it', () => {
  assert.match(page, /<BasisChip basis="assumed" note=\{SEED_NOTE\} \/>/,
    'the hand-written cards no longer carry a basis');
  assert.equal((page.match(/note=\{SEED_NOTE\}/g) ?? []).length, 2,
    'both hand-written cards should be labelled, not one');
  assert.match(page, /const SEED_NOTE =/, 'the note is gone');
});

test('the label does not invent a date the app does not have', () => {
  // nfl_teams has no timestamp column and the edit route at routes/teams.js
  // writes none, so there is no date to show. Saying "as of preseason" would be
  // a guess presented as provenance, which is the exact failure the basis
  // vocabulary exists to prevent.
  const schema = read('server/db/schema/core-and-fantasy.js');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS nfl_teams'),
    schema.indexOf('CREATE TABLE IF NOT EXISTS players'));
  assert.doesNotMatch(table, /updated_at|created_at/,
    'nfl_teams now has a timestamp — the page can and should show a real date');
  assert.match(page, /does not record when/, 'the note stopped admitting there is no date');
});

test('the measured block is still above the prose, which is the whole argument', () => {
  // Tendencies renders before the two prose cards. If that order ever inverts,
  // the page is leading with the sentence and following with the evidence.
  const tendencies = page.indexOf('<Tendencies');
  const prose = page.indexOf('Coach &amp; Fantasy Outlook') >= 0
    ? page.indexOf('Coach &amp; Fantasy Outlook') : page.indexOf('Coach & Fantasy Outlook');
  assert.ok(tendencies > 0, 'the measured identity block is no longer on the page');
  assert.ok(prose > 0, 'the prose card is no longer on the page');
  assert.ok(tendencies < prose, 'the prose now renders above the measurement');
});
