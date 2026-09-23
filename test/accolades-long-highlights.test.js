/**
 * A 4,000-character window silently zeroed the most decorated players.
 *
 * `parseHighlights` found the infobox block with
 *
 *     wikitext.match(/highlights\s*=([\s\S]{0,4000}?)(?:\n\s*\|\s*[a-zA-Z_]+\s*=|\n\}\})/i)
 *
 * The quantifier is lazy and capped at 4,000. If the terminator — the next
 * infobox key, or the closing `}}` — is further than 4,000 characters from
 * `highlights =`, the match fails entirely. `block` is null, `text` becomes
 * `''`, and every count falls through to 0.
 *
 * WHY THIS IS NOT A COSMETIC MISCOUNT. The zeros are WRITTEN. At
 * `server/routes/accolades.js:130-132` the sync upserts
 * `hi?.pro_bowls ?? 0`, `hi?.first_team_all_pro ?? 0`, `hi?.super_bowls ?? 0`
 * and `hi?.major_awards ?? null` straight into the table, and `wikiOk++` has
 * already counted the player as wiki-verified because the object exists. The
 * only trace is the `source` column reading `espn` rather than
 * `wikipedia+espn`. So the run reports success, the table gains a row saying a
 * Hall-of-Fame career has no Pro Bowls, and nothing goes red.
 *
 * That is the failure CLAUDE.md names: a layer goes inert and the surface keeps
 * printing numbers as if nothing had happened.
 *
 * AND THE BIAS IS BACKWARDS. The window is exceeded precisely when the
 * highlights block is long, and it is long for the players with the most
 * accolades. The bug cannot fire on a player with nothing to report; it fires
 * only on the ones the data is for.
 *
 * The fix must not simply raise the cap — that moves the cliff. It scans to the
 * real terminator. The third test below is the one that matters for that: an
 * unbounded scan must still STOP at the terminator, or the block swallows the
 * rest of the infobox and starts counting another field's contents.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHighlights } from '../server/routes/accolades.js';

// A real infobox shape: `highlights =`, a long list, then the next key.
const pad = (n) => Array.from({ length: n },
  (_, i) => `* [[${2000 + i} All-Pro Team|${2000 + i} season note ${'x'.repeat(40)}]]`).join('\n');

function infobox(body, { terminator = '\n| statlabel1 = Passing yards' } = {}) {
  return `{{Infobox NFL biography\n| name = Test Player\n| position = QB\n`
    + `| highlights =\n${body}\n${terminator}\n| statvalue1 = 1000\n}}`;
}

// Long enough that the terminator sits well past 4,000 characters.
// NOTE: written as "7× Super Bowl champion" rather than the "[[Super Bowl]]
// champion" form Wikipedia actually uses, because that form is defeated by a
// SECOND, separate defect in the same function — the counter allows an opening
// `[[` but not the closing `]]` before "champion", so every real champion reads
// zero. That is fixed in its own commit with its own test; using the working
// form here keeps this file about the window and nothing else.
const DECORATED = [
  '* 7× Super Bowl champion',
  '* 5× [[Super Bowl MVP]]',
  '* 3× [[NFL Most Valuable Player]]',
  '* 15× [[Pro Bowl]]',
  '* 3× First-team [[All-Pro]]',
  '* 2× Second-team [[All-Pro]]',
  '* [[Comeback Player of the Year]]',
  '* [[NFL All-Rookie Team|All-Rookie]]',
  pad(60),
].join('\n');

test('the block is found even when it runs past four thousand characters', () => {
  const wikitext = infobox(DECORATED);
  const offset = wikitext.indexOf('| statlabel1');
  assert.ok(offset - wikitext.search(/highlights\s*=/i) > 4000,
    'the fixture must actually exceed the old window, or it proves nothing');

  const hi = parseHighlights(wikitext);
  assert.equal(hi.found, true,
    'the highlights block exists and was not found. Every count below is then '
    + 'zero, and accolades.js writes those zeros to the table as a success.');
});

test('a decorated player keeps every accolade, not zero', () => {
  const hi = parseHighlights(infobox(DECORATED));
  assert.equal(hi.super_bowls, 7);
  assert.equal(hi.pro_bowls, 15);
  assert.equal(hi.first_team_all_pro, 3);
  assert.equal(hi.second_team_all_pro, 2);
  assert.equal(hi.all_rookie, 1);
  assert.match(hi.major_awards ?? '', /NFL MVP|Most Valuable Player/);
  assert.match(hi.major_awards ?? '', /Super Bowl MVP/);
  assert.match(hi.major_awards ?? '', /Comeback Player of the Year/);
});

// The guard on the fix. Removing a cap is only correct if the scan still stops
// where the block stops; otherwise it reads on into the rest of the infobox.
test('the block still stops at the next infobox key', () => {
  const wikitext = infobox('* 2× [[Pro Bowl]]',
    { terminator: '\n| awards = 9× [[Pro Bowl]] and 4× First-team [[All-Pro]]' });
  const hi = parseHighlights(wikitext);
  assert.equal(hi.pro_bowls, 2,
    'the count came from a later infobox field, so the scan ran past the '
    + "block's terminator. An unbounded scan is only a fix if it still stops.");
  assert.equal(hi.first_team_all_pro, 0,
    'First-team All-Pro appears only AFTER the terminator and must not count');
});

test('a short block is unaffected', () => {
  const hi = parseHighlights(infobox('* 2× [[Pro Bowl]]\n* Super Bowl champion'));
  assert.equal(hi.found, true);
  assert.equal(hi.pro_bowls, 2);
  assert.equal(hi.super_bowls, 1);
});

test('wikitext with no highlights block reports not-found rather than zeros', () => {
  const hi = parseHighlights('{{Infobox NFL biography\n| name = Nobody\n}}');
  assert.equal(hi.found, false,
    'found:false is what tells the caller to label the row `espn` instead of '
    + '`wikipedia+espn`; it must stay distinguishable from a real empty block.');
});

test('an empty highlights block is found, and is not the same as missing', () => {
  const hi = parseHighlights('{{Infobox NFL biography\n| highlights =\n| position = QB\n}}');
  assert.equal(hi.found, true);
  assert.equal(hi.pro_bowls, 0);
});
