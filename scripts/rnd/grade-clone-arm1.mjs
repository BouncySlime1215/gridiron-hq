#!/usr/bin/env node
/**
 * CLONE-01b b2, PRE clone test Arm 1 (primary): Sleeper 2024 waiver choices,
 * managers with >= 10 prior claims. Pre-registered in docs/tdd/clone-01b-b2.tdd.md
 * ("Pre-registration, Arm 1"), committed before this script existed.
 *
 *   node scripts/rnd/grade-clone-arm1.mjs --sleeper <copy of sleeper_history.sqlite> \
 *     --app <copy of data.sqlite> [--seed 7]
 *
 * Opens both DBs read-only. Reads season 2024 only (2025 is never opened).
 * Prints aggregates only: no league, roster or player ids.
 *
 * Waivers have no price and no decline, so this tests the clone's per-manager
 * update alone, in the categorical form of the shipped rule (k + m p0)/(n + m):
 *   pool       the league's earlier claims by position, (count + 1)/(N + 6)
 *   clone      (his count + 15 p0)/(his n + 15)     m = 15, as shipped
 *   baseline   (his count + 5 p0)/(his n + 5)       EVAL E1 activity-only shape
 *   population p0 alone                             the clone at n = 0
 * Gain = LL(reference) - LL(clone), per claim; manager-clustered bootstrap 90% CI.
 */
import { DatabaseSync } from 'node:sqlite';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const sleeperPath = arg('--sleeper');
const appPath = arg('--app');
const SEED = Number(arg('--seed') ?? 7);
const RESAMPLES = 1000;
const MIN_PRIOR = 10;
const CLONE_M = 15;
const BASE_K = 5;
const SEASON = 2024;
const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
if (!sleeperPath || !appPath) {
  console.error('grade-clone-arm1: pass --sleeper and --app (sqlite .backup copies)');
  process.exit(2);
}

const app = new DatabaseSync(appPath, { readOnly: true });
const hasApp = t => !!app.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(t);
const posOf = new Map();
for (const t of ['players', 'off_sleeper_players']) {   // later wins: the Sleeper table is the better map
  if (!hasApp(t)) continue;
  for (const r of app.prepare(`SELECT sleeper_id AS s, position AS p FROM ${t} WHERE sleeper_id IS NOT NULL`).all()) {
    if (POS.includes(r.p)) posOf.set(String(r.s), r.p);
  }
}
app.close();
/** A team defence is keyed by its abbreviation in Sleeper. */
const position = id => posOf.get(String(id)) ?? (/^[A-Z]{2,3}$/.test(String(id)) ? 'DEF' : null);

const db = new DatabaseSync(sleeperPath, { readOnly: true });
const claims = db.prepare(`SELECT t.league_id, t.week, t.seq, t.created_ms, t.adds_json
  FROM sh_transactions t JOIN sh_leagues l ON l.league_id = t.league_id
  WHERE l.season = ? AND l.season <> 2025 AND t.type = 'waiver' AND t.status = 'complete'
  ORDER BY t.league_id, t.week, t.created_ms, t.seq`).all(SEASON);
db.close();

const skipped = { multi_add: 0, unreadable: 0, unmapped: 0 };
const byLeague = new Map();
for (const c of claims) {
  let adds;
  try { adds = JSON.parse(c.adds_json ?? '{}'); } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    skipped.unreadable++;
    continue;
  }
  const entries = Object.entries(adds ?? {});
  if (entries.length !== 1) { skipped.multi_add++; continue; }
  const [pid, roster] = entries[0];
  const p = position(pid);
  if (!p) { skipped.unmapped++; continue; }
  (byLeague.get(c.league_id) ?? byLeague.set(c.league_id, []).get(c.league_id)).push({ roster: String(roster), p });
}

const clip = x => Math.max(1e-6, x);
const scored = [];
for (const [league, list] of byLeague) {
  const pool = Object.fromEntries(POS.map(p => [p, 0]));
  let N = 0;
  const mine = new Map();
  for (const e of list) {
    const his = mine.get(e.roster) ?? mine.set(e.roster, { n: 0, c: Object.fromEntries(POS.map(p => [p, 0])) }).get(e.roster);
    if (his.n >= MIN_PRIOR) {
      const p0 = q => (pool[q] + 1) / (N + POS.length);
      const shrink = s => q => (his.c[q] + s * p0(q)) / (his.n + s);
      scored.push({ manager: `${league}:${e.roster}`, league,
        clone: -Math.log(clip(shrink(CLONE_M)(e.p))),
        base: -Math.log(clip(shrink(BASE_K)(e.p))),
        pop: -Math.log(clip(p0(e.p))) });
    }
    his.n++; his.c[e.p]++;
    pool[e.p]++; N++;
  }
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function gainCI(ref) {
  const by = new Map();
  for (const o of scored) (by.get(o.manager) ?? by.set(o.manager, []).get(o.manager)).push(o[ref] - o.clone);
  const groups = [...by.values()].map(g => [g.reduce((s, v) => s + v, 0), g.length]);
  const mean = scored.reduce((s, o) => s + o[ref] - o.clone, 0) / (scored.length || 1);
  const r = rng(SEED);
  const boots = [];
  for (let b = 0; b < RESAMPLES && groups.length; b += 1) {
    let s = 0; let n = 0;
    for (let i = 0; i < groups.length; i += 1) { const g = groups[Math.floor(r() * groups.length)]; s += g[0]; n += g[1]; }
    boots.push(s / n);
  }
  return { mean, lo: pct(boots, 0.05), hi: pct(boots, 0.95) };
}
const f = x => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
const LL = k => scored.reduce((s, o) => s + o[k], 0) / (scored.length || 1);
const verdict = g => (g.lo > 0 ? 'PASS (CI lower > 0)' : g.hi < 0 ? 'FAIL (CI upper < 0)' : 'not decided (CI spans 0)');

console.log(`CLONE-01b b2 · PRE Arm 1 · Sleeper ${SEASON} waiver choices (position claimed), prequential`);
console.log(`complete waiver claims read: ${claims.length}; skipped ${JSON.stringify(skipped)}`);
console.log(`graded claims (manager has >= ${MIN_PRIOR} earlier claims): ${scored.length}; managers: ${new Set(scored.map(o => o.manager)).size}; leagues: ${new Set(scored.map(o => o.league)).size}`);
console.log('not testable on waivers, so NOT in this grade: price relevance, price bound, motive, activity');
console.log(`log loss  population ${f(LL('pop'))}  activity-only(k=${BASE_K}) ${f(LL('base'))}  clone(m=${CLONE_M}) ${f(LL('clone'))}`);
const primary = gainCI('base');
const secondary = gainCI('pop');
console.log(`PRIMARY gain clone vs activity-only: ${f(primary.mean)}  90% CI [${f(primary.lo)}, ${f(primary.hi)}]  ${verdict(primary)}  (manager-clustered bootstrap, ${RESAMPLES}, seed ${SEED})`);
console.log(`secondary gain clone vs population: ${f(secondary.mean)}  90% CI [${f(secondary.lo)}, ${f(secondary.hi)}]  ${verdict(secondary)}`);
