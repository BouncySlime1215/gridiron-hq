/**
 * TEST 3 -- Jev-score every 4th-down decision 2016-2025 for AGGRESSION and QUALITY.
 *
 * Why Jev and not a go-rate: a raw go-for-it rate does not know that punting on 4th-and-1 from the
 * opponent 38 while down 10 in the 4th is maximally conservative, while punting on 4th-and-14 from
 * your own 12 is simply conventional. Jev normalises the decision AGAINST THE SITUATION, which is
 * exactly the judgement no SQL predicate expresses.
 *
 * Reads nflverse.sqlite READ-ONLY. Writes labels to a separate scratch db.
 * Usage: set -a; . ./.env.local; set +a; npx tsx scripts/news-line/jev_coach_decisions.mts [--limit N]
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';

const SRC = '/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/nflverse.sqlite';
const OUT = process.env.JEV_OUT ?? '/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/coach_decisions.sqlite';
const CONCURRENCY = Number(process.env.JEV_CONC ?? 32);
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 3.0);

const AGG_LEVELS = ['max_conservative', 'conservative', 'conventional', 'aggressive', 'max_aggressive'];
const QUAL_LEVELS = ['clearly_wrong', 'defensible', 'clearly_correct'];

const QUESTIONS = {
  decision_aggression: {
    type: 'score' as const,
    instructions:
      'Judge ONLY how aggressive or risk-taking this fourth-down decision was, GIVEN the down, ' +
      'distance, field position, score margin and time remaining described. Aggression means ' +
      'choosing to keep possession and play for the larger payoff (going for it, a long field ' +
      'goal, a fake) rather than surrendering possession or taking the safe points. Conventional ' +
      'means what a typical NFL head coach would do in exactly this situation. Judge the choice ' +
      'itself, not whether it worked.',
    criteria: [
      'Maximally conservative: the coach gave up possession or took the safe option in a spot where almost no one would, given the distance, field position, score and clock.',
      'Conservative: safer than the typical NFL coach would be in this exact situation.',
      'Conventional: exactly what a typical NFL head coach does in this situation.',
      'Aggressive: more risk-taking than the typical NFL coach would be in this exact situation.',
      'Maximally aggressive: the coach kept possession or played for the big payoff in a spot where almost no one would.',
    ],
  },
  decision_quality: {
    type: 'score' as const,
    instructions:
      'Judge whether this fourth-down decision was the RIGHT call to maximise the chance of ' +
      'winning the game, using only the information available before the play ran. Ignore ' +
      'entirely whether the play succeeded or failed -- a correct decision that failed is still ' +
      'correct, and a bad decision that worked is still bad.',
    criteria: [
      'Clearly wrong: the decision measurably lowered this team\'s chance of winning versus the obvious alternative.',
      'Defensible: reasonable coaches could disagree; the alternatives are close in value.',
      'Clearly correct: the decision measurably raised this team\'s chance of winning versus the alternative.',
    ],
  },
  went_for_it: {
    type: 'boolean' as const,
    instructions:
      'Did the offense run an ordinary offensive play (a pass or a run) to try to gain the first ' +
      'down or score, rather than punting or attempting a field goal?',
  },
};

const src = new DatabaseSync(`file:${SRC}?mode=ro`, { readOnly: true } as any);
const db = new DatabaseSync(OUT);
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS jev_decision_signals (
  pkey TEXT NOT NULL, question TEXT NOT NULL, probability REAL,
  PRIMARY KEY (pkey, question))`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_decision_done (
  pkey TEXT PRIMARY KEY, game_id TEXT, play_id INTEGER, ok INTEGER,
  input_tokens INTEGER, error TEXT)`);

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const rows = src.prepare(`
  SELECT game_id, CAST(play_id AS INTEGER) play_id, season, week, posteam, defteam,
         CAST(qtr AS INTEGER) qtr, quarter_seconds_remaining qsr, game_seconds_remaining gsr,
         CAST(ydstogo AS INTEGER) ydstogo, CAST(yardline_100 AS INTEGER) yl,
         CAST(score_differential AS INTEGER) sd,
         CAST(posteam_timeouts_remaining AS INTEGER) pto,
         CAST(defteam_timeouts_remaining AS INTEGER) dto,
         play_type, substr(desc,1,110) d
  FROM play_by_play
  WHERE down = 4 AND season BETWEEN 2016 AND 2025
    AND play_type IN ('punt','field_goal','pass','run')
    AND posteam IS NOT NULL AND yardline_100 IS NOT NULL AND ydstogo IS NOT NULL
  ORDER BY game_id, play_id`).all() as any[];

const doneSet = new Set<string>(
  (db.prepare('SELECT pkey FROM jev_decision_done WHERE ok=1').all() as any[]).map(r => r.pkey));
const todo = rows.filter(r => !doneSet.has(`${r.game_id}|${r.play_id}`)).slice(0, LIMIT || undefined);
console.log(`${rows.length.toLocaleString()} fourth-down decisions, ${todo.length.toLocaleString()} to do`);

function stateText(r: any): string {
  const mm = Math.floor((r.qsr ?? 0) / 60), ss = Math.round((r.qsr ?? 0) % 60);
  const sd = r.sd ?? 0;
  const margin = sd === 0 ? 'the game is tied'
    : sd > 0 ? `the offense leads by ${sd}` : `the offense trails by ${-sd}`;
  const fp = r.yl > 50 ? `its own ${100 - r.yl}-yard line` : `the opponent ${r.yl}-yard line`;
  const fg = r.yl + 17;
  return `NFL game, ${r.posteam} on offense against ${r.defteam}. ` +
    `Fourth down and ${r.ydstogo}, ball on ${fp} (a field goal would be ${fg} yards). ` +
    `Quarter ${r.qtr}, ${mm}:${String(ss).padStart(2, '0')} left in the quarter, ${margin}. ` +
    `Offense has ${r.pto ?? 0} timeouts, defense ${r.dto ?? 0}. ` +
    `The coach chose to ${r.play_type === 'punt' ? 'punt' : r.play_type === 'field_goal'
      ? `attempt the field goal` : 'run an offensive play and go for it'}. ` +
    `Play: ${String(r.d ?? '').replace(/\s+/g, ' ')}`;
}

const insSig = db.prepare('INSERT OR REPLACE INTO jev_decision_signals VALUES (?,?,?)');
const insDone = db.prepare('INSERT OR REPLACE INTO jev_decision_done VALUES (?,?,?,?,?,?)');

let ok = 0, failed = 0, tokens = 0, stop = false, cursor = 0;
const t0 = Date.now();

async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= todo.length) return;
    const r = todo[i];
    const pkey = `${r.game_id}|${r.play_id}`;
    try {
      const result = await evaluate({
        model: 'typesafe-ai/jev',
        state: stateText(r),
        questions: QUESTIONS,
      });
      for (const [q, a] of Object.entries(result.answers as Record<string, any>)) {
        if (!a) continue;
        if (a.type === 'boolean') { insSig.run(pkey, q, a.probability ?? null); continue; }
        if (a.type === 'score') insSig.run(pkey, `${q}.mean`, a.score ?? null);
        const levels = q === 'decision_aggression' ? AGG_LEVELS : QUAL_LEVELS;
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>))
          insSig.run(pkey, `${q}.${levels[Number(k)] ?? k}`, pr as number);
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(pkey, r.game_id, r.play_id, 1, used, null);
      ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      insDone.run(pkey, r.game_id, r.play_id, 0, 0, msg.slice(0, 300));
      failed++;
      if (/authentication|not have access|free tier|quota|payment/i.test(msg)) {
        console.log(`\nSTOPPING: ${msg.slice(0, 200)}`); stop = true; return;
      }
    }
    const done = ok + failed;
    if (done % 500 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${todo.length} ok=${ok} fail=${failed} ${tokens.toLocaleString()}tok ` +
        `~$${usd.toFixed(4)} ${rate.toFixed(1)}/s eta=${((todo.length - done) / rate / 60).toFixed(1)}min`);
      if (usd > MAX_USD) { console.log(`budget $${MAX_USD} reached`); stop = true; return; }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ok=${ok} failed=${failed} ${tokens.toLocaleString()} tok ~$${((tokens / 1e6) * 0.042).toFixed(4)}`);
