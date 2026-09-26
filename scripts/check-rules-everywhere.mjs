#!/usr/bin/env node
/**
 * RULES-EVERYWHERE check: does any trade-suggesting surface serve a trade that breaks one of Nick's hard
 * rules? Calls each service directly (no HTTP, no auth) for one league and Nick's team in it, against
 * GRIDIRON_DB_PATH, and checks every package it would serve from Nick's side.
 *
 *   GRIDIRON_DB_PATH=<copy> node scripts/check-rules-everywhere.mjs [--league 4]
 *   (point the War Room plans-path variable, server/services/warroom-flag.js, at a copy of the plans too)
 *
 * Read-only: nothing here writes, and after the imports the shared connection is switched to
 * PRAGMA query_only, so a surface that tries to write fails loudly instead. Point it at a COPY anyway
 * (importing the app creates any missing tables). No model call is made: a surface that needs one
 * reads its cached answer or is reported as not run.
 *
 * The rules are re-stated here on purpose, from the raw tables, rather than read from
 * campaign/never-give.js: the check must not be graded by the code it checks.
 *   never give 160, 80, 277 | never get 290 or a player Nick traded away this season (any team)
 *   every get scores 83+ on the served blue-chip board (unscored fails) | every player priced by FantasyCalc (fc_value)
 *   Nick never gives more fc_value than he gets (the +12% depth-only 2-for-1 exception needs lineup
 *   points and title odds, which no surface here carries, so it never applies)
 *   STEP-REGRET: every served step of the War Room plan (the file and the view as served) gains title
 *   odds on its own (a step at or below 0 breaks "every move beats doing nothing")
 *   STEP-OVERPAY: every served step of the War Room plan passes the overpay rule on its own (cap 0; +12%
 *   only on a depth-only 2-for-1 whose served lineup-points and title-odds deltas both rise)
 *   PROTECTED-UPGRADE (Nick 2026-09-26): outside the War Room plan 160 and 80 are still never given (no
 *   surface there carries a step's rise). In the served plan a step may give one only when his setting
 *   (warroom_requests protect.mode, Nick's rows; none -> Blue chips only) is Blue chips only, a get
 *   scores 83+ AND above him on the served board AND has a higher fc_value, the step's served
 *   confirmed lineup-points and playoff-odds deltas are both > 0, and the card needs Nick's OK (it is
 *   next_move only once he OK'd it)
 *
 * FantasyPros exposure (Nick's rule: never displayed or committed): the War Room view and Coach's
 * plan_read of the blue-chip board, as served, must carry no key matching /^fp_|fantasypros/i.
 *
 * Prints one PASS/FAIL line per surface (ids and counts only) and a total. Exit 1 on any violation.
 */
