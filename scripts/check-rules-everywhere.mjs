#!/usr/bin/env node
/**
 * RULES-EVERYWHERE check: does any trade-suggesting surface serve a trade that breaks one of Nick's hard
 * rules? Calls each service directly (no HTTP, no auth) for one league and Nick's team in it, against
 * GRIDIRON_DB_PATH, and checks every package it would serve from Nick's side.
 *
 *   GRIDIRON_DB_PATH=<copy> GRIDIRON_WARROOM_PLANS=<plans copy> node scripts/check-rules-everywhere.mjs [--league 4]
 *
 * Read-only: nothing here writes, and after the imports the shared connection is switched to
 * PRAGMA query_only, so a surface that tries to write fails loudly instead. Point it at a COPY anyway
 * (importing the app creates any missing tables). No model call is made: a surface that needs one
 * reads its cached answer or is reported as not run.
 *
 * The rules are re-stated here on purpose, from the raw tables, rather than read from
 * campaign/never-give.js: the check must not be graded by the code it checks.
 *   never give 160, 80, 277 | never get 290 or a player Nick traded away this season (any team)
 *   every get with a served blue-chip score scores 83+ | every player priced by FantasyCalc (fc_value)
 *   Nick never gives more fc_value than he gets (the +12% depth-only 2-for-1 exception needs lineup
 *   points and title odds, which no surface here carries, so it never applies)
 *
 * FantasyPros exposure (Nick's rule: never displayed or committed): the War Room view and Coach's
 * plan_read of the blue-chip board, as served, must carry no key matching /^fp_|fantasypros/i.
 *
 * Prints one PASS/FAIL line per surface (ids and counts only) and a total. Exit 1 on any violation.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.SCHEDULER_DISABLED = '1';
if (!process.env.GRIDIRON_DB_PATH) { console.error('GRIDIRON_DB_PATH is not set (point it at a copy of the app DB)'); process.exit(2); }
const argLeague = process.argv.indexOf('--league');
const LEAGUE = Number(argLeague > 0 ? process.argv[argLeague + 1] : 4);

const { db, row, rows } = await import('../server/db/index.js');
// Side-effect imports the engine needs (tables some routes create on import), as the app does.
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const engine = await import('../server/services/trade-engine.js');
const { titleOddsTrades } = await import('../server/services/title-odds-trades.js');
const proposals = await import('../server/services/trade-proposals.js');
const negotiate = await import('../server/services/warroom-negotiate.js');
const negotiateRoute = await import('../server/routes/warroom-negotiate.js');
const coachTools = await import('../server/services/coach/tools.js');
const neverGive = await import('../server/services/campaign/never-give.js');
db.exec('PRAGMA query_only = ON');

const S = x => String(x);
// The league row without its credential columns: they are never selected, so never read.
const SECRET = /espn_s2|swid|cookie|token|secret/i;
const cols = rows('PRAGMA table_info(leagues)').map(c => c.name).filter(c => !SECRET.test(c));
const lgFull = row(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM leagues WHERE id = ?`, LEAGUE);
if (!lgFull) { console.error(`league ${LEAGUE} not found`); process.exit(2); }
const lg = lgFull;
const ME = S(lg.my_team_id);

/* ------------------------------------------------------------ the rules, from the raw tables */
const NEVER_GIVE = new Set(['160', '80', '277']);
const NEVER_GET = new Set(['290']);
const fc = new Map(rows(`SELECT player_id, value FROM player_metrics WHERE source = 'fc_value'`).map(r => [S(r.player_id), Number(r.value)]));
const sold = new Set();
{
  const tx = rows(`SELECT items_json FROM league_transactions_raw WHERE league_id = ? AND season = ? AND type = 'TRADE_ACCEPT'
                   AND execution_type = 'PROCESS' AND status = 'EXECUTED'`, LEAGUE, lg.season);
  const byEspn = new Map();
  for (const r of rows('SELECT id, espn_id FROM players WHERE espn_id > 0')) byEspn.set(S(r.espn_id), [...(byEspn.get(S(r.espn_id)) ?? []), S(r.id)]);
  for (const t of tx) for (const i of JSON.parse(t.items_json || '[]')) {
    if (S(i.fromTeamId) !== ME || !(Number(i.toTeamId) > 0)) continue;
    const hit = byEspn.get(S(i.playerId));
    if (hit?.length === 1) sold.add(hit[0]);
  }
}
const plansFile = process.env.GRIDIRON_WARROOM_PLANS || path.join(os.homedir(), 'gridiron-local', 'warroom', 'plans.json');
const score = new Map();
if (fs.existsSync(plansFile)) {
  const entry = (JSON.parse(fs.readFileSync(plansFile, 'utf8')).leagues ?? []).find(l => S(l.league) === S(LEAGUE));
  if (entry?.blue_chips?.status === 'ok') for (const r of entry.blue_chips.value.rows ?? []) score.set(S(r.player), Number(r.score));
}

