/**
 * TEST 4 -- narrative salience. Classify every 2016-2025 REG team-game by how the game FELT,
 * from that team's point of view, with team identities stripped so Jev cannot smuggle in prior
 * beliefs about team quality. State is rendered from structured play-by-play, not prose.
 *
 * Usage: set -a; . ./.env.local; set +a; npx tsx scripts/news-line/jev_narrative.mts [--limit N]
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';

const DB = '/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/t4/states.sqlite';
const CONCURRENCY = 8;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 1.5);

const QUESTIONS = {
  narrative: {
    type: 'choice' as const,
    instructions:
      'How did this game FEEL for this team -- the story a fan or a commentator would tell about ' +
      'it the following week? Judge the emotional shape of the result, not who was the better team.',
    criteria: {
      dominant_win: 'A win that was never in doubt; the team controlled the game wire to wire.',
      comfortable_win: 'A clear win, decided before the end, but not a total rout.',
      narrow_win: 'A win that came down to the wire and could easily have gone the other way.',
      heartbreak_loss: 'A loss the team was close to winning, decided late or by a tiny margin.',
      blowout_loss: 'A lopsided loss that was over well before the end.',
      competitive_loss: 'A loss that was contested but settled without late drama.',
      chaotic: 'A wild, back-and-forth game with many swings, hard to characterise as either.',
    },
  },
  memorability: {
    type: 'score' as const,
    instructions:
      'How memorable would this game be to a casual football fan a week later -- how vivid and ' +
      'talked-about is it likely to be?',
    criteria: [
      'Forgettable: nothing about it would stick in anyone\'s mind.',
      'Ordinary: a normal result, discussed briefly and dropped.',
      'Notable: people would bring it up unprompted during the week.',
      'Unforgettable: a genuinely remarkable game people would still be talking about.',
    ],
  },
};
const MEM_LEVELS = ['forgettable', 'ordinary', 'notable', 'unforgettable'];

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=600000');
db.exec(`CREATE TABLE IF NOT EXISTS jev_narrative_signals (
  key TEXT NOT NULL, question TEXT NOT NULL, probability REAL,
  evaluated_at TEXT NOT NULL, PRIMARY KEY (key, question))`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_narrative_top (
  key TEXT PRIMARY KEY, narrative TEXT, narrative_p REAL, mem_mean REAL, evaluated_at TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_narrative_done (
  key TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL,
  input_tokens INTEGER, ok INTEGER, error TEXT)`);

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const rows = db.prepare(`
  SELECT s.key, s.state FROM team_game_state s
  LEFT JOIN jev_narrative_done d ON d.key = s.key
  WHERE d.key IS NULL ORDER BY s.key ${LIMIT ? 'LIMIT ' + LIMIT : ''}`).all() as any[];
console.log(`${rows.length.toLocaleString()} team-games to classify`);

const insSig = db.prepare('INSERT OR REPLACE INTO jev_narrative_signals VALUES (?,?,?,?)');
const insTop = db.prepare('INSERT OR REPLACE INTO jev_narrative_top VALUES (?,?,?,?,?)');
const insDone = db.prepare('INSERT OR REPLACE INTO jev_narrative_done VALUES (?,?,?,?,?)');

let ok = 0, failed = 0, tokens = 0, stop = false, cursor = 0;

async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= rows.length) return;
    const r = rows[i];
    const now = new Date().toISOString();
    try {
      const result = await evaluate({ model: 'typesafe-ai/jev', state: r.state, questions: QUESTIONS });
      const a: any = (result.answers as any);
      const narr = a.narrative, mem = a.memorability;
      for (const [k, pr] of Object.entries((narr?.probabilities ?? {}) as Record<string, number>))
        insSig.run(r.key, `narrative.${k}`, pr as number, now);
      insSig.run(r.key, 'memorability.mean', mem?.score ?? null, now);
      for (const [k, pr] of Object.entries((mem?.probabilities ?? {}) as Record<string, number>))
        insSig.run(r.key, `memorability.${MEM_LEVELS[Number(k)] ?? k}`, pr as number, now);
      insTop.run(r.key, narr?.choice ?? null,
        (narr?.probabilities?.[narr?.choice] ?? null) as any, mem?.score ?? null, now);
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(r.key, now, used, 1, null);
      ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      insDone.run(r.key, now, 0, 0, msg.slice(0, 300));
      failed++;
      if (/authentication|not have access|free tier/i.test(msg)) {
        console.log(`\nSTOPPING: ${msg.slice(0, 200)}`); stop = true; return;
      }
    }
    const done = ok + failed;
    if (done % 250 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      console.log(`  ${done}/${rows.length} ok=${ok} failed=${failed} ${tokens.toLocaleString()} tok (~$${usd.toFixed(4)})`);
      if (usd > MAX_USD) { console.log(`budget $${MAX_USD} reached`); stop = true; return; }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ${ok} classified, ${failed} failed, ${tokens.toLocaleString()} input tokens (~$${((tokens/1e6)*0.042).toFixed(4)})`);
