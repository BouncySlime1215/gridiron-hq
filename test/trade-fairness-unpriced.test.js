/**
 * An unpriced deal has been displaying as an even-money deal.
 *
 * `fairnessLabel` (server/services/trade-engine.js) opens with
 * `if (!total) return 'unpriced';`. That sixth value had no entry in
 * `FAIRNESS_TONE`, and the fallback was `text-[var(--muted)]` — byte-identical
 * to the tone for `'even money'`. So a deal where nothing could be priced and a
 * deal that is perfectly balanced have been pixel-identical on the deployed
 * app for as long as both have existed. Nothing failed; the label was right and
 * the styling said the opposite.
 *
 * Source text only: node:test has no build step and cannot import a .tsx.
 *
 * Every slice below is anchored on a string proven unique in the file it reads,
 * and each slice asserts that it actually landed on the region it names. The
 * first draft of this file did not: it cut `fairnessLabel` at `'/* -----'`,
 * which occurs eleven times in trade-engine.js and first occurs 1,161 lines
 * BEFORE the function, so the slice was empty and the assertion failed for a
 * reason that had nothing to do with the code. That is the fourth instance of
 * this bug in this stack — see docs/tdd/trade-fairness-unpriced.tdd.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const card = read('client/src/components/TradeCard.tsx');
const lab = read('client/src/pages/TradeLab.tsx');
const engine = read('server/services/trade-engine.js');

/** A `{ key: string-value }` object literal, read out of source between two unique anchors. */
function literalBetween(src, startAnchor, endAnchor, what) {
  const start = src.indexOf(startAnchor);
  assert.ok(start >= 0, `${what}: the opening anchor ${startAnchor} is gone — re-point this test`);
  const end = src.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `${what}: the closing anchor ${endAnchor} no longer follows the opening one`);
  const block = src.slice(start, end);
  const out = {};
  // Both quote styles: a sentence containing an apostrophe is written with
  // double quotes, and a reader that only knew single quotes skipped it
  // silently — the entry looked absent when it was merely quoted differently.
  for (const m of block.matchAll(/(?:'([^']+)'|([a-z_]+)):\s*(?:'([^']+)'|"([^"]+)")/g)) {
    out[m[1] ?? m[2]] = m[3] ?? m[4];
  }
  // A parse that quietly drops an entry is the failure this whole file is
  // about, so count what is there before trusting what came out.
  const declared = (block.match(/^\s*(?:'[^']+'|[a-z_]+):/gm) ?? []).length;
  assert.equal(Object.keys(out).length, declared,
    `${what}: ${declared} entries declared, ${Object.keys(out).length} parsed — the reader is dropping one`);
  return out;
}

const tones = literalBetween(card, 'const FAIRNESS_TONE', 'export const FAIRNESS_FALLBACK', 'FAIRNESS_TONE');
const notes = literalBetween(card, 'export const FAIRNESS_NOTE', '\n};', 'FAIRNESS_NOTE');

test('the server can send a value with no tone, and this is the one it sends', () => {
  // Read out of the function that decides it rather than copied, so a change
  // there surfaces here instead of silently reopening the hole.
  assert.match(engine, /if \(!total\) return 'unpriced';/,
    'fairnessLabel no longer returns unpriced where this test looks — re-point it');
  const start = engine.indexOf('function fairnessLabel');
  assert.ok(start >= 0, 'fairnessLabel is gone from trade-engine.js — re-point this test');
  const end = engine.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of fairnessLabel');
  const body = engine.slice(start, end);
  // The slice landed on the function, not on some other span that happens to
  // contain returns: it opens with the declaration and closes on the last
  // branch, and a whole function of six lines is nowhere near 2,000 characters.
  assert.ok(body.startsWith('function fairnessLabel('), 'the slice does not start at the function');
  assert.match(body, /return 'lopsided their way';\s*$/, 'the slice does not reach the last branch');
  assert.ok(body.length < 2000, `the slice ran past the function (${body.length} chars)`);

  const served = [...body.matchAll(/return '([^']+)';/g)].map(m => m[1]);
  assert.equal(served.length, 6, `fairnessLabel returns ${served.length} values, not the six this test read`);
  for (const v of served) {
    assert.ok(tones[v], `the server can send '${v}' and the card has no tone for it`);
  }
});

test('an absence never wears the tone of an answer', () => {
  // This is the defect. Not "the fallback is missing" — the fallback existed
  // and was the same string as the even-money tone, which is worse than a
  // missing one, because a missing one would have looked wrong.
  const even = tones['even money'];
  assert.ok(even, 'the even-money tone is gone — recheck what the absences are being compared against');
  assert.ok(tones['unpriced'], 'unpriced has no tone');
  assert.ok(tones['partly unpriced'], 'partly unpriced has no tone');
  assert.notEqual(tones['unpriced'], even, 'an unpriced deal is styled as an even-money deal again');
  assert.notEqual(tones['partly unpriced'], even, 'a partly unpriced deal is styled as an even-money deal');
  const fallback = card.match(/export const FAIRNESS_FALLBACK = '([^']+)';/);
  assert.ok(fallback, 'the fallback tone is no longer named');
  assert.notEqual(fallback[1], even, 'a value this build has never heard of is styled as an even-money deal');
  // And the three absences are told apart from each other, not merged into one
  // "something is missing" colour.
  const three = [tones['unpriced'], tones['partly unpriced'], fallback[1]];
  assert.equal(new Set(three).size, 3, 'two of the three absence states share a tone');
});

