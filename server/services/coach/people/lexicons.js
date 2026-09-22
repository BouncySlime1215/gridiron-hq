/**
 * The word lists the style variables count.
 *
 * Kept in one small file on purpose. They are the most arguable thing in the
 * profile — a hedge list is a judgement call, not a measurement — so they are
 * somewhere a person can read and edit them in one screen, rather than buried
 * in the middle of the scorer. Every variable that uses one says so in its
 * `measured_by`, and the grading harness is what decides whether counting
 * them predicts anything.
 *
 * These are matched as whole words, case-insensitively, against message text.
 */

/** Uncertainty markers. A person who hedges a lot says no softly. */
export const HEDGES = Object.freeze([
  'maybe', 'probably', 'possibly', 'might', 'perhaps', 'kinda', 'kind of',
  'sort of', 'i think', 'i guess', 'i feel like', 'not sure', 'unsure',
  'could be', 'idk', 'i dunno', 'apparently', 'seems', 'seemed', 'somewhat'
]);

/** Intensity markers. A person whose baseline is superlative gives no signal by using one. */
export const SUPERLATIVES = Object.freeze([
  'best', 'worst', 'never', 'always', 'huge', 'insane', 'crazy', 'literally',
  'absolutely', 'definitely', 'obviously', 'massive', 'terrible', 'amazing',
  'unreal', 'elite', 'garbage', 'smash', 'must', 'lock'
]);

export const NEGATIONS = Object.freeze([
  'no', 'not', 'never', 'cant', "can't", 'wont', "won't", 'dont', "don't",
  'nope', 'nah', 'isnt', "isn't", 'aint', "ain't"
]);

/** A refusal that closes the subject. */
export const HARD_NO = Object.freeze([
  'no', 'nope', 'nah', 'not happening', 'hard pass', 'pass', 'no chance',
  'not a chance', 'never', 'untouchable', 'not moving him', 'not trading him',
  'forget it', 'no thanks'
]);

/** A refusal that leaves the door open. Telling these apart is the point. */
export const SOFT_NO = Object.freeze([
  'let me think', 'ill think', "i'll think", 'maybe later', 'not right now',
  'not yet', 'ill get back', "i'll get back", 'lemme look', 'let me look',
  'ill look', "i'll look", 'hmm', 'idk maybe', 'tempting'
]);

export const FIRST_PERSON = Object.freeze(['i', 'me', 'my', 'mine', 'myself', "i'm", 'im', "i'd", "i'll", "i've"]);
export const SECOND_PERSON = Object.freeze(['you', 'your', 'yours', 'yourself', "you're", 'youre', "you'd", "you'll"]);

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, punctuation-proof, case-insensitive. "no" must not match "nothing". */
export function countWords(list, text) {
  const haystack = String(text ?? '');
  let hits = 0;
  for (const word of list) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, 'giu');
    hits += (haystack.match(pattern) ?? []).length;
  }
  return hits;
}

/** Does the text contain any of them at all? */
export const hasWord = (list, text) => countWords(list, text) > 0;
