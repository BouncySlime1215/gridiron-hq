/**
 * Role-conditioned chance to play (contingency.js).
 *
 * The bug: a healthy starter with no injury report was shown
 * min(0.831, career durability) on Start/Sit. 0.831 is the play rate of
 * players who WERE on the practice report without a game status, and the
 * durability prior is shrunk toward a position mean that includes every
 * backup — so Caleb Williams, who has played every game, showed 0.758.
 *
 * The fix adds a role layer: recent snap share (tier) and whether he played
 * his team's last game (gap), from data strictly before the week, with rates
 * fitted by scripts/fit-availability.mjs into nfl_availability_role_rates.
 * With no role rates on file, nothing changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-role-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
// Namespace import, so a missing export fails its own test at runtime (and the
// behaviour tests run against today's code) instead of failing the whole file.
const C = await import('../server/services/contingency.js');
const { weeklyAvailability } = C;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const player = (id, name, position, gsis) =>
  run('INSERT INTO players (id, name, position, gsis_id) VALUES (?,?,?,?)', id, name, position, gsis);
const usage = (id, season, week, team, position) =>
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,?,?,5,0,0)`, id, season, week, team, position);
const snap = (id, season, week, pct) =>
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)',
    id, season, week, Math.max(1, Math.round(pct * 65)), pct);
const appear = (id, season, week, team, position, pct) => { usage(id, season, week, team, position); snap(id, season, week, pct); };

/* ----------------------------------------------------------- pure helpers */

test('role tier thresholds: starter >= .60, rotation >= .35, depth >= .15, fringe below, unknown without snaps', () => {
  assert.equal(C.roleTier(0.60), 'starter');
  assert.equal(C.roleTier(0.599), 'rotation');
  assert.equal(C.roleTier(0.35), 'rotation');
  assert.equal(C.roleTier(0.349), 'depth');
  assert.equal(C.roleTier(0.15), 'depth');
  assert.equal(C.roleTier(0.149), 'fringe');
  assert.equal(C.roleTier(null), 'unknown');
  assert.equal(C.roleTier(undefined), 'unknown');
});

test('gap buckets: played last game g0, missed one g1, missed two or three g2, four or more is out of scope', () => {
  assert.equal(C.ROLE_MAX_GAP, 3);
  assert.equal(C.gapBucket(0), 'g0');
  assert.equal(C.gapBucket(1), 'g1');
  assert.equal(C.gapBucket(2), 'g2');
  assert.equal(C.gapBucket(3), 'g2');
  assert.equal(C.gapBucket(4), null);
  assert.equal(C.gapBucket(undefined), null);
});

/* ------------------------------------------------------------ role states */

// Team BBB, 2022-2023. Filler 914 defines BBB's schedule: weeks 1-4, bye 5, 6-8.
player(911, 'BBB Carryover', 'RB', 'bbb-c');
player(912, 'BBB Fader', 'WR', 'bbb-d');
player(913, 'BBB Tight', 'TE', 'bbb-e');
player(914, 'BBB Filler', 'WR', 'bbb-f');
appear(911, 2022, 17, 'BBB', 'RB', 0.7);
appear(911, 2022, 18, 'BBB', 'RB', 0.7);
for (const w of [1, 2, 3]) appear(912, 2023, w, 'BBB', 'WR', 0.9);
appear(912, 2023, 4, 'BBB', 'WR', 0.1);
for (const w of [1, 2, 3]) appear(913, 2023, w, 'BBB', 'TE', 0.5);
for (const w of [1, 2, 3, 4, 6, 7, 8]) appear(914, 2023, w, 'BBB', 'WR', 0.3);

test('role features never read the target week: week-4 snaps are invisible at week 4 and visible at week 5', () => {
  const atFour = C.roleStates(2023, 4).get(912);
  assert.equal(atFour.share, 0.9, 'share at week 4 must come from weeks 1-3 only');
  assert.equal(atFour.tier, 'starter');
  const atFive = C.roleStates(2023, 5).get(912);
  assert.ok(Math.abs(atFive.share - (0.9 + 0.9 + 0.1) / 3) < 1e-9, `got ${atFive.share}`);
});

