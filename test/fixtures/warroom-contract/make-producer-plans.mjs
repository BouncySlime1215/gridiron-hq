#!/usr/bin/env node
/**
 * The contract's producer fixture, written by the real producer
 * (scripts/campaign/produce-plans.mjs#buildPlansFile, the loop its main()
 * runs) on the made-up league in test/fixtures/campaign-league.mjs. No real
 * data.
 *
 * Two refreshes, as the refresh loop runs it: the file is the second run, read
 * against the first (so `ground_lost` and the change diff are real). Six
 * leagues, so the file exercises every branch a consumer reads:
 *   1  title, Nick's stops (get / sell an untouchable / bye / custom),
 *      a safe-until-week-6 mode, an arrive-by week, chat labels on team 3,
 *      the ONE-COUNTERPART model on (team 3 wants Nick's P2), and Nick's
 *      'untouchable: P33' note on team 4 (never a target, a get or a flip leg)
 *   2  a league whose world failed: the contract's { league, me, names, error }
 *   3  points objective, team 3 nearly out of it (a "desperate" catch-up move
 *      that is also a deck card) and team 4 checked out
 *   4  go get player 21, points side panel at 105 a week (reachable under the FIX-05 balanced fallback: by_week is ok)
 *   5  sliders at zero assets: nothing clears, so next_move is unknown with its reason
 *   8  a made-up season trade ledger (TRADE-MEMORY): two sold players never bought back (one
 *      after a 16% price fall), the count in _run.dropped_by_reason
 *
 * The FEAS-140 points side panel is switched on (ENV below, never the process env), so
 * every non-points league writes feasibility_points; league 3 writes it as unknown.
 *
 * FIX-05: every league goes through the brain gate (campaign/brain-gate.js) on a
 * made-up report card with E1 failing, so league 4's all_in falls back to
 * balanced (brain_report.fell_back_to) and the others keep their mode. Leagues
 * 1 and 3 carry made-up number-audit rows (a warn and an ok); the others have
 * none yet, so their number_health is unknown with the reason.
 *
 *   node test/fixtures/warroom-contract/make-producer-plans.mjs   # rewrites producer-plans.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeAdapter } from '../campaign-league.mjs';
import { buildPlansFile } from '../../../scripts/campaign/produce-plans.mjs';
import { applyBrainReport, readNumberHealth } from '../../../server/services/campaign/brain-gate.js';
import { nickBlock, resolveUntouchables, untouchableIds } from '../../../server/services/people/profile-reader.js';
import { buildCounterparts } from '../../../server/services/people/counterpart.js';

const FIRST_AT = '2026-09-24T05:00:00.000Z';
const GENERATED_AT = '2026-09-24T06:00:00.000Z';
const ENV = { GRIDIRON_POINTS_FEASIBILITY: '1' };
const CHAT_OK = { engagement: 'high', tone: 'friendly', open_to_trade: 'high', no_holds: 'no', loves: [], hates: [], messages: 40, source: 'chat', status: 'ok' };

const leagueOf = (id, opts = {}) => {
  const a = makeAdapter(opts);
  a.league = { ...a.league, id };
  return a;
};

export const OBJECTIVES = {
  1: { risk_mode: 'safe', risk_until_week: 6, arrive_by: 6, untouchables: ['2'], version: 3,
    stops: [{ kind: 'get', player: '21' }, { kind: 'sell', player: '2' }, { kind: 'cover_bye', week: 6 }, { kind: 'custom', label: 'Keep a TE' }] },
  3: { kind: 'points', points_per_week: 95 },
  4: { kind: 'player', target: '21', risk_mode: 'all_in', side_points_per_week: 105 },
  5: { tolerances: { max_assets: 0 } },
};

/** A made-up report card in the graders' row shape (eval/common.js#result), computed just before the run. */
export const BRAIN_REPORT = {
  run_id: 'fixture-run', computed_at: '2026-09-24T04:30:00.000Z',
  checks: [
    { check: 'E1', name: 'Chance he says yes is calibrated', status: 'failing', metric_name: 'calibration_slope', metric: 0.41,
      ci_low: 0.22, ci_high: 0.6, n: 64, needs_text: null, pass_bar: 'slope within 0.8-1.2', detail: {} },
    ...['E2', 'E3', 'E4', 'E5', 'E6', 'E7'].map(check => ({ check, name: `check ${check}`, status: 'not_enough_data',
      metric_name: 'n', metric: null, ci_low: null, ci_high: null, n: 3, needs_text: 'needs 37 more offers',
      pass_bar: 'stated in the TDD', detail: {} })),
  ],
};
const AUDIT = {
  1: [{ check_id: 'D.current_week', status: 'ok', title: 'Current week agrees', detail: 'all say week 5' },
    { check_id: 'B.title_odds_paths', status: 'warn', title: 'Title odds paths differ', detail: 'two paths differ by 2 pts', cause: 'rounding' }],
  3: [{ check_id: 'D.current_week', status: 'ok', title: 'Current week agrees', detail: 'all say week 5' }],
};
/** readNumberAudit's shape, from the made-up rows above (no DB). */
const fakeAudit = leagueId => {
  const rows = AUDIT[leagueId] ?? [];
  const count = st => rows.filter(r => r.status === st).length;
  return { table_missing: false, as_of: rows.length ? '2026-09-24T04:00:00.000Z' : null, rows,
    broken: count('broken'), warn: count('warn'), ok: count('ok') };
};
export const BRAIN = { read: { report: BRAIN_REPORT, error: null }, applyBrainReport,
  numberHealth: id => readNumberHealth(null, id, { read: fakeAudit }) };

