/**
 * RULE-FUZZ x RULES-EVERYWHERE: the RULE-FUZZ oracle (test/fixtures/nick-rules.mjs, independent of how
 * any rule is enforced) run over every trade-suggesting surface outside the planner, through the one
 * rule gate (campaign/never-give.js#ruleGate). Made-up leagues from RULE-FUZZ's generator
 * (test/fixtures/rule-fuzz-league.mjs, fixed seeds): its players, FantasyCalc values (the adapter's
 * value), blue-chip board (its scoreOf) and season trade ledger are written to a throwaway database and
 * plans file, then random candidate trades (the pinned players, Olave and players Nick sold included on
 * purpose) are fed through each surface's gate wrapper. Every package a surface would still serve is
 * handed to the oracle as a one-step plan; it must find no break of any rule the gate enforces.
 *
 * Surfaces: findTrades (gateIdeas: /find, /post-draft-plan, /find/sequences, /title-trades),
 * offerFor / offerForMany (gateLadder: /offer, /offer-many), /proposals (gateProposals), War Room
 * negotiation reply-table branches (gateThreadView). /explain, the negotiation open and Coach
 * negotiate_reply call gate.ok, the same check (covered in test/rules-everywhere.test.js).
 * beats_no_trade is the planner's confirm-dice rule, not the gate's, so it is not counted here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rule-fuzz-surfaces-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;

const { db, row, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const NG = await import('../server/services/campaign/never-give.js');
const engine = await import('../server/services/trade-engine.js');
const { gateProposals } = await import('../server/services/trade-proposals.js');
const { gateThreadView } = await import('../server/routes/warroom-negotiate.js');
const { makeFuzzLeague, rng } = await import('./fixtures/rule-fuzz-league.mjs');
const { ruleViolations } = await import('./fixtures/nick-rules.mjs');
const { scoreForRules } = await import('./fixtures/rule-gate.mjs');

db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);

const S = String;
const ESPN = id => 50000 + Number(id);
const GATE_RULES = new Set(['never_give', 'aj_brown', 'final_get', 'overpay', 'no_olave', 'no_buyback', 'no_undo']);
const SEEDS = Number(process.env.RULE_FUZZ_SURFACE_SEEDS ?? 60);

/** Write one fuzz league where the gate reads it. */
function install(a) {
  const L = a.league.id;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    run('DELETE FROM player_metrics'); run('DELETE FROM players'); run('DELETE FROM league_transactions_raw');
    run('DELETE FROM leagues WHERE id = ?', L);
    for (const p of a.players.values()) {
      run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', p.id, p.name, p.position, ESPN(p.id));
      run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, p.id, Math.max(0, p.value));
    }
    run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, connection_status)
         VALUES (?, 'espn', ?, 2026, 'Fuzz', '{"teams":[]}', ?, ?, 'connected')`, L, `fuzz-${L}`, a.league.team_count, a.league.me);
    for (const t of a.tradeLedger?.trades ?? []) {
      run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, processed_at, items_json, first_seen_at, last_seen_at)
           VALUES (?, 2026, ?, 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', ?, ?, 'now', 'now')`, L, t.tx_id, new Date(t.at).toISOString(),
      JSON.stringify(t.moves.map(m => ({ playerId: ESPN(m.player), fromTeamId: Number(m.from), toTeamId: Number(m.to), type: 'TRADE' }))));
    }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
  scoreForRules(L, new Map([...a.players.values()].map(p => [S(p.id), a.scoreOf(p.id).score])));
}