test('gap counts the team games he missed, and a bye is not a missed game', () => {
  assert.equal(C.roleStates(2023, 4).get(913).gap, 0);
  assert.equal(C.roleStates(2023, 5).get(913).gap, 1, 'missed week 4');
  assert.equal(C.roleStates(2023, 6).get(913).gap, 1, 'week 5 was a bye, not a miss');
  const atEight = C.roleStates(2023, 8).get(913);
  assert.equal(atEight.gap, 3);
  assert.equal(atEight.gap_bucket, 'g2');
  const atNine = C.roleStates(2023, 9).get(913);
  assert.equal(atNine.gap, 4);
  assert.equal(atNine.gap_bucket, null, 'four missed games is out of role scope');
  assert.equal(atNine.team, 'BBB');
});

test('week 1 reads the previous season: a back who played the last two games is a g0 starter', () => {
  const c = C.roleStates(2023, 1).get(911);
  assert.equal(c.gap, 0);
  assert.equal(c.tier, 'starter');
  assert.equal(c.position, 'RB');
  assert.equal(C.roleStates(2023, 1).has(912), false, 'no appearance before week 1 -> not in role scope');
});

/* --------------------------------------------------------------- fitting */

test('fitRoleRates shrinks each cell toward its parent with strength k', () => {
  const obs = [];
  const push = (n, hits, cell) => { for (let i = 0; i < n; i++) obs.push({ ...cell, active: i < hits ? 1 : 0 }); };
  push(10, 9, { rs: 'noreport', ps: 'none', position: 'WR', tier: 'starter', gap: 'g0' });
  push(10, 2, { rs: 'noreport', ps: 'none', position: 'WR', tier: 'starter', gap: 'g1' });
  push(20, 10, { rs: 'noreport', ps: 'none', position: 'RB', tier: 'depth', gap: 'g0' });
  const rates = C.fitRoleRates(obs, { k: 10, byPosition: false });
  const get = (rs, ps, pos, tier, gap) => rates.find(r => r.report_status === rs && r.practice_status === ps
    && r.position === pos && r.tier === tier && r.gap === gap);
  const root = get('noreport', '*', '*', '*', '*');
  assert.equal(root.n, 40);
  assert.ok(Math.abs(root.p_active - 21 / 40) < 1e-9);
  const l1 = get('noreport', 'none', '*', '*', '*');
  assert.ok(Math.abs(l1.p_active - (21 + 10 * 0.525) / 50) < 1e-9);
  const starter = get('noreport', 'none', '*', 'starter', '*');
  assert.ok(Math.abs(starter.p_active - (11 + 10 * l1.p_active) / 30) < 1e-9);
  const leaf = get('noreport', 'none', '*', 'starter', 'g0');
  assert.ok(Math.abs(leaf.p_active - (9 + 10 * starter.p_active) / 20) < 1e-9);
  assert.equal(leaf.raw_rate, 0.9);

  const byPos = C.fitRoleRates(obs, { k: 10, byPosition: true });
  assert.ok(byPos.some(r => r.position === 'WR' && r.tier === 'starter' && r.gap === 'g0'));
  assert.ok(byPos.some(r => r.position === 'RB' && r.tier === '*' && r.gap === '*'));
});

test('role lookup falls back to the deepest fitted ancestor when a cell was never seen', () => {
  const obs = [];
  for (let i = 0; i < 10; i++) obs.push({ rs: 'noreport', ps: 'none', position: 'WR', tier: 'starter', gap: 'g0', active: i < 9 ? 1 : 0 });
  const roleRates = C.fitRoleRates(obs, { k: 10, byPosition: false })
    .map(r => ({ ...r, config: JSON.stringify({ k: 10, byPosition: false, durabilityCap: false }) }));
  const lk = C.buildAvailabilityLookup({ rates: [], roleRates });
  const seen = lk.roleLookup({ status: 'noreport', practice: 'none', position: 'WR', tier: 'starter', gap: 'g0' });
  const unseen = lk.roleLookup({ status: 'noreport', practice: 'none', position: 'WR', tier: 'starter', gap: 'g2' });
  const starterNode = roleRates.find(r => r.tier === 'starter' && r.gap === '*');
  assert.ok(Math.abs(seen.p - roleRates.find(r => r.gap === 'g0').p_active) < 1e-9);
  assert.ok(Math.abs(unseen.p - starterNode.p_active) < 1e-9);
  assert.equal(lk.roleLookup({ status: 'questionable', practice: 'dnp', position: 'WR', tier: 'starter', gap: 'g0' }), null,
    'no fitted report group -> no role cell, caller keeps today\'s path');
});

