/**
 * TEST 2: garbage-time detection as a STATE judgement.
 *
 * Jev scores state. A play's game state is fully described by (quarter, clock, score differential,
 * down, distance) -- and there are only ~6,300 distinct coarse states behind 360,000 pass/rush
 * plays. So we label the STATE SPACE once, not every play, and join labels back to every play.
 * Complete coverage, ~6k calls instead of 360k.
 *
 * Usage: set -a; . ./.env.local; set +a; npx tsx scripts/news-line/jev_garbage_time.mts
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const NFLV = path.join(REPO, 'data/line-history/nflverse.sqlite');
const OUT = process.env.GT_OUT ?? '/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/t2/gt_labels.sqlite';
const CONCURRENCY = 8;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 3.0);

const QUESTIONS = {
  garbage_time: {
    type: 'boolean' as const,
    instructions:
      'Is this snap garbage time? Garbage time means the result of the game is effectively ' +
      'decided and the two teams are playing it out rather than competing: the trailing team ' +
      'cannot realistically come back, the leading team is protecting the clock or resting ' +
      'starters, and yards gained here do not reflect either team true quality.',
  },
  competitive_intensity: {
    type: 'score' as const,
    instructions:
      'How hard are both teams still competing for the win at this snap?',
    criteria: [
      'Fully decided: the outcome is certain, both sides are running out the clock, backups are in.',
      'Largely decided: one side is coasting and the other is in empty comeback mode.',
      'One side is clearly coasting but the result is not yet formally out of reach.',
      'Competitive but tilted: one team is favoured and playing conservatively, both still trying.',
      'Fully contested: the outcome is genuinely in doubt and both teams are playing to win.',
    ],
  },
};
const LEVELS = ['decided', 'largely_decided', 'coasting', 'tilted', 'contested'];

const src = new DatabaseSync(`file:${NFLV}?mode=ro`, { readOnly: true } as any);
const db = new DatabaseSync(OUT);
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS jev_state_labels (
  state_key TEXT NOT NULL, question TEXT NOT NULL, value REAL,
  evaluated_at TEXT NOT NULL, PRIMARY KEY (state_key, question))`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_state_done (
  state_key TEXT PRIMARY KEY, n_plays INTEGER, prompt TEXT,
  evaluated_at TEXT, input_tokens INTEGER, ok INTEGER, error TEXT)`);

// The bucket definition. MUST be kept byte-identical in the feature-rebuild script.
const BUCKETS = `
  CAST(MIN(qtr,5) AS INT) AS q,
  CAST(CAST(quarter_seconds_remaining/120 AS INT) AS INT) AS tb,
  CAST(MAX(-9,MIN(9, CAST(score_differential/4.0 AS INT))) AS INT) AS sd,
  CAST(COALESCE(down,0) AS INT) AS dn,
  CASE WHEN down IS NULL THEN 0 WHEN ydstogo<=3 THEN 1 WHEN ydstogo<=7 THEN 2
       WHEN ydstogo<=15 THEN 3 ELSE 4 END AS yb`;

const states = src.prepare(`
  WITH b AS (SELECT ${BUCKETS} FROM play_by_play
    WHERE season BETWEEN 2016 AND 2025 AND play=1 AND (pass=1 OR rush=1)
      AND score_differential IS NOT NULL AND qtr IS NOT NULL AND quarter_seconds_remaining IS NOT NULL)
  SELECT q,tb,sd,dn,yb, COUNT(*) n FROM b GROUP BY q,tb,sd,dn,yb ORDER BY n DESC`).all() as any[];

function key(r: any) { return `${r.q}|${r.tb}|${r.sd}|${r.dn}|${r.yb}`; }

// Render a bucket as one concrete, representative game state in plain English.
function render(r: any): string {
  const q = Number(r.q), tb = Number(r.tb), sd = Number(r.sd), dn = Number(r.dn), yb = Number(r.yb);
  // clock: midpoint of the 2-minute bucket
  const secs = Math.min(q === 5 ? 600 : 900, tb * 120 + 60);
  const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');
  const qname = q === 5 ? 'overtime' : `Q${q}`;
  // game clock remaining overall
  const gameSecs = q === 5 ? secs : secs + (4 - q) * 900;
  // Score-diff midpoint. SQLite CAST truncates toward zero, so sd=0 covers -3..+3,
  // sd=+1 covers +4..+7 and sd=-1 covers -4..-7. Midpoints must be signed accordingly.
  const diff = sd > 0 ? 4 * sd + 2 : sd < 0 ? 4 * sd - 2 : 0;
  const dclip = Math.abs(sd) === 9 ? (sd > 0 ? 38 : -38) : diff;
  const scoreTxt = dclip === 0 ? 'The game is tied.'
    : dclip > 0 ? `The team with the ball leads by about ${dclip} points.`
      : `The team with the ball trails by about ${-dclip} points.`;
  const ydsMid = [0, 2, 5, 11, 18][yb];
  const ddTxt = dn === 0 ? 'Down and distance are not applicable.'
    : `It is ${['', '1st', '2nd', '3rd', '4th'][dn]} and ${ydsMid}.`;
  const timeTxt = q === 5
    ? `Overtime, ${mm}:${ss} left in the overtime period.`
    : `${qname}, ${mm}:${ss} left in the quarter (about ${Math.round(gameSecs / 60)} minutes left in regulation).`;
  return `NFL game, a single offensive snap. ${timeTxt} ${scoreTxt} ${ddTxt}`;
}

const doneSet = new Set((db.prepare('SELECT state_key FROM jev_state_done WHERE ok=1').all() as any[]).map(r => r.state_key));
const todo = states.filter(r => !doneSet.has(key(r)));
console.log(`${states.length} distinct states, ${todo.length} to label ` +
  `(covering ${states.reduce((a, r) => a + Number(r.n), 0).toLocaleString()} plays)`);
console.log('EXAMPLE PROMPT:', render(states[0]));
console.log('EXAMPLE PROMPT:', render(states.find(r => Number(r.sd) <= -7 && Number(r.q) === 4) ?? states[1]));

const insL = db.prepare('INSERT OR REPLACE INTO jev_state_labels VALUES (?,?,?,?)');
const insD = db.prepare('INSERT OR REPLACE INTO jev_state_done VALUES (?,?,?,?,?,?,?)');

let ok = 0, failed = 0, tokens = 0, stop = false, cursor = 0;
async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= todo.length) return;
    const r = todo[i]; const k = key(r); const prompt = render(r);
    const now = new Date().toISOString();
    try {
      const res: any = await evaluate({ model: 'typesafe-ai/jev', state: prompt, questions: QUESTIONS });
      const a = res.answers as Record<string, any>;
      if (a.garbage_time) insL.run(k, 'garbage_time', a.garbage_time.probability ?? null, now);
      if (a.competitive_intensity) {
        insL.run(k, 'intensity.mean', a.competitive_intensity.score ?? null, now);
        for (const [lv, p] of Object.entries((a.competitive_intensity.probabilities ?? {}) as Record<string, number>))
          insL.run(k, `intensity.${LEVELS[Number(lv)] ?? lv}`, p as number, now);
      }
      const used = res.usage?.inputTokens ?? 0; tokens += used;
      insD.run(k, Number(r.n), prompt, now, used, 1, null);
      ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      insD.run(k, Number(r.n), prompt, now, 0, 0, msg.slice(0, 300)); failed++;
      if (/authentication|not have access|free tier|401|403/i.test(msg)) {
        console.log(`\nSTOPPING: ${msg.slice(0, 200)}`); stop = true; return;
      }
    }
    const d = ok + failed;
    if (d % 200 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      console.log(`  ${d}/${todo.length} ok=${ok} failed=${failed} ${tokens.toLocaleString()} tok ~$${usd.toFixed(4)}`);
      if (usd > MAX_USD) { console.log('budget reached'); stop = true; return; }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ok=${ok} failed=${failed} tokens=${tokens.toLocaleString()} ~$${((tokens / 1e6) * 0.042).toFixed(4)}`);
