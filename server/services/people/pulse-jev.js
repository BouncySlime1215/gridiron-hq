/**
 * PULSE-02: the pulse's own Jev reading (the classifier path of the chat pulse).
 *
 * PULSE-01 read Jev's general chat signals (jev_chat_signals: topic, tone, open_to_trade),
 * which never ask the pulse's question and never see who owns the players. Its WANT_PLAYER
 * label was 0.56 precise against the PEOPLE-LAB hand labels, mostly because "talks trade
 * and names a player he does not own" is also every comparison and every counter. This asks
 * Jev the pulse's own questions, one boolean per statement type, with what a hand labeller
 * had: the thread's last few lines and, for every player named in them, whose team he is on
 * at that moment (the speaker's, Nick's, another team's, nobody's). Names of league-mates
 * are never sent: speakers are SPEAKER / NICK / OTHER.
 *
 * Pure parts live here (state, questions, reading the stored answers); the network call and
 * the spend cap are scripts/people/jev-pulse.mjs. Answers are stored in the private chat DB
 * (jev_pulse_signals), next to jev_chat_signals, never in the app DB.
 */

export const PULSE_JEV_VERSION = 'pulse-jev-3';
export const PULSE_JEV_MODEL = 'typesafe-ai/jev';
/** Gateway input price used for the spend cap (the league_chat step's own figure). */
export const USD_PER_M_TOKENS = 0.042;
/** The daily Jev budget for the pulse (NORTH-STAR: $0.50/day), overridable by env. */
export const DAILY_USD_CAP = 0.5;
const CONTEXT_LINES = 4;

export const PULSE_JEV_QUESTIONS = Object.freeze({
  want_player: {
    type: 'boolean',
    instructions: 'Is the SPEAKER, in the LAST message (>>>), trying to GET a specific player who is on another team? Yes for: '
      + 'asking for him ("gimme X", "can I get X", "would you move X", "what do you want for X"), proposing a trade in which '
      + 'the SPEAKER receives him ("my A for your X", "X for A", "add X and I take it"), naming the player he wants in reply '
      + 'to a question, or answering "me" / "yes" when someone else is shopping a player. No for: rating or comparing players, '
      + 'lineup talk, commenting on someone else\'s trade, or only offering his own players.',
  },
  shop: {
    type: 'boolean',
    instructions: 'Is the SPEAKER, in the LAST message (>>>), offering one of HIS OWN players? Yes for: saying he is available, '
      + 'asking who wants him, taking offers, or proposing or adding him to a trade in which the SPEAKER gives him away '
      + '("my A for your X", "I\'ll throw in A"). No for: only asking for someone else\'s player, or refusing to move his own.',
  },
  urgency: {
    type: 'boolean',
    instructions: 'Does the LAST message (>>>) say the SPEAKER\'s own fantasy team is in trouble and needs a move now: '
      + 'injury panic, a losing streak, "my season is over", "I have to trade", "I need help at a position"?',
  },
  refusal: {
    type: 'boolean',
    instructions: 'Is the SPEAKER, in the LAST message (>>>), turning down a trade offer or idea (a no, a laugh-off, '
      + 'a polite pass, a counter instead, or a stall)?',
  },
});
export const PULSE_JEV_TYPES = Object.freeze({ want_player: 'WANT_PLAYER', shop: 'SHOP', urgency: 'URGENCY', refusal: 'REFUSAL' });

/** Where a player sits relative to the speaker at the message's time. */
export function ownerTag(owner, speakerRoster, nickRoster) {
  if (owner == null) return 'not on a team';
  if (speakerRoster != null && Number(owner) === Number(speakerRoster)) return "on SPEAKER's team";
  if (nickRoster != null && Number(owner) === Number(nickRoster)) return "on NICK's team";
  return 'on another team';
}

/**
 * The Jev state for one message. `msg`: {text, chat_kind}; `context`: the thread's earlier
 * lines, oldest first, [{who: 'SPEAKER'|'NICK'|'OTHER', text}]; `named`: [{name, tag}] for
 * the players named in the message and its context. Text is sent as-is (the league_chat
 * step already sends every message under the retention Nick chose); names of people are not.
 */
export function pulseJevState(msg, context = [], named = []) {
  const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return [
    `Fantasy football league chat (${msg.chat_kind === 'group' ? 'group chat' : 'private DM with NICK'}). SPEAKER wrote the last line.`,
    ...context.slice(-CONTEXT_LINES).map(c => `${c.who}: ${clip(c.text, 240)}`),
    `>>> SPEAKER: ${clip(msg.text, 400)}`,
    named.length ? `Players named above: ${named.map(p => `${p.name} (${p.tag})`).join('; ')}.` : 'Players named above: none resolved.',
  ].join('\n');
}

/** Context lines before a message in its thread, oldest first, as SPEAKER / NICK / OTHER. */
export function threadContext(chat, msg, speakerName) {
  return chat.prepare(`SELECT name, is_from_me, text FROM messages WHERE chat_name = ? AND msg_id < ?
      AND COALESCE(is_tapback, 0) = 0 AND text IS NOT NULL AND length(trim(text)) > 0
      ORDER BY msg_id DESC LIMIT ?`).all(msg.chat_name, msg.msg_id, CONTEXT_LINES).reverse()
    .map(r => ({ who: r.is_from_me ? 'NICK' : r.name === speakerName ? 'SPEAKER' : 'OTHER', text: r.text }));
}

export function ensurePulseJevTables(chat) {
  chat.exec(`CREATE TABLE IF NOT EXISTS jev_pulse_signals (msg_id INTEGER NOT NULL, question TEXT NOT NULL,
    probability REAL, version TEXT NOT NULL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question, version))`);
  chat.exec(`CREATE TABLE IF NOT EXISTS jev_pulse_done (msg_id INTEGER NOT NULL, version TEXT NOT NULL, ok INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1, input_tokens INTEGER, output_tokens INTEGER, usd REAL, error TEXT,
    evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, version))`);
}

/** USD the pulse has spent on Jev on `day` (YYYY-MM-DD, UTC). 0 when nothing is stored yet. */
export function spentOn(chat, day) {
  const has = chat.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jev_pulse_done'`).get();
  if (!has) return 0;
  return Number(chat.prepare(`SELECT COALESCE(SUM(usd), 0) AS u FROM jev_pulse_done WHERE substr(evaluated_at, 1, 10) = ?`)
    .get(day)?.u ?? 0);
}

/**
 * The stored pulse reading of one message: {want_player, shop, urgency, refusal} probabilities,
 * or null when the message has none (not classified yet, failed, or the table is absent).
 */
export function pulseJevFeatures(chat, msgId, version = PULSE_JEV_VERSION) {
  let out;
  try {
    out = chat.prepare('SELECT question, probability FROM jev_pulse_signals WHERE msg_id = ? AND version = ?').all(msgId, version);
  } catch (e) {
    if (/no such table/.test(String(e?.message))) return null;
    throw e;
  }
  if (!out.length) return null;
  return Object.fromEntries(out.map(r => [r.question, Number(r.probability) || 0]));
}
