/**
 * Classify every NFL play that falls inside the live-market (Kalshi OR Polymarket) window.
 *
 * WHY. The live/in-game surface is the only market in this project that has never been tested.
 * A live book must reprice in seconds on events it did not see coming. To test whether it
 * reprices correctly we need, per play, a machine-readable answer to "what just happened, and
 * how surprising was it?" -- the second half being the part that matters. Markets move on
 * SURPRISE, not on events: a 3-yard run on 2nd-and-4 is not news, a 3-yard run on 4th-and-2
 * from the 40 is.
 *
 * WHY JEV RATHER THAN THE STRUCTURED COLUMNS. espn_plays already carries type/scoring/
 * stat_yardage, and those are used here as a VALIDATION cross-check, not as the feature. What
 * they cannot give is (a) injury language, which lives only in the prose, (b) whether the named
 * player is a star, and (c) surprise conditional on down/distance/field position. Jev returns a
 * typed answer plus a probability per option, and the probability is the point: a hard label
 * throws away the gradation that the downstream repricing test needs.
 *
 * WINDOW. Measured, not assumed:
 *   kalshi_candles ts span   2026-05-15T18:00:00Z .. 2026-09-17T04:03:00Z  -> 11,505 plays
 *   pm_price_history t span  2024-07-30T01:55:02Z .. 2026-09-17T14:30:19Z -> 132,592 plays
 * The Polymarket span strictly contains the Kalshi span, so the UNION is 132,592 plays
 * (132,588 with non-empty text) across 732 games. Ordered wallclock DESC so the Kalshi subset
 * -- the only one of the two with a real bid/ask -- is finished first.
 *
 * FIELD POSITION. espn_plays.start_yardline is ABSOLUTE field position measured from the HOME
 * team's goal line (verified on two games: GB home, GB ball at GB 28 -> 28; same drive at WAS 46
 * -> 54). Converted here to yards-from-own-goal for the offense so "own 24" reads correctly.
 *
 * NO LOOK-AHEAD IN THE STATE. home_score/away_score on a play row are the score AFTER that play.
 * Feeding those in would leak the outcome into the pre-play context that `surprise` is supposed
 * to be judged against, so the PREVIOUS play's scores (LAG over sequence) are passed instead.
 *
 * WRITES GO TO A SEPARATE FILE. line_history.sqlite has live collectors writing to it and is
 * opened read-only here; labels land in jev_live_plays.sqlite, which downstream work ATTACHes.
 *
 * Usage: set -a; . ./.env.local; set +a; npx --yes tsx scripts/live-market/jev_live_plays.mts [--limit N]
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO, 'data/line-history/line_history.sqlite');
const OUT = path.join(REPO, 'data/line-history/jev_live_plays.sqlite');
const CONCURRENCY = Number(process.env.JEV_CONCURRENCY ?? 8);
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 8.0);

// Window bounds, taken from the measured spans above. PM contains Kalshi, so PM's start is the
// union's start.
const WINDOW_START = '2024-07-30T01:55:02Z';

const QUESTIONS = {
  event_class: {
    type: 'choice' as const,
    instructions:
      'What kind of football event does this play describe? Pick the single best category. ' +
      'If several apply, pick the one a live betting market would reprice on hardest.',
    criteria: {
      scoring_td: 'A touchdown is scored, by either team, on any kind of play.',
      scoring_fg: 'A field goal attempt, extra point attempt, or safety.',
      turnover_int: 'A pass is intercepted.',
      turnover_fumble: 'A fumble is lost to the other team, or a turnover on downs.',
      punt: 'A punt, including a blocked or downed punt.',
      sack: 'The quarterback is sacked behind the line of scrimmage.',
      big_gain: 'A gain of roughly 15 yards or more that is not a touchdown.',
      big_loss: 'A loss of yardage that is not a sack.',
      penalty: 'The play is primarily a penalty, including one that negates the play.',
      injury: 'The play text describes a player being injured, shaken up, or attended to.',
      routine: 'An ordinary run, short pass, or incompletion with no unusual outcome.',
      game_state:
        'A timeout, end of quarter or half, two-minute warning, kneel-down, spike, coin toss, ' +
        'or other clock or administrative event.',
    },
  },
  // Injury language lives only in the prose. An ordered score, not a boolean: "shaken up" and
  // "carted off" are days apart in what they imply for the rest of the game.
  injury_severity: {
    type: 'score' as const,
    instructions:
      'How severe is the injury described in this play text, if any? Judge only what the text ' +
      'actually says; do not infer injury from a hard hit.',
    criteria: [
      'No injury is mentioned at all.',
      'A player is shaken up, slow to get up, or is attended to and stays in.',
      'A player is helped off the field or leaves the game.',
      'A player is carted off, taken to the locker room, or ruled out.',
    ],
  },
  star_player_involved: {
    type: 'boolean' as const,
    instructions:
      'Does this play text name a quarterback, or an obvious primary offensive weapon (a lead ' +
      'running back, a number-one receiver) as the player who carried, threw, or caught the ball?',
  },
  // THE feature. Markets reprice on surprise, not on events.
  surprise: {
    type: 'score' as const,
    instructions:
      'Given the down, distance, field position, quarter and score stated in the game state, ' +
      'how unexpected is this outcome? Judge the outcome against what a well-informed fan would ' +
      'have expected BEFORE the snap, not against a neutral play. A 3-yard run on 2nd-and-4 is ' +
      'not news. A punt on 4th-and-8 is not news either. A fourth-down conversion, a turnover, ' +
      'or a 60-yard touchdown is.',
    criteria: [
      'Exactly what you would expect in this situation; the game state barely moves.',
      'Slightly better or worse than expected, within the normal range of outcomes.',
      'Noticeably unexpected; a fan would react.',
      'Very unexpected; a clear swing in who is likely to win.',
      'Shocking; the kind of play that is replayed all week.',
    ],
  },
};

const LEVELS: Record<string, string[]> = {
  injury_severity: ['none', 'shaken_up', 'helped_off', 'carted_off'],
  surprise: ['expected', 'mild', 'notable', 'large', 'shocking'],
};

// ---------------------------------------------------------------- source (read-only)
let src: DatabaseSync;
try {
  src = new DatabaseSync(SRC, { readOnly: true } as any);
  src.prepare('SELECT 1').get();
} catch (e: any) {
  // A WAL database cannot always be opened read-only (the -shm file needs write access).
  console.log(`readOnly open failed (${String(e?.message ?? e).slice(0, 80)}); opening rw, SELECT-only`);
  src = new DatabaseSync(SRC);
}
src.exec('PRAGMA busy_timeout=600000');
src.exec('PRAGMA query_only=ON');

// ---------------------------------------------------------------- output
const db = new DatabaseSync(OUT);
db.exec('PRAGMA busy_timeout=600000');
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS jev_play_labels (
  event_id TEXT NOT NULL, play_id TEXT NOT NULL, question TEXT NOT NULL,
  value REAL, wallclock TEXT,
  PRIMARY KEY (event_id, play_id, question)) WITHOUT ROWID`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_play_done (
  event_id TEXT NOT NULL, play_id TEXT NOT NULL, evaluated_at TEXT NOT NULL,
  wallclock TEXT, event_class TEXT, input_tokens INTEGER, ok INTEGER, error TEXT,
  PRIMARY KEY (event_id, play_id)) WITHOUT ROWID`);
db.exec('CREATE INDEX IF NOT EXISTS jev_play_labels_q ON jev_play_labels(question)');

// Resume set. 132k keys is a few MB in memory and one scan beats 132k point lookups.
const done = new Set<string>();
for (const r of db.prepare('SELECT event_id, play_id FROM jev_play_done WHERE ok=1').all() as any[]) {
  done.add(`${r.event_id}|${r.play_id}`);
}
console.log(`${done.size.toLocaleString()} plays already classified`);

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const t0 = Date.now();
const rows = src.prepare(`
  WITH w AS (
    SELECT p.event_id, p.play_id, p.sequence, p.period, p.clock, p.wallclock, p.type, p.text,
           p.start_down, p.start_distance, p.start_yardline, p.start_team,
           LAG(p.home_score) OVER (PARTITION BY p.event_id ORDER BY p.sequence) AS pre_home,
           LAG(p.away_score) OVER (PARTITION BY p.event_id ORDER BY p.sequence) AS pre_away
    FROM espn_plays p
    WHERE p.wallclock >= ? AND p.text IS NOT NULL AND p.text <> ''
  )
  SELECT w.*, e.name AS game_name, e.home AS home_id, e.away AS away_id, e.season, e.week
  FROM w JOIN espn_events e ON e.event_id = w.event_id
  ORDER BY w.wallclock DESC
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}`).all(WINDOW_START) as any[];
console.log(`${rows.length.toLocaleString()} plays in the live-market window ` +
  `(loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const todo = rows.filter(r => !done.has(`${r.event_id}|${r.play_id}`));
console.log(`${todo.length.toLocaleString()} to classify`);

function buildState(r: any): string {
  const [awayName, homeName] = String(r.game_name ?? ' at ').split(' at ');
  const offIsHome = String(r.start_team) === String(r.home_id);
  const off = offIsHome ? homeName : awayName;
  const def = offIsHome ? awayName : homeName;
  // start_yardline is absolute, from the HOME goal line. Flip it for an away offense.
  const yl = r.start_yardline;
  let field = 'field position not recorded';
  if (yl !== null && yl !== undefined && yl >= 0 && yl <= 100) {
    const own = offIsHome ? yl : 100 - yl;
    field = own <= 50
      ? `on its own ${own}-yard line (${100 - own} yards from the opponent's end zone)`
      : `on the opponent's ${100 - own}-yard line (${100 - own} yards from the end zone)`;
  }
  const d = r.start_down;
  const situation = d >= 1 && d <= 4
    ? `${['', '1st', '2nd', '3rd', '4th'][d]} and ${r.start_distance ?? '?'}, ${field}`
    : `no scrimmage down (kickoff, try, or administrative), ${field}`;
  const ph = r.pre_home ?? 0, pa = r.pre_away ?? 0;
  const score = offIsHome
    ? `${off} (offense, home) ${ph}, ${def} ${pa}`
    : `${off} (offense, away) ${pa}, ${def} ${ph}`;
  return [
    `NFL live in-game play. ${r.game_name}${r.season ? `, ${r.season} season week ${r.week}` : ''}.`,
    `Quarter ${r.period ?? '?'}, ${r.clock ?? '?'} left on the clock.`,
    `Score BEFORE this play: ${score}.`,
    `Situation BEFORE the snap: ${off} has the ball, ${situation}.`,
    `ESPN play type: ${r.type ?? 'unknown'}.`,
    `Play: ${r.text}`,
  ].join('\n');
}

if (todo.length) console.log(`\n--- sample state ---\n${buildState(todo[0])}\n--------------------\n`);

const insLabel = db.prepare('INSERT OR REPLACE INTO jev_play_labels VALUES (?,?,?,?,?)');
const insDone = db.prepare('INSERT OR REPLACE INTO jev_play_done VALUES (?,?,?,?,?,?,?,?)');

let ok = 0, failed = 0, tokens = 0, retries = 0, stop = false, cursor = 0;
const start = Date.now();

async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= todo.length) return;
    const r = todo[i];
    const now = new Date().toISOString();
    try {
      // Transient 429/5xx on a gateway are not information. Three tries with backoff, then give
      // up on the row -- it stays retryable because only ok=1 rows enter the resume set.
      let result: any = null, lastErr: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await evaluate({
            model: 'typesafe-ai/jev',
            state: buildState(r),
            questions: QUESTIONS,
          });
          lastErr = null;
          break;
        } catch (e: any) {
          lastErr = e;
          const m = String(e?.message ?? e);
          if (/authentication|not have access|free tier|unauthorized|invalid api key/i.test(m)) break;
          retries++;
          await new Promise(res => setTimeout(res, 1200 * (attempt + 1) + Math.random() * 800));
        }
      }
      if (lastErr) throw lastErr;
      let cls: string | null = null;
      for (const [q, a] of Object.entries(result.answers as Record<string, any>)) {
        if (!a) continue;
        if (a.type === 'boolean') {
          insLabel.run(r.event_id, r.play_id, q, a.probability ?? null, r.wallclock);
          continue;
        }
        if (a.type === 'choice') {
          cls = q === 'event_class' ? (a.choice ?? null) : cls;
        }
        if (a.type === 'score') {
          insLabel.run(r.event_id, r.play_id, `${q}.mean`, a.score ?? null, r.wallclock);
        }
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>)) {
          const name = a.type === 'score' ? (LEVELS[q]?.[Number(k)] ?? k) : k;
          insLabel.run(r.event_id, r.play_id, `${q}.${name}`, pr as number, r.wallclock);
        }
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(r.event_id, r.play_id, now, r.wallclock, cls, used, 1, null);
      ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      insDone.run(r.event_id, r.play_id, now, r.wallclock, null, 0, 0, msg.slice(0, 300));
      failed++;
      // An auth or access failure is not per-row; retrying it 132,000 times learns nothing.
      if (/authentication|not have access|free tier|unauthorized|invalid api key/i.test(msg)) {
        console.log(`\nSTOPPING: ${msg.slice(0, 200)}`);
        stop = true;
        return;
      }
    }
    const n = ok + failed;
    if (n % 500 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      const rate = n / ((Date.now() - start) / 1000);
      const eta = (todo.length - n) / rate / 60;
      console.log(`  ${n}/${todo.length}  ok=${ok} failed=${failed}  ` +
        `${tokens.toLocaleString()} tok (~$${usd.toFixed(4)})  retries=${retries}  ` +
        `${rate.toFixed(1)}/s  eta ${eta.toFixed(0)}m`);
      if (usd > MAX_USD) { console.log(`budget $${MAX_USD} reached, stopping`); stop = true; return; }
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const secs = (Date.now() - start) / 1000;
console.log(`\ndone: ${ok} classified, ${failed} failed, ${retries} retries, ${tokens.toLocaleString()} input tokens ` +
  `(~$${((tokens / 1e6) * 0.042).toFixed(4)}) in ${(secs / 60).toFixed(1)}m ` +
  `= ${(ok / secs).toFixed(1)} plays/s`);