test('by-position fits (the config the 2024 selection chose) look up by position and fall back within it', () => {
  const obs = [];
  const push = (n, hits, cell) => { for (let i = 0; i < n; i++) obs.push({ ...cell, active: i < hits ? 1 : 0 }); };
  push(20, 19, { rs: 'noreport', ps: 'none', position: 'RB', tier: 'starter', gap: 'g0' });
  push(20, 12, { rs: 'noreport', ps: 'none', position: 'QB', tier: 'starter', gap: 'g0' });
  push(20, 4, { rs: 'noreport', ps: 'none', position: 'QB', tier: 'depth', gap: 'g0' });
  const config = JSON.stringify({ k: 5, byPosition: true, durabilityCap: false });
  const roleRates = C.fitRoleRates(obs, { k: 5, byPosition: true }).map(r => ({ ...r, config }));
  const lk = C.buildAvailabilityLookup({ roleRates });
  const rb = lk.roleLookup({ status: 'noreport', practice: 'none', position: 'RB', tier: 'starter', gap: 'g0' });
  const qb = lk.roleLookup({ status: 'noreport', practice: 'none', position: 'QB', tier: 'starter', gap: 'g0' });
  assert.ok(rb.p > qb.p, 'RB starters play more often than QB starters in this fixture, and the lookup must keep them apart');
  assert.equal(rb.basis, 'noreport/none/RB/starter/g0');
  const qbUnseenGap = lk.roleLookup({ status: 'noreport', practice: 'none', position: 'QB', tier: 'starter', gap: 'g1' });
  assert.equal(qbUnseenGap.basis, 'noreport/none/QB/starter', 'falls back to the same position and tier, not the pooled rate');
  const teUnseen = lk.roleLookup({ status: 'noreport', practice: 'none', position: 'TE', tier: 'starter', gap: 'g0' });
  assert.equal(teUnseen.basis, 'noreport/none', 'an unseen position falls back to the pooled status/practice cell');
});

/* ------------------------------------------------------ weeklyAvailability */

