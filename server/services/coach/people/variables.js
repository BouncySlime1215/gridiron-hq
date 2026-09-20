/**
 * The counted half of a person profile: who someone is, in numbers, read from
 * every message they have sent.
 *
 * Nick, 2026-09-20: "I want our analysis of these people to be scored on
 * TONNSSS of physiology variables to create an aggregate of who this person
 * is. Read my entire text chain with each person."
 *
 * The builder that exists reads at most 160 trade-flagged messages
 * (scripts/build-negotiation-profiles.mjs:45,63-93) and returns prose. This
 * reads the whole chain and returns numbers. The two are complements: prose
 * says what a person is like, numbers say how much of it there is and on how
 * many observations, and only the second can be graded.
 *
 * THREE RULES, each of which is a way this would otherwise go quietly wrong.
 *
 * 1. A thin variable is WITHHELD, not reported as zero. A reply latency from
 *    two observations and one from two hundred must not look alike, and the
 *    zero a naive count returns is the most confident-looking wrong number
 *    there is. Same discipline as manager-signals.js applies to
 *    tx_accept_rate under five decided offers.
 * 2. Nothing is priceable until it has been graded. Everything here ships
 *    `priceable: false`; only the grading harness may flip it, the way no
 *    draft metric survived its repeatability test (manager-signals.js:73-76).
 * 3. A variable the extractor already computes is READ from
 *    `manager_chat_profile`, never recomputed. Two implementations of "night
 *    share" would eventually disagree and nobody would know which screen was
 *    right.
 *
 * NO MESSAGE TEXT SURVIVES INTO A PROFILE. Only counts, rates and sample
 * sizes. That is deliberate: the corpus is private and cannot leave Nick's
 * machine, but a profile made only of numbers can, which is what makes Coach
 * on Fly possible at all.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { chatDbPath } from '../../manager-signals.js';
import { personContext, contextMatches } from './context.js';
import { HEDGES, SUPERLATIVES, NEGATIONS, HARD_NO, SOFT_NO, FIRST_PERSON, SECOND_PERSON, hasWord, countWords }
  from './lexicons.js';

/** Below this many observations a variable is withheld rather than reported. */
export const MIN_N = 5;

export const VARIABLE_FAMILIES = Object.freeze([
  'responsiveness', 'style', 'negotiation', 'disposition', 'social', 'context'
]);

/** Minutes. A gap longer than this is a new conversation, not a slow reply. */
const REPLY_WINDOW_MIN = 360;
/** Minutes of silence before a message counts as opening a conversation. */
const OPENER_SILENCE_MIN = 180;
/** Minutes of silence after a message before it counts as having ended one. */
const CLOSER_SILENCE_MIN = 360;
const LONG_MESSAGE_CHARS = 200;
/** Nick's own name in the corpus, as the extractor writes it. */
const SELF = 'ME';

const EMOJI = /\p{Extended_Pictographic}/u;

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60_000;
const finite = value => (Number.isFinite(value) ? value : null);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function stdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
}

/**
 * Variables this cannot compute, named rather than approximated.
 *
 * Each of these is a real question about a person that the data cannot
 * currently answer. An approximation here would be indistinguishable from a
 * measurement once it reached a profile, which is the failure this whole
 * service exists to prevent.
 */
