/**
 * TEST 1 -- LUCK VERSUS SKILL, PLAY BY PLAY.
 *
 * Score every resolved turnover / fumble event in espn_plays on a LUCK axis with Jev.
 * The distinction that matters -- a tipped ball falling into a linebacker's lap versus a corner
 * reading the route and undercutting it -- lives only in the play text. No SQL predicate has it.
 *
 * Writes to a SEPARATE sqlite in the scratchpad so the read-only collectors are never contended.
 *
 * Usage: set -a; . ./.env.local; set +a; npx --yes tsx scripts/news-line/jev_luck_plays.mts [--limit N]
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DIR = '/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/luck';
const OUT = `${DIR}/jev_luck.sqlite`;
const CONCURRENCY = 8;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 3.0);

const QUESTIONS = {
  // THE feature. Ordered, so the fractional mean is a usable continuous luck weight.
  luck: {
    type: 'score' as const,
    instructions:
      'On this football play the ball changed hands, or was fumbled and recovered. How much did ' +
      'CHANCE, as opposed to deliberate skill and execution by the player who ended up with the ' +
      'ball, determine who came away with it? Judge only the play described.',
    criteria: [
      'Entirely earned by execution: a cleanly read and cleanly caught interception, a deliberate stripped ball recovered at once, a clearly beaten and punished throw.',
      'Mostly earned: good technique or pressure created the ball, with only a small element of circumstance.',
      'A genuine mix of good play and good fortune.',
      'Mostly fortunate: the ball was loose or misdirected for reasons largely outside the recovering player\'s control, and he happened to be there.',
      'Almost entirely fortunate: a tipped or deflected ball, a wild bounce, a muffed or aborted snap, a ball off a receiver\'s hands, a scramble pile that could have gone either way.',
    ],
  },
  // Validation anchor #1: compare against the structured espn_plays.type / my parsed kind.
  event_kind: {
    type: 'choice' as const,
    instructions: 'What happened to the football on this play? Pick the single best description.',
    criteria: {
      interception: 'A forward pass was intercepted by the defense.',
      fumble_lost: 'The ball was fumbled and recovered by the opposing team.',
      fumble_kept: 'The ball was fumbled but recovered by the team that fumbled it.',
      no_turnover: 'The ball did not come loose and was not intercepted.',
    },
  },
  // Validation anchor #2: a fact stated literally in the text when present, so a regex can check it.
  deflected: {
    type: 'boolean' as const,
    instructions:
      'Does the description say the ball was tipped, deflected, batted, or came off a player\'s ' +
      'hands or body before it was caught or recovered?',
  },
};

const LEVELS = ['all_skill', 'mostly_skill', 'mixed', 'mostly_luck', 'all_luck'];

const events = JSON.parse(fs.readFileSync(`${DIR}/events.json`, 'utf8')) as any[];

const db = new DatabaseSync(OUT);
db.exec('PRAGMA busy_timeout=600000');
db.exec(`CREATE TABLE IF NOT EXISTS jev_luck (
  key TEXT NOT NULL, question TEXT NOT NULL, value REAL, PRIMARY KEY (key, question))`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_luck_done (
  key TEXT PRIMARY KEY, evaluated_at TEXT, input_tokens INTEGER, ok INTEGER, error TEXT)`);

const done = new Set<string>(
  (db.prepare('SELECT key FROM jev_luck_done WHERE ok=1').all() as any[]).map(r => String(r.key)));

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

let rows = events.filter(e => !done.has(`${e.event_id}|${e.play_id}`));
if (LIMIT) rows = rows.slice(0, LIMIT);
console.log(`${rows.length.toLocaleString()} plays to score (${done.size.toLocaleString()} already done)`);

const insSig = db.prepare('INSERT OR REPLACE INTO jev_luck VALUES (?,?,?)');
const insDone = db.prepare('INSERT OR REPLACE INTO jev_luck_done VALUES (?,?,?,?,?)');

let ok = 0, failed = 0, tokens = 0, stop = false, cursor = 0;

function stateOf(e: any) {
  const dd = e.down ? `${e.down} and ${e.dist}` : '';
  return `NFL play, Q${e.period ?? '?'} ${e.clock ?? ''}${dd ? ', ' + dd : ''}: ${e.text}`;
}

async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= rows.length) return;
    const e = rows[i];
    const key = `${e.event_id}|${e.play_id}`;
    const now = new Date().toISOString();
    try {
      const result = await evaluate({ model: 'typesafe-ai/jev', state: stateOf(e), questions: QUESTIONS });
      for (const [q, a] of Object.entries(result.answers as Record<string, any>)) {
        if (!a) continue;
        if (a.type === 'boolean') { insSig.run(key, q, a.probability ?? null); continue; }
        if (a.type === 'score') insSig.run(key, `${q}.mean`, a.score ?? null);
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>)) {
          const name = a.type === 'score' ? (LEVELS[Number(k)] ?? k) : k;
          insSig.run(key, `${q}.${name}`, pr as number);
        }
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(key, now, used, 1, null);
      ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      insDone.run(key, now, 0, 0, msg.slice(0, 300));
      failed++;
      if (/authentication|not have access|free tier/i.test(msg)) {
        console.log(`\nSTOPPING: ${msg.slice(0, 200)}`); stop = true; return;
      }
    }
    const d = ok + failed;
    if (d % 250 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      console.log(`  ${d}/${rows.length} ok=${ok} failed=${failed} ${tokens.toLocaleString()} tok (~$${usd.toFixed(4)})`);
      if (usd > MAX_USD) { console.log(`budget $${MAX_USD} reached`); stop = true; return; }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ${ok} scored, ${failed} failed, ${tokens.toLocaleString()} input tokens (~$${((tokens/1e6)*0.042).toFixed(4)})`);