import fs from 'node:fs';
import path from 'node:path';

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
const newsLag = await import('../server/services/news-lag-trader.js');
const neverGive = await import('../server/services/campaign/never-give.js');
const { warRoomPlansPath, WARROOM_ENV } = await import('../server/services/warroom-flag.js');
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
const plansFile = warRoomPlansPath();
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
    if (!score.has(id)) v.push(`gets ${id} unscored`);
    else if (score.get(id) < 83) v.push(`gets ${id} scored ${score.get(id)}`);
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
surface('news-edge (buys and claims)', () => {
  const raw = newsLag.newsOpportunities(LEAGUE, { myTeamId: ME, hours: 24 * 21 });
  if (raw.error) return { skip: `not run: ${raw.error}` };
  // Served the way the route serves it (routes/trades.js /news-edge): through news-lag-trader.js#gateNewsEdge.
  const out = newsLag.gateNewsEdge(raw, neverGive.ruleGate({ row, rows }, { leagueId: LEAGUE, teamId: ME }));
  // A buy is a trade: every rule. A claim is not: only never get and no buy-back apply, so its
  // package is checked with those two alone (a get of 290 or of a sold player is still a violation).
  const buys = (out.opportunities ?? []).filter(o => ['buy_beneficiary', 'buy_low'].includes(o.action?.kind));
  const claims = (out.opportunities ?? []).filter(o => o.action?.kind === 'claim_waiver');
  const bad = claims.map(o => S(o.action.target_id)).filter(id => NEVER_GET.has(id) || sold.has(id));
  return { packages: [...buys.map(o => ({ give: [], get: ids([o.action.target_id]) })),
    ...bad.map(id => ({ give: [], get: [id] }))], dropped: out.dropped_by_rule };
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

/* ------------------------------------------------------------ STEP-REGRET on the served numbers */
// Nick's rule "every move beats doing nothing, per step" (restated in scripts/rules/step-regret-check.mjs, not
// imported from the code it checks). The plans file as the producer wrote it, and the War Room view as served.
const { servedStepRegret } = await import('./rules/step-regret-check.mjs');
const stepRegretResult = (name, entry) => {
  if (!entry) { results.push({ name, skip: 'not run: no plans entry for this league' }); return; }
  const moves = [...(entry.next_move?.status === 'ok' ? [entry.next_move.value] : []), ...(entry.alternatives?.status === 'ok' ? entry.alternatives.value ?? [] : [])];
  const breaks = servedStepRegret(entry);
  results.push({ name, n: moves.reduce((k, m) => k + (m.steps?.length ?? 0), 0), dropped: null,
    bad: breaks.map(b => ({ give: [b.move_id], get: [`step ${b.step}`], v: [`step ${b.step} of ${b.move_id} (${b.where}) gains ${(b.delta * 100).toFixed(2)} pts of title odds, not above 0`] })) });
};
stepRegretResult('war-room plans file: STEP-REGRET', fs.existsSync(plansFile)
  ? (JSON.parse(fs.readFileSync(plansFile, 'utf8')).leagues ?? []).find(l => S(l.league) === S(LEAGUE)) : null);

/* ------------------------------------------------------------ STEP-OVERPAY on the served plan */
// Nick's overpay rule applies to EVERY step of a War Room path (each is a real trade): FantasyCalc value
// given never above value got, except a depth-only 2-for-1 up to +12% whose own served deltas (lineup
// points and title odds) both rise. Restated here from the raw values, not imported from never-give.js.
const stepOverpays = st => {
  const g = (st.give ?? []).map(S), r = (st.get ?? []).map(S);
  if (![...g, ...r].every(id => fc.has(id))) return null;          // unpriced: the package check above owns that
  const gv = g.reduce((s, id) => s + fc.get(id), 0), rv = r.reduce((s, id) => s + fc.get(id), 0);
  if (!(rv > 0) || gv <= rv + 1e-9) return null;
  const over = gv / rv - 1;
  const dp = st.depth_premium?.status === 'ok' ? st.depth_premium.value : st.depth_premium;
  const pts = dp?.confirmed_lineup_points_delta ?? dp?.lineup_points_delta, tit = dp?.confirmed_title_odds_delta ?? dp?.title_odds_delta;
  if (g.length === 2 && r.length === 1 && over <= 0.12 + 1e-9 && Number(pts) > 0 && Number(tit) > 0) return null;
  return over;
};
const stepOverpayResult = (name, entry) => {
  if (!entry) { results.push({ name, skip: 'not run: no plans entry for this league' }); return; }
  const moves = [...(entry.next_move?.status === 'ok' ? [['next_move', entry.next_move.value]] : []),
    ...(entry.alternatives?.status === 'ok' ? (entry.alternatives.value ?? []).map((m, i) => [`alternatives[${i}]`, m]) : [])];
  const firsts = entry.risk_modes?.status === 'ok' ? (entry.risk_modes.value ?? []).filter(m => m?.first_step).map(m => [`${m.mode}.first_step`, { steps: [m.first_step] }]) : [];
  const bad = [];
  let n = 0;
  for (const [where, m] of [...moves, ...firsts]) {
    (m.steps ?? []).forEach((st, k) => {
      n++;
      const over = stepOverpays(st);
      if (over != null) bad.push({ give: (st.give ?? []).map(S), get: (st.get ?? []).map(S), v: [`${where} step ${k + 1} overpays ${(over * 100).toFixed(1)}%`] });
    });
  }
  results.push({ name, n, dropped: null, bad });
};
stepOverpayResult('war-room plans file: STEP-OVERPAY (every step)', fs.existsSync(plansFile)
  ? (JSON.parse(fs.readFileSync(plansFile, 'utf8')).leagues ?? []).find(l => S(l.league) === S(LEAGUE)) : null);

/* ------------------------------------------------------------ PROTECTED-UPGRADE on the served plan */
// Restated from the raw tables: Nick's setting per protected player (latest protect.mode row he wrote and
// did not take back; none -> Blue chips only), the served board and fc_value.
const PROTECTED = ['160', '80'];
const protectMode = (() => {
  const mode = new Map(PROTECTED.map(id => [id, 'blue_chips_only']));
  const has = rows(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'warroom_requests'`).length;
  if (!has) return mode;
  const list = rows(`SELECT id, kind, payload, source FROM warroom_requests WHERE league_id = ? AND kind IN ('protect.mode', 'retract') ORDER BY id`, LEAGUE);
  const pj = t => { try { return JSON.parse(t); } catch { return null; } };
  const gone = new Set(list.filter(r => r.kind === 'retract').map(r => Number(pj(r.payload)?.request_id)));
  for (const r of list) {
    const p = pj(r.payload);
    if (r.kind !== 'protect.mode' || r.source !== 'nick' || gone.has(r.id) || !p || !PROTECTED.includes(S(p.player_id))) continue;
    if (p.mode === 'locked' || p.mode === 'blue_chips_only') mode.set(S(p.player_id), p.mode);
  }
  return mode;
})();
const protectedStepResult = (name, entry) => {
  if (!entry) { results.push({ name, skip: 'not run: no plans entry for this league' }); return; }
  const moves = [...(entry.next_move?.status === 'ok' ? [['next_move', entry.next_move.value]] : []),
    ...(entry.alternatives?.status === 'ok' ? (entry.alternatives.value ?? []).map((m, i) => [`alternatives[${i}]`, m]) : [])];
  const firsts = entry.risk_modes?.status === 'ok' ? (entry.risk_modes.value ?? []).filter(m => m?.first_step).map(m => [`${m.mode}.first_step`, { steps: [m.first_step] }]) : [];
  const bad = [];
  let n = 0;
  for (const [where, m] of [...moves, ...firsts]) {
    (m.steps ?? []).forEach((st, k) => {
      const g = (st.give ?? []).map(S), r = (st.get ?? []).map(S);
      for (const id of g.filter(x => PROTECTED.includes(x))) {
        n++;
        const v = [];
        if (protectMode.get(id) !== 'blue_chips_only') v.push(`gives ${id} (Locked)`);
        const up = r.some(x => score.has(x) && score.has(id) && fc.has(x) && fc.has(id) && score.get(x) >= 83 && score.get(x) > score.get(id) && fc.get(x) > fc.get(id));
        if (!up) v.push(`gives ${id} without a true tier up`);
        const pu = st.protected_upgrade?.status === 'ok' ? st.protected_upgrade.value : null;
        if (!(Number(pu?.confirmed_lineup_points_delta) > 0 && Number(pu?.confirmed_playoff_odds_delta) > 0)) v.push(`gives ${id} without a confirmed rise in lineup points and playoff odds`);
        if (!m.requires_nick_confirm && !st.requires_nick_confirm) v.push(`gives ${id} without needing Nick's OK`);
        if (where === 'next_move' && !m.nick_confirmed) v.push(`gives ${id} as the next move before Nick's OK`);
        if (v.length) bad.push({ give: g, get: r, v: v.map(x => `${where} step ${k + 1} ${x}`) });
      }
    });
  }
  results.push({ name, n, dropped: null, bad });
};
protectedStepResult('war-room plans file: PROTECTED-UPGRADE (every step)', fs.existsSync(plansFile)
  ? (JSON.parse(fs.readFileSync(plansFile, 'utf8')).leagues ?? []).find(l => S(l.league) === S(LEAGUE)) : null);

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
  process.env[WARROOM_ENV] = '1';
  const { warRoomView } = await import('../server/services/war-room-view.js');
  const view = await warRoomView(LEAGUE);
  if (!view?.enabled) return { skip: 'not run: War Room view is off' };
  return fpKeys(asServed(view));
});
{
  process.env[WARROOM_ENV] = '1';
  const { warRoomView } = await import('../server/services/war-room-view.js');
  const view = await warRoomView(LEAGUE);
  if (view?.enabled) {
    stepRegretResult('war-room view as served: STEP-REGRET', view);
    protectedStepResult('war-room view as served: PROTECTED-UPGRADE', view);
  }
  else results.push({ name: 'war-room view as served: STEP-REGRET', skip: 'not run: War Room view is off' });
}
await fpSurface('fantasypros: coach plan_read blue_chips', async () => {
  const { planRead } = await import('../server/services/coach/brain-tools.js');
  const cols = new Map();
  for (const r of planRead({ league_id: LEAGUE, section: 'blue_chips' })) {
    for (const k of Object.keys(r)) if (/(^|_)fp(_|$)|fantasypros/i.test(k)) cols.set(k.replace(/_\d+_/g, '_N_'), (cols.get(k.replace(/_\d+_/g, '_N_')) ?? 0) + 1);
  }
  return cols;
});

await fpSurface('fantasypros: committed server data (analyst notes -> LiveDraft prompt)', async () => {
  const dir = new URL('../server/data/', import.meta.url);
  const hits = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(json|csv|md|txt)$/i.test(f)) continue;
    const n = (fs.readFileSync(new URL(f, dir), 'utf8').match(/fantasypros|\(FP \d+\/\d+/gi) ?? []).length;
    if (n) hits.set(`server/data/${f}`, n);
  }
  return hits;
});

/* ------------------------------------------------------------ report */
let fail = 0;
for (const r of results) {
  if (r.skip) { console.log(`SKIP ${r.name}: ${r.skip}`); continue; }
  if (r.error) { fail++; console.log(`FAIL ${r.name}: error ${r.error}`); continue; }
  if (r.fp) {
    const n = [...r.fp.values()].reduce((a, b) => a + b, 0);
    if (n) { fail++; console.log(`FAIL ${r.name}: ${n} FantasyPros keys or mentions reach the client or the repo (${[...r.fp.keys()].slice(0, 4).join(', ')})`); }
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
