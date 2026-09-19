/**
 * Classify the league group chat + member DMs with Jev, so manager archetypes can be fit.
 *
 * WHAT THIS IS FOR. The trade engine prices both sides of a deal with OUR model. The edge in a
 * fantasy trade lives in the gap between our valuation and the COUNTERPARTY's, and the best
 * evidence of a counterparty's valuation is what he says: "I'm not moving Bijan for anything" is a
 * stated reservation price; "Kelce is washed" is a sell signal; "easy W this week" is confidence
 * that may or may not be earned. No transaction log carries that.
 *
 * PRIVACY. Source is data/derived/league_chat.sqlite — a gitignored extract of iMessage threads
 * the user is a participant in. Classifies EVERY message — members, Nick's own, and tapback reactions
 * (Nick: "dont skip mine and tapbacks", 2026-09-17). Sent under standard gateway retention by Nick's choice. Results go back
 * into the same private file, never into the repo's tracked databases.
 *
 * WHY JEV. Typed questions with probabilities over thousands of short messages is exactly its
 * shape. It cannot tell us WHICH player a message is about, so the player is pre-extracted here by
 * name match against the app's players table and handed to Jev in the state.
 *
 * Usage: set -a; . ./.env.local; set +a; npx tsx scripts/news-line/jev_league_chat.mts [--limit N]
 */
import { experimental_evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
// Same environment names the extractor uses (scripts/chat/extract_league_chat.py), so a
// test can point both at a fixture instead of the real private extract.
const CHAT_DB = process.env.LEAGUE_CHAT_OUT ?? path.join(REPO, 'data/derived/league_chat.sqlite');
const APP_DB = process.env.GRIDIRON_DB_PATH ?? path.join(REPO, 'server/data.sqlite');
const CONCURRENCY = 8;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 1.0);
// How often one message may be sent before it is given up. A failed row used to be
// parked for good, so a gateway outage lost every row it touched (review-fixes-2,
// finding 3). Mirrored by MAX_CLASSIFY_ATTEMPTS in scripts/chat/extract_league_chat.py,
// which counts exactly the rows this run will re-send.
const MAX_ATTEMPTS = 3;
// Test seam: a module exporting `evaluate`, honoured only under NODE_ENV=test, so the
// retry policy is testable without sending a message anywhere.
const evaluate = process.env.NODE_ENV === 'test' && process.env.JEV_EVALUATE_MODULE
  ? (await import(process.env.JEV_EVALUATE_MODULE)).evaluate as typeof experimental_evaluate
  : experimental_evaluate;