/** Random candidate trades Nick <-> another team, pinned / Olave / sold players included. */
function candidates(a, seed, n = 16) {
  const r = rng(seed * 104729 + 7);
  const me = a.league.me;
  const mine = a.rosters.get(me).map(S);
  const others = [...a.rosters.keys()].filter(t => t !== me);
  const pick = (list, k) => [...new Set(Array.from({ length: k }, () => list[Math.floor(r() * list.length)]))];
  return Array.from({ length: n }, (_, i) => {
    const team = others[Math.floor(r() * others.length)];
    return { id: `c${i}`, team, give: pick(mine, 1 + Math.floor(r() * 2)), get: pick(a.rosters.get(team).map(S), 1 + Math.floor(r() * 2)) };
  });
}

const P = (a, id) => ({ id: Number(id), name: a.players.get(Number(id))?.name ?? `P${id}`, value: a.players.get(Number(id))?.value ?? 0 });

test(`RULE-FUZZ oracle over every gated surface, ${SEEDS} fuzz leagues: nothing served breaks a rule`, () => {
  const byRule = Object.fromEntries([...GATE_RULES].map(k => [k, 0]));
  let served = 0, dropped = 0, offered = 0, raw = 0;
  const fails = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const a = makeFuzzLeague(seed);
    install(a);
    const lg = row('SELECT id, my_team_id, season FROM leagues WHERE id = ?', a.league.id);
    const me = a.league.me;
    const cs = candidates(a, seed);
    offered += cs.length;
    const deal = c => ({ id: c.id, partner_id: c.team, partner: `Team ${c.team}`, i_give: c.give.map(id => P(a, id)), i_get: c.get.map(id => P(a, id)) });
    const packages = [];
    // The oracle has bite: the same candidates, ungated, break rules.
    for (const c of cs) raw += ruleViolations(a, { best: { steps: [{ team: c.team, give: c.give, get: c.get }] } }).filter(x => GATE_RULES.has(x.rule)).length;

    const ideas = engine.gateIdeas(lg, { mode: 'league', me: { roster_id: me }, deals: cs.map(deal) }, me);
    dropped += ideas.dropped_by_rule;
    for (const d of ideas.deals) packages.push(['find', d.partner_id, d.i_give.map(p => S(p.id)), d.i_get.map(p => S(p.id))]);

    for (const c of cs.slice(0, 4)) {
      const ladder = engine.gateLadder(lg, { target: P(a, c.get[0]), owner_id: c.team, me: { roster_id: me },
        offers: cs.filter(x => x.team === c.team).map(x => ({ i_give: x.give.map(id => P(a, id)) })), alternatives: [] }, me);
      dropped += ladder.dropped_by_rule;
      for (const o of ladder.offers) packages.push(['offer', c.team, o.i_give.map(p => S(p.id)), [S(c.get[0])]]);
    }

    const full = cs.map(deal);
    const props = gateProposals(NG.ruleGate({ row, rows }, { leagueId: lg.id, teamId: me }),
      { proposals: full.map(d => ({ idea_ids: [d.id], package: { i_give: d.i_give.map(p => p.name), i_get: d.i_get.map(p => p.name) } })) }, full);
    dropped += props.dropped_by_rule;
    for (const pr of props.kept) { const c = cs.find(x => x.id === pr.idea_ids[0]); packages.push(['proposals', c.team, c.give, c.get]); }

    const tv = gateThreadView(NG.ruleGate({ row, rows }, { leagueId: lg.id }),
      { get: cs[0].get, branches: cs.map(c => ({ kind: 'counter', plan: { status: 'ok', value: { backup: { partner: c.team, give: c.give, get: c.get } } } })) });
    dropped += tv.dropped_by_rule;
    tv.branches.forEach((b, k) => { if (b.plan.status === 'ok') packages.push(['negotiation', cs[k].team, cs[k].give, cs[k].get]); });

    for (const [surface, team, give, get] of packages) {
      served++;
      const res = { best: { steps: [{ team, give, get }] } };
      for (const v of ruleViolations(a, res).filter(x => GATE_RULES.has(x.rule))) {
        byRule[v.rule]++;
        if (fails.length < 5) fails.push(`seed ${seed} ${surface}: ${v.rule} ${v.detail}`);
      }
    }
  }
  console.log(`# RULE-FUZZ surfaces: ${SEEDS} leagues, ${offered} candidates (${raw} rule breaks ungated), ${served} served, ${dropped} dropped, violations ${JSON.stringify(byRule)}`);
  assert.ok(raw > 0, 'the ungated candidates break rules, so a leak would be seen');
  assert.deepEqual(fails, []);
  assert.ok(served > 0 && dropped > 0, `not vacuous: ${served} served, ${dropped} dropped`);
});

