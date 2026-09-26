/**
 * A league-mate is "they", never he, him or his (Nick, 2026-09-26): the ONE pronoun guard, used by
 * Numbers & People's why lines and every line Coach shows (coach/answer-shape.js#neutralAnswer).
 * Pure: no imports.
 */
/** Gendered words a league-mate line may not use, and their neutral forms where the swap is safe. */
const NEUTRAL = [[/\bhimself\b/gi, 'themselves'], [/\bhim\b/gi, 'them'], [/\bhis\b/gi, 'their'], [/\bhe's\b/gi, "they're"],
  [/\bhe is\b/gi, 'they are'], [/\bhe was\b/gi, 'they were'], [/\bhe has\b/gi, 'they have'], [/\bhe does\b/gi, 'they do'],
  [/\bhe doesn't\b/gi, "they don't"], [/\bhe won't\b/gi, "they won't"], [/\bhe will\b/gi, 'they will'], [/\bhe would\b/gi, 'they would'],
  [/\bhe can\b/gi, 'they can'], [/\bhe might\b/gi, 'they might']];
export const GENDERED = /\b(he|him|his|himself|she|her|hers|herself)\b/i;

/** "he says" -> "they say": the verb after a subject pronoun, in its plural form (COACH-V2 drawer). */
const IRREGULAR = { is: 'are', was: 'were', has: 'have', does: 'do', goes: 'go', "doesn't": "don't", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't" };
function plural(verb) {
  const v = verb.toLowerCase();
  if (IRREGULAR[v]) return IRREGULAR[v];
  if (/ies$/.test(v)) return v.replace(/ies$/, 'y');
  if (/(sh|ch|ss|x|z|o)es$/.test(v)) return v.replace(/es$/, '');
  if (/[^s]s$/.test(v)) return v.slice(0, -1);
  return v; // a modal or a past tense: "he will", "he said"
}
const SUBJECT = /\b(he|she)(\s+)((?:always|never|also|still|just|often|usually|rarely|only|even|really|probably|then|now)\s+)?([a-z']+)\b/gi;
const CONTRACTED = [[/\bhe'll\b/gi, "they'll"], [/\bshe'll\b/gi, "they'll"], [/\bhe'd\b/gi, "they'd"], [/\bshe'd\b/gi, "they'd"],
  [/\bhe's\b/gi, "they're"], [/\bshe's\b/gi, "they're"]];
const OBJECT = [[/\bhimself\b/gi, 'themselves'], [/\bherself\b/gi, 'themselves'], [/\bhim\b/gi, 'them'], [/\bhis\b/gi, 'their'], [/\bhers\b/gi, 'theirs']];
const keepCase = (m, to) => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);

/**
 * A league-mate line in neutral words; null when a gendered word is left that cannot be swapped
 * safely. Subject pronouns take the plural verb ("If he says no" -> "If they say no"); "her"
 * is left alone (object or possessive cannot be told apart), so a line with it is null.
 */
export function neutral(text) {
  let t = String(text ?? '');
  for (const [rx, to] of CONTRACTED) t = t.replace(rx, m => keepCase(m, to));
  t = t.replace(SUBJECT, (m, pro, sp, adv, verb) => `${keepCase(pro, 'they')}${sp}${adv ?? ''}${plural(verb)}`);
  for (const [rx, to] of [...NEUTRAL, ...OBJECT]) t = t.replace(rx, m => keepCase(m, to));
  return GENDERED.test(t) ? null : t;
}