/** Violations of one package from Nick's side: [] when it may be served. */
function violations(give, get) {
  const g = give.map(S), r = get.map(S), v = [];
  for (const id of g) if (NEVER_GIVE.has(id)) v.push(`gives ${id}`);
  for (const id of r) {
    if (NEVER_GET.has(id)) v.push(`gets ${id}`);
    if (sold.has(id)) v.push(`gets sold ${id}`);
    if (score.has(id) && score.get(id) < 83) v.push(`gets ${id} scored ${score.get(id)}`);
  }
  const unpriced = [...g, ...r].filter(id => !fc.has(id));
  if (unpriced.length) v.push(`no fc_value ${unpriced.join(',')}`);
  else {
    const gv = g.reduce((s, id) => s + fc.get(id), 0), rv = r.reduce((s, id) => s + fc.get(id), 0);
    if (gv > rv + 1e-9) v.push(`overpays ${(((gv - rv) / Math.max(rv, 1)) * 100).toFixed(1)}%`);
  }
  return v;
}
const ids = list => (list ?? []).map(x => (x && typeof x === 'object' ? x.id ?? x.player_id : x)).filter(x => x != null).map(S);

/* ------------------------------------------------------------ the surfaces */
const results = [];
function surface(name, fn) {
  const t0 = Date.now();
  try {
    const out = fn();
    if (out?.skip) { results.push({ name, skip: out.skip }); return; }
    const bad = out.packages.map(p => ({ ...p, v: violations(p.give, p.get) })).filter(p => p.v.length);
    results.push({ name, n: out.packages.length, bad, dropped: out.dropped, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, error: String(e?.message ?? e).slice(0, 160) });
  }
}
const fromDeals = deals => (deals ?? []).map(d => ({ give: ids(d.i_give), get: ids(d.i_get) }));
const fromLadder = (l, get) => ['offers', 'alternatives'].flatMap(k => (l[k] ?? []).map(p => ({ give: ids(p.i_give), get })))
  .concat(['open_with', 'fair', 'max'].filter(k => l[k]?.i_give).map(k => ({ give: ids(l[k].i_give), get })));

