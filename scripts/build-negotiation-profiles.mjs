#!/usr/bin/env node
/**
 * Per-manager negotiation profiles, read by a model rather than by thresholds.
 *
 * Nick, 2026-09-17: "each person's techniques and behavioural stats read
 * differently — make sure we are using an AI model for this. It should be
 * trained on negotiation techniques, actual conversations, and fantasy football
 * talk."
 *
 * He is pointing at a real defect. Everything the counterparty layer does so far
 * is a fixed threshold on an aggregate: sentiment >= 2.3 is "praise", a gap of
 * 3 points a game is "hot". Those cutoffs are the same for all ten people, and
 * people are not the same. One manager calls everyone on his roster a league
 * winner; for him praise carries no information at all. Another says "he's
 * fine" about a player he would not trade for anything. A single scale cannot
 * read both, and averaging over their messages destroys exactly the signal that
 * distinguishes them.
 *
 * So this reads each manager's ACTUAL messages — the trade-relevant ones, in
 * conversation order, with the surrounding thread — and asks Claude for the
 * things a threshold cannot produce:
 *
 *   - how this person says no, and whether his no means no
 *   - what his praise is FOR: belief, or a case being built before a sale
 *   - the techniques he actually uses, quoted, not guessed at
 *   - the calibration: on his personal scale, what counts as enthusiasm
 *
 * Output goes to `negotiation_profiles` in the private chat DB and is consumed
 * by the counterparty layer, which prefers a model read over its own threshold
 * wherever one exists.
 *
 * Cost control (Nick: "for API stuff keep it low"): only trade-relevant
 * messages are sent, capped per manager; the run is idempotent and skips
 * managers whose message set has not changed since the last profile.
 *
 * Usage: node --env-file-if-exists=.env scripts/build-negotiation-profiles.mjs [--manager NAME] [--dry-run]
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_DB = path.join(ROOT, 'data/derived/league_chat.sqlite');
const DRY = process.argv.includes('--dry-run');
const onlyIdx = process.argv.indexOf('--manager');
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;
/** Enough conversation to read a style; beyond this it is repetition we pay for. */
const MAX_MESSAGES = 160;
const CONTEXT_BEFORE = 2;

const chat = new DatabaseSync(CHAT_DB);
chat.exec('PRAGMA busy_timeout=60000');
chat.exec(`CREATE TABLE IF NOT EXISTS negotiation_profiles (
  name TEXT PRIMARY KEY, profile_json TEXT NOT NULL, messages_read INTEGER,
  corpus_hash TEXT, model TEXT, built_at TEXT NOT NULL)`);

/**
 * The messages worth reading: anything about a trade, a player opinion, an
 * openness signal, or a refusal — plus the couple of messages before each, so
 * the model sees what he was responding to. A refusal without its question is
 * unreadable.
 */
function corpusFor(name) {
  const anchors = chat.prepare(`
    SELECT DISTINCT m.msg_id, m.chat_kind, m.chat_name, m.ts_utc
    FROM messages m JOIN jev_chat_signals s ON s.msg_id = m.msg_id
    WHERE m.name = ? AND (
      s.question = 'topic.argmax:trade_talk' OR s.question = 'topic.argmax:player_opinion'
      OR (s.question = 'open_to_trade' AND s.probability > 0.45)
      OR (s.question = 'own_roster.untouchable' AND s.probability > 0.4))
    ORDER BY m.ts_utc DESC LIMIT ?`).all(name, MAX_MESSAGES);
  if (!anchors.length) return [];
  const ctx = chat.prepare(`SELECT name, ts_utc, text FROM messages
    WHERE chat_name = ? AND ts_utc < ? AND text IS NOT NULL
      AND trim(replace(text, char(65532), '')) <> ''
    ORDER BY ts_utc DESC LIMIT ?`);
  const getMsg = chat.prepare('SELECT name, ts_utc, text, chat_kind, chat_name FROM messages WHERE msg_id = ?');
  const seen = new Set();
  const out = [];
  for (const a of anchors.slice().reverse()) {
    for (const c of ctx.all(a.chat_name, a.ts_utc, CONTEXT_BEFORE).reverse()) {
      const k = `${c.ts_utc}|${c.name}`;
      if (seen.has(k)) continue; seen.add(k);
      out.push({ who: c.name === 'ME' ? 'NICK' : c.name, at: c.ts_utc, text: c.text, ctx: true });
    }
    const m = getMsg.get(a.msg_id);
    const k = `${m.ts_utc}|${m.name}`;
    if (seen.has(k)) continue; seen.add(k);
    out.push({ who: m.name, at: m.ts_utc, text: m.text, where: m.chat_kind === 'group' ? 'GROUP' : 'DM' });
  }
  return out;
}

