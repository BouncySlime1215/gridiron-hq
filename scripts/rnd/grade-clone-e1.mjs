#!/usr/bin/env node
/**
 * CLONE-01b b2 grade, EVAL E1 shape: the SHIPPED clone update rule
 * (cloneFor in server/services/trade-acceptance.js) against the activity-only
 * baseline, on log loss, over every decided ESPN trade offer in the app DB.
 *
 *   node scripts/rnd/grade-clone-e1.mjs [--db <copy of data.sqlite>] [--seed 7]
 *
 * Opens the DB read-only (default $GRIDIRON_DB_PATH). Prints aggregates only:
 * no league ids, team ids, names or player ids.
 *
 * Prequential, as of each proposal: offer i is scored with only the offers in
 * its league RESOLVED before it was proposed (EVAL E1's rule).
 *   y         TRADE_ACCEPT = 1; TRADE_DECLINE or a counter from the decider = 0.
 *   baseline  activity only (server/services/eval/e1.js on #cloud-e1-fix):
 *             (acc + 5 g) / (n + 5), g = (league acc + 1) / (league n + 2).
 *   clone     cloneFor with the league pool {p0: g, m: 15} and the decider's
 *             earlier replies as the settled evidence, each priced by its gain
 *             for him from as-of dynasty values. Motive and activity are NOT
 *             reconstructable as of old dates and are left out (said in output).
 *   clone_np  the same with every price withheld: isolates the price-relevance
 *             weighting from the shrinkage.
 * Gain = LL(baseline) - LL(model), per offer, mean with a decider-clustered
 * bootstrap 90% CI. Probabilities are clipped to [0.02, 0.98] like E1.
 */
import { DatabaseSync } from 'node:sqlite';
import { cloneFor, packageGainPct } from '../../server/services/trade-acceptance.js';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const dbPath = arg('--db') ?? process.env.GRIDIRON_DB_PATH;
const SEED = Number(arg('--seed') ?? 7);
const RESAMPLES = 1000;
const SHRINK_K = 5;
const POOL_M = 15;
const CLIP = 0.02;
if (!dbPath) { console.error('grade-clone-e1: pass --db or set GRIDIRON_DB_PATH'); process.exit(2); }

const db = new DatabaseSync(dbPath, { readOnly: true });
const has = t => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(t);
if (!has('league_transactions_raw')) { console.log('league_transactions_raw absent: nothing to grade'); process.exit(0); }

/* ------------------------------------------------------------- prices */
const priceOf = (() => {
  if (!has('league_roster_snapshots') || !has('dynasty_values')) return () => null;
  const map = new Map(db.prepare(`SELECT espn_player_id AS e, MAX(player_id) AS p FROM league_roster_snapshots
    WHERE player_id IS NOT NULL GROUP BY espn_player_id`).all().map(r => [String(r.e), r.p]));
  const fmt = db.prepare(`SELECT format_key FROM dynasty_values GROUP BY format_key ORDER BY COUNT(*) DESC LIMIT 1`).get()?.format_key;
  const hist = has('dynasty_value_history') ? db.prepare(`SELECT value FROM dynasty_value_history
    WHERE format_key = ? AND player_id = ? AND captured_on <= ? ORDER BY captured_on DESC LIMIT 1`) : null;
  const now = db.prepare(`SELECT value FROM dynasty_values WHERE format_key = ? AND player_id = ?`);
  return (espnId, date) => {
    const pid = map.get(String(espnId));
    if (pid == null || !fmt) return null;
    const v = hist?.get(fmt, pid, String(date).slice(0, 10))?.value ?? now.get(fmt, pid)?.value;
    return Number.isFinite(v) ? v : null;
  };
})();

/* ------------------------------------------------------------- offers */
const tx = db.prepare(`SELECT league_id, season, tx_id, type, execution_type, team_id, related_tx_id,
  proposed_at, items_json FROM league_transactions_raw`).all();
