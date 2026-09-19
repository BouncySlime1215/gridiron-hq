/**
 * Classify a decade of official NFL roster moves with Jev, so they can be event-studied.
 *
 * WHY THIS AND NOT THE PRESS CONFERENCES. The presser corpus is coach-speak: hedged, ambiguous,
 * covering 20 of 32 teams, and usable only where we hold a real publication TIME -- which YouTube
 * stops exposing after about six weeks, capping us at 482 events. espn_transactions is the
 * opposite in every dimension that matters to an event study:
 *
 *            pressers            espn_transactions
 *   events   482 timestamped     12,268 in-season (24,873 total)
 *   span     ~6 weeks            2016-2026, ten seasons
 *   teams    20                  32
 *   content  "we'll see"         "Placed QB on injured reserve."
 *   cost     $1.00               $0.025
 *
 * A transaction is a dated, official, unambiguous fact. That is what an event study needs, and it
 * is 25x the sample over 10x the span for 1/40th the price.
 *
 * WHY JEV RATHER THAN A REGEX. The descriptions are free text with enormous variety: "Placed X on
 * IR", "Waived/injured", "Activated from the PUP list", "Designated to return". A regex over that
 * is a week of whack-a-mole that still misclassifies the tail. Jev returns a typed answer plus a
 * PROBABILITY per option, and the probability is the point: "Signed QB to the practice squad" is
 * weakly negative news and a hard label would throw that gradation away.
 *
 * The questions are deliberately about AVAILABILITY and IMPACT, not about transaction taxonomy for
 * its own sake -- the downstream test is whether the market misprices personnel change.
 *
 * Usage: set -a; . ./.env.local; set +a; npx tsx scripts/news-line/jev_transactions.mts [--limit N]
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const DB = path.join(REPO, 'data/line-history/line_history.sqlite');
const CONCURRENCY = 8;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 2.0);

const QUESTIONS = {
  move_type: {
    type: 'choice' as const,
    instructions: 'What kind of roster move does this describe? Pick the single best category.',
    criteria: {
      injured_reserve: 'A player is placed on injured reserve, PUP, or a non-football injury list.',
      activated: 'A player is activated or returns from injured reserve, PUP, or suspension.',
      released: 'A player is released, waived, cut, or terminated.',
      signed: 'A player is signed, claimed, or re-signed to the active roster.',
      practice_squad: 'A move involving the practice squad specifically.',
      trade: 'A player is traded.',
      suspended: 'A player is suspended.',
      retired: 'A player retires.',
      contract_admin: 'A contract, franchise tag, extension or purely administrative move.',
      other: 'Anything else, including coaching and front-office moves.',
    },
  },
  // The whole downstream question is whether the market misprices personnel change, so this is the
  // feature that matters. An ordered score, not a boolean: losing a starting QB and losing a
  // practice-squad lineman are not the same event.
  availability_impact: {
    type: 'score' as const,
    instructions:
      'How does this move change the talent available to this team for its NEXT game, relative ' +
      'to the week before?',
    criteria: [
      'A clear starter becomes unavailable.',
      'A rotational contributor becomes unavailable, or depth is lost.',
      'No meaningful change to available talent.',
      'A rotational contributor becomes available, or depth is added.',
      'A clear starter becomes available.',
    ],
  },
  position_group: {
    type: 'choice' as const,
    instructions: 'Which position group is most affected?',
    criteria: {
      quarterback: 'Quarterback.',
      skill: 'Running back, wide receiver or tight end.',
      offensive_line: 'Offensive line.',
      defensive_line: 'Defensive line or edge rusher.',
      linebacker: 'Linebacker.',
      secondary: 'Cornerback or safety.',
      special_teams: 'Kicker, punter, or long snapper.',
      none: 'No specific player, or a non-player move.',
    },
  },
  starter_involved: {
    type: 'boolean' as const,
    instructions:
      'Does this move involve a player who would plausibly start or take significant snaps ' +
      'for this team?',
  },
};

const SCORE_LEVELS = ['starter_out', 'depth_out', 'neutral', 'depth_in', 'starter_in'];

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=600000');
db.exec(`CREATE TABLE IF NOT EXISTS jev_transaction_signals (
  txn_key TEXT NOT NULL, question TEXT NOT NULL, probability REAL,
  team_id TEXT, date TEXT, evaluated_at TEXT NOT NULL,
  PRIMARY KEY (txn_key, question))`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_transaction_done (
  txn_key TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL,
  input_tokens INTEGER, ok INTEGER, error TEXT)`);

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

// In-season only (Sep-Jan) and 2019+, because that is where covers_line_history has a real tape
// to event-study against. Ordered newest-first so a partial run still covers the current season.
const rows = db.prepare(`
  SELECT t.date || '|' || t.team_id || '|' || substr(t.description,1,60) AS txn_key,
         t.date, t.team_id, t.description
  FROM espn_transactions t
  LEFT JOIN jev_transaction_done d ON d.txn_key = t.date || '|' || t.team_id || '|' || substr(t.description,1,60)
  WHERE d.txn_key IS NULL
    AND CAST(substr(t.date,1,4) AS INTEGER) >= 2019
    AND CAST(substr(t.date,6,2) AS INTEGER) IN (9,10,11,12,1)
  ORDER BY t.date DESC
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}`).all() as any[];

console.log(`${rows.length.toLocaleString()} transactions to classify (in-season, 2019+)`);

const insSig = db.prepare(
  'INSERT OR REPLACE INTO jev_transaction_signals VALUES (?,?,?,?,?,?)');
const insDone = db.prepare('INSERT OR REPLACE INTO jev_transaction_done VALUES (?,?,?,?,?)');

let ok = 0, failed = 0, tokens = 0, stop = false;
let cursor = 0;

async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= rows.length) return;
    const r = rows[i];
    const now = new Date().toISOString();
    try {
      const result = await evaluate({
        model: 'typesafe-ai/jev',
        state: `NFL roster transaction, ${String(r.date).slice(0, 10)}: ${r.description}`,
        questions: QUESTIONS,
      });
      for (const [q, a] of Object.entries(result.answers as Record<string, any>)) {
        if (!a) continue;
        if (a.type === 'boolean') {
          insSig.run(r.txn_key, q, a.probability ?? null, String(r.team_id), String(r.date), now);
          continue;
        }
        if (a.type === 'score') {
          insSig.run(r.txn_key, `${q}.mean`, a.score ?? null, String(r.team_id), String(r.date), now);
        }
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>)) {
          const name = a.type === 'score' ? (SCORE_LEVELS[Number(k)] ?? k) : k;
          insSig.run(r.txn_key, `${q}.${name}`, pr as number, String(r.team_id), String(r.date), now);
        }
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(r.txn_key, now, used, 1, null);
      ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      insDone.run(r.txn_key, now, 0, 0, msg.slice(0, 300));
      failed++;
      // An auth or access failure is not per-row and retrying 12,000 times learns nothing.
      if (/authentication|not have access|free tier/i.test(msg)) {
        console.log(`\nSTOPPING: ${msg.slice(0, 160)}`);
        stop = true;
        return;
      }
    }
    const done = ok + failed;
    if (done % 250 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      console.log(`  ${done}/${rows.length}  ok=${ok} failed=${failed}  ` +
        `${tokens.toLocaleString()} tok (~$${usd.toFixed(4)})`);
      if (usd > MAX_USD) { console.log(`budget $${MAX_USD} reached`); stop = true; return; }
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ${ok} classified, ${failed} failed, ${tokens.toLocaleString()} input tokens ` +
  `(~$${((tokens / 1e6) * 0.042).toFixed(4)})`);