surface('find', () => {
  const out = engine.findTrades(lgFull, { myTeamId: ME, maxPerSide: 2, requireMutual: true, limit: 20 });
  return { packages: [...fromDeals(out.deals), ...fromDeals(out.title_mutual?.deals)], dropped: out.dropped_by_rule };
});
surface('post-draft-plan', () => {
  const out = engine.findTrades(lgFull, { myTeamId: ME, maxPerSide: 2, requireMutual: true, limit: 5 });
  return { packages: fromDeals(out.deals), dropped: out.dropped_by_rule };
});
surface('find/sequences', () => {
  const out = engine.findTradeSequences(lgFull, { myTeamId: ME, maxPerSide: 2, requireMutual: true });
  return { packages: [...fromDeals(out.deals), ...fromDeals(out.step1 ? [out.step1] : []), ...fromDeals(out.sequences)], dropped: out.dropped_by_rule };
});
// The targets: 290 (never get) and the other team's highest-priced player that breaks no rule as a get.
const others = rows(`SELECT player_id FROM player_metrics WHERE source = 'fc_value' ORDER BY value DESC`).map(r => S(r.player_id));
surface('offer (target 290)', () => {
  const out = engine.offerFor(lgFull, { myTeamId: ME, targetId: 290 });
  return { packages: fromLadder(out, ['290']), dropped: out.dropped_by_rule };
});
surface('offer-many (290 + best priced)', () => {
  const pick = others.find(id => !NEVER_GET.has(id) && !sold.has(id) && id !== '290') ?? null;
  const out = engine.offerForMany(lgFull, { myTeamId: ME, targetIds: [290, ...(pick ? [Number(pick)] : [])] });
  return { packages: (out.ladders ?? []).flatMap(l => fromLadder(l, ids(l.targets))), dropped: out.dropped_by_rule };
});
surface('title-trades', () => {
  const out = titleOddsTrades(LEAGUE, { teamId: ME, shortlist: 4, runs: 200 });
  if (out.error) return { skip: `not run: ${out.error}` };
  return { packages: fromDeals(out.deals), dropped: out.dropped_by_rule };
});
surface('proposals (cached slate only)', () => {
  const found = engine.findTrades(lgFull, { myTeamId: ME, requireMutual: true, limit: proposals.PROPOSAL_SLATE_SIZE });
  const ideas = found.deals ?? [];
  const key = ideas.length ? proposals.cacheKeyFor(LEAGUE, ideas) : null;
  const hit = key ? proposals.dbCache(LEAGUE).get(key) : null;
  if (!hit?.proposals?.length) return { skip: 'not run: no cached proposal slate for the current ideas (no model call is made)' };
  const served = proposals.gateProposals ? proposals.gateProposals(neverGive.ruleGate({ row, rows }, { leagueId: LEAGUE, teamId: ME }), hit, ideas).kept : hit.proposals;
  const byName = new Map(ideas.flatMap(i => [...i.i_give, ...i.i_get]).map(p => [String(p.name).toLowerCase(), S(p.id)]));
  return { packages: served.map(p => ({ give: (p.package?.i_give ?? []).map(n => byName.get(String(n).toLowerCase()) ?? `?${n.length}`),
    get: (p.package?.i_get ?? []).map(n => byName.get(String(n).toLowerCase()) ?? `?${n.length}`) })) };
});
surface('warroom negotiation threads', () => {
  const list = negotiate.threadsFor(LEAGUE, { now: Date.now() });
  if (!list.length) return { skip: 'not run: no negotiation thread in this league' };
  const gate = negotiateRoute.gateThreadView ? v => negotiateRoute.gateThreadView(neverGive.ruleGate({ row, rows }, { leagueId: LEAGUE }), v) : v => v;
  const packages = [];
  for (const t of list) {
    const v = gate(negotiate.threadView(t, negotiate.eventsOf(t.id), null, Date.now()));
    for (const b of v.branches ?? []) {
      if (b.plan?.status !== 'ok') continue;
      const walk = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk);
        if (Array.isArray(x.give) && Array.isArray(x.get)) packages.push({ give: ids(x.give), get: ids(x.get) });
        for (const k of ['next_rung_give', 'walk_away_give']) if (Array.isArray(x[k])) packages.push({ give: ids(x[k]), get: ids(v.get) });
        for (const [k, y] of Object.entries(x)) if (k !== 'give' && k !== 'get') walk(y); };
      walk(b.plan.value);
    }
  }
  return { packages };
});
surface('coach draft message', () => {
  const nm = row('SELECT name FROM players WHERE id = 80')?.name;
  if (!nm) return { skip: 'not run: player 80 is not in this DB' };
  const out = coachTools.runCoachTool('warroom_draft_message', { type: 'draft_message', text: `Would you take ${nm} for your guy` }, {});
  // A served draft that names player 80 is a package giving 80.
  return { packages: out.action ? [{ give: ['80'], get: [] }] : [], dropped: out.dropped_by_rule };
});

