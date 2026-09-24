/**
 * MSG-CHECK-FIX: message-check.js reads player names the way a styled draft writes them.
 * False rejections (every named player IS in the step) must pass; a draft naming a player
 * outside the step must still fail, however it is cased or punctuated.
 * Synthetic fixtures: public NFL player names only; no league, manager or chat data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../server/services/campaign/message-check.js');
const V = await import('../server/services/coach/voice.js');

const NAMES = {
  1: 'Justin Jefferson (WR)',
  2: 'Jaxon Smith-Njigba (WR)',
  3: 'Jordan Addison (WR)',
  4: 'Tyler Smith (RB)',
  5: "Ja'Marr Chase (WR)",
  6: 'Kyren Williams (RB)',
  7: 'Jordan Love (QB)',
  8: "D'Andre Swift (RB)",
};
// The step: Smith-Njigba for Addison. Everyone else is outside it.
const facts = () => C.factsFor({ names: NAMES, ids: ['2', '3'] });
const ok = t => C.checkBursts(t, facts());

test('false rejections: step players however a styled draft writes them', () => {
  for (const t of [
    'Smith-Njigba for Addison?',
    'smith-njigba for addison',
    'would u do smith-njigba\nfor addison',
    'Jaxon Smith-Njigba for Jordan Addison',
    'jaxon smith-njigba for jordan addison',
    "Smith-Njigba's floor is real, addison fits u",
    'Smith-Njigba’s floor, I’m in',
    'I’m good with addison',
  ]) assert.equal(ok(t).ok, true, `${t}: ${ok(t).errors.join('; ')}`);
});

test('a lowercase common word that is also a surname is the word; capitalised it is a name', () => {
  assert.equal(ok('love that addison fit, smith-njigba is yours').ok, true);
  assert.equal(ok('big chase for addison').ok, true);
  assert.equal(ok('Love for Addison?').ok, false);
  assert.equal(ok('addison for Chase').ok, false);
});

test('safety: a player outside the step is still rejected, however written', () => {
  for (const t of [
    'Jefferson for Addison?', // capitalised surname
    'addison for jefferson', // lowercase surname
    'justin jefferson for addison', // lowercase full name
    'JEFFERSON for addison', // upper case
    'Jefferson-for-Addison?', // hyphen compound that is not a name
    "Addison for Jefferson's upside", // straight possessive
    'Addison for Jefferson’s upside', // curly possessive
    'addison for jefferson’s upside', // lowercase curly possessive
    'addison and smith', // the other Smith, alone
    'addison for Smith', // capitalised
    "addison for ja'marr chase", // apostrophe full name, lowercase
    'addison for Ja’Marr Chase', // curly apostrophe full name
    "addison for d'andre swift", // apostrophe first name, lowercase
    'williams-for-addison', // lowercase hyphen compound
    'smith-njigba\nfor jefferson', // burst
  ]) {
    const c = ok(t);
    assert.equal(c.ok, false, `${t} should be rejected`);
    assert.ok(c.errors.some(e => /names a player not in this step/.test(e)), `${t}: ${c.errors.join('; ')}`);
  }
});

test('styled drafts of a hyphenated step name pass (the #331 styler, all-lowercase profile)', () => {
  const f = facts();
  const keep = [...f.allowed].map(id => C.splitName(NAMES[id]).name);
  const short = V.surnamePairs(Object.values(NAMES).map(n => C.splitName(n).name), keep);
  const profile = { all_lower: 1, i_cap: 0, apostrophe: 1, curly_apos: 1, comma: 0, end_period: 0, first_cap: 0 };
  for (const draft of ['Would you do Jaxon Smith-Njigba for Jordan Addison?', "I'm offering Jaxon Smith-Njigba for Jordan Addison."]) {
    const styled = V.styleText(draft, profile, { keep, short }).text;
    assert.equal(C.checkBursts(draft, f).ok, true, 'the plain draft passes');
    assert.equal(C.checkBursts(styled, f).ok, true, `styled: ${C.checkBursts(styled, f).errors.join('; ')}`);
  }
});