export const NOT_COMPUTED = Object.freeze([
  Object.freeze({
    id: 'concession_after_counter', name: 'Concession after a counter', family: 'negotiation',
    what: 'How far he moves off his own opening ask once you counter, and in how many steps.',
    needs: 'The chat-to-proposal join: ESPN proposal, accept and decline timestamps matched to the '
      + 'chat window either side of them. That is Phase 4e of the master plan and does not exist. '
      + 'COACH-PLAYBOOK.md section 4 depends on it, so the concession ladder is a spec, not a behaviour.'
  }),
  Object.freeze({
    id: 'counter_rate', name: 'Counter rate', family: 'negotiation',
    what: 'Of the offers sent to him, the share he answered with an offer of his own rather than a no.',
    needs: 'league_transactions_raw, which is collected by hand (Finding 7) and so carries an age. '
      + 'It is computable, but only with that as-of shown beside it, and only once the identity map '
      + 'ties this chat name to a roster id. Withheld rather than shown undated.'
  }),
  Object.freeze({
    id: 'loss_reactivity', name: 'Reaction to losing', family: 'disposition',
    what: 'How much his volume and tone change in the two days after his team loses.',
    needs: 'His matchup results joined to his chat name. The results are in the app database and the '
      + 'messages are in the private one; the join needs manager-identity.js, which is another '
      + "thread's file. Buildable, not built."
  }),
  Object.freeze({
    id: 'reopen_rate', name: 'Reopening an untouchable', family: 'negotiation',
    what: 'How often a player he called untouchable is later discussed in a trade or actually moved.',
    needs: 'Player names extracted from the message that carried the untouchable signal. '
      + 'jev_chat_signals records that the signal fired, not who it was about.'
  }),
  Object.freeze({
    id: 'alliance_index', name: 'Who he talks to', family: 'social',
    what: 'Which other managers he is disproportionately in conversation with.',
    needs: 'The identity map from chat names to league rosters (manager-identity.js). Without it a '
      + 'name in a group thread cannot be tied to a team, and an alliance between two strangers is '
      + 'not a finding.'
  })
]);

/** Open the private corpus read-only. Absent is normal — it lives on one machine. */
function openCorpus() {
  const file = chatDbPath();
  if (!existsSync(file)) return null;
  return new DatabaseSync(file, { readOnly: true });
}

const has = (corpus, table) =>
  !!corpus.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);

/**
 * Every counted variable for one person.
 *
 * Returns the full list whatever the data says, with `value: null` and a
 * `withheld` reason where there is not enough to measure. A variable that
 * silently disappears when it is thin teaches a reader that absence means
 * "not applicable" rather than "not enough", which is the wrong lesson.
 */
