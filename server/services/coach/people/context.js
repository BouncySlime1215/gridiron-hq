/**
 * The facts about a person that change what their words mean.
 *
 * Nick, 2026-09-20 04:30Z: "Heads up for Josh smith btw we coach a flag
 * football team together so try not to mix that up. Like if he's talking
 * about how we need a qb that means the team."
 *
 * The obvious thing to do with that is write an exception into the
 * classifier. This stores it as a row instead, with who said it and when,
 * because it is the first of a kind and not a one-off. Everyone in a chain has
 * something about them that changes how to read them — a nickname that is a
 * person rather than a player, a second league, a brother who jokes harder
 * than he means it — and the next one of those should be a row too, addable
 * without a deploy.
 *
 * MATCHING IS THE HARD PART and it is where this would go wrong silently. A
 * rule keyed on "we" has to fire on "we need a QB" and must not fire on
 * "week", "weather" or "were". So triggers are matched as whole words or
 * whole phrases with a literal, escaped comparison — never as a substring,
 * and never as a caller-supplied regular expression, which would be both a
 * matching bug and a denial-of-service waiting to happen.
 *
 * A rule with no trigger applies to everything that person says. That is the
 * right default for a fact about a person rather than about a phrase.
 *
 * Retiring keeps the row. What was believed, by whom, and when it stopped
 * being believed is the record; deleting it loses exactly the thing that makes
 * a profile auditable later.
 */
import { db, rows, row, run } from '../../../db/index.js';

db.exec(`CREATE TABLE IF NOT EXISTS coach_person_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL,
  scope TEXT NOT NULL,
  rule TEXT NOT NULL,
  applies_when TEXT,
  author TEXT NOT NULL,
  stated_at TEXT NOT NULL,
  retired_at TEXT)`);
db.exec(`CREATE INDEX IF NOT EXISTS coach_person_context_person
         ON coach_person_context (person)`);

/** What kind of fact this is. Kept small on purpose; 'other' is the escape hatch. */
export const CONTEXT_SCOPES = Object.freeze(['pronoun', 'topic', 'relationship', 'nickname', 'other']);

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word (or whole-phrase) match, case-insensitive, punctuation-proof.
 * The boundaries are asserted on either side rather than with \b, so a phrase
 * ending in punctuation still matches and "week" never satisfies "we".
 */
function triggerHits(trigger, text) {
  const haystack = String(text ?? '');
  return String(trigger).split(',').map(part => part.trim()).filter(Boolean)
    .some(part => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(part)}(?![\\p{L}\\p{N}])`, 'iu')
      .test(haystack));
}

/** Every rule on record for a person. Active ones by default. */
export function personContext(person, { includeRetired = false } = {}) {
  const name = String(person ?? '').trim();
  if (!name) return [];
  return rows(`SELECT * FROM coach_person_context
               WHERE person = ? ${includeRetired ? '' : 'AND retired_at IS NULL'}
               ORDER BY id`, name);
}

/**
 * Record a fact about a person.
 *
 * @param {{person: string, scope: string, rule: string, author: string,
 *   applies_when?: string|null, statedAt?: string}} entry
 */
export function addPersonContext({ person, scope, rule, author, applies_when = null, statedAt } = {}) {
  const name = String(person ?? '').trim();
  const text = String(rule ?? '').trim();
  const by = String(author ?? '').trim();
  if (!name) throw new Error('a context rule needs the person it is about');
  if (!CONTEXT_SCOPES.includes(scope)) {
    throw new Error(`scope must be one of ${CONTEXT_SCOPES.join(', ')}, not ${JSON.stringify(scope)}`);
  }
  if (!text) throw new Error('a context rule needs the rule itself, in plain words');
  if (!by) throw new Error('a context rule needs an author — an unattributed fact cannot be checked later');
  run(`INSERT INTO coach_person_context (person, scope, rule, applies_when, author, stated_at)
       VALUES (?,?,?,?,?,?)`,
    name, scope, text, applies_when ? String(applies_when).trim() : null, by,
    statedAt ?? new Date().toISOString());
  return row(`SELECT * FROM coach_person_context WHERE id = last_insert_rowid()`);
}

/** Stop applying a rule without losing the record that it was believed. */
export function retirePersonContext(id, at = new Date().toISOString()) {
  run(`UPDATE coach_person_context SET retired_at = ? WHERE id = ? AND retired_at IS NULL`, at, id);
  return row(`SELECT * FROM coach_person_context WHERE id = ?`, id) ?? null;
}

/**
 * The rules that apply to one message from one person: every untriggered rule
 * about them, plus every triggered rule whose trigger is in the text.
 */
export function contextMatches(person, text) {
  return personContext(person)
    .filter(rule => !rule.applies_when || triggerHits(rule.applies_when, text));
}

/** The rules about a person, as prose for a prompt or a panel. Empty when there are none. */
export function contextBrief(person) {
  const rules = personContext(person);
  if (!rules.length) return '';
  return rules
    .map(rule => `${rule.person}: ${rule.rule} (${rule.author}, ${rule.stated_at.slice(0, 10)})`)
    .join('\n');
}

/**
 * The rules Nick has stated, so a fresh database starts with what he already
 * said rather than needing him to say it again. Idempotent on (person, rule).
 */
export function seedPersonContext() {
  const seeds = [{
    person: 'Josh Smith',
    scope: 'pronoun',
    rule: 'He and Nick coach a flag football team together, so "we" in his messages means that team, '
      + 'not a fantasy roster — "we need a QB" is about the flag team. Do not read it as trade interest '
      + 'or as a statement about his fantasy needs.',
    applies_when: 'we, us, our, we\'re, we need',
    author: 'Nick Matta',
    statedAt: '2026-09-20T04:30:38Z'
  }];
  const added = [];
  for (const seed of seeds) {
    const existing = row(`SELECT id FROM coach_person_context WHERE person = ? AND rule = ?`,
      seed.person, seed.rule);
    if (existing) continue;
    added.push(addPersonContext(seed));
  }
  return added;
}