// Team AAA, 2024-2025. Healthy starter S (thin 2024 history -> low durability
// prior), starter M who missed week 5, O who has not played in 4 AAA games,
// and Q, a starter listed Questionable/Limited for week 6.
player(901, 'AAA Starter', 'WR', 'aaa-s');
player(902, 'AAA Missed', 'WR', 'aaa-m');
player(903, 'AAA Gone', 'WR', 'aaa-o');
player(904, 'AAA Questionable', 'WR', 'aaa-q');
for (let w = 1; w <= 6; w++) usage(901, 2024, w, 'AAA', 'WR');
for (let w = 1; w <= 5; w++) appear(901, 2025, w, 'AAA', 'WR', 0.9);
for (let w = 1; w <= 4; w++) appear(902, 2025, w, 'AAA', 'WR', 0.9);
appear(903, 2025, 1, 'AAA', 'WR', 0.9);
for (let w = 1; w <= 5; w++) appear(904, 2025, w, 'AAA', 'WR', 0.85);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury)
     VALUES (2025, 6, 'aaa-q', 'AAA', 'AAA Questionable', 'WR', 'Questionable', 'Limited Participation in Practice', 'Ankle')`);

// The fixture owns its DDL; the test below checks the module's DDL creates the
// same columns, so the two cannot drift silently.
const FIXTURE_RATES_DDL = `CREATE TABLE IF NOT EXISTS nfl_availability_rates (
  scope TEXT NOT NULL, team TEXT NOT NULL, report_status TEXT NOT NULL, practice_status TEXT NOT NULL,
  p_active REAL NOT NULL, n INTEGER NOT NULL, raw_rate REAL, shrunk INTEGER NOT NULL, fitted_at TEXT NOT NULL,
  PRIMARY KEY (scope, team, report_status, practice_status))`;
const FIXTURE_ROLE_DDL = `CREATE TABLE IF NOT EXISTS nfl_availability_role_rates (
  report_status TEXT NOT NULL, practice_status TEXT NOT NULL, position TEXT NOT NULL, tier TEXT NOT NULL,
  gap TEXT NOT NULL, p_active REAL NOT NULL, n INTEGER NOT NULL, raw_rate REAL, config TEXT NOT NULL,
  fitted_at TEXT NOT NULL, PRIMARY KEY (report_status, practice_status, position, tier, gap))`;
db.exec(FIXTURE_RATES_DDL);
db.exec(FIXTURE_ROLE_DDL);
const now = new Date().toISOString();
for (const [scope, team, rs, ps, p, n] of [
  ['league', '', 'none', 'any', 0.8314, 3564],
  ['league', '', 'questionable', 'any', 0.58, 1841],
  ['league', '', 'questionable', 'limited', 0.60, 1173],
  ['team', 'AAA', 'questionable', 'any', 0.638, 40]
]) {
  run(`INSERT INTO nfl_availability_rates (scope,team,report_status,practice_status,p_active,n,raw_rate,shrunk,fitted_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, scope, team, rs, ps, p, n, p, scope === 'team' ? 1 : 0, now);
}
const ROLE_CELLS = [
  ['noreport', '*', '*', '*', '*', 0.70], ['noreport', 'none', '*', '*', '*', 0.70],
  ['noreport', 'none', '*', 'starter', '*', 0.90], ['noreport', 'none', '*', 'starter', 'g0', 0.953],
  ['noreport', 'none', '*', 'starter', 'g1', 0.30],
  ['questionable', '*', '*', '*', '*', 0.58], ['questionable', 'limited', '*', '*', '*', 0.60],
  ['questionable', 'limited', '*', 'starter', '*', 0.72], ['questionable', 'limited', '*', 'starter', 'g0', 0.74]
];
function writeRoleCells({ durabilityCap = false } = {}) {
  run('DELETE FROM nfl_availability_role_rates');
  const config = JSON.stringify({ k: 10, byPosition: false, durabilityCap });
  for (const [rs, ps, pos, tier, gap, p] of ROLE_CELLS) {
    run(`INSERT INTO nfl_availability_role_rates
         (report_status,practice_status,position,tier,gap,p_active,n,raw_rate,config,fitted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`, rs, ps, pos, tier, gap, p, 100, p, config, now);
  }
  if (typeof C.resetAvailabilityCache === 'function') C.resetAvailabilityCache();
}

test('a healthy starter who played last week gets the fitted starter rate, not min(0.831, durability)', () => {
  writeRoleCells();
  const current = weeklyAvailability(2025, 6, { useRole: false }).get(901);
  assert.ok(current.durability_prior < 0.8314, `fixture needs a thin durability prior, got ${current.durability_prior}`);
  assert.equal(current.active_probability, current.durability_prior, 'today: capped at the durability prior');

  const s = weeklyAvailability(2025, 6).get(901);
  assert.equal(s.active_probability, 0.953);
  assert.match(s.source, /role/);
  assert.equal(s.role.tier, 'starter');
  assert.equal(s.role.gap, 0);
});

test('a starter who missed his team\'s last game is priced lower than one who played it', () => {
  writeRoleCells();
  const a = weeklyAvailability(2025, 6);
  assert.equal(a.get(902).active_probability, 0.30);
  assert.ok(a.get(902).active_probability < a.get(901).active_probability);
});

test('a player out of role scope (four missed team games) keeps today\'s number', () => {
  writeRoleCells();
  const o = weeklyAvailability(2025, 6).get(903);
  const today = weeklyAvailability(2025, 6, { useRole: false }).get(903);
  assert.equal(o.active_probability, today.active_probability);
  assert.doesNotMatch(o.source, /role/);
});

