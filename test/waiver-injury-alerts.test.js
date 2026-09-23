/**
 * WV-02: the injury replacement alert on the waiver board.
 *
 * When one of my STARTERS is Out, on IR or Doubtful (the more severe of the NFL
 * report and ESPN's status, contingency.js#weekDesignation), or carries a current
 * feed injury flag with no designation, the board names the replacements: same NFL
 * team and position first, each with current snap share (contingency.js#roleStates,
 * the number the availability role tier uses; ordered by this week's projection by
 * default, snap-share order default-off per the evidence), then the best free agent at the
 * position, plus the league's next waiver processing run from the synced ESPN
 * settings. Evidence: docs/tdd/2026-09-23-injury-replacement-alert.tdd.md.
 *
 * The asset universe is mocked so every projection is known. Snap shares are real
 * rows in a temp database, read by the real roleStates.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-wv02-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 2 })
  }
});
const { waiverBoard, nextWaiverRun } = await import('../server/services/waiver-wire.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
// ESPN lineup slot ids: 0 QB, 2 RB, 4 WR, 6 TE, 23 FLEX, 20 bench, 21 IR.
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, BENCH: 20, IR: 21 };

const insPlayer = db.prepare('INSERT INTO players (name, position) VALUES (?, ?)');
const insSnap = db.prepare(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct)
                            VALUES (?, ?, ?, ?, ?)`);
const insUsage = db.prepare(`INSERT INTO player_week_usage (player_id, season, week, team, position)
                             VALUES (?, ?, ?, ?, ?)`);
const insMetric = db.prepare(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (?, ?, ?, ?)
                              ON CONFLICT(player_id, source) DO UPDATE SET value = excluded.value,
                              fetched_at = excluded.fetched_at`);

/** A player: a row in `players`, one 2026 week-1 appearance with a snap share, and an asset. */
function p(name, position, week, ros, { team = 'NYJ', snap = null, ...extra } = {}) {
  const id = Number(insPlayer.run(name, position).lastInsertRowid);
  insUsage.run(id, 2026, 1, team, position);
  if (snap != null) insSnap.run(id, 2026, 1, Math.round(snap * 60), snap);
  return { id, name, position, team_abbr: team, current_week_ppg: week, adj_ppg: week, ppg: week,
    ros_ppg: ros, available: true, active_probability: 0.95, espn_id: 5000 + id, ...extra };
}
// ESPN payload entries always carry the player's ESPN id and position id; the board
// resolves by id first (RL-6-4, trade-engine.js#espnPlayerResolver).
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };

const ACQ = { waiverProcessDays: ['WEDNESDAY', 'SATURDAY'], waiverProcessHour: 11, waiverHours: 24 };
// Tuesday 2026-10-06, 10:00 US Eastern: a date away from the real clock, so a board that
// ignores `now` cannot pass by coincidence (mutant M8 survived with 2026-09-22 on 09-23).
const TUESDAY = new Date('2026-10-06T14:00:00Z');

function board(mine, others, free, { acq = ACQ, now = TUESDAY, sameTeamOrder } = {}) {
  assets = new Map([...mine, ...others, ...free].map(a => [a.id, a]));
  const entries = list => list.map(a => ({
    lineupSlotId: a.slot ?? SLOT_ID.BENCH,
    playerPoolEntry: { player: { id: a.espn_id, fullName: a.name, defaultPositionId: POS_ID[a.position],
      injuryStatus: a.espn_status ?? 'ACTIVE' } }
  }));
  const payload = {
    settings: acq ? { acquisitionSettings: acq } : {},
    teams: [{ id: 1, roster: { entries: entries(mine) } }, { id: 2, roster: { entries: entries(others) } }]
  };
  const lg = { id: 1, platform: 'espn', team_count: 10, ppr: 1, my_team_id: '1',
    roster_positions: JSON.stringify(SLOTS), payload: JSON.stringify(payload) };
  return waiverBoard(lg, { now, sameTeamOrder });
}