const QUESTIONS = {
  topic: {
    type: 'choice' as const,
    instructions: 'What is the LAST message (marked >>>) mainly about? Use the earlier lines only as context.',
    criteria: {
      trade_talk: 'Proposing, discussing, negotiating or reacting to a fantasy trade.',
      lineup_or_waiver: 'Start/sit decisions, waiver pickups, drops, bye weeks.',
      trash_talk: 'Banter, gloating or ribbing about fantasy results.',
      nfl_news: 'Injury news, depth-chart news, or an NFL event being reported.',
      player_opinion: 'An opinion about how good or bad a specific player is.',
      non_fantasy: 'Not about fantasy football or the NFL at all.',
    },
  },
  confidence: {
    type: 'score' as const,
    instructions: 'How confident or assertive is the speaker of the last message about whatever they are claiming?',
    criteria: [
      'Hedged or uncertain — questions, "maybe", "idk".',
      'Neutral statement of fact or logistics.',
      'Assertive — states an opinion plainly.',
      'Very confident — no hedging, dismisses alternatives.',
      'Overconfident — absolute claims, guarantees, mocking doubt.',
    ],
  },
  tone: {
    type: 'choice' as const,
    instructions: 'What is the tone of the last message?',
    criteria: {
      friendly: 'Warm, collaborative, supportive.',
      competitive: 'Rivalrous, wants to win, but not hostile.',
      dismissive: 'Brushes off the other person or the idea.',
      defensive: 'Justifying their own roster, picks or decisions.',
      joking: 'Primarily humor, sarcasm or memes.',
      neutral: 'Plain and functional.',
    },
  },
  own_roster: {
    type: 'choice' as const,
    instructions: 'Does the last message express feeling about a player on the SPEAKER\'S OWN team?',
    criteria: {
      none: 'No feeling expressed about their own players.',
      complaining: 'Frustrated with or giving up on one of their own players.',
      praising: 'Proud of or attached to one of their own players.',
      untouchable: 'Explicitly says they will not trade a player of theirs.',
    },
  },
  player_sentiment: {
    type: 'score' as const,
    instructions: 'If a MENTIONED PLAYER is given, how does the speaker feel about that player\'s fantasy value? If no player is mentioned, choose the middle level.',
    criteria: [
      'Very negative — washed, bust, drop him.',
      'Negative — disappointed, cooling on him.',
      'Neutral or no player mentioned.',
      'Positive — likes him, buying.',
      'Very positive — elite, untouchable, league-winner.',
    ],
  },
  open_to_trade: {
    type: 'boolean' as const,
    instructions: 'Does the last message signal willingness to make or consider a trade?',
  },
  reacting_to_loss: {
    type: 'boolean' as const,
    instructions: 'Is the last message a reaction to the speaker losing, or to a bad week for their team?',
  },
};
const CONF_LEVELS = ['hedged', 'neutral', 'assertive', 'very_confident', 'overconfident'];
const SENT_LEVELS = ['very_negative', 'negative', 'neutral', 'positive', 'very_positive'];

const chat = new DatabaseSync(CHAT_DB);
chat.exec('PRAGMA busy_timeout=60000');
chat.exec(`CREATE TABLE IF NOT EXISTS jev_chat_signals (
  msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
  question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question))`);
// Every stored row has been attempted at least once, which is what the default says;
// a row written below always carries its true count. The live table predates the
// column, so its 18 parked rows get their remaining retries, not a fresh set.
chat.exec(`CREATE TABLE IF NOT EXISTS jev_chat_done (msg_id INTEGER PRIMARY KEY, evaluated_at TEXT, input_tokens INTEGER, ok INTEGER, error TEXT, attempts INTEGER NOT NULL DEFAULT 1)`);
if (!(chat.prepare('PRAGMA table_info(jev_chat_done)').all() as { name: string }[]).some(c => c.name === 'attempts')) {
  chat.exec('ALTER TABLE jev_chat_done ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1');
}

// Player names for mention pre-extraction.
//
// Three rules, all learned from the first full run (2026-09-17), where "still",
// "early" and "price" were matched to Bryan Still, Quinn Early and Taylor Price
// dozens of times each:
//   1. the pool is players with any usage in the last two seasons, not the whole
//      8,640-row table;
//   2. a bare last name counts only if it is NOT an English word
//      (/usr/share/dict/words) and is >= 5 characters;
//   3. a bare last name counts only if exactly ONE player in the pool has it —
//      "taylor" alone names nobody.
// Full names always count.
const app = new DatabaseSync(APP_DB, { readOnly: true });
const players = app.prepare(`SELECT DISTINCT p.name FROM players p
  WHERE p.position IN ('QB','RB','WR','TE') AND p.name IS NOT NULL
    AND EXISTS (SELECT 1 FROM player_week_usage u WHERE u.player_id = p.id AND u.season >= 2025)`).all() as { name: string }[];
