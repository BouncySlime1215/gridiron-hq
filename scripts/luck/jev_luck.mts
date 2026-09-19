/**
 * TEST 1 — LUCK VERSUS SKILL, PLAY BY PLAY.
 * Score every interception / fumble / blocked-kick play 2016-2025 REG on a LUCK axis from its
 * gamebook text. Writes to a scratch DB; line_history.sqlite stays read-only.
 */
import { experimental_evaluate as evaluate } from 'ai';
import { DatabaseSync } from 'node:sqlite';

const SRC = '/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/line_history.sqlite';
const NV  = '/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/nflverse.sqlite';
const OUT = process.env.OUT_DB!;
const CONCURRENCY = 12;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 3.0);

const QUESTIONS = {
  // index 0 = pure skill ... index 4 = pure luck. Higher mean = luckier.
  luck: {
    type: 'score' as const,
    instructions:
      'This is the official play-by-play description of an NFL play on which the ball came ' +
      'loose, was intercepted, or a kick was blocked. Judge ONLY how the loose ball or ' +
      'interception came about. How much of this outcome was earned by the defense executing, ' +
      'versus how much was fortune -- a tipped or deflected ball landing in a defender\'s hands, ' +
      'a bad bounce, an aborted or muffed snap or exchange, a ball popping out with no defender ' +
      'forcing it, a desperation or Hail Mary throw, an untouched runner losing the ball. Ignore ' +
      'how many yards were returned and whether it was a touchdown.',
    criteria: [
      'Entirely earned: the defense forced this directly -- a clean strip, a defender ripping the ball out, a punched-out ball, a jumped route with the defender undercutting the intended receiver, a read and broken-up throw caught cleanly.',
      'Mostly earned: clear defensive pressure or coverage caused it, with some fortune in the result -- a sack-strip where the ball happened to bounce to the defense, pressure forcing an errant throw a defender ran down.',
      'A mix of skill and fortune: both contributed roughly equally, or the description does not make the cause clear.',
      'Mostly fortunate: a tipped or deflected pass, a ball off the receiver\'s hands, a ball off a body, a throw away from anyone that a defender happened to be under.',
      'Almost entirely fortunate: an aborted snap or botched exchange, a muffed punt or kick, a ball that simply popped loose with no defender credited, a bad bounce recovered by chance, a desperation heave at the end of a half or game.',
    ],
  },
  possession_lost: {
    type: 'boolean' as const,
    instructions:
      'On this play, did the team that had the ball actually LOSE possession to the other team? ' +
      'True for an interception or a fumble recovered by the opponent. False if the offense ' +
      'recovered its own fumble, or possession did not change hands.',
  },
  event_kind: {
    type: 'choice' as const,
    instructions: 'What kind of loose-ball or takeaway event does this description show?',
    criteria: {
      interception: 'A forward pass was intercepted.',
      fumble_lost: 'A fumble was recovered by the opposing team.',
      fumble_kept: 'A fumble was recovered by the fumbling team itself.',
      blocked_kick: 'A punt, field goal or extra point was blocked.',
      muff: 'A punt or kickoff return man muffed the catch.',
      other: 'Anything else.',
    },
  },
};
const LEVELS = ['earned', 'mostly_earned', 'mixed', 'mostly_lucky', 'pure_luck'];

const src = new DatabaseSync(SRC, { readOnly: true } as any);
src.exec(`ATTACH DATABASE 'file:${NV}?mode=ro' AS nv`);
const rows = src.prepare(`
  SELECT p.event_id, p.play_id, p.text, p.type, p.scoring, p.stat_yardage,
         p.period, p.start_team, g.game_id, g.season, g.week
  FROM espn_plays p
  JOIN nv.nfldata_games g ON CAST(g.espn AS TEXT)=p.event_id
  WHERE g.game_type='REG' AND g.season BETWEEN 2016 AND 2025
    AND (p.text LIKE '%INTERCEPTED%' OR p.text LIKE '%FUMBLES%'
         OR p.text LIKE '%MUFFS%' OR p.text LIKE '%BLOCKED%')
    AND p.text IS NOT NULL AND LENGTH(p.text) > 25
  ORDER BY g.season, g.week, p.event_id, p.play_id`).all() as any[];
src.close();

const out = new DatabaseSync(OUT);
out.exec('PRAGMA journal_mode=WAL');
out.exec('PRAGMA busy_timeout=120000');
out.exec(`CREATE TABLE IF NOT EXISTS jev_luck (
  event_id TEXT, play_id TEXT, question TEXT, value REAL,
  game_id TEXT, season INTEGER, week INTEGER, start_team TEXT, espn_type TEXT,
  scoring INTEGER, stat_yardage INTEGER, PRIMARY KEY(event_id, play_id, question))`);
out.exec(`CREATE TABLE IF NOT EXISTS jev_luck_done (
  event_id TEXT, play_id TEXT, ok INTEGER, tok INTEGER, err TEXT,
  PRIMARY KEY(event_id, play_id))`);
const doneSet = new Set((out.prepare('SELECT event_id, play_id FROM jev_luck_done WHERE ok=1').all() as any[]).map((r:any) => `${r.event_id}|${r.play_id}`));
const todo = rows.filter(r => !doneSet.has(`${r.event_id}|${r.play_id}`));
console.log(`${rows.length} candidate plays, ${todo.length} still to score`);

const ins = out.prepare('INSERT OR REPLACE INTO jev_luck VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const insDone = out.prepare('INSERT OR REPLACE INTO jev_luck_done VALUES (?,?,?,?,?)');

let ok = 0, failed = 0, tokens = 0, stop = false, cursor = 0;
async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= todo.length) return;
    const r = todo[i];
    try {
      const res = await evaluate({
        model: 'typesafe-ai/jev',
        state: `NFL play-by-play description: ${r.text}`,
        questions: QUESTIONS,
      });
      const put = (q: string, v: number | null) =>
        ins.run(r.event_id, r.play_id, q, v, r.game_id, r.season, r.week,
                String(r.start_team), r.type, r.scoring, r.stat_yardage);
      for (const [q, a] of Object.entries(res.answers as Record<string, any>)) {
        if (!a) continue;
        if (a.type === 'boolean') { put(q, a.probability ?? null); continue; }
        if (a.type === 'score') put(`${q}.mean`, a.score ?? null);
        for (const [k, pr] of Object.entries((a.probabilities ?? {}) as Record<string, number>)) {
          put(`${q}.${a.type === 'score' ? (LEVELS[Number(k)] ?? k) : k}`, pr as number);
        }
      }
      const used = (res as any).usage?.inputTokens ?? 0;
      tokens += used; insDone.run(r.event_id, r.play_id, 1, used, null); ok++;
    } catch (e: any) {
      const m = String(e?.message ?? e);
      insDone.run(r.event_id, r.play_id, 0, 0, m.slice(0, 250)); failed++;
      if (/authentication|not have access|free tier|quota/i.test(m)) {
        console.log(`STOPPING: ${m.slice(0, 200)}`); stop = true; return;
      }
    }
    const d = ok + failed;
    if (d % 250 === 0) {
      const usd = (tokens / 1e6) * 0.042;
      console.log(`  ${d}/${todo.length} ok=${ok} fail=${failed} ${tokens.toLocaleString()} tok ~$${usd.toFixed(4)}`);
      if (usd > MAX_USD) { console.log('budget reached'); stop = true; return; }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`DONE ok=${ok} fail=${failed} tokens=${tokens} ~$${((tokens/1e6)*0.042).toFixed(4)}`);