export function personVariables(person, { corpus } = {}) {
  const name = String(person ?? '').trim();
  const db = corpus ?? openCorpus();
  const out = [];

  const add = (id, displayName, family, source, unit, value, n, measuredBy) => {
    const enough = n >= MIN_N;
    out.push({
      id, name: displayName, family, source, unit,
      value: enough ? finite(value) : null,
      n,
      priceable: false,
      measured_by: measuredBy,
      ...(enough ? {} : { withheld: `only ${n} observations; a variable needs ${MIN_N} to be reported` })
    });
  };

  if (!db || !name || !has(db, 'messages')) {
    // Same variable list, nothing measured. The caller sees the shape either
    // way and can say "not on this machine" rather than "no data about him".
    for (const spec of SPECS) add(spec.id, spec.name, spec.family, spec.source, spec.unit, null, 0, spec.measured_by);
    if (!corpus) db?.close();
    return out;
  }

  const mine = db.prepare(
    `SELECT msg_id, chat_kind, chat_name, ts_utc, text FROM messages
     WHERE name = ? AND text IS NOT NULL ORDER BY ts_utc`).all(name);
  const total = mine.length;

  /* ---- responsiveness: measured against the surrounding conversation ---- */
  const latencies = [];
  const latencyToSelf = [];
  const latencyToOthers = [];
  let openers = 0;
  let closers = 0;
  const previous = db.prepare(
    `SELECT name, ts_utc FROM messages WHERE chat_name = ? AND ts_utc < ? AND name <> ?
     ORDER BY ts_utc DESC LIMIT 1`);
  const previousAny = db.prepare(
    `SELECT ts_utc FROM messages WHERE chat_name = ? AND ts_utc < ? ORDER BY ts_utc DESC LIMIT 1`);
  const nextAny = db.prepare(
    `SELECT ts_utc FROM messages WHERE chat_name = ? AND ts_utc > ? ORDER BY ts_utc LIMIT 1`);
  const lastOwn = db.prepare(
    `SELECT ts_utc FROM messages WHERE chat_name = ? AND name = ? AND ts_utc < ? ORDER BY ts_utc DESC LIMIT 1`);

  for (const message of mine) {
    const other = previous.get(message.chat_name, message.ts_utc, name);
    const own = lastOwn.get(message.chat_name, name, message.ts_utc);
    // A reply is a message that follows someone ELSE more recently than it
    // follows the speaker's own last message — otherwise it is a continuation
    // of his own turn, and counting it would say he replies instantly.
    const isReply = other && (!own || Date.parse(own.ts_utc) < Date.parse(other.ts_utc));
    if (isReply) {
      const gap = minutes(other.ts_utc, message.ts_utc);
      if (gap >= 0 && gap <= REPLY_WINDOW_MIN) {
        latencies.push(gap);
        (other.name === SELF ? latencyToSelf : latencyToOthers).push(gap);
      }
    }
    const before = previousAny.get(message.chat_name, message.ts_utc);
    if (!before || minutes(before.ts_utc, message.ts_utc) >= OPENER_SILENCE_MIN) openers += 1;
    const after = nextAny.get(message.chat_name, message.ts_utc);
    if (!after || minutes(message.ts_utc, after.ts_utc) >= CLOSER_SILENCE_MIN) closers += 1;
  }
  const sorted = latencies.slice().sort((a, b) => a - b);
  const half = Math.floor(latencies.length / 2);

  add('reply_latency_p50', 'Typical reply time', 'responsiveness', 'computed', 'minutes',
    quantile(sorted, 0.5), latencies.length,
    'the median gap between a message from someone else and his next message in the same thread, '
    + `counting only gaps under ${REPLY_WINDOW_MIN / 60} hours`);
  add('reply_latency_p90', 'Slow reply time', 'responsiveness', 'computed', 'minutes',
    quantile(sorted, 0.9), latencies.length,
    'the ninetieth percentile of the same gaps: how long a reply takes on his slow days');
  add('reply_latency_trend', 'Reply time, later vs earlier', 'responsiveness', 'computed', 'ratio',
    half >= 1 ? quantile(sorted.slice(half), 0.5) / (quantile(sorted.slice(0, half), 0.5) || 1) : null,
    latencies.length, 'his median reply time over the later half of his messages divided by the earlier half; '
    + 'above 1 means he is getting slower');
  add('response_asymmetry', 'Replies to Nick vs to everyone else', 'responsiveness', 'computed', 'ratio',
    latencyToSelf.length && latencyToOthers.length
      ? quantile(latencyToSelf.slice().sort((a, b) => a - b), 0.5)
        / (quantile(latencyToOthers.slice().sort((a, b) => a - b), 0.5) || 1) : null,
    Math.min(latencyToSelf.length, latencyToOthers.length),
    'his median reply time to Nick divided by his median reply time to anyone else; below 1 means Nick gets answered first');
  add('initiation_rate', 'How often he starts it', 'responsiveness', 'computed', 'share of 1',
    total ? openers / total : null, total,
    `the share of his messages sent after at least ${OPENER_SILENCE_MIN / 60} hours of silence in that thread`);
  add('thread_close_rate', 'How often he has the last word', 'responsiveness', 'computed', 'share of 1',
    total ? closers / total : null, total,
    `the share of his messages followed by at least ${CLOSER_SILENCE_MIN / 60} hours of silence`);

  const hours = new Set(mine.map(m => m.ts_utc.slice(0, 13)));
  add('burst_index', 'Messages per active hour', 'responsiveness', 'computed', 'messages',
    hours.size ? total / hours.size : null, total,
    'his message count divided by the number of distinct hours he sent anything in: how much he arrives in bursts');
  const gameday = mine.filter(m => {
    const at = new Date(m.ts_utc);
    return at.getUTCDay() === 0 && at.getUTCHours() >= 17 && at.getUTCHours() <= 23;
  }).length;
  add('gameday_concentration', 'How much he talks during games', 'responsiveness', 'computed', 'share of 1',
    total ? gameday / total : null, total,
    'the share of his messages sent on a Sunday between 1pm and 7pm Eastern, when games are on');

  /* ---- style: counted over every message, with the word lists in lexicons.js ---- */
  const lengths = mine.map(m => String(m.text).length).sort((a, b) => a - b);
  const rate = predicate => (total ? mine.filter(m => predicate(String(m.text))).length / total : null);
  const letters = text => /\p{L}/u.test(text);

  add('mean_message_length', 'Message length', 'style', 'computed', 'characters',
    total ? lengths.reduce((a, b) => a + b, 0) / total : null, total,
    'the mean character count of his messages');
  add('median_message_length', 'Typical message length', 'style', 'computed', 'characters',
    quantile(lengths, 0.5), total, 'the median character count, which a few essays cannot drag');
  add('long_message_rate', 'How often he writes at length', 'style', 'computed', 'share of 1',
    rate(text => text.length > LONG_MESSAGE_CHARS), total,
    `the share of his messages longer than ${LONG_MESSAGE_CHARS} characters`);
  add('question_rate', 'How often he asks', 'style', 'computed', 'share of 1',
    rate(text => text.includes('?')), total, 'the share of his messages containing a question mark');
  add('emoji_rate', 'Emoji', 'style', 'computed', 'share of 1',
    rate(text => EMOJI.test(text)), total, 'the share of his messages containing an emoji');
  add('all_caps_rate', 'Shouting', 'style', 'computed', 'share of 1',
    rate(text => letters(text) && text.length >= 3 && text === text.toUpperCase()), total,
    'the share of his messages written entirely in capitals');
  add('hedge_rate', 'Hedging', 'style', 'computed', 'share of 1',
    rate(text => hasWord(HEDGES, text)), total,
    `the share of his messages containing one of ${HEDGES.length} hedging phrases (lexicons.js)`);
  add('superlative_rate', 'Superlatives', 'style', 'computed', 'share of 1',
    rate(text => hasWord(SUPERLATIVES, text)), total,
    `the share of his messages containing one of ${SUPERLATIVES.length} intensity words (lexicons.js); `
    + 'a person whose baseline is superlative gives no signal by using one');
  add('negation_rate', 'Negation', 'style', 'computed', 'share of 1',
    rate(text => hasWord(NEGATIONS, text)), total,
    'the share of his messages containing a negation');
  const firstPerson = mine.reduce((sum, m) => sum + countWords(FIRST_PERSON, m.text), 0);
  const secondPerson = mine.reduce((sum, m) => sum + countWords(SECOND_PERSON, m.text), 0);
  add('first_person_ratio', 'Talks about himself vs about you', 'style', 'computed', 'ratio',
    secondPerson ? firstPerson / secondPerson : null, total,
    'his I/me/my word count divided by his you/your word count');

  /* ---- negotiation: what the words do, not what they are about ---- */
  add('hard_no_rate', 'Flat refusals', 'negotiation', 'computed', 'share of 1',
    rate(text => hasWord(HARD_NO, text)), total,
    'the share of his messages containing a refusal that closes the subject (lexicons.js)');
  add('soft_no_rate', 'Refusals that leave the door open', 'negotiation', 'computed', 'share of 1',
    rate(text => hasWord(SOFT_NO, text)), total,
    'the share of his messages containing a deferral rather than a refusal (lexicons.js); '
    + 'telling these two apart is the point of having both');

  /* ---- signals: read from what the extractor already labelled ---- */
  const signalShare = question => {
    if (!has(db, 'jev_chat_signals')) return null;
    const hit = db.prepare(
      `SELECT COUNT(DISTINCT s.msg_id) AS n FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
       WHERE m.name = ? AND s.question = ? AND s.probability >= 0.5`).get(name, question);
    return total ? (hit?.n ?? 0) / total : null;
  };
  add('non_fantasy_share', 'How much of it is not fantasy', 'context', 'signal', 'share of 1',
    signalShare('topic.non_fantasy'), total,
    'the share of his messages the classifier labelled non-fantasy (jev_chat_signals topic.non_fantasy); '
    + 'high here means a person profile built from his chat is mostly not about football');
  add('player_opinion_share', 'How much of it is player opinions', 'negotiation', 'signal', 'share of 1',
    signalShare('topic.argmax:player_opinion'), total,
    'the share of his messages the classifier labelled as an opinion about a player');

  const confidences = has(db, 'jev_chat_signals')
    ? db.prepare(`SELECT s.probability AS p FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
                  WHERE m.name = ? AND s.question = 'confidence.mean'`).all(name).map(r => r.p)
      .filter(Number.isFinite)
    : [];
  add('confidence_volatility', 'How much his confidence swings', 'disposition', 'computed', 'standard deviations',
    stdev(confidences), confidences.length,
    'the standard deviation of the per-message confidence the classifier assigned him; '
    + 'manager_chat_profile keeps only the mean, which is exactly what hides a reactive person');

  /* ---- the extractor's own aggregates, read and not recomputed ---- */
  const profile = has(db, 'manager_chat_profile')
    ? db.prepare(`SELECT * FROM manager_chat_profile WHERE name = ?`).get(name) : null;
  const fromProfile = (id, displayName, family, unit, value, note) =>
    add(id, displayName, family, 'extractor', unit, value,
      profile ? (profile.msgs ?? 0) : 0,
      `read from manager_chat_profile, which the chat extractor writes${note ? `. ${note}` : ''}`);

  fromProfile('night_share', 'How much he talks at night', 'responsiveness', 'share of 1', profile?.night_share);
  fromProfile('group_share', 'Group vs one-to-one', 'social', 'share of 1',
    profile && profile.msgs ? profile.group_msgs / profile.msgs : null);
  fromProfile('tapback_ratio', 'Reacts instead of replying', 'social', 'share of 1',
    profile && profile.msgs ? profile.tapbacks / profile.msgs : null);
  fromProfile('confidence_mean', 'How certain he sounds', 'disposition', 'probability 0-1', profile?.confidence_mean,
    'Read confidence_volatility beside it: the mean alone cannot tell a steady person from a swinging one');
  fromProfile('tone_competitive', 'Competitive tone', 'disposition', 'probability 0-1', profile?.p_competitive);
  fromProfile('tone_friendly', 'Friendly tone', 'disposition', 'probability 0-1', profile?.p_friendly);
  fromProfile('tone_defensive', 'Defensive tone', 'disposition', 'probability 0-1', profile?.p_defensive);
  fromProfile('trade_talk_share', 'How much he talks trades', 'negotiation', 'probability 0-1', profile?.p_trade_talk);
  fromProfile('trash_talk_share', 'How much he talks trash', 'social', 'probability 0-1', profile?.p_trash_talk);
  fromProfile('open_to_trade', 'How open he sounds to a deal', 'negotiation', 'probability 0-1', profile?.p_open_to_trade);
  fromProfile('reacting_to_loss', 'How often he is reacting to a loss', 'disposition', 'probability 0-1',
    profile?.p_reacting_to_loss);
  fromProfile('own_complaining', 'Complaining about his own team', 'disposition', 'probability 0-1',
    profile?.p_own_complaining);
  fromProfile('own_untouchable', 'Declaring a player untouchable', 'negotiation', 'probability 0-1',
    profile?.p_own_untouchable);

  /* ---- context: how much of him is being reinterpreted, and by what ---- */
  // Both of these are counts over the messages examined, so their n is the
  // message count and not the count itself. "Nought rules, from three
  // messages" is not a finding, and routing them through add() is what stops
  // it reading as one.
  const rules = personContext(name);
  const hits = mine.filter(m => contextMatches(name, m.text).some(rule => rule.applies_when)).length;
  add('context_rules', 'Rules recorded about him', 'context', 'computed', 'rules',
    rules.length, total, 'the number of active rows in coach_person_context for this person, '
    + 'against the messages they would be applied to');
  add('context_rule_hits', 'Messages a rule reinterprets', 'context', 'computed', 'messages',
    hits, total, 'his messages matched by a triggered context rule — for Josh Smith, the ones where "we" '
    + 'means the flag football team rather than fantasy');

  const dms = mine.filter(m => m.chat_kind !== 'group').length;
  add('dm_share', 'One-to-one vs in the group', 'social', 'computed', 'share of 1',
    total ? dms / total : null, total, 'the share of his messages sent in a one-to-one thread');
  const rooms = new Set(mine.map(m => m.chat_name));
  const counterparts = new Set();
  for (const room of rooms) {
    for (const other of db.prepare(
      `SELECT DISTINCT name FROM messages WHERE chat_name = ? AND name <> ?`).all(room, name)) {
      counterparts.add(other.name);
    }
  }
  add('mention_breadth', 'How many people he talks to', 'social', 'computed', 'people',
    counterparts.size, total, 'the number of distinct people in the threads he posts in');

  if (!corpus) db.close();
  return out;
}