const fullNames = players.map(p => p.name);
let englishWords = new Set<string>();
try { englishWords = new Set(readFileSync('/usr/share/dict/words', 'utf8').split('\n').map(w => w.trim().toLowerCase()).filter(Boolean)); } catch { /* no dictionary: rule 2 is skipped */ }
const lastCount = new Map<string, number>();
for (const n of fullNames) { const last = (n.split(' ').pop() ?? '').toLowerCase(); lastCount.set(last, (lastCount.get(last) ?? 0) + 1); }
const lastNames = new Map<string, string>();
for (const n of fullNames) {
  const last = (n.split(' ').pop() ?? '').toLowerCase();
  if (last.length >= 5 && lastCount.get(last) === 1 && !englishWords.has(last)) lastNames.set(last, n);
}
const lastNameRe = new Map([...lastNames].map(([last, full]) => [new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), full] as const));
function mentioned(text: string): string | null {
  const t = text.toLowerCase();
  for (const n of fullNames) if (t.includes(n.toLowerCase())) return n;
  for (const [re, full] of lastNameRe) if (re.test(t)) return full;
  return null;
}

// --recheck-mentions: recompute the mention for every labeled message; where it
// differs from what the label was produced with, drop that message's rows so
// the normal run re-labels it with the corrected MENTIONED PLAYER line.
if (process.argv.includes('--recheck-mentions')) {
  const labeled = chat.prepare(`SELECT d.msg_id, m.text, (SELECT mentioned_player FROM jev_chat_signals s WHERE s.msg_id = d.msg_id LIMIT 1) AS was
    FROM jev_chat_done d JOIN messages m ON m.msg_id = d.msg_id WHERE d.ok = 1`).all() as any[];
  const del1 = chat.prepare('DELETE FROM jev_chat_signals WHERE msg_id = ?');
  const del2 = chat.prepare('DELETE FROM jev_chat_done WHERE msg_id = ?');
  let changed = 0, cleared = 0, gained = 0;
  for (const r of labeled) {
    const now = mentioned(String(r.text ?? ''));
    if ((now ?? null) === (r.was ?? null)) continue;
    changed++; if (now && !r.was) gained++; if (!now && r.was) cleared++;
    del1.run(r.msg_id); del2.run(r.msg_id);
  }
  console.log(`recheck-mentions: ${labeled.length} labeled, ${changed} changed (${cleared} false mentions cleared, ${gained} mentions gained) — rows dropped for re-labeling; pool ${fullNames.length} players, ${lastNames.size} usable last names`);
  process.exit(0);
}

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
const rows = chat.prepare(`
  SELECT m.msg_id, m.name, m.chat_kind, m.chat_name, m.ts_utc, m.text, m.is_tapback,
         COALESCE(d.attempts, CASE WHEN d.msg_id IS NULL THEN 0 ELSE 1 END) AS attempts
  FROM messages m LEFT JOIN jev_chat_done d ON d.msg_id = m.msg_id
  -- Never sent, or failed with attempts left. extract_league_chat.py#unlabeled_backlog
  -- counts exactly these rows, so the backlog and this query cannot disagree.
  WHERE (d.msg_id IS NULL OR (d.ok = 0 AND COALESCE(d.attempts, 1) < ${MAX_ATTEMPTS}))
    AND m.name IS NOT NULL  -- unnamed = a handle not in participants yet (extract_league_chat.py); never sent
    AND m.text IS NOT NULL AND trim(replace(m.text, char(65532), '')) <> ''  -- 'W', 'L', 'gg', a lone emoji all count; only the bare attachment placeholder is skipped
  ORDER BY m.chat_name, m.ts_utc ${LIMIT ? 'LIMIT ' + LIMIT : ''}`).all() as any[];
const retrying = rows.filter(r => Number(r.attempts) > 0).length;
console.log(`${rows.length.toLocaleString()} messages to classify — everyone incl. Nick, tapbacks included (standard retention)` +
  (retrying ? `; ${retrying} of them a retry of an earlier failure` : ''));

// Context: the two messages before this one in the same thread.
const ctxStmt = chat.prepare(`SELECT name, text FROM messages WHERE chat_name = ? AND ts_utc < ? AND text IS NOT NULL
  AND name IS NOT NULL AND is_tapback = 0 ORDER BY ts_utc DESC LIMIT 2`);