test('the absence tones come from the basis ramp, not the semantic colours', () => {
  // An unpriced deal is not a bad deal. It is an unanswered question, and
  // --good/--warn/--crit would tell a manager something about his trade that
  // nobody measured. The basis ramp is this app's vocabulary for "where did
  // this number come from", which is exactly what these are.
  for (const v of ['unpriced', 'partly unpriced']) {
    assert.match(tones[v], /var\(--basis-/, `'${v}' is styled from outside the basis ramp`);
    assert.doesNotMatch(tones[v], /--good|--warn|--crit|--danger/, `'${v}' is styled as a verdict`);
  }
  assert.match(card, /FAIRNESS_FALLBACK = 'text-\[var\(--basis-unknown\)\]'/,
    'an unknown fairness value no longer reads as unknown');
});

test('the absence is explained in plain words, on screen and not on hover', () => {
  // A title reaches a mouse and nothing else, and this app is read on a phone —
  // the same reason BasisChip renders its sentence rather than hiding it.
  assert.match(card, /\{fairnessNote\(deal\) && \(/, 'the explanation is gone');
  assert.match(card, /<p className="text-\[11px\] leading-relaxed text-\[var\(--muted\)\] mb-2">\s*\{fairnessNote\(deal\)\}/,
    'the explanation is no longer rendered as text');
  // Read out of the map by exact key. Matching /'?unpriced'?: '/ against the
  // whole file would have been satisfied by the 'partly unpriced' entry alone,
  // so deleting the unpriced sentence would have left this green.
  assert.ok(notes['unpriced'], "'unpriced' has no sentence");
  assert.ok(notes['partly unpriced'], "'partly unpriced' has no sentence");
  assert.notEqual(notes['unpriced'], notes['partly unpriced'],
    'nothing priced and something priced are explained with the same sentence');
  // The word a manager would misread is addressed head-on.
  assert.match(notes['unpriced'], /This is not a balanced deal — it is an unanswered question\./,
    'the unpriced sentence stopped saying what it is not');
  // The partly-unpriced sentence refuses to say the deal is fine, and says
  // which direction it cannot tell — feature audit's copy, cut down.
  assert.match(notes['partly unpriced'], /the deal may be better or worse than it looks, and we don't know which/,
    'the partly-unpriced sentence stopped saying that the direction is unknown');
  // The same phrase as the row below it, so the sentence and the count say the
  // same thing about the same fact. Guarded here as well as in the row, because
  // it appears twice and a change to either copy would otherwise go unnoticed
  // in the other.
  assert.match(notes['partly unpriced'], /no market value we can read/,
    'the sentence and the count no longer describe the absence the same way');
});

test('the count is spliced into the sentence only when the server sent one', () => {
  // The fields are served by nothing today. `?? 0` on both of them makes the
  // sum 0, and "0 of these players have no market value" is the exact opposite
  // of what the label above it says — on every deal, until the day they ship.
  const fn = card.slice(card.indexOf('export function fairnessNote'), card.indexOf('export const fairnessTone'));
  assert.ok(fn.startsWith('export function fairnessNote'), 'fairnessNote is gone — re-point this test');
  assert.ok(fn.length < 1200, `the slice ran past fairnessNote (${fn.length} chars)`);
  assert.match(fn, /if \(!n\) return base;/, 'a zero count is spliced into the sentence as a number');
  // Counted on MY side only: the same player is my out and their in, so adding
  // the other chair's pair would count every player in the deal twice.
  assert.match(fn, /deal\?\.me\?\.value_out_unpriced \?\? 0\) \+ \(deal\?\.me\?\.value_in_unpriced \?\? 0/,
    'the count is no longer one side\'s two legs');
  assert.doesNotMatch(fn, /them\?\./, 'the count double-counts by adding the other side');
  // Plural agreement, since the count is spliced into a fixed sentence.
  assert.match(fn, /n === 1 \? 'has' : 'have'/, 'the spliced sentence no longer agrees with its number');
});

test('the deal list carries the same tone as the card', () => {
  // TradeLab.tsx printed {d.fairness} as bare text, so an unpriced deal read as
  // an ordinary one in the list as well as on the card — two surfaces, one
  // defect, and fixing only the card would have left half of it.
  assert.match(lab, /<span className=\{fairnessTone\(d\.fairness\)\}>\{d\.fairness\}<\/span>/,
    'the deal list is printing the fairness label untoned again');
  assert.match(lab, /import TradeCard, \{[^}]*fairnessTone[^}]*\}/,
    'the list has its own tone logic instead of the card\'s');
});

test('the unpriced count renders per leg, only where there is one', () => {
  // Four fields, not two: the same player is one side's out and the other's in,
  // so a single per-side count is identical on both sides and says nothing
  // about who is short-changed. Each line names the one total it explains.
  const start = card.indexOf('<dt className="text-[var(--muted)]">Market value</dt>');
  assert.ok(start >= 0, 'the Market value row is gone — re-point this test');
  const dl = card.slice(start);
  const notPriced = dl.indexOf('Not priced');
  const nextRow = dl.indexOf('Weekly floor');
  assert.ok(notPriced >= 0 && nextRow >= 0, 'the Not priced row or the row after it is gone');
  assert.ok(notPriced < nextRow, 'the unpriced count is no longer directly under Market value');

  const block = dl.slice(0, nextRow);
  // Rendered only where the count is above zero — never as a "0 players" row,
  // which would claim everyone was priced.
  assert.match(block, /\.filter\(l => \(l\.n \?\? 0\) > 0\)/,
    'a leg with no unpriced players still renders a row');
  // Both legs, each named.
  assert.match(block, /n: s\.value_out_unpriced/, 'the leaving leg is not read');
  assert.match(block, /n: s\.value_in_unpriced/, 'the arriving leg is not read');
  assert.match(block, /leaving your roster/, 'the leaving leg is no longer named');
  assert.match(block, /arriving on your roster/, 'the arriving leg is no longer named');
  // Counted in players, said in the words feature audit gave.
  assert.match(block, /no market value we can read/, 'the row stopped saying what the count means');
  assert.match(block, /l\.n === 1 \? 'player' : 'players'/, 'the row no longer counts players');
  assert.doesNotMatch(block, /assets/, 'the row counts assets, and these fields count players');
});

test('the horizon line names the horizon the number was actually charged over', () => {
  // "over the season" was wrong in both directions. GAMES is fixed at 17 on the
  // untouched server (trade-engine.js:119, :1096), so at week 2 of a 16-week
  // league the number is neither the season nor the rest of it. Three states
  // arrive, and each gets the sentence that is true of it.
  const raw = card.slice(card.indexOf('{s.lineup_before}'), card.indexOf('<dl className='));
  assert.ok(raw.startsWith('{s.lineup_before}'), 'the horizon line is gone — re-point this test');
  assert.ok(raw.length < 1500, `the slice ran past the horizon line (${raw.length} chars)`);
  // A ban on a string has to skip the comment that explains why it is banned —
  // otherwise the explanation is what fails the test. Same reason the outlook
  // panel's test strips comments before its "preseason" ban.
  const line = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.doesNotMatch(line, /over the season/, 'the card is calling seventeen weeks "the season" again');
  assert.match(line, /\{horizonPhrase\(s\)\}/, 'the line stopped asking what horizon it is printing');
  // season_delta is null when a caller gave no horizon; num() would print an
  // em dash and the sentence would still assert a horizon around nothing.
  assert.match(line, /\{s\.season_delta != null &&/,
    'a missing season_delta still renders a horizon sentence');
});

test('each of the three horizon states gets the sentence that is true of it', () => {
  const fn = card.slice(card.indexOf('export function horizonPhrase'), card.indexOf("/** One team's outcome"));
  assert.ok(fn.startsWith('export function horizonPhrase'), 'horizonPhrase is gone — re-point this test');
  assert.ok(fn.length < 900, `the slice ran past horizonPhrase (${fn.length} chars)`);
  // weeks_remaining: the league's own count of weeks left.
  assert.match(fn, /season_delta_basis === 'weeks_remaining'/, 'the served basis is no longer read');
  assert.match(fn, /over the \$\{weeks\} weeks left/, 'the remaining-weeks wording is gone');
  // full_season_default: a full season, said to be a default, and never 17 when
  // the payload says something else. The served count is what gets printed.
  assert.match(fn, /full \$\{weeks\}-week season/, 'a served default horizon is printed as a literal instead');
  assert.match(fn, /which is a default rather than this league's own length/,
    'the default stopped being labelled as a default');
  // Fields absent: today's copy, unchanged, and the only place 17 is written.
  assert.match(fn, /if \(weeks == null\) return 'if that weekly gain held for a full 17-week season';/,
    'the no-fields fallback is gone or no longer first');
  assert.equal((fn.match(/17/g) ?? []).length, 1,
    'seventeen is written somewhere other than the no-fields fallback');
});

