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
  // ONE Choice, not two booleans. availability and its direction are a SINGLE latent variable with
  // mutually exclusive states, and asking it as separate booleans (starter_doubtful,
  // starter_returning) let Jev return 0.7 doubtful AND 0.6 returning on the same transcript --
  // incoherent, and unusable as a feature. A Choice returns one distribution over one variable.
  // It also gives "not_discussed" a state of its own. As two booleans, a presser with no injury
  // news and a presser where the coach confirms everyone is healthy BOTH scored near zero, and
  // those are opposite signals to a market. That conflation was the real defect.
  availability_state: {
    type: 'choice' as const,
    instructions:
      'What does the coach convey about the availability of a starting or clearly important ' +
      'player for the next game? Choose the single best description.',
    criteria: {
      not_discussed: 'No specific player availability or injury is discussed at all.',
      confirmed_out: 'A player is ruled out, will miss the game, or is on injured reserve.',
      doubtful: 'A player is described as doubtful or unlikely to play.',
      questionable: 'A player is genuinely uncertain, limited, or a game-time decision.',
      probable: 'A player is expected to play but with some minor qualification.',
      confirmed_playing: 'A player is confirmed healthy, cleared, or definitely playing.',
    },
  },

  // A Score, not a boolean. "Does this make the team weaker" is a MAGNITUDE question, and the
  // market prices magnitude: a backup guard being questionable and a starting quarterback being
  // ruled out are not the same event, but a boolean records both as "yes".
  team_impact: {
    type: 'score' as const,
    instructions:
      'Relative to what a well-informed reader would have assumed before this press conference, ' +
      'how much does this news change the team s strength for its next game?',
    // A score's criteria is an ORDERED ARRAY, indexed from zero -- not a named map like choice.
    // The answer comes back as a fractional `score` in [0, levels-1] plus a distribution keyed by
    // zero-based index STRINGS, so the ordering here defines the scale: 0 = much worse for the
    // team, 4 = much better. SCORE_LEVELS below maps those indices back to names on write.
    criteria: [
      'A key starter is newly ruled out or seriously injured.',
      'A contributor is newly doubtful, or an injury is worse than expected.',
      'No meaningful change, or the news was already priced in.',
      'A contributor is returning sooner or healthier than expected.',
      'A key starter is newly cleared after being in real doubt.',
    ],
  },

  // Positional importance drives how much of the spread the news is worth. Quarterback news moves
  // a line by multiple points; a nickel corner does not.
  position_group: {
    type: 'choice' as const,
    instructions: 'Which position group does the most significant availability news concern?',
    criteria: {
      none: 'No specific player availability news.',
      quarterback: 'The quarterback.',
      skill: 'Running back, wide receiver or tight end.',
      offensive_line: 'Offensive line.',
      defense: 'Any defensive player.',
      special_teams: 'Kicker, punter or returner.',
    },
  },

  // Kept as a boolean because it genuinely IS binary and it is the one that carries the alpha:
  // how firm the coach is. A hedge is the market s uncertainty, and the probability -- not the
  // label -- is the feature.
  coach_hedging: {
    type: 'boolean' as const,
    instructions:
      'Is the coach evasive or non-committal about availability, rather than giving a clear ' +
      'yes or no?',
  },
};

// Zero-based level index -> name, matching team_impact.criteria order above.
const SCORE_LEVELS = ['much_worse', 'worse', 'neutral', 'better', 'much_better'];

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
let consecutiveRateLimits = 0;

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
      // Boolean answers carry a scalar probability; choice and score answers carry a
      // DISTRIBUTION over their options. Storing only `.probability` would silently drop every
      // choice/score answer as NULL -- the whole point of the rewrite. One row per outcome, so a
      // choice question lands as several rows and the feature join can use the full distribution.
      // The three answer shapes are genuinely different and only `boolean` carries a bare
      // `.probability`. Reading that field alone -- as this script originally did -- would store
      // NULL for every choice and score answer, silently discarding the rewrite's whole point.
      //   boolean -> { probability }                    P(true)
      //   choice  -> { choice, probabilities? }         distribution over named options
      //   score   -> { score, probabilities? }          fractional mean + distribution keyed by
      //                                                 zero-based level index STRINGS
      for (const [q, a] of Object.entries(result.answers as Record<string, any>)) {
        if (!a) {
          insSignal.run(r.video_id, q, null, r.team, r.published_at, now);
          continue;
        }
        if (a.type === 'boolean') {
          insSignal.run(r.video_id, q, a.probability ?? null, r.team, r.published_at, now);
          continue;
        }
        if (a.type === 'score') {
          // Store the scalar too: it is the probability-weighted mean and is the single most
          // useful column for a regression against line movement.
          insSignal.run(r.video_id, `${q}.mean`, a.score ?? null, r.team, r.published_at, now);
        }
        if (a.type === 'choice' && typeof a.choice === 'string') {
          insSignal.run(r.video_id, `${q}.argmax:${a.choice}`, 1, r.team, r.published_at, now);
        }
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>)) {
          const name = a.type === 'score' ? (SCORE_LEVELS[Number(k)] ?? k) : k;
          insSignal.run(r.video_id, `${q}.${name}`, pr as number, r.team, r.published_at, now);
        }
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(r.video_id, now, used, 1, null);
      ok++;
      consecutiveRateLimits = 0;
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
      // An exhausted FREE TIER does not recover on a timescale backoff can bridge: the previous
      // run spent hours cycling 5s/10s/.../120s waits across 845 transcripts and still logged
      // 513 failures against 62 successes. Nine attempts at up to 120s is ~10 minutes burned per
      // transcript to learn the same thing each time. Give up on the RUN, not just the row, so
      // the operator sees the real problem immediately.
      consecutiveRateLimits++;
      if (consecutiveRateLimits >= 12) {
        console.log(
          '\nSTOPPING: the free tier is exhausted, not momentarily busy -- ' +
            `${consecutiveRateLimits} rate limits in a row. Nothing was lost; rows already done ` +
            'are recorded and a rerun resumes from here. Add paid credits to continue.',
        );
        process.exit(0);
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