/* ------------------------------------------------------------ FantasyPros exposure */
// Nick's rule: FantasyPros is never displayed or committed, so no client payload carries its fields.
// Each client-facing view is built as the route serves it (through the /api guard when it exists) and
// scanned for keys matching /^fp_|fantasypros/i (Coach's flattened columns: /(^|_)fp(_|$)/).
let guard = null;
try { guard = await import('../server/services/fantasypros-guard.js'); } catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const asServed = body => (guard ? guard.stripFantasyPros(body) : body);
const FP = /^fp_|fantasypros/i;
function fpKeys(value, at = '', out = new Map()) {
  if (Array.isArray(value)) value.forEach(v => fpKeys(v, `${at}[]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FP.test(k) || k === 'fp') out.set(`${at}.${k}`, (out.get(`${at}.${k}`) ?? 0) + 1);
      fpKeys(v, `${at}.${k}`, out);
    }
  }
  return out;
}
async function fpSurface(name, fn) {
  try {
    const out = await fn();
    if (out?.skip) { results.push({ name, skip: out.skip }); return; }
    results.push({ name, fp: out });
  } catch (e) { results.push({ name, error: String(e?.message ?? e).slice(0, 160) }); }
}
await fpSurface('fantasypros: war-room view', async () => {
  process.env.GRIDIRON_WARROOM_ENABLED = '1';
  const { warRoomView } = await import('../server/services/war-room-view.js');
  const view = await warRoomView(LEAGUE);
  if (!view?.enabled) return { skip: 'not run: War Room view is off' };
  return fpKeys(asServed(view));
});
await fpSurface('fantasypros: coach plan_read blue_chips', async () => {
  const { planRead } = await import('../server/services/coach/brain-tools.js');
  const cols = new Map();
  for (const r of planRead({ league_id: LEAGUE, section: 'blue_chips' })) {
    for (const k of Object.keys(r)) if (/(^|_)fp(_|$)|fantasypros/i.test(k)) cols.set(k.replace(/_\d+_/g, '_N_'), (cols.get(k.replace(/_\d+_/g, '_N_')) ?? 0) + 1);
  }
  return cols;
});

/* ------------------------------------------------------------ report */
let fail = 0;
for (const r of results) {
  if (r.skip) { console.log(`SKIP ${r.name}: ${r.skip}`); continue; }
  if (r.error) { fail++; console.log(`FAIL ${r.name}: error ${r.error}`); continue; }
  if (r.fp) {
    const n = [...r.fp.values()].reduce((a, b) => a + b, 0);
    if (n) { fail++; console.log(`FAIL ${r.name}: ${n} FantasyPros keys reach the client (${[...r.fp.keys()].slice(0, 4).join(', ')})`); }
    else console.log(`PASS ${r.name}: 0 FantasyPros keys`);
    continue;
  }
  const d = r.dropped == null ? 'no dropped_by_rule' : `dropped_by_rule ${r.dropped}`;
  if (r.bad.length) {
    fail++;
    const ex = r.bad.slice(0, 3).map(p => `[give ${p.give.join('+') || '-'} get ${p.get.join('+') || '-'}: ${p.v.join('; ')}]`).join(' ');
    console.log(`FAIL ${r.name}: ${r.bad.length} of ${r.n} served packages break a rule (${d}) ${ex}`);
  } else {
    console.log(`PASS ${r.name}: ${r.n} served packages, 0 break a rule (${d})`);
  }
}
const run = results.filter(r => !r.skip).length;
console.log(`TOTAL league ${LEAGUE} team ${ME}: ${run - fail} of ${run} surfaces pass, ${results.filter(r => r.skip).length} not run; rules: sold ${sold.size}, fc_value ${fc.size}, scored ${score.size}`);
process.exit(fail ? 1 : 0);