/**
 * PROTECTED-UPGRADE (Nick 2026-09-26): with 160 / 80 on "Blue chips only" (their default; no setting row),
 * a surface outside the planner never serves them: none carries a step's confirmed rise in lineup points
 * and playoff odds, so the gate keeps them locked there. Candidates built to be true tier ups (a Blue chip
 * scoring AND valued above him) are fed in on purpose; every one is dropped and counted.
 */
test(`PROTECTED-UPGRADE over every gated surface, ${Math.min(SEEDS, 30)} fuzz leagues: tier-up bait for 160 / 80 is never served outside the planner`, () => {
  let bait = 0, served = 0;
  for (let seed = 1; seed <= Math.min(SEEDS, 30); seed++) {
    const a = makeFuzzLeague(seed);
    install(a);
    const lg = row('SELECT id, my_team_id, season FROM leagues WHERE id = ?', a.league.id);
    const me = a.league.me;
    const g = NG.ruleGate({ row, rows }, { leagueId: lg.id });
    assert.ok(g.rules.protectUpgrade.has('160') && g.rules.protectUpgrade.has('80'), 'Blue chips only is the default');
    const sc = id => a.scoreOf(id)?.score, v = id => a.players.get(Number(id))?.value ?? 0;
    const cs = [];
    for (const pid of ['160', '80']) {
      if (!a.rosters.get(me).map(S).includes(pid)) continue;
      for (const [t, ids] of a.rosters) {
        if (t === me) continue;
        for (const x of ids) if (sc(x) >= 83 && sc(x) > sc(pid) && v(x) > v(pid)) cs.push({ id: `b${cs.length}`, team: t, give: [pid], get: [S(x)] });
      }
    }
    bait += cs.length;
    const deal = c => ({ id: c.id, partner_id: c.team, partner: `Team ${c.team}`, i_give: c.give.map(id => P(a, id)), i_get: c.get.map(id => P(a, id)) });
    const ideas = engine.gateIdeas(lg, { mode: 'league', me: { roster_id: me }, deals: cs.map(deal) }, me);
    served += ideas.deals.length;
    const full = cs.map(deal);
    served += gateProposals(g, { proposals: full.map(d => ({ idea_ids: [d.id], package: { i_give: d.i_give.map(p => p.name), i_get: d.i_get.map(p => p.name) } })) }, full).kept.length;
    const tv = gateThreadView(g, { get: cs[0]?.get ?? [], branches: cs.map(c => ({ kind: 'counter', plan: { status: 'ok', value: { backup: { partner: c.team, give: c.give, get: c.get } } } })) });
    served += tv.branches.filter(b => b.plan.status === 'ok').length;
    // The one check itself: a tier up with a rise passes (and needs Nick's OK); without the rise it does not.
    for (const c of cs.slice(0, 3)) {
      const withRise = g.check({ give: c.give, get: c.get, rises: { points_delta: 1, playoff_delta: 0.01 } });
      if (withRise.ok) assert.equal(withRise.requires_nick_confirm, true);
      assert.equal(g.check({ give: c.give, get: c.get }).ok, false);
    }
  }
  console.log(`# PROTECTED-UPGRADE surfaces: ${bait} tier-up bait packages, ${served} served`);
  assert.ok(bait > 0, 'the fuzz leagues hold tier ups to bait with');
  assert.equal(served, 0);
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
