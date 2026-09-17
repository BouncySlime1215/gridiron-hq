/**
 * Turn press-conference transcripts into timestamped availability signals with TypeSafe AI's Jev.
 *
 * WHY THIS ANGLE. The injury→line-movement study died on timestamps: nfl_injuries.modified_at is
 * real and second-precision for 2021-2024, but 2025 and 2026 have none at all, so there is no
 * holdout for the current season. Press conferences DO carry real timestamps — published_at on the
 * YouTube upload — which makes coach speak the only timestamped availability source that still
 * exists for 2026. That is the whole reason this is worth running.
 *
 * WHY JEV RATHER THAN A CHAT MODEL. Jev is an evaluation model: it takes state plus typed questions
 * and returns boolean PROBABILITIES, several per request, at $0.042/M input. The probabilities are
 * the point. "We'll see how he looks Friday" is not a 0 or a 1, and a feature that records 0.16
 * carries information a hard label throws away — which is exactly what a line-movement study needs,
 * because the market prices degrees of doubt, not binary states.
 *
 * FREE-TIER REALITY. Jev is rate-limited per model on the free tier (429 RateLimitExceededError
 * after roughly one call). This runs at concurrency 1 with exponential backoff and is fully
 * resumable, so it makes progress at whatever rate the tier allows and finishes fast after a top-up.
 *
 * Output: jev_presser_signals in data/line-history/line_history.sqlite, one row per
 * (video_id, question) with the probability, joinable to line movement on (team, published_at).
 *
 * Run: node --env-file-if-exists=.env.local scripts/news-line/jev_presser_signals.mts [--limit N]
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const DB = path.join(REPO, 'data/line-history/line_history.sqlite');

// Transcripts run to 49k chars. Jev reports context_window 0 (unspecified), so cap the input:
// a presser's availability content is front-loaded in the Q&A, and this keeps cost predictable.
const MAX_CHARS = 12_000;

/**
 * Questions chosen so the answers compose into a DIRECTION, not just a topic label. The market
 * moves on "a starter the team needs is less likely to play", so the set has to separate
 * (a) is this about availability at all, (b) which way does it cut, (c) how firm is the coach.
 */
const QUESTIONS = {
  availability_news: {
    type: 'boolean' as const,
    instructions: 'Does the coach reveal information about whether a specific player will or will not be available for the next game?',
  },
  starter_doubtful: {
    type: 'boolean' as const,
    instructions: 'Is a starting or clearly important player described as injured, doubtful, questionable, limited, or unlikely to play?',
  },
  starter_returning: {
    type: 'boolean' as const,
    instructions: 'Is a starting or clearly important player described as healthy, returning, cleared, or definitely playing?',
  },
  quarterback_involved: {
    type: 'boolean' as const,
    instructions: 'Does the availability or injury discussion involve the quarterback specifically?',
  },
  coach_hedging: {
    type: 'boolean' as const,
    instructions: 'Is the coach evasive or non-committal about availability, rather than giving a clear yes or no?',
  },
  net_negative_for_team: {
    type: 'boolean' as const,
    instructions: 'Taken as a whole, does this news make the team WEAKER for its next game than a reader would have assumed beforehand?',
  },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jev_presser_signals (
  video_id TEXT NOT NULL, question TEXT NOT NULL, probability REAL,
  team TEXT, published_at TEXT, evaluated_at TEXT NOT NULL,
  PRIMARY KEY (video_id, question));
CREATE INDEX IF NOT EXISTS jev_presser_at ON jev_presser_signals(team, published_at);
CREATE TABLE IF NOT EXISTS jev_presser_done (
  video_id TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL,
  input_tokens INTEGER, ok INTEGER NOT NULL, error TEXT);
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=600000');
db.exec(SCHEMA);

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

// Hard spend ceiling. The whole projected corpus (~23k transcripts, ~58M input tokens) costs about
// $2.45 at Jev's $0.042/M and fits inside the $5 of free gateway credits, so this should never
// trigger — it exists so an unattended overnight run cannot drift onto a real card.
const budgetArg = process.argv.indexOf('--max-usd');
const MAX_USD = budgetArg > -1 ? Number(process.argv[budgetArg + 1]) : 3.0;
const PRICE_PER_TOKEN = 0.042 / 1e6;

// Tokens already spent in previous runs count against the ceiling; the table is the ledger.
const priorTokens =
  (db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS t FROM jev_presser_done`).get() as { t: number }).t ?? 0;

const rows = db
  .prepare(
    `SELECT p.video_id, p.team, p.published_at, p.transcript
       FROM press_conferences_raw p
       LEFT JOIN jev_presser_done d ON d.video_id = p.video_id
      WHERE p.transcript IS NOT NULL AND length(p.transcript) > 400 AND d.video_id IS NULL
      ORDER BY p.published_at DESC` + (LIMIT ? ` LIMIT ${LIMIT}` : ''),
  )
  .all() as Array<{ video_id: string; team: string; published_at: string; transcript: string }>;

console.log(`${rows.length} transcripts to evaluate`);

const insSignal = db.prepare(
  `INSERT OR REPLACE INTO jev_presser_signals VALUES (?,?,?,?,?,?)`,
);
const insDone = db.prepare(`INSERT OR REPLACE INTO jev_presser_done VALUES (?,?,?,?,?)`);

let ok = 0,
  failed = 0,
  tokens = 0;

for (const [i, r] of rows.entries()) {
  const spent = (priorTokens + tokens) * PRICE_PER_TOKEN;
  if (spent >= MAX_USD) {
    console.log(`STOPPING: spend ceiling reached — $${spent.toFixed(4)} >= $${MAX_USD.toFixed(2)}. ` +
                `${rows.length - i} transcripts left; rerun with --max-usd to raise it.`);
    break;
  }
  const now = new Date().toISOString();
  let done = false;

  // Free-tier rate limiting is the normal case here, not an exception. Back off and keep going;
  // never drop a transcript silently, because a gap in coverage biases the event study.
  for (let attempt = 0; attempt < 9 && !done; attempt++) {
    try {
      const result = await evaluate({
        model: 'typesafe-ai/jev',
        state: r.transcript.slice(0, MAX_CHARS),
        questions: QUESTIONS,
      });
      for (const [q, a] of Object.entries(result.answers as Record<string, { probability?: number }>)) {
        insSignal.run(r.video_id, q, a?.probability ?? null, r.team, r.published_at, now);
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(r.video_id, now, used, 1, null);
      ok++;
      done = true;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const rateLimited = /rate.?limit|429/i.test(msg);
      if (!rateLimited || attempt === 8) {
        insDone.run(r.video_id, now, 0, 0, msg.slice(0, 300));
        failed++;
        done = true;
        break;
      }
      const wait = Math.min(5000 * 2 ** attempt, 120_000);
      if (attempt === 0 || attempt % 3 === 0) {
        console.log(`  rate limited, waiting ${wait / 1000}s (${i + 1}/${rows.length})`);
      }
      await sleep(wait);
    }
  }

  if ((i + 1) % 25 === 0) {
    console.log(
      `  ${i + 1}/${rows.length}  ok=${ok} failed=${failed}  ` +
        `${tokens.toLocaleString()} input tokens (~$${((tokens / 1e6) * 0.042).toFixed(3)})`,
    );
  }
}

console.log(
  `done: ${ok} evaluated, ${failed} failed, ${tokens.toLocaleString()} input tokens ` +
    `(~$${((tokens / 1e6) * 0.042).toFixed(3)})`,
);
