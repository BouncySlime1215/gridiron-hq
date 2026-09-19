/**
 * TEST 5 -- CORPUS TRIAGE. Classify all 59,935 official-team-channel YouTube TITLES with Jev so
 * the transcript collector can be pointed at the ~2-3k videos that actually carry availability
 * news, rather than the whole channel.
 *
 * This is infrastructure, not alpha. It produces no bet.
 *
 * Usage: set -a; . ./.env.local; set +a; npx tsx scripts/news-line/jev_yt_triage.mts [--limit N]
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO, 'data/line-history/line_history.sqlite');
// Sidecar. line_history.sqlite has live collectors writing to it; this run never touches it.
const DB = path.join(REPO, 'data/line-history/jev_yt_triage.sqlite');
const CONCURRENCY = Number(process.env.JEV_CONC ?? 8);
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 3.0);

const QUESTIONS = {
  content_type: {
    type: 'choice' as const,
    instructions:
      'This is the title of a video posted by an NFL team\'s own YouTube channel. What kind of ' +
      'content is it? Pick the single best category.',
    criteria: {
      head_coach_presser:
        'A press conference, podium session or media availability given by the head coach or a ' +
        'coordinator / assistant coach.',
      player_presser:
        'A press conference, podium session, locker-room or media availability given by a player.',
      injury_report:
        'An injury report, practice participation report, roster/availability update, or a ' +
        'segment whose subject is who is hurt or who will play.',
      beat_analysis:
        'Analysis, preview, breakdown, podcast, roundtable or beat-reporter commentary produced ' +
        'by the team\'s media staff.',
      highlights:
        'Game highlights, a single play, a top-plays reel, a hype video or a mic\'d-up segment.',
      game_broadcast:
        'A full or near-full game, a live broadcast, a replay, or a live radio/TV simulcast.',
      other:
        'Anything else: community events, entertainment, features, draft coverage, cheerleaders, ' +
        'sponsorships, behind-the-scenes documentary.',
    },
  },
  // Ordered low -> high. The point of the whole run: which videos would tell us, before kickoff,
  // that a player's availability changed.
  injury_relevance: {
    type: 'score' as const,
    instructions:
      'How much of this video is likely to be about player availability -- injuries, injury ' +
      'designations, practice participation, who is active or inactive, or a return from injury?',
    criteria: [
      'Contains no availability or injury content at all.',
      'Availability might come up in passing, but it is not what the video is about.',
      'A substantial part of the video is about injuries or availability.',
      'Player availability is the entire subject of the video.',
    ],
  },
  names_a_specific_player: {
    type: 'boolean' as const,
    instructions:
      'Does this title name a specific individual person (a player or a coach), as opposed to ' +
      'only teams, units or generic subjects?',
  },
};

const SCORE_LEVELS = ['none', 'incidental', 'substantial', 'entire_subject'];

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=600000');
db.exec(`ATTACH DATABASE 'file:${SRC}?mode=ro' AS src`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_yt_signals (
  video_id TEXT NOT NULL, question TEXT NOT NULL, probability REAL,
  team TEXT, evaluated_at TEXT NOT NULL, PRIMARY KEY (video_id, question))`);
db.exec(`CREATE TABLE IF NOT EXISTS jev_yt_done (
  video_id TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL,
  input_tokens INTEGER, ok INTEGER, error TEXT)`);

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const rows = db.prepare(`
  SELECT y.video_id, y.team, y.title, y.duration_s
  FROM src.yt_channel_index y
  LEFT JOIN jev_yt_done d ON d.video_id = y.video_id
  WHERE d.video_id IS NULL AND y.title IS NOT NULL AND y.title <> ''
  ORDER BY y.team, y.video_id
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}`).all() as any[];

console.log(`${rows.length.toLocaleString()} titles to classify`);

const insSig = db.prepare('INSERT OR REPLACE INTO jev_yt_signals VALUES (?,?,?,?,?)');
const insDone = db.prepare('INSERT OR REPLACE INTO jev_yt_done VALUES (?,?,?,?,?)');

function dur(s: number | null) {
  if (s == null) return 'unknown length';
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m${String(r).padStart(2, '0')}s long`;
}

let ok = 0, failed = 0, tokens = 0, stop = false, cursor = 0;

async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= rows.length) return;
    const r = rows[i];
    const now = new Date().toISOString();
    try {
      const result = await evaluate({
        model: 'typesafe-ai/jev',
        state: `Video on the official YouTube channel of the ${r.team} NFL team, ` +
               `${dur(r.duration_s)}. Title: "${r.title}"`,
        questions: QUESTIONS,
      });
      for (const [q, a] of Object.entries(result.answers as Record<string, any>)) {
        if (!a) continue;
        if (a.type === 'boolean') {
          insSig.run(r.video_id, q, a.probability ?? null, String(r.team), now);
          continue;
        }
        if (a.type === 'score') {
          insSig.run(r.video_id, `${q}.mean`, a.score ?? null, String(r.team), now);
        }
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>)) {
          const name = a.type === 'score' ? (SCORE_LEVELS[Number(k)] ?? k) : k;
          insSig.run(r.video_id, `${q}.${name}`, pr as number, String(r.team), now);
        }
      }
      const used = (result as any).usage?.inputTokens ?? 0;
      tokens += used;
      insDone.run(r.video_id, now, used, 1, null);
      ok++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      insDone.run(r.video_id, now, 0, 0, msg.slice(0, 300));
      failed++;
      if (/authentication|not have access|free tier/i.test(msg)) {
        console.log(`\nSTOPPING: ${msg.slice(0, 160)}`);
        stop = true; return;
      }
    }
    const done = ok + failed;
    if (done % 500 === 0) {
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