/** League 1's people: Nick's untouchable note on team 4 and a counterpart model per team (no real data). */
function withPeople(a) {
  const nick4 = resolveUntouchables(nickBlock(null, [{ note: 'untouchable: P33 (fixture)', source: 'nick-chat-2026-09-24' }]),
    a.rosters.get('4').map(id => a.players.get(id)));
  a.managers.set('4', { ...a.managers.get('4'), nick: nick4 });
  a.untouchable = untouchableIds([nick4]);
  const at = Date.parse(FIRST_AT);
  const profile = { values_talk: { wants: [{ player: 'P2', at, n: 4 }], untouchable: [], shopping: [], talks_up: [], talks_down: [] } };
  // Team 3: Nick reads him as hard to deal with (the counterpart caps the price at fair on his screen).
  const nick3 = nickBlock({ difficulty: 'hard to deal with' });
  a.counterparts = buildCounterparts({ profiles: new Map([['3', { status: 'ok', profile, built_at: FIRST_AT, nick: nick3 }]]),
    players: a.players, now: at, teams: [...a.managers.keys()] });
  return a;
}

/**
 * League 8's season ledger (TRADE-MEMORY, made up): Nick sold P11 to team 2 twelve days ago at 5,000
 * (4,200 now, a 16% fall: still no buy-back) and P22 to team 3 for P4. Neither is ever bought back.
 */
function withLedger(a) {
  const at = Date.parse(FIRST_AT) - 12 * 864e5;
  a.tradeLedger = { now: Date.parse(FIRST_AT), unmapped: 0, valueAt: id => (id === 11 ? 5000 : null),
    trades: [{ tx_id: 'fx1', at, moves: [{ player: 11, from: '1', to: '2' }, { player: 6, from: '2', to: '1' }] },
      { tx_id: 'fx2', at, moves: [{ player: 22, from: '1', to: '3' }, { player: 4, from: '3', to: '1' }] }] };
  return a;
}

export async function makeProducerPlans() {
  const leagues = [
    { id: 1, load: async () => ({ adapter: withPeople(leagueOf(1, { managerExtra: { 3: { chat: CHAT_OK } } })),
      counterpart: { status: 'ok', reason: null, field: 'people.counterpart' } }) },
    { id: 2, load: async () => { const a = leagueOf(2); a.world = () => ({ fail: 'no schedule for this season' }); return { adapter: a }; } },
    { id: 3, load: async () => ({ adapter: leagueOf(3, { managerExtra: { 3: { title_now: 0.01 }, 4: { checked_out: true } } }) }) },
    { id: 4, load: async () => ({ adapter: leagueOf(4) }) },
    // TEAM-NAMES: league 5 also names one manager (synthetic), so the file writes every teams path.
    { id: 5, load: async () => { const a = leagueOf(5); const t = a.teams(); a.teams = () => ({ ...t, 2: { ...t[2], manager: 'Manager B' } }); return { adapter: a }; } },
    { id: 8, load: async () => ({ adapter: withLedger(leagueOf(8)) }) },
  ];
  const first = await buildPlansFile(leagues, { generated_at: FIRST_AT, objectives: OBJECTIVES, clock: () => 0, brain: BRAIN, env: ENV });
  const previous = new Map(first.leagues.map(e => [String(e.league), e]));
  return buildPlansFile(leagues, { generated_at: GENERATED_AT, objectives: OBJECTIVES, previous, clock: () => 0, brain: BRAIN, env: ENV });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'producer-plans.json');
  fs.writeFileSync(out, JSON.stringify(await makeProducerPlans(), null, 1) + '\n');
  console.log(`wrote ${out}`);
}