const PROFILE_TOOL = {
  name: 'record_negotiation_profile',
  description: 'Record the negotiating profile of one league member, grounded in their messages and the numbers.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'one sentence a leaguemate would recognise him from' },
      says_no: {
        type: 'object',
        properties: {
          how: { type: 'string' },
          hard_no_looks_like: { type: 'array', items: { type: 'string' } },
          soft_no_looks_like: { type: 'array', items: { type: 'string' } },
          does_his_no_hold: { type: 'string', enum: ['yes', 'usually', 'rarely', 'unknown'] },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['how', 'does_his_no_hold', 'evidence'],
      },
      praise_means: {
        type: 'object',
        properties: {
          reading: { type: 'string', enum: ['belief', 'marketing', 'habit', 'mixed', 'unknown'] },
          why: { type: 'string' },
          hypes_before_selling: { type: 'boolean' },
          agrees_with_numbers: { type: 'string', description: 'does his enthusiasm track the usage data he was shown, or run against it' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['reading', 'why', 'evidence'],
      },
      techniques: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            how_he_does_it: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
            how_often: { type: 'string', enum: ['often', 'sometimes', 'once'] },
          },
          required: ['name', 'how_he_does_it', 'how_often'],
        },
      },
      calibration: {
        type: 'object',
        properties: {
          enthusiasm_scale: { type: 'string' },
          baseline_tone: { type: 'string' },
          inflation: { type: 'string', enum: ['none', 'mild', 'heavy', 'unknown'] },
        },
        required: ['enthusiasm_scale', 'inflation'],
      },
      roster_read: {
        type: 'object',
        properties: {
          really_untouchable: { type: 'array', items: { type: 'string' }, description: 'players he would genuinely not move' },
          quietly_available: { type: 'array', items: { type: 'string' }, description: 'players the talk or the numbers say he would move' },
          overvalues: { type: 'array', items: { type: 'string' } },
          undervalues: { type: 'array', items: { type: 'string' } },
          reasoning: { type: 'string', description: 'tie the names to both the messages and the numbers' },
        },
      },
      what_moves_him: { type: 'array', items: { type: 'string' } },
      what_shuts_him_down: { type: 'array', items: { type: 'string' } },
      how_to_approach: { type: 'string' },
      best_bait: { type: 'string', description: 'which of NICK\'s players is the most effective thing to dangle, and why' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      caveats: { type: 'array', items: { type: 'string' } },
    },
    required: ['headline', 'says_no', 'praise_means', 'techniques', 'calibration',
      'what_moves_him', 'how_to_approach', 'confidence', 'caveats'],
  },
};

const SYSTEM = `You analyse negotiation behaviour in fantasy-football league chats.

You are reading real messages between friends in a 10-team ESPN redraft league. Your job is to
profile ONE person's negotiating style so a trade tool can approach him the way he actually
responds, rather than with generic advice.

Ground every claim in the messages. Quote them. If the corpus does not support a claim, say so in
"caveats" rather than inventing a plausible-sounding read — a confident wrong profile is worse than
an honest thin one, because it will be acted on.

Pay particular attention to the distinction that generic sentiment scoring gets wrong: praise for a
player has two opposite causes. A manager may rate a player and not want to move him, or may be
building a case before shopping him. Look for the tell — does the praise arrive unprompted, near
trade talk, or paired with an opening to deal? Does he praise players he then offers?

Also calibrate to HIM. Some people call everyone a league winner, so their praise carries no
information; others are flat about players they would never trade. State his baseline.

These are friends talking. Read the register accurately: trash talk between friends is not
hostility, and a joke refusal is not a hard no.

You are given BOTH his messages AND the numbers: his roster with our projections and market
values, how each player is performing against what his usage actually earns (expected fantasy
points vs actual — a player far above that line is the classic sell-high profile), his measured
chat behaviour, his record of declaring players untouchable and then reopening them, and his
transaction history. Use them together. The messages tell you what he says; the numbers tell you
whether to believe it. Where they disagree, say so explicitly — that disagreement is the single
most valuable thing in this profile.

Record your answer with the record_negotiation_profile tool.`;