const key = t => `${t.league_id}:${t.season}:${t.tx_id}`;
const proposals = new Map(tx.filter(t => t.type === 'TRADE_PROPOSAL' && t.execution_type === 'EXECUTE').map(t => [key(t), t]));
/** Items, or null when unreadable: counted in `skipped.unreadable`, never dropped silently. */
const parse = j => {
  try { const x = JSON.parse(j ?? '[]'); return Array.isArray(x) ? x : null; } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
};
const skipped = { unreadable: 0, multi_party: 0, unanswered: 0 };
const offers = [];
for (const p of proposals.values()) {
  const items = parse(p.items_json);
  if (!items) { skipped.unreadable++; continue; }
  const proposer = String(p.team_id);
  const others = [...new Set(items.flatMap(i => [i.fromTeamId, i.toTeamId]).filter(x => x != null && Number(x) > 0).map(String))]
    .filter(x => x !== proposer);
  if (others.length !== 1) { skipped.multi_party++; continue; }
  const decider = others[0];
  const answers = tx.filter(t => t.league_id === p.league_id && t.season === p.season
    && String(t.related_tx_id) === String(p.tx_id) && t.execution_type === 'EXECUTE');
  const acc = answers.find(t => t.type === 'TRADE_ACCEPT');
  const dec = answers.find(t => t.type === 'TRADE_DECLINE')
    ?? answers.find(t => t.type === 'TRADE_PROPOSAL' && String(t.team_id) === decider);
  const a = acc ?? dec;
  if (!a) { skipped.unanswered++; continue; }
  const give = items.filter(i => String(i.fromTeamId) === proposer).map(i => ({ value: priceOf(i.playerId, p.proposed_at) }));
  const get = items.filter(i => String(i.toTeamId) === proposer).map(i => ({ value: priceOf(i.playerId, p.proposed_at) }));
  offers.push({ league: `${p.league_id}:${p.season}`, decider: `${p.league_id}:${decider}`, y: acc ? 1 : 0,
    proposed_at: Date.parse(p.proposed_at), resolved_at: Date.parse(a.proposed_at ?? p.proposed_at),
    gain_pct: packageGainPct(give, get) });
}
offers.sort((a, b) => a.proposed_at - b.proposed_at);

/* ------------------------------------------------------------- score */
const clip = p => Math.min(1 - CLIP, Math.max(CLIP, p));
const ll = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));
const scored = offers.map(o => {
  const before = offers.filter(x => x.league === o.league && x.resolved_at < o.proposed_at);
  const mine = before.filter(x => x.decider === o.decider);
  const g = (before.reduce((s, x) => s + x.y, 0) + 1) / (before.length + 2);
  const base = (mine.reduce((s, x) => s + x.y, 0) + SHRINK_K * g) / (mine.length + SHRINK_K);
  const pool = { p0: g, m: POOL_M };
  const replies = mine.map(x => ({ y: x.y, gain_pct: x.gain_pct }));
  const clone = cloneFor({ counterparty: null, pool, fit: { replies }, gainPct: o.gain_pct }).p;
  const np = cloneFor({ counterparty: null, pool, fit: { replies: replies.map(r => ({ y: r.y, gain_pct: null })) }, gainPct: null }).p;
  return { ...o, base, clone, np };
});

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function gainCI(model) {
  const d = scored.map(o => ({ c: o.decider, v: ll(o.base, o.y) - ll(o[model], o.y) }));
  const mean = d.reduce((s, x) => s + x.v, 0) / (d.length || 1);
  const by = new Map();
  for (const x of d) (by.get(x.c) ?? by.set(x.c, []).get(x.c)).push(x.v);
  const groups = [...by.values()];
  const r = rng(SEED);
  const boots = [];
  for (let b = 0; b < RESAMPLES && groups.length; b += 1) {
    let s = 0; let n = 0;
    for (let i = 0; i < groups.length; i += 1) { const gr = groups[Math.floor(r() * groups.length)]; s += gr.reduce((a, v) => a + v, 0); n += gr.length; }
    boots.push(s / n);
  }
  return { mean, lo: boots.length ? pct(boots, 0.05) : NaN, hi: boots.length ? pct(boots, 0.95) : NaN };
}
const f = x => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
const LL = m => scored.reduce((s, o) => s + ll(o[m], o.y), 0) / (scored.length || 1);

console.log('CLONE-01b b2 · EVAL E1 grade (prequential, as of each proposal)');
console.log(`offers decided: ${scored.length} (accepted ${scored.filter(o => o.y).length}); deciders: ${new Set(scored.map(o => o.decider)).size}; leagues: ${new Set(scored.map(o => o.league)).size}`);
console.log(`skipped: ${JSON.stringify(skipped)}; priced (gain known): ${scored.filter(o => Number.isFinite(o.gain_pct)).length}/${scored.length}`);
console.log('not reconstructable as of old dates, so NOT in this grade: motive offset, activity offset');
console.log(`log loss  activity-only ${f(LL('base'))}  clone ${f(LL('clone'))}  clone_no_price ${f(LL('np'))}`);
for (const m of ['clone', 'np']) {
  const g = gainCI(m);
  console.log(`gain vs activity-only (${m === 'np' ? 'clone_no_price' : 'clone'}): ${f(g.mean)}  90% CI [${f(g.lo)}, ${f(g.hi)}]  (decider-clustered bootstrap, ${RESAMPLES}, seed ${SEED})`);
}
const buckets = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 1.01]];
for (const [lo, hi] of buckets) {
  const b = scored.filter(o => o.clone >= lo && o.clone < hi);
  if (b.length) console.log(`reliability clone [${lo}, ${Math.min(hi, 1)}): n ${b.length} predicted ${f(b.reduce((s, o) => s + o.clone, 0) / b.length)} observed ${f(b.reduce((s, o) => s + o.y, 0) / b.length)}`);
}