/** The shape of the list, for a caller with no corpus. Kept beside the adds above. */
const SPECS = Object.freeze([
  ['reply_latency_p50', 'Typical reply time', 'responsiveness', 'computed', 'minutes'],
  ['reply_latency_p90', 'Slow reply time', 'responsiveness', 'computed', 'minutes'],
  ['reply_latency_trend', 'Reply time, later vs earlier', 'responsiveness', 'computed', 'ratio'],
  ['response_asymmetry', 'Replies to Nick vs to everyone else', 'responsiveness', 'computed', 'ratio'],
  ['initiation_rate', 'How often he starts it', 'responsiveness', 'computed', 'share of 1'],
  ['thread_close_rate', 'How often he has the last word', 'responsiveness', 'computed', 'share of 1'],
  ['burst_index', 'Messages per active hour', 'responsiveness', 'computed', 'messages'],
  ['gameday_concentration', 'How much he talks during games', 'responsiveness', 'computed', 'share of 1'],
  ['mean_message_length', 'Message length', 'style', 'computed', 'characters'],
  ['median_message_length', 'Typical message length', 'style', 'computed', 'characters'],
  ['long_message_rate', 'How often he writes at length', 'style', 'computed', 'share of 1'],
  ['question_rate', 'How often he asks', 'style', 'computed', 'share of 1'],
  ['emoji_rate', 'Emoji', 'style', 'computed', 'share of 1'],
  ['all_caps_rate', 'Shouting', 'style', 'computed', 'share of 1'],
  ['hedge_rate', 'Hedging', 'style', 'computed', 'share of 1'],
  ['superlative_rate', 'Superlatives', 'style', 'computed', 'share of 1'],
  ['negation_rate', 'Negation', 'style', 'computed', 'share of 1'],
  ['first_person_ratio', 'Talks about himself vs about you', 'style', 'computed', 'ratio'],
  ['hard_no_rate', 'Flat refusals', 'negotiation', 'computed', 'share of 1'],
  ['soft_no_rate', 'Refusals that leave the door open', 'negotiation', 'computed', 'share of 1'],
  ['non_fantasy_share', 'How much of it is not fantasy', 'context', 'signal', 'share of 1'],
  ['player_opinion_share', 'How much of it is player opinions', 'negotiation', 'signal', 'share of 1'],
  ['confidence_volatility', 'How much his confidence swings', 'disposition', 'computed', 'standard deviations'],
  ['night_share', 'How much he talks at night', 'responsiveness', 'extractor', 'share of 1'],
  ['group_share', 'Group vs one-to-one', 'social', 'extractor', 'share of 1'],
  ['tapback_ratio', 'Reacts instead of replying', 'social', 'extractor', 'share of 1'],
  ['confidence_mean', 'How certain he sounds', 'disposition', 'extractor', 'probability 0-1'],
  ['tone_competitive', 'Competitive tone', 'disposition', 'extractor', 'probability 0-1'],
  ['tone_friendly', 'Friendly tone', 'disposition', 'extractor', 'probability 0-1'],
  ['tone_defensive', 'Defensive tone', 'disposition', 'extractor', 'probability 0-1'],
  ['trade_talk_share', 'How much he talks trades', 'negotiation', 'extractor', 'probability 0-1'],
  ['trash_talk_share', 'How much he talks trash', 'social', 'extractor', 'probability 0-1'],
  ['open_to_trade', 'How open he sounds to a deal', 'negotiation', 'extractor', 'probability 0-1'],
  ['reacting_to_loss', 'How often he is reacting to a loss', 'disposition', 'extractor', 'probability 0-1'],
  ['own_complaining', 'Complaining about his own team', 'disposition', 'extractor', 'probability 0-1'],
  ['own_untouchable', 'Declaring a player untouchable', 'negotiation', 'extractor', 'probability 0-1'],
  ['context_rules', 'Rules recorded about him', 'context', 'computed', 'rules'],
  ['context_rule_hits', 'Messages a rule reinterprets', 'context', 'computed', 'messages'],
  ['dm_share', 'One-to-one vs in the group', 'social', 'computed', 'share of 1'],
  ['mention_breadth', 'How many people he talks to', 'social', 'computed', 'people']
].map(([id, name, family, source, unit]) => Object.freeze({
  id, name, family, source, unit,
  measured_by: 'not measured here: the private chat corpus is not on this machine'
})));

/** Every variable this can produce, with no corpus needed. For a UI or a doc. */
export function variableCatalogue() {
  return SPECS.map(spec => ({ ...spec }));
}