const { callClaude } = await import('../server/services/claude.js');
const { rows: appRows } = await import('../server/db/index.js');
const { expectationGaps } = await import('../server/services/talk-vs-model.js');
const { managerSignalsFor } = await import('../server/services/manager-signals.js');
const { declarationCredibility } = await import('../server/services/bluff-detector.js');
const { assetUniverse, tradeWeekContext } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

const LEAGUE_ID = 4;
const weekNow = tradeWeekContext();
const gaps = expectationGaps(weekNow.season, weekNow.week);
const signals = managerSignalsFor(LEAGUE_ID);
const credibility = declarationCredibility();
const identity = new Map(appRows(
  `SELECT chat_name, roster_id, espn_name, team_name FROM league_member_identity
   WHERE league_id = ? AND chat_name IS NOT NULL`, LEAGUE_ID).map(r => [r.chat_name, r]));
const leagueRow = appRows('SELECT * FROM leagues WHERE id = ?', LEAGUE_ID)[0];
const payload = JSON.parse(leagueRow.payload);
// Our own valuation and projection for every player, so the model sees what we
// think a name is worth next to what he says about it. assetUniverse returns a
// Map of player id -> priced asset, with a `context` property hung off it.
const assets = assetUniverse(leagueRow, deriveFormat(leagueRow).formatKey);
const assetByName = new Map();
for (const a of assets.values()) if (a?.name) assetByName.set(String(a.name).toLowerCase(), a);

function rosterPacket(rosterId) {
  const team = (payload.teams ?? []).find(t => String(t.id) === String(rosterId));
  if (!team) return null;
  return (team.roster?.entries ?? []).map(e => {
    const pl = e.playerPoolEntry?.player ?? {};
    const nm = pl.fullName ?? '';
    const g = gaps.get(nm.toLowerCase());
    const a = assetByName.get(nm.toLowerCase());
    return {
      player: nm,
      pos: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'][pl.defaultPositionId - 1] ?? '?',
      our_ppg: a?.adj_ppg != null ? +a.adj_ppg.toFixed(1) : null,
      our_value: a?.value != null ? Math.round(a.value) : null,
      expected_pts_per_game: g?.xfp_per_game ?? null,
      actual_pts_per_game: g?.actual_per_game ?? null,
      above_expectation: g?.gap_per_game ?? null,
      injury: pl.injuryStatus && pl.injuryStatus !== 'ACTIVE' ? pl.injuryStatus : null,
      acquired: e.acquisitionType ?? null,
      starting: e.lineupSlotId !== 20 && e.lineupSlotId !== 21,
    };
  }).filter(p => p.player);
}

function statsPacket(name) {
  const id = identity.get(name);
  if (!id) return null;
  const s = signals.get(String(id.roster_id));
  const cred = credibility?.byManager?.get(name) ?? null;
  const tx = appRows(`SELECT type, status, COUNT(*) n FROM league_transactions_raw
                      WHERE league_id = ? AND team_id = ? GROUP BY type, status`, LEAGUE_ID, Number(id.roster_id));
  return {
    espn_name: id.espn_name, team: id.team_name, roster_id: id.roster_id,
    his_roster: rosterPacket(id.roster_id),
    nicks_roster: rosterPacket(String(leagueRow.my_team_id ?? 5)),
    measured_chat_behaviour: s ? Object.fromEntries(Object.entries(s.metrics)
      .filter(([k]) => k.startsWith('chat_')).map(([k, v]) => [k, v])) : null,
    his_opinions_on_players: s?.players
      ? [...s.players].map(([pn, v]) => ({ player: pn, sentiment_0to4: v.sentiment, mentions: v.n, last: v.last }))
        .sort((a, b) => b.mentions - a.mentions).slice(0, 18)
      : [],
    declaration_record: cred
      ? { declarations: cred.declarations, reversed_outright: cred.hard_reversals,
        hedged_in_same_message: cred.hedged, held: cred.held,
        credibility_0to1: cred.credibility, note: 'a reversal is him calling a player untouchable and reopening him within 10 days' }
      : null,
    transactions_last_3_days: tx,
  };
}

const names = ONLY ? [ONLY] : chat.prepare(
  `SELECT DISTINCT name FROM messages WHERE name <> 'ME' ORDER BY name`).all().map(r => r.name);

