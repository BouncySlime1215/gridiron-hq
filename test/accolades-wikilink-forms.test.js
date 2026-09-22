/**
 * `[[Super Bowl]] champion` counted as ZERO Super Bowls.
 *
 * The counter is
 *
 *     /(\d+)×\s*\[?\[?Super Bowl champion/i
 *
 * with a fallback of `/Super Bowl\s*(champion|[IVXL]+\s*champion)/i`. Both
 * allow an OPENING `[[` and neither allows the CLOSING `]]`, so the one form
 * English Wikipedia actually uses on NFL infoboxes — the award name as a
 * wikilink, followed by the word outside it — matches nothing.
 *
 * Measured before the fix:
 *
 *   7× [[Super Bowl]] champion   -> 0
 *   7× Super Bowl champion       -> 7
 *   7× [[Super Bowl champion]]   -> 7
 *   [[Super Bowl]] champion      -> 0
 *
 * Same user-visible result as the 4,000-character window fixed alongside it —
 * a champion recorded with no rings — but a different cause, so it is its own
 * commit and its own test file.
 *
 * The other counters already tolerate this shape, which is why only Super Bowls
 * were affected: `Pro Bowl` and `All-Pro` are matched as the wikilink TARGET
 * (`\[?\[?Pro Bowl`), where the closing brackets fall after the matched text
 * and never get in the way. Super Bowls are the only accolade whose label needs
 * a word that sits OUTSIDE the link.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHighlights } from '../server/routes/accolades.js';

const box = (line) => `{{Infobox NFL biography\n| highlights =\n${line}\n| position = QB\n}}`;

test('a wikilinked Super Bowl with the word champion outside it counts', () => {
  assert.equal(parseHighlights(box('* 7× [[Super Bowl]] champion')).super_bowls, 7,
    'the form Wikipedia actually uses must count; it read zero, and that zero '
    + 'is written to the table as a successful sync.');
});

test('a single wikilinked championship counts as one', () => {
  assert.equal(parseHighlights(box('* [[Super Bowl]] champion')).super_bowls, 1);
});

test('the forms that already worked still work', () => {
  assert.equal(parseHighlights(box('* 7× Super Bowl champion')).super_bowls, 7);
  assert.equal(parseHighlights(box('* 7× [[Super Bowl champion]]')).super_bowls, 7);
  assert.equal(parseHighlights(box('* Super Bowl champion')).super_bowls, 1);
});

test('a real-shaped entry naming the specific game still counts', () => {
  // How a decorated player's line is actually written.
  assert.equal(parseHighlights(
    box('* 3× [[Super Bowl]] champion ([[Super Bowl XXXVI|XXXVI]], [[Super Bowl XXXVIII|XXXVIII]])')
  ).super_bowls, 3);
});

// The guard. Loosening a counter must not make it count things that are not
// championships, or the fix trades a false zero for a false trophy.
test('an appearance is not a championship', () => {
  assert.equal(parseHighlights(box('* 2× [[Super Bowl]] appearance')).super_bowls, 0,
    'reaching a Super Bowl is not winning one');
});

test('a Super Bowl MVP award is not itself a championship count', () => {
  const hi = parseHighlights(box('* 5× [[Super Bowl MVP]]'));
  assert.equal(hi.super_bowls, 0,
    'the MVP line must not be read as a championship; it is counted separately '
    + 'as a major award');
  assert.match(hi.major_awards ?? '', /Super Bowl MVP/);
});

test('a losing record mentioning the game does not count', () => {
  assert.equal(parseHighlights(box('* Lost [[Super Bowl]] LII')).super_bowls, 0);
});
