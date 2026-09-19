/**
 * Validate the Jev live-play labels BEFORE anything is built on them.
 *
 * Three checks, each against something Jev never saw:
 *  1. event_class vs a deterministic mapping of espn_plays.type/scoring/stat_yardage. Reports
 *     the confusion matrix, overall agreement, per-class precision/recall, and specifically the
 *     rate at which Jev calls a turnover that the structured data denies.
 *  2. star_player_involved vs whether the play is a pass/sack (a QB is named by construction) --
 *     a discrimination check, reported as AUC.
 *  3. surprise vs |ESPN win-probability change| across the play, from espn_probabilities. This is
 *     the only check that tests the feature that actually matters, and ESPN's model is an
 *     independent judge.
 *
 * Usage: node scripts/live-market/validate_jev_live_plays.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const db = new DatabaseSync(path.join(REPO, 'data/line-history/jev_live_plays.sqlite'));
db.exec('PRAGMA busy_timeout=600000');
db.exec(`ATTACH DATABASE 'file:${path.join(REPO, 'data/line-history/line_history.sqlite')}?mode=ro' AS src`);
db.exec('PRAGMA busy_timeout=600000');

// Deterministic structured label, same taxonomy, precedence = "what a live market reprices on
// hardest first". Written as SQL so it is auditable in one place.
const STRUCT = `
  CASE
    WHEN p.type LIKE '%Touchdown%' THEN 'scoring_td'
    WHEN p.type IN ('Field Goal Good','Field Goal Missed','Blocked Field Goal','Safety',
                    'Missed Field Goal Return','Two Point Pass') THEN 'scoring_fg'
    WHEN p.type LIKE '%Interception%' THEN 'turnover_int'
    WHEN p.type IN ('Fumble Recovery (Opponent)','Sack Opp Fumble Recovery',
                    'Muffed Punt Recovery (Opponent)') THEN 'turnover_fumble'
    WHEN p.type IN ('Punt','Blocked Punt') THEN 'punt'
    WHEN p.type = 'Sack' THEN 'sack'
    WHEN p.type = 'Penalty' THEN 'penalty'
    WHEN p.type IN ('Official Timeout','Timeout','Two-minute warning','End Period','End of Half',
                    'End of Game','End of Regulation','Coin Toss') THEN 'game_state'
    WHEN p.stat_yardage >= 15 THEN 'big_gain'
    WHEN p.stat_yardage <= -5 THEN 'big_loss'
    ELSE 'routine'
  END`;

const rows = db.prepare(`
  SELECT d.event_class AS jev, ${STRUCT} AS structured, p.type AS ptype
  FROM jev_play_done d JOIN src.espn_plays p
    ON p.event_id = d.event_id AND p.play_id = d.play_id
  WHERE d.ok = 1 AND d.event_class IS NOT NULL`).all();

console.log(`n = ${rows.length.toLocaleString()} classified plays with a structured counterpart\n`);

const classes = ['scoring_td','scoring_fg','turnover_int','turnover_fumble','punt','sack',
                 'big_gain','big_loss','penalty','injury','routine','game_state'];
const cm = new Map();
let agree = 0;
for (const r of rows) {
  if (r.jev === r.structured) agree++;
  const k = `${r.structured}|${r.jev}`;
  cm.set(k, (cm.get(k) ?? 0) + 1);
}
console.log(`OVERALL AGREEMENT: ${(100 * agree / rows.length).toFixed(2)}%  (${agree.toLocaleString()}/${rows.length.toLocaleString()})\n`);

console.log('PER-CLASS (structured as reference):');
console.log('class'.padEnd(17) + 'struct_n'.padStart(9) + 'jev_n'.padStart(9) +
            'recall'.padStart(9) + 'precis'.padStart(9) + '   top disagreement');
for (const c of classes) {
  let sn = 0, jn = 0, hit = 0;
  const conf = new Map();
  for (const r of rows) {
    if (r.structured === c) { sn++; if (r.jev === c) hit++; else conf.set(r.jev, (conf.get(r.jev) ?? 0) + 1); }
    if (r.jev === c) jn++;
  }
  const top = [...conf.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(c.padEnd(17) + String(sn).padStart(9) + String(jn).padStart(9) +
    (sn ? (100 * hit / sn).toFixed(1) + '%' : '   -').padStart(9) +
    (jn ? (100 * hit / jn).toFixed(1) + '%' : '   -').padStart(9) +
    (top ? `   ${top[0]} ${top[1]} (${(100 * top[1] / sn).toFixed(1)}%)` : ''));
}

// The question asked for by name: when Jev says turnover, how often does the structured data
// deny it, and what does the structured data say instead?
// Two classes have no honest structured counterpart: `injury` does not exist as an ESPN type at
// all, and `big_loss` is a threshold ESPN never defined (this script guesses <= -5 yards). Report
// agreement with those two excluded so the headline number is not punished for a definition gap.
{
  const sub = rows.filter(r => r.jev !== 'injury' && r.structured !== 'injury' &&
                               r.jev !== 'big_loss' && r.structured !== 'big_loss');
  const a = sub.filter(r => r.jev === r.structured).length;
  console.log(`\nAGREEMENT excluding injury (no ESPN type exists) and big_loss (threshold is this ` +
    `script's guess): ${(100 * a / sub.length).toFixed(2)}%  (${a.toLocaleString()}/${sub.length.toLocaleString()})`);
  // What does the structured data say about the plays Jev calls an injury?
  const ij = rows.filter(r => r.jev === 'injury');
  const by = new Map();
  for (const r of ij) by.set(r.structured, (by.get(r.structured) ?? 0) + 1);
  console.log(`  jev=injury n=${ij.length} -> structured says ` +
    [...by.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' '));
}

console.log('\nTURNOVER FALSE-POSITIVE AUDIT (Jev says turnover, structured disagrees):');
for (const c of ['turnover_int', 'turnover_fumble']) {
  const sub = rows.filter(r => r.jev === c);
  const bad = sub.filter(r => r.structured !== c);
  const by = new Map();
  for (const r of bad) by.set(r.structured, (by.get(r.structured) ?? 0) + 1);
  console.log(`  jev=${c}: n=${sub.length}, disagree ${bad.length} = ` +
    `${sub.length ? (100 * bad.length / sub.length).toFixed(2) : '0.00'}%  -> ` +
    [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' '));
  // and the miss direction
  const truth = rows.filter(r => r.structured === c);
  const missed = truth.filter(r => r.jev !== c);
  console.log(`    structured=${c}: n=${truth.length}, Jev missed ${missed.length} = ` +
    `${truth.length ? (100 * missed.length / truth.length).toFixed(2) : '0.00'}%`);
}

// ---- 2. star_player_involved: passes and sacks name a QB by construction.
const star = db.prepare(`
  SELECT l.value AS p,
         CASE WHEN p.type IN ('Pass Reception','Pass Incompletion','Passing Touchdown','Sack',
                              'Pass Interception Return','Interception Return Touchdown','Pass',
                              'Sack Opp Fumble Recovery') THEN 1 ELSE 0 END AS qb_named
  FROM jev_play_labels l JOIN src.espn_plays p
    ON p.event_id = l.event_id AND p.play_id = l.play_id
  WHERE l.question = 'star_player_involved'
    AND p.type NOT IN ('Official Timeout','Timeout','Two-minute warning','End Period','End of Half',
                       'End of Game','End of Regulation','Coin Toss')`).all();
const pos = star.filter(r => r.qb_named).map(r => r.p);
const neg = star.filter(r => !r.qb_named).map(r => r.p);
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
// Rank-based AUC (Mann-Whitney), ties averaged.
function auc(p, n) {
  const all = [...p.map(v => [v, 1]), ...n.map(v => [v, 0])].sort((a, b) => a[0] - b[0]);
  let i = 0, rsum = 0;
  while (i < all.length) {
    let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rsum += avgRank;
    i = j + 1;
  }
  return (rsum - p.length * (p.length + 1) / 2) / (p.length * n.length);
}
console.log(`\nSTAR_PLAYER_INVOLVED vs "a QB is named by construction" (scrimmage plays only):`);
console.log(`  QB-named plays   n=${pos.length.toLocaleString()}  mean p = ${mean(pos).toFixed(4)}`);
console.log(`  no-QB plays      n=${neg.length.toLocaleString()}  mean p = ${mean(neg).toFixed(4)}`);
console.log(`  AUC = ${auc(pos, neg).toFixed(4)}`);

// ---- 3. surprise vs |ESPN win-probability change|
const sr = db.prepare(`
  WITH wp AS (
    SELECT pr.event_id, pr.play_id, pr.home_wp,
           LAG(pr.home_wp) OVER (PARTITION BY pr.event_id ORDER BY pr.sequence) AS prev_wp
    FROM src.espn_probabilities pr)
  SELECT l.value AS surprise, ABS(wp.home_wp - wp.prev_wp) AS dwp
  FROM jev_play_labels l
  JOIN wp ON wp.event_id = l.event_id AND wp.play_id = l.play_id
  WHERE l.question = 'surprise.mean' AND wp.prev_wp IS NOT NULL`).all();
console.log(`\nSURPRISE vs |ESPN win-probability change|   n = ${sr.length.toLocaleString()}`);
if (sr.length) {
  const bins = [[0, .5], [.5, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, 3], [3, 4]];
  console.log('  surprise.mean      n        mean |dWP|     median |dWP|');
  for (const [lo, hi] of bins) {
    const s = sr.filter(r => r.surprise >= lo && r.surprise < hi).map(r => r.dwp).sort((a, b) => a - b);
    if (!s.length) continue;
    console.log(`  [${lo.toFixed(1)},${hi.toFixed(1)})`.padEnd(14) +
      String(s.length).padStart(8) + (100 * mean(s)).toFixed(3).padStart(14) + 'pp' +
      (100 * s[Math.floor(s.length / 2)]).toFixed(3).padStart(14) + 'pp');
  }
  const xs = sr.map(r => r.surprise), ys = sr.map(r => r.dwp);
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  console.log(`  Pearson r = ${(num / Math.sqrt(dx * dy)).toFixed(4)}`);
}

// ---- injury language spot-check (no structured column exists)
const inj = db.prepare(`
  SELECT l.value AS p, CASE WHEN p.text LIKE '%injur%' OR p.text LIKE '%shaken up%'
         OR p.text LIKE '%carted%' OR p.text LIKE '%helped off%' THEN 1 ELSE 0 END AS textual
  FROM jev_play_labels l JOIN src.espn_plays p
    ON p.event_id = l.event_id AND p.play_id = l.play_id
  WHERE l.question = 'injury_severity.mean'`).all();
const it = inj.filter(r => r.textual).map(r => r.p), inot = inj.filter(r => !r.textual).map(r => r.p);
console.log(`\nINJURY_SEVERITY vs injury words in the text:`);
console.log(`  text mentions injury  n=${it.length.toLocaleString()}  mean score = ${mean(it).toFixed(4)}`);
console.log(`  text does not         n=${inot.length.toLocaleString()}  mean score = ${mean(inot).toFixed(4)}`);
console.log(`  false-positive rate (no injury words but score>0.5): ` +
  `${(100 * inot.filter(v => v > 0.5).length / (inot.length || 1)).toFixed(3)}%`);

// ---- cost & throughput
const c = db.prepare(`SELECT COUNT(*) n, SUM(input_tokens) tok, SUM(ok) ok,
  MIN(evaluated_at) t0, MAX(evaluated_at) t1 FROM jev_play_done`).get();
console.log(`\nCOST/THROUGHPUT: ${Number(c.ok).toLocaleString()} ok of ${Number(c.n).toLocaleString()} rows, ` +
  `${Number(c.tok).toLocaleString()} input tokens = $${((c.tok / 1e6) * 0.042).toFixed(4)} ` +
  `(${(c.tok / c.n).toFixed(0)} tok/play)`);