let built = 0, skipped = 0, failed = 0, tokensIn = 0, tokensOut = 0;
for (const name of names) {
  const corpus = corpusFor(name);
  if (corpus.length < 12) { console.log(`${name}: only ${corpus.length} readable messages — skipped`); skipped++; continue; }
  const hash = crypto.createHash('sha1')
    .update(corpus.map(c => `${c.at}|${c.who}|${c.text}`).join('\n')).digest('hex').slice(0, 16);
  const prior = chat.prepare('SELECT corpus_hash FROM negotiation_profiles WHERE name = ?').get(name);
  if (prior?.corpus_hash === hash) { console.log(`${name}: unchanged since last profile — skipped`); skipped++; continue; }

  const transcript = corpus.map(c =>
    `[${c.at.slice(0, 16)}${c.where ? ' ' + c.where : ''}] ${c.who === name ? 'HIM' : c.who}: ${String(c.text).slice(0, 260)}`
  ).join('\n');
  const stats = statsPacket(name);
  const prompt = `Profile the negotiating style of ${name} (referred to as HIM below).
NICK is the person running the trade tool. Other names are other league members.

=== THE NUMBERS ===
${stats ? JSON.stringify(stats, null, 1) : 'no roster mapping for this person'}

Reading guide for the numbers:
- our_ppg / our_value are OUR model's projection and trade value.
- expected_pts_per_game is what his usage earns; actual_pts_per_game is what he scored.
  above_expectation is the difference. Strongly positive means he is outscoring his usage,
  which regresses — the classic profile of a player someone talks up before shopping him.
- sentiment_0to4 is how he talks about that player (2 is neutral).
- declaration_record is how often his "untouchable" has actually held.

=== HIS MESSAGES (${corpus.length}, oldest first, with what he was replying to) ===
${transcript}`;

  if (DRY) { console.log(`${name}: would send ${corpus.length} messages, ~${Math.round(prompt.length / 4)} tokens`); continue; }
  try {
    const msg = await callClaude({
      feature: 'negotiation_profile', model: 'claude-sonnet-5', maxTokens: 8000,
      system: SYSTEM, prompt,
      // Tool use rather than "return JSON": free-form JSON truncated mid-string
      // on 8 of 9 managers, which is a parse failure that looks like a model
      // failure. A forced tool call is validated at the API boundary.
      tools: [PROFILE_TOOL],
      toolChoice: { type: 'tool', name: PROFILE_TOOL.name, disable_parallel_tool_use: true },
    });
    const block = msg.content?.find(c => c.type === 'tool_use' && c.name === PROFILE_TOOL.name);
    if (!block?.input) throw new Error('model did not call the profile tool');
    const profile = block.input;
    // A tool call that hits the output cap comes back as a PARTIAL object: the
    // nested keys arrive flattened at the root and the sections we actually use
    // are undefined. That parses cleanly and is worthless, so check the shape
    // rather than trusting that it parsed. `stop_reason: 'max_tokens'` is the
    // other half of the same signal.
    const missing = ['headline', 'says_no', 'praise_means', 'techniques', 'calibration', 'how_to_approach']
      .filter(k => profile[k] == null);
    if (missing.length || msg.stop_reason === 'max_tokens') {
      throw new Error(`incomplete profile (stop=${msg.stop_reason}, missing: ${missing.join(',') || 'none'})`);
    }
    chat.prepare(`INSERT OR REPLACE INTO negotiation_profiles
      (name, profile_json, messages_read, corpus_hash, model, built_at)
      VALUES (?,?,?,?,?,datetime('now'))`)
      .run(name, JSON.stringify(profile), corpus.length, hash, 'claude-sonnet-5');
    tokensIn += msg.usage?.input_tokens ?? 0; tokensOut += msg.usage?.output_tokens ?? 0;
    built++;
    console.log(`${name}: profiled from ${corpus.length} messages — ${profile.headline ?? ''}`);
  } catch (e) {
    failed++; console.log(`${name}: FAILED ${String(e?.message ?? e).slice(0, 160)}`);
  }
}
console.log(`\nbuilt ${built}, skipped ${skipped}, failed ${failed} | tokens in ${tokensIn.toLocaleString()} out ${tokensOut.toLocaleString()}`);
process.exit(failed && !built ? 1 : 0);