function roster({ backOne = {}, extra = [] } = {}) {
  return [
    p('Starting QB', 'QB', 20, 20, { slot: SLOT_ID.QB, snap: 1.0 }),
    p('Back One', 'RB', 15, 15, { slot: SLOT_ID.RB, snap: 0.78, ...backOne }),
    p('Back Two', 'RB', 12, 12, { slot: SLOT_ID.RB, team: 'MIA', snap: 0.65 }),
    p('Wideout One', 'WR', 15, 15, { slot: SLOT_ID.WR, team: 'DAL', snap: 0.9 }),
    p('Wideout Two', 'WR', 11, 11, { slot: SLOT_ID.WR, team: 'SEA', snap: 0.85 }),
    p('Tight End', 'TE', 8, 8, { slot: SLOT_ID.TE, team: 'KC', snap: 0.8 }),
    p('Flex Back', 'RB', 9, 9, { slot: SLOT_ID.FLEX, team: 'DEN', snap: 0.6 }),
    p('Bench Receiver', 'WR', 5, 6, { team: 'NYG', snap: 0.5 }),
    ...extra
  ];
}

/** Same-team free agents at RB: the higher snap share has the LOWER projection. */
function wire() {
  return [
    p('Handcuff High', 'RB', 5, 5, { snap: 0.55 }),
    p('Handcuff Low', 'RB', 7, 6, { snap: 0.20 }),
    p('Other Back', 'RB', 11, 9, { team: 'BUF', snap: 0.7 }),
    p('Other Receiver', 'WR', 13, 10, { team: 'BUF', snap: 0.8 })
  ];
}

test('an Out starter raises the alert with same-team replacements (snap share on each row), the best free agent and the waiver run', () => {
  const others = [p('Rostered Teammate', 'RB', 9, 8, { snap: 0.6 })];
  const out = board(roster({ backOne: { espn_status: 'OUT' } }), others, wire());
  assert.ok(Array.isArray(out.injury_alerts), 'the board carries injury_alerts');
  assert.equal(out.injury_alerts.length, 1);
  const alert = out.injury_alerts[0];
  assert.equal(alert.player, 'Back One');
  assert.equal(alert.designation, 'out');
  assert.equal(alert.designation_source, 'espn');
  // Default order is this week's projection: snap-share order failed its pre-registered
  // non-inferiority bound on 2022-2024 (evidence section 5), so it ships default-off.
  // Low (0.20 snaps, 7 ppg) before High (0.55, 5 ppg); snap share is still on every row.
  assert.deepEqual(alert.replacements.same_team.map(r => r.player), ['Handcuff Low', 'Handcuff High']);
  assert.deepEqual(alert.replacements.same_team.map(r => r.snap_share), [0.2, 0.55]);
  assert.equal(alert.replacements.order, 'projection');
  // A teammate on someone else's roster cannot be claimed.
  assert.ok(!alert.replacements.same_team.some(r => r.player === 'Rostered Teammate'));
  assert.equal(alert.replacements.best_free_agent.player, 'Other Back');
  assert.equal(alert.replacements.best_free_agent.snap_share, 0.7);
  assert.deepEqual(
    { day: alert.claim_by.day, date: alert.claim_by.date, hour: alert.claim_by.hour },
    { day: 'WEDNESDAY', date: '2026-10-07', hour: 11 });
  assert.deepEqual(out.waiver_run, alert.claim_by);
});

test('the snap-share order is one option away, default-off', () => {
  const out = board(roster({ backOne: { espn_status: 'OUT' } }), [], wire(), { sameTeamOrder: 'snap_share' });
  const r = out.injury_alerts[0].replacements;
  assert.equal(r.order, 'snap_share');
  assert.deepEqual(r.same_team.map(x => x.player), ['Handcuff High', 'Handcuff Low']);
  assert.match(r.ranked_by, /unconfirmed/);
});

test('the best free agent comes from another team, even when a teammate projects higher', () => {
  const free = [...wire(), p('Handcuff Star', 'RB', 14, 10, { snap: 0.3 })];
  const r = board(roster({ backOne: { espn_status: 'OUT' } }), [], free).injury_alerts[0].replacements;
  assert.equal(r.same_team[0].player, 'Handcuff Star');
  assert.equal(r.best_free_agent.player, 'Other Back');
});

