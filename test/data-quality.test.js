/**
 * DATA QUALITY PANEL (Batch D item 35): one read-only report for Settings -> Health.
 *
 * Pre-registered bars B1-B8 live in docs/tdd/2026-09-26-data-quality.tdd.md. The report composes
 * producers that already exist (dataFreshness, loadDecidedOffers, planAge, the number audit); these
 * tests pin that it reads them rather than re-deriving them, that the one new piece of data (the
 * daily number-health count) leaves the audit's own rows untouched, and that nothing on it reads as
 * dev text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-data-quality-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
delete process.env.GRIDIRON_DATA_QUALITY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const dq = await import('../server/services/data-quality.js');
const { writeAuditRows, readNumberAudit, readNumberHealthTrend } = await import('../server/services/number-audit.js');
const { dataFreshness, FALLBACK_REGISTRY } = await import('../server/services/data-freshness.js');
const { loadDecidedOffers } = await import('../server/services/eval/decided-offers.js');
const { __resetPlansCache } = await import('../server/services/war-room-view.js');
const { default: dataQualityRouter } = await import('../server/routes/data-quality.js');

const app = express();
app.use('/api/data-quality', dataQualityRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const getJson = async url => (await fetch(base + url)).json();

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = hoursAgo => new Date(NOW - hoursAgo * 3_600_000).toISOString();

/* ------------------------------------------------------------------ B6 helper */

/** Every headline/detail string anywhere in a response. */
function plainStrings(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => plainStrings(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'headline' || k === 'detail') && typeof v === 'string') out.push(v);
      else plainStrings(v, out);
    }
  }
  return out;
}
const DEV_TEXT = /[a-z]+_[a-z0-9_]+|\/|\.m?js\b|GRIDIRON_|\bSELECT\b|\bWHERE\b|Error\b|\bnull\b|\bundefined\b|\bNaN\b/;
function assertNoDevText(report) {
  const strings = plainStrings(report);
  assert.ok(strings.length > 0, 'no plain strings to check');
  for (const s of strings) assert.doesNotMatch(s, DEV_TEXT, `dev text on the panel: "${s}"`);
}

/* ------------------------------------------------------------------ B1 */

test('B1: flag off, the route answers enabled:false with its reason and nothing else', async () => {
  delete process.env.GRIDIRON_DATA_QUALITY;
  assert.deepEqual(await getJson('/api/data-quality'), { enabled: false, reason: dq.DATA_QUALITY_OFF_REASON });
});

test('B1: preview mode alone does not switch it on; only its own flag does', async () => {
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    assert.equal(dq.dataQualityFlag(process.env).enabled, false);
    assert.equal((await getJson('/api/data-quality')).enabled, false);
  } finally { delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; }
  assert.equal(dq.dataQualityFlag({ GRIDIRON_DATA_QUALITY: '1' }).enabled, true);
});

/* ------------------------------------------------------------------ B2 */