const insSig = chat.prepare('INSERT OR REPLACE INTO jev_chat_signals VALUES (?,?,?,?,?,?,?)');
const insDone = chat.prepare(`INSERT OR REPLACE INTO jev_chat_done
  (msg_id, evaluated_at, input_tokens, ok, error, attempts) VALUES (?,?,?,?,?,?)`);

let ok = 0, failed = 0, gaveUp = 0, tokens = 0, stop = false, cursor = 0;
async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= rows.length) return;
    const r = rows[i];
    const now = new Date().toISOString();
    try {
      const prior = (ctxStmt.all(r.chat_name, r.ts_utc) as any[]).reverse();
      const who = (n: string) => (n === 'ME' ? 'NICK' : 'THEM');
      const player = mentioned(r.text);
      const state = [
        `Fantasy football league chat (${r.chat_kind === 'group' ? 'group chat' : 'private DM with Nick'}).`,
        player ? `MENTIONED PLAYER: ${player}` : 'MENTIONED PLAYER: none',
        ...prior.map(p => `${who(p.name)}: ${String(p.text).slice(0, 240)}`),
        `>>> ${who(r.name)}${r.is_tapback ? ' (TAPBACK REACTION to a quoted message)' : ''}: ${String(r.text).slice(0, 400)}`,
      ].join('\n');
      const result = await evaluate({
        model: 'typesafe-ai/jev', state, questions: QUESTIONS,
        // Nick chose standard retention on 2026-09-17 (ZDR is Pro/Enterprise-only; he declined to
        // upgrade). Re-enable `providerOptions: { gateway: { zeroDataRetention: true } }` on a paid plan.
      });
      for (const [q, a] of Object.entries(result.answers as Record<string, any>)) {
        if (!a) continue;
        if (a.type === 'boolean') { insSig.run(r.msg_id, r.name, r.chat_kind, player, q, a.probability ?? null, now); continue; }
        if (a.type === 'score') insSig.run(r.msg_id, r.name, r.chat_kind, player, `${q}.mean`, a.score ?? null, now);
        if (a.type === 'choice' && typeof a.choice === 'string') insSig.run(r.msg_id, r.name, r.chat_kind, player, `${q}.argmax:${a.choice}`, 1, now);
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>)) {
          const levels = q === 'confidence' ? CONF_LEVELS : q === 'player_sentiment' ? SENT_LEVELS : null;
          const name = a.type === 'score' && levels ? (levels[Number(k)] ?? k) : k;
          insSig.run(r.msg_id, r.name, r.chat_kind, player, `${q}.${name}`, pr as number, now);
        }
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used; insDone.run(r.msg_id, now, used, 1, null, Number(r.attempts) + 1); ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const attempts = Number(r.attempts) + 1;
      insDone.run(r.msg_id, now, 0, 0, msg.slice(0, 300), attempts); failed++;
      if (attempts >= MAX_ATTEMPTS) gaveUp++;
      if (/authentication|not have access|free tier/i.test(msg)) { console.log(`\nSTOPPING: ${msg.slice(0, 160)}`); stop = true; return; }
    }
    const done = ok + failed;
    if (done % 500 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      console.log(`  ${done}/${rows.length}  ok=${ok} failed=${failed}  ${tokens.toLocaleString()} tok (~$${usd.toFixed(3)})`);
      if (usd > MAX_USD) { console.log(`budget $${MAX_USD} reached`); stop = true; return; }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ${ok} classified, ${failed} failed` +
  (gaveUp ? `, gave up on ${gaveUp} after ${MAX_ATTEMPTS} attempts` : failed ? ' (retried next run)' : '') +
  `, ${tokens.toLocaleString()} input tokens (~$${((tokens / 1e6) * 0.042).toFixed(3)})`);
// Giving up on a message is the one thing here that cannot be undone by the next tick,
// so it is the one thing that fails the run. A failure with attempts left is reported
// and retried; the outstanding count is printed every tick by extract_league_chat.py.
if (gaveUp) process.exit(2);