test('replacements are healthy: an Out or Doubtful teammate or free agent is never offered; my own healthy backup is', () => {
  // U2: a same-team backup already on MY roster (bench) is listed, marked on_your_roster.
  const mine = roster({ backOne: { espn_status: 'OUT' }, extra: [p('My Bench Back', 'RB', 6, 6, { snap: 0.35 })] });
  const free = [
    ...wire(),
    // U1: same-team free agents who project highest but are hurt.
    p('Hurt Handcuff', 'RB', 13, 12, { snap: 0.5, espn_status: 'OUT' }),
    p('Doubtful Handcuff', 'RB', 12, 11, { snap: 0.45, injury_status: 'Doubtful' }),
    // U3: an other-team free agent who projects above Other Back (11) but is Out.
    p('Hurt Other Back', 'RB', 16, 14, { team: 'BUF', snap: 0.8, espn_status: 'OUT' })
  ];
  const r = board(mine, [], free).injury_alerts[0].replacements;
  const names = r.same_team.map(x => x.player);
  assert.ok(!names.includes('Hurt Handcuff'), 'an Out teammate is not a replacement');
  assert.ok(!names.includes('Doubtful Handcuff'), 'a Doubtful teammate is not a replacement');
  assert.deepEqual(names, ['Handcuff Low', 'My Bench Back', 'Handcuff High']);
  assert.equal(r.same_team_count, 3);
  const bench = r.same_team.find(x => x.player === 'My Bench Back');
  assert.equal(bench.on_your_roster, true);
  assert.equal(r.same_team.find(x => x.player === 'Handcuff Low').on_your_roster, false);
  assert.equal(r.best_free_agent.player, 'Other Back', 'an Out free agent is not the best free agent');
});

test('IR and Doubtful starters alert; a healthy, Questionable or benched Out player does not', () => {
  const ir = board(roster({ backOne: { espn_status: 'INJURY_RESERVE' } }), [], wire());
  assert.deepEqual(ir.injury_alerts.map(a => [a.player, a.designation]), [['Back One', 'out']]);

  const doubtful = board(roster({ backOne: { injury_status: 'Doubtful' } }), [], wire());
  assert.deepEqual(doubtful.injury_alerts.map(a => [a.player, a.designation, a.designation_source]),
    [['Back One', 'doubtful', 'nfl']]);

  // Control: nobody hurt.
  assert.deepEqual(board(roster(), [], wire()).injury_alerts, []);
  // Questionable is not an alert.
  assert.deepEqual(board(roster({ backOne: { espn_status: 'QUESTIONABLE' } }), [], wire()).injury_alerts, []);
  // An Out player on MY BENCH is not a starter.
  const benchOut = board(roster({ extra: [p('Bench Back', 'RB', 3, 3, { espn_status: 'OUT', snap: 0.3 })] }), [], wire());
  assert.deepEqual(benchOut.injury_alerts, []);
});

test('a current feed injury flag alerts when no designation exists; a stale one does not', () => {
  const mine = roster();
  const back = mine.find(a => a.name === 'Back One');
  insMetric.run(back.id, 'sleeper_rank', 40, '2026-09-22 10:00:00');
  insMetric.run(back.id, 'injury_flag', 1, '2026-09-22 10:00:00');
  const flagged = board(mine, [], wire());
  assert.deepEqual(flagged.injury_alerts.map(a => [a.player, a.designation, a.designation_source]),
    [['Back One', null, 'feed_flag']]);

  // The writer never clears the flag, so a flag older than the same sync's rank row is stale.
  insMetric.run(back.id, 'sleeper_rank', 40, '2026-09-22 18:00:00');
  assert.deepEqual(board(mine, [], wire()).injury_alerts, []);
});

test('next waiver run: the first processing day at or after now, in US Eastern; unknown without settings', () => {
  // Wednesday 12:00 Eastern is past 11:00, so the Wednesday run has gone: Saturday.
  const run = nextWaiverRun({ settings: { acquisitionSettings: ACQ } }, new Date('2026-09-23T16:00:00Z'));
  assert.deepEqual({ day: run.day, date: run.date, hour: run.hour }, { day: 'SATURDAY', date: '2026-09-26', hour: 11 });
  // Wednesday 10:00 Eastern: today's run is still ahead.
  const early = nextWaiverRun({ settings: { acquisitionSettings: ACQ } }, new Date('2026-09-23T14:00:00Z'));
  assert.equal(early.date, '2026-09-23');
  // At 11:00 Eastern exactly the run is processing: the next claim deadline is Saturday.
  const onTheHour = nextWaiverRun({ settings: { acquisitionSettings: ACQ } }, new Date('2026-09-23T15:00:00Z'));
  assert.equal(onTheHour.date, '2026-09-26');
  const none = nextWaiverRun({ settings: {} }, TUESDAY);
  assert.equal(none.known, false);
  assert.match(none.reason, /acquisition settings/);
});

test('the waiver card reads injury_alerts (the reader that reaches the Lineup page)', () => {
  const src = fs.readFileSync(new URL('../client/src/components/lineup/WaiverWire.tsx', import.meta.url), 'utf8');
  assert.match(src, /injury_alerts/);
  assert.match(src, /claim_by/);
});