test('B2: freshness section equals dataFreshness source for source', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS player_week_usage (season INTEGER, week INTEGER, player_id INTEGER)`);
  db.prepare('INSERT INTO player_week_usage VALUES (2025, 17, 1)').run();
  const tables = dataFreshness({ registry: FALLBACK_REGISTRY, currentSeason: 2026, currentWeek: 3, database: db });
  const section = dq.freshnessSection(tables);
  assert.equal(section.sources.length, tables.length);
  for (const t of tables) {
    const s = section.sources.find(x => x.label === t.label);
    assert.ok(s, `source ${t.label} missing`);
    assert.equal(s.status, t.status);
  }
  for (const st of ['fresh', 'stale', 'empty', 'unknown']) {
    assert.equal(section.counts[st], tables.filter(t => t.status === st).length, st);
  }
  assert.equal(section.status, tables.every(t => t.status === 'fresh') ? 'ok' : 'attention');
  // player_week_usage holds 2025 only: stale, and says so in words.
  assert.equal(section.sources.find(s => s.label === 'Weekly player usage').status, 'stale');
  assertNoDevText({ section });
});

/* ------------------------------------------------------------------ B3 */

function seedOffers() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER, season INTEGER, tx_id TEXT, type TEXT, execution_type TEXT, team_id INTEGER,
    related_tx_id TEXT, proposed_at TEXT, items_json TEXT)`);
  const raw = db.prepare(`INSERT INTO league_transactions_raw
    (league_id, season, tx_id, type, execution_type, team_id, related_tx_id, proposed_at, items_json) VALUES (?,?,?,?,?,?,?,?,?)`);
  const items = JSON.stringify([{ playerId: 11, fromTeamId: 1, toTeamId: 2 }, { playerId: 12, fromTeamId: 2, toTeamId: 1 }]);
  // Two answers whose proposals were never collected: orphans.
  raw.run(4, 2026, 'a-900', 'TRADE_ACCEPT', 'EXECUTE', 2, 'p-900', iso(30), null);
  raw.run(2, 2026, 'a-901', 'TRADE_DECLINE', 'EXECUTE', 3, 'p-901', iso(20), null);
  // One answered offer with its proposal: not an orphan.
  raw.run(4, 2026, 'p-902', 'TRADE_PROPOSAL', 'EXECUTE', 1, null, iso(50), items);
  raw.run(4, 2026, 'a-902', 'TRADE_DECLINE', 'EXECUTE', 2, 'p-902', iso(40), null);

  const to = db.prepare(`INSERT INTO trade_outcomes
    (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at, model_p_accept, status, idea_id, sent_at, matched_tx_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  to.run(4, 2026, 'app_proposed', '1', '3', iso(81), 0.4, 'proposed', 'i-1', iso(80), null, iso(81)); // unmatched 80 h: orphan
  to.run(4, 2026, 'app_proposed', '1', '5', iso(11), 0.4, 'proposed', 'i-2', iso(10), null, iso(11)); // 10 h: not yet
  to.run(4, 2026, 'app_proposed', '1', '2', iso(51), 0.4, 'proposed', 'i-3', iso(50), 'p-902', iso(51)); // matched: not
}

test('B3: offer orphans per league, the answer count straight from loadDecidedOffers', () => {
  seedOffers();
  const decided = loadDecidedOffers(db);
  const sent = dq.readUnmatchedSent(db);
  const section = dq.orphansSection({ decided, sent, now: NOW });
  const byLeague = Object.fromEntries(section.leagues.map(l => [l.league_id, l]));
  assert.equal(byLeague[4].answers_without_offer, 1);
  assert.equal(byLeague[4].sent_not_found, 1);
  assert.equal(byLeague[2].answers_without_offer, 1);
  assert.equal(byLeague[2].sent_not_found, 0);
  assert.equal(section.total, 3);
  assert.equal(section.leagues.reduce((s, l) => s + l.answers_without_offer, 0), decided.orphans.length);
  assert.equal(section.status, 'attention');
  assertNoDevText({ section });
});

test('B3: no offers anywhere is ok, not attention', () => {
  const section = dq.orphansSection({ decided: { orphans: [] }, sent: [], now: NOW });
  assert.equal(section.status, 'ok');
  assert.equal(section.total, 0);
});

/* ------------------------------------------------------------------ B4 */

const auditRow = (id, status) => ({ check_id: id, status, title: `Check ${id}`, detail: 'd' });

test('B4: one point per UTC day, the last run of the day wins, directions', () => {
  writeAuditRows(7, [auditRow('a', 'ok'), auditRow('b', 'ok')], { asOf: '2026-09-24T10:00:00Z', database: db });
  writeAuditRows(7, [auditRow('a', 'broken'), auditRow('b', 'ok')], { asOf: '2026-09-25T10:00:00Z', database: db });
  writeAuditRows(7, [auditRow('a', 'broken'), auditRow('b', 'warn')], { asOf: '2026-09-26T01:00:00Z', database: db });
  writeAuditRows(7, [auditRow('a', 'warn'), auditRow('b', 'warn')], { asOf: '2026-09-26T09:00:00Z', database: db });
  const points = readNumberHealthTrend(db, { now: NOW }).filter(p => p.league_id === 7);
  assert.deepEqual(points.map(p => p.day), ['2026-09-24', '2026-09-25', '2026-09-26']);
  assert.deepEqual(points.at(-1), { league_id: 7, day: '2026-09-26', broken: 0, warn: 2, ok: 0 });

  const section = dq.trendSection(points);
  assert.equal(section.leagues[0].direction, 'worse');
  assert.equal(dq.trendSection([{ league_id: 1, day: '2026-09-20', broken: 2, warn: 0, ok: 5 },
    { league_id: 1, day: '2026-09-26', broken: 0, warn: 1, ok: 6 }]).leagues[0].direction, 'better');
  assert.equal(dq.trendSection([{ league_id: 1, day: '2026-09-20', broken: 1, warn: 0, ok: 5 },
    { league_id: 1, day: '2026-09-26', broken: 0, warn: 1, ok: 5 }]).leagues[0].direction, 'flat');
  assert.equal(dq.trendSection([{ league_id: 1, day: '2026-09-26', broken: 0, warn: 0, ok: 5 }]).leagues[0].direction, 'too_new');
  assertNoDevText({ section });
});

test('B4: the 14-day window drops older points', () => {
  writeAuditRows(8, [auditRow('a', 'ok')], { asOf: '2026-09-01T10:00:00Z', database: db });
  writeAuditRows(8, [auditRow('a', 'ok')], { asOf: '2026-09-25T10:00:00Z', database: db });
  const days = readNumberHealthTrend(db, { now: NOW }).filter(p => p.league_id === 8).map(p => p.day);
  assert.deepEqual(days, ['2026-09-25']);
});

test('B4: number_audit rows are byte-identical with and without the daily table', () => {
  const rows = [auditRow('x', 'broken'), auditRow('y', 'ok')];
  writeAuditRows(9, rows, { asOf: '2026-09-26T10:00:00Z', database: db });
  const withDaily = JSON.stringify(readNumberAudit(9, { database: db }));
  db.exec('DELETE FROM number_audit WHERE league_id = 9');
  db.exec('ALTER TABLE number_health_daily RENAME TO number_health_daily_aside');
  try {
    writeAuditRows(9, rows, { asOf: '2026-09-26T10:00:00Z', database: db });
    assert.equal(JSON.stringify(readNumberAudit(9, { database: db })), withDaily);
  } finally {
    db.exec('ALTER TABLE number_health_daily_aside RENAME TO number_health_daily');
  }
});

/* ------------------------------------------------------------------ B5 */

function plansFixture() {
  return {
    status: 'ok', as_of: iso(1), id: 'plans@1',
    entries: [
      { league: 4, planned_at: iso(1), error: 'planLeague threw TypeError: x is undefined' },
      { league: 2, planned_at: iso(30) },
      { league: 3, planned_at: iso(1), brain_report: { overall: 'failing', checks: [], blocks: ['E1 failing'], fell_back_to: 'balanced' } },
      { league: 5, planned_at: iso(1), brain_report: { overall: 'passing', checks: [], blocks: [] } },
    ],
  };
}
const fitTables = [
  { table: 'weekly_fits', label: 'Weekly model fit', grain: 'fit', status: 'stale' },
  { table: 'dynasty_values', label: 'FantasyCalc market values', grain: 'static', status: 'fresh' },
];

test('B5: planner failure, a kept out-of-date plan, a Balanced fallback and a stale fit; nothing for the clean league', () => {
  const section = dq.fallbacksSection({ plans: plansFixture(), tables: fitTables, now: NOW });
  const kinds = section.items.map(i => `${i.kind}:${i.league_id ?? i.label}`).sort();
  assert.deepEqual(kinds, ['balanced_fallback:3', 'model_fallback:Weekly model fit', 'plan_out_of_date:2', 'planner_failed:4']);
  assert.ok(!section.items.some(i => i.league_id === 5));
  assert.equal(section.status, 'attention');
  assertNoDevText({ section });
});

test('B5: no plans file is one plain item, not an error', () => {
  const section = dq.fallbacksSection({ plans: { status: 'unknown', reason: 'No plan has been run yet: the plans file does not exist.' }, tables: [], now: NOW });
  assert.equal(section.items.length, 1);
  assert.equal(section.items[0].kind, 'no_plans');
  assertNoDevText({ section });
});

/* ------------------------------------------------------------------ B7 */

test('B7: a section whose reader throws is unknown in words; the others still serve; the error is logged only', () => {
  const names = ['freshness', 'offer_orphans', 'number_health_trend', 'fallbacks'];
  for (const broken of names) {
    const logged = [];
    const readers = Object.fromEntries(names.map(n => [n, n === broken
      ? () => { throw new Error('SELECT exploded in some_table'); }
      : () => ({ status: 'ok', headline: 'Fine' })]));
    const report = dq.composeReport(readers, { now: NOW, log: m => logged.push(m) });
    assert.equal(report.sections[broken].status, 'unknown');
    assert.equal(report.sections[broken].headline, 'Could not be read');
    for (const n of names.filter(x => x !== broken)) assert.equal(report.sections[n].status, 'ok');
    assert.equal(report.overall, 'unknown');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /exploded/);
    assert.doesNotMatch(JSON.stringify(report), /exploded/);
  }
});

/* ------------------------------------------------------------------ B6 + B8, end to end */

test('B6 + B8: flag on, the route serves all four sections fast with no dev text', async () => {
  fs.writeFileSync(process.env.GRIDIRON_WARROOM_PLANS, JSON.stringify({
    schema: 'x', generated_at: iso(1), producer: 'p', producer_version: 'v', leagues: plansFixture().entries,
  }));
  __resetPlansCache();
  process.env.GRIDIRON_DATA_QUALITY = '1';
  try {
    const t0 = performance.now();
    const body = await getJson('/api/data-quality');
    const ms = performance.now() - t0;
    assert.equal(body.enabled, true);
    for (const k of ['freshness', 'offer_orphans', 'number_health_trend', 'fallbacks']) {
      assert.ok(body.sections[k], `section ${k} missing`);
      assert.notEqual(body.sections[k].status, 'unknown', `section ${k} could not be read`);
    }
    assert.ok(['ok', 'attention'].includes(body.overall));
    assertNoDevText(body);
    assert.ok(ms < 250, `report took ${ms.toFixed(0)} ms`);
  } finally { delete process.env.GRIDIRON_DATA_QUALITY; }
});
