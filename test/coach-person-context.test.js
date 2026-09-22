/**
 * Per-person context rules: the facts about a person that change what their
 * words mean.
 *
 * Nick, 2026-09-20 04:30Z: "Heads up for Josh smith btw we coach a flag
 * football team together so try not to mix that up. Like if he's talking
 * about how we need a qb that means the team. He will use the word we so
 * that's the team not fantasy."
 *
 * The temptation is to write that as an exception in the classifier. It is
 * stored as a row instead, with who said it and when, because it is the first
 * of a kind rather than a one-off: every person in a chain has something about
 * them that changes how to read them, and the next one should be data too.
 *
 * The hard part is the matching, and it is where this would go wrong quietly.
 * "we" is a word, not a substring: a rule keyed on it must fire on "we need a
 * QB" and must not fire on "week", "weather" or "were". A rule about one person
 * must never touch another person's messages. And a retired rule must stop
 * applying without being deleted, because the record of what was believed and
 * when is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-context-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

await import('../server/db/index.js');
const { personContext, addPersonContext, retirePersonContext, contextMatches,
  contextBrief, seedPersonContext, CONTEXT_SCOPES } =
  await import('../server/services/coach/people/context.js');

test('the Josh Smith rule is there, as a row, with who said it and when', () => {
  seedPersonContext();
  const rules = personContext('Josh Smith');
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.equal(rule.scope, 'pronoun');
  assert.match(rule.rule, /flag football/i);
  assert.match(rule.rule, /not.*fantasy/i);
  assert.equal(rule.author, 'Nick Matta');
  assert.match(rule.stated_at, /^2026-09-20/);
});

test('seeding twice does not duplicate it', () => {
  seedPersonContext();
  seedPersonContext();
  assert.equal(personContext('Josh Smith').length, 1);
});

test('"we" fires on the sentence Nick described', () => {
  seedPersonContext();
  const hits = contextMatches('Josh Smith', 'bro we need a qb badly');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].scope, 'pronoun');
});

test('"we" does not fire on week, weather or were', () => {
  seedPersonContext();
  for (const text of ['what week is the bye', 'weather looks bad sunday',
    'they were terrible', 'sweet', 'owed me one']) {
    assert.deepEqual(contextMatches('Josh Smith', text), [],
      `a substring match fired on "${text}"`);
  }
});

test("one person's rule never touches another person's messages", () => {
  seedPersonContext();
  assert.deepEqual(contextMatches('Haiden', 'we need a qb'), []);
  assert.deepEqual(personContext('Haiden'), []);
});

test('a rule can be added for anyone, and it needs a person, a scope, a rule and an author', () => {
  const added = addPersonContext({ person: 'Test Person', scope: 'nickname',
    rule: '"the kid" is his son, not a player', applies_when: 'the kid',
    author: 'Nick Matta', statedAt: '2026-09-20T05:00:00Z' });
  assert.ok(added.id);
  assert.equal(contextMatches('Test Person', 'the kid had a game').length, 1);

  for (const bad of [
    { scope: 'nickname', rule: 'x', author: 'y' },
    { person: 'p', rule: 'x', author: 'y' },
    { person: 'p', scope: 'nickname', author: 'y' },
    { person: 'p', scope: 'nickname', rule: 'x' },
    { person: 'p', scope: 'not-a-scope', rule: 'x', author: 'y' }
  ]) {
    assert.throws(() => addPersonContext(bad), /person|scope|rule|author/i);
  }
  assert.deepEqual(CONTEXT_SCOPES.slice().sort(),
    ['nickname', 'other', 'pronoun', 'relationship', 'topic']);
});

test('a multi-word phrase matches as a phrase, not as its words', () => {
  addPersonContext({ person: 'Phrase Person', scope: 'topic',
    rule: '"the league" means his work fantasy league, not ours',
    applies_when: 'the league', author: 'Nick Matta' });
  assert.equal(contextMatches('Phrase Person', 'the league is a mess').length, 1);
  assert.deepEqual(contextMatches('Phrase Person', 'league night'), []);
});

test('a rule with no trigger applies to the person always, not to no message', () => {
  addPersonContext({ person: 'Always Person', scope: 'relationship',
    rule: 'He is Nick\'s brother-in-law and jokes harder than he means it',
    author: 'Nick Matta' });
  assert.equal(contextMatches('Always Person', 'anything at all').length, 1);
  assert.equal(contextMatches('Always Person', '').length, 1);
});

test('a retired rule stops applying but stays on the record', () => {
  const added = addPersonContext({ person: 'Retired Person', scope: 'topic',
    rule: 'temporary', applies_when: 'temporary', author: 'Nick Matta' });
  assert.equal(contextMatches('Retired Person', 'temporary thing').length, 1);
  retirePersonContext(added.id);
  assert.deepEqual(contextMatches('Retired Person', 'temporary thing'), []);
  assert.deepEqual(personContext('Retired Person'), []);
  assert.equal(personContext('Retired Person', { includeRetired: true }).length, 1);
});

test('the brief reads as a sentence a model or a person can act on', () => {
  seedPersonContext();
  const brief = contextBrief('Josh Smith');
  assert.match(brief, /Josh Smith/);
  assert.match(brief, /flag football/i);
  assert.match(brief, /Nick Matta/);
  assert.match(brief, /2026-09-20/);
  assert.equal(contextBrief('Nobody At All'), '');
});

test('matching is case-insensitive and survives punctuation', () => {
  seedPersonContext();
  for (const text of ['WE need a qb', 'ok. we, honestly, need a qb', '"we" need a qb']) {
    assert.equal(contextMatches('Josh Smith', text).length, 1, `missed: ${text}`);
  }
});