test('a listed Questionable starter gets the role cell times the same team ratio as today', () => {
  writeRoleCells();
  const q = weeklyAvailability(2025, 6).get(904);
  assert.equal(q.active_probability, +(0.74 * (0.638 / 0.58)).toFixed(3));
  assert.match(q.source, /AAA/);
});

test('the fitted durability cap is honoured when the selection chose it', () => {
  writeRoleCells({ durabilityCap: true });
  const s = weeklyAvailability(2025, 6).get(901);
  assert.equal(s.active_probability, s.durability_prior);
});

test('with no role rates on file every number is exactly today\'s', () => {
  run('DELETE FROM nfl_availability_role_rates');
  C.resetAvailabilityCache();
  const withLayer = weeklyAvailability(2025, 6);
  const without = weeklyAvailability(2025, 6, { useRole: false });
  for (const id of [901, 902, 903, 904]) {
    assert.equal(withLayer.get(id).active_probability, without.get(id).active_probability);
  }
});

test('the module exports the DDL the fit script uses, with the columns this fixture relies on', () => {
  assert.equal(typeof C.resetAvailabilityCache, 'function');
  const cols = ddl => {
    const scratch = new (db.constructor)(':memory:');
    scratch.exec(ddl);
    const names = scratch.prepare('SELECT name FROM pragma_table_info(?)').all(ddl.match(/EXISTS (\w+)/)[1]).map(r => r.name);
    scratch.close();
    return names.sort();
  };
  assert.deepEqual(cols(C.AVAILABILITY_RATES_DDL), cols(FIXTURE_RATES_DDL));
  assert.deepEqual(cols(C.AVAILABILITY_ROLE_RATES_DDL), cols(FIXTURE_ROLE_DDL));
});

/* --------------------------------------------------------------- scoring */

test('availabilityScores: log loss, Brier, ECE and the calibration table', () => {
  const s = C.availabilityScores([{ p: 0.9, y: 1 }, { p: 0.9, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 0 }]);
  assert.equal(s.n, 4);
  assert.ok(Math.abs(s.log_loss - (-3 * Math.log(0.9) - Math.log(0.1)) / 4) < 1e-9);
  assert.ok(Math.abs(s.brier - 0.21) < 1e-9);
  assert.ok(Math.abs(s.ece - 0.25) < 1e-9);
  const top = s.table.find(b => b.lo === 0.9);
  assert.deepEqual({ n: top.n, rate: top.rate }, { n: 2, rate: 0.5 });
  assert.ok(Math.abs(top.mean_p - 0.9) < 1e-9);
});

test('the pre-registered gate passes only when log loss, calibration and the guard all hold', () => {
  const rows = [];
  // 60 players x 10 weeks. Truth: starters play 95%. Current says 0.8,
  // candidate says 0.95. Listed rows: both identical.
  for (let pid = 1; pid <= 60; pid++) for (let w = 1; w <= 10; w++) {
    const y = (pid * 7 + w) % 20 === 0 ? 0 : 1;
    rows.push({ player_id: pid, y, p_current: 0.8, p_candidate: 0.95, rs: 'noreport' });
  }
  for (let pid = 61; pid <= 70; pid++) rows.push({ player_id: pid, y: pid % 2, p_current: 0.6, p_candidate: 0.6, rs: 'questionable' });
  const good = C.roleGateDecision(rows);
  assert.equal(good.pass, true, JSON.stringify(good.checks));

  const worse = C.roleGateDecision(rows.map(r => ({ ...r, p_candidate: r.rs === 'noreport' ? 0.5 : r.p_candidate })));
  assert.equal(worse.pass, false);
  assert.equal(worse.checks.log_loss.pass, false);

  const guardFail = C.roleGateDecision(rows.map(r => r.rs === 'questionable'
    ? { ...r, p_candidate: r.y ? 0.2 : 0.8 } : r));
  assert.equal(guardFail.checks.guard.pass, false);
  assert.equal(guardFail.pass, false);
});
