/**
 * BROKEN-01a/b: the number audit (server/services/number-audit.js), its table
 * (migration 077), its refresh-loop step, the read-only GET /api/number-audit, and
 * the Settings "Number health" card + nav dot (client/src/components/NumberHealth.tsx).
 *
 * RED cases from ENGINE-SPECS BROKEN-01:
 *  - two title-odds paths 5 pts apart -> a 'broken' row naming both pages;
 *  - a NaN range -> broken;
 *  - a stale ESPN sync -> warn;
 *  - an all-clean fixture -> 0 broken;
 *  - the route returns the stored rows; the card renders a broken row in plain words;
 *    the dot is hidden when 0 are broken.
 * Snapshots are fixtures: no simulation runs here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import express from 'express';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-number-audit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const AUDIT = await import('../server/services/number-audit.js');
const { evaluateSnapshot, writeAuditRows, readNumberAudit, runNumberAudit } = AUDIT;

const NOW = Date.parse('2026-09-23T20:00:00Z');
const minutesAgo = m => new Date(NOW - m * 60_000).toISOString();

/** A league of four teams, two playoff spots, every producer agreeing. */
function cleanSnapshot() {
  const title = { 1: 0.31, 2: 0.29, 3: 0.22, 4: 0.18 };
  const playoff = { 1: 0.62, 2: 0.55, 3: 0.45, 4: 0.38 };
  return {
    league_id: 7, my_team_id: '1', playoff_teams: 2,
    title_paths: [
      { id: 'my_team', label: 'My team', pages: ['My team'], complete: true, title: { ...title }, playoff: { ...playoff } },
      { id: 'trade_lab', label: 'Trade Lab title impact', pages: ['Trade Lab (title impact)', 'TradeCard title button'], complete: true,
        title: { ...title, 1: 0.30, 2: 0.30 }, playoff: { ...playoff } },
      { id: 'finder_horizon', label: 'Trade finder horizon', pages: ['Trade finder (playoff weighting)'], complete: false, playoff: { 1: 0.61 } },
    ],
    projection_basis: { rank_corr: 0.95, n: 60, mean_abs_ppg_diff: 1.1 },
    weekly_ranges: [
      { id: 'trade_card', label: 'Trade card', pages: ['Trade cards'], floor: 92, median: 110, ceiling: 128 },
      { id: 'season_sim', label: 'Title odds simulator', pages: ['My team (title odds)'], floor: 90, median: 111, ceiling: 131 },
      { id: 'ceiling_lineup', label: 'Ceiling lineup', pages: ['My team (ceiling lineup)'], floor: 94, median: 109, ceiling: 126 },
      { id: 'lineup_posture', label: 'Start/Sit posture', pages: ['Start/Sit'], floor: 91, median: 110, ceiling: 129 },
    ],
    current_weeks: [
      { id: 'trade_engine', label: 'Trade finder / trade cards', pages: ['Trade finder'], week: 3 },
      { id: 'league_week', label: 'League Hub', pages: ['League Hub'], week: 3 },
      { id: 'season_sim', label: 'Title odds simulator', pages: ['My team (title odds)'], week: 3 },
    ],
    p_play: { rostered: 60, defaulted: 0, max_caller_gap: 0.01 },
    checked_out: { signals: [
      { id: 'checked_out_factor', label: 'checkedOutFactor (counterparty pricing)', on: true },
      { id: 'activity_manager', label: 'activity.manager (engine)', on: false },
    ] },
    sources: [
      { id: 'league_sync', label: 'League sync', as_of: minutesAgo(20), max_age_minutes: 180, pages: ['Every league page'] },
      { id: 'nfl_injuries', label: 'NFL injury reports', as_of: minutesAgo(90), max_age_minutes: 4320, pages: ['Start/Sit'] },
    ],
  };
}

const byId = rows => Object.fromEntries(rows.map(r => [r.check_id, r]));
const broken = rows => rows.filter(r => r.status === 'broken');

// ------------------------------------------------------------------ evaluation
test('clean fixture: 0 broken and 0 warn, every check present', () => {
  const rows = evaluateSnapshot(cleanSnapshot(), { now: NOW });
  assert.deepEqual(broken(rows), [], JSON.stringify(broken(rows), null, 1));
  assert.deepEqual(rows.filter(r => r.status === 'warn').map(r => r.check_id), []);
  assert.deepEqual(rows.map(r => r.check_id).sort(), Object.keys(AUDIT.CHECKS).sort());
});

test('RED: two title-odds paths 5 pts apart -> broken, naming both pages', () => {
  const snap = cleanSnapshot();
  snap.title_paths[1].title = { 1: 0.26, 2: 0.32, 3: 0.23, 4: 0.19 }; // My team 31% vs Trade Lab 26%
  const r = byId(evaluateSnapshot(snap, { now: NOW })).title_odds_paths;
  assert.equal(r.status, 'broken');
  assert.equal(r.inventory_row, 'B');
  assert.ok(r.pages_affected.includes('My team'), r.pages_affected.join(', '));
  assert.ok(r.pages_affected.includes('Trade Lab (title impact)'), r.pages_affected.join(', '));
  assert.match(r.detail, /My team and Trade Lab title impact disagree on your title odds: 31% vs 26%/);
  assert.match(r.detail, /5.0 pts apart; limit 4 pts/);
  assert.ok(r.trust && r.cause, 'what to trust and why are on the row');
});

test('RED: a NaN weekly range -> broken', () => {
  const snap = cleanSnapshot();
  snap.weekly_ranges[2].ceiling = NaN;
  const rows = byId(evaluateSnapshot(snap, { now: NOW }));
  assert.equal(rows.inv_no_nan.status, 'broken');
  assert.match(rows.inv_no_nan.detail, /Ceiling lineup\.ceiling/);
  assert.deepEqual(rows.inv_no_nan.pages_affected, ['My team (ceiling lineup)']);
  assert.notEqual(rows.inv_range_order.status, 'broken', 'a NaN is reported once, as NaN, not as a disorder');
});

test('RED: a stale ESPN league sync -> warn, not broken', () => {
  const snap = cleanSnapshot();
  snap.sources[0].as_of = '2026-09-22 20:00:00'; // SQLite datetime('now') text, 24 h old
  const rows = evaluateSnapshot(snap, { now: NOW });
  const r = byId(rows).source_age;
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /League sync last synced 24 h ago \(max 3\.0 h\)/);
  assert.deepEqual(broken(rows), []);
});

test('the other duplicate producers: A rank agreement, C samplers, D weeks, E defaults, H two signals', () => {
  const snap = cleanSnapshot();
  snap.projection_basis = { rank_corr: 0.796, n: 58, mean_abs_ppg_diff: 3.4 };
  snap.weekly_ranges[3] = { ...snap.weekly_ranges[3], floor: 70, median: 100, ceiling: 130 };
  snap.current_weeks[0].week = 4;
  snap.p_play = { rostered: 60, defaulted: 3, max_caller_gap: 0.3 };
  snap.checked_out.signals[1].on = true;
  const rows = byId(evaluateSnapshot(snap, { now: NOW }));
  assert.equal(rows.projection_basis.status, 'broken');
  assert.match(rows.projection_basis.detail, /0\.80 over 58 rostered players/);
  assert.equal(rows.weekly_range.status, 'broken');
  assert.match(rows.weekly_range.detail, /floor this week: .*Start\/Sit posture says 70\.0/);
  assert.equal(rows.current_week.status, 'broken');
  assert.match(rows.current_week.detail, /Trade finder \/ trade cards week 4, League Hub week 3/);
  assert.equal(rows.p_play_default.status, 'broken');
  assert.match(rows.p_play_default.detail, /3 of 60 rostered players/);
  assert.equal(rows.checked_out.status, 'broken');
  // Defaults alone, with the callers agreeing, are a warning.
  snap.p_play = { rostered: 60, defaulted: 3, max_caller_gap: 0 };
  assert.equal(byId(evaluateSnapshot(snap, { now: NOW })).p_play_default.status, 'warn');
});

test('invariants: odds outside [0,1], sums off, a floor above its ceiling', () => {
  const snap = cleanSnapshot();
  snap.title_paths[0].title[4] = 1.2;
  snap.title_paths[1].playoff = { 1: 0.9, 2: 0.9, 3: 0.9, 4: 0.9 };
  snap.weekly_ranges[0] = { ...snap.weekly_ranges[0], floor: 140 };
  const rows = byId(evaluateSnapshot(snap, { now: NOW }));
  assert.equal(rows.inv_probability_range.status, 'broken');
  assert.equal(rows.inv_odds_sum.status, 'broken');
  assert.match(rows.inv_odds_sum.detail, /Trade Lab title impact playoff odds sum to 3\.60 for 2 spots/);
  assert.equal(rows.inv_range_order.status, 'broken');
});

test('a producer that failed is a warn row that says why, never a silent ok', () => {
  const snap = cleanSnapshot();
  snap.title_paths = [{ id: 'my_team', label: 'My team', pages: ['My team'], error: 'no remaining fixtures' },
    snap.title_paths[1]];
  snap.projection_basis = { error: 'buildProjections threw' };
  const rows = byId(evaluateSnapshot(snap, { now: NOW }));
  assert.equal(rows.title_odds_paths.status, 'warn');
  assert.match(rows.title_odds_paths.detail, /Could not measure: My team: no remaining fixtures/);
  assert.equal(rows.projection_basis.status, 'warn');
  assert.match(rows.projection_basis.detail, /buildProjections threw/);
});

// ------------------------------------------------------------------ storage + loop
test('write/read: rows round-trip worst first; first_seen_at holds while the status holds', () => {
  const snap = cleanSnapshot();
  snap.title_paths[1].title = { 1: 0.26, 2: 0.32, 3: 0.23, 4: 0.19 };
  writeAuditRows(7, evaluateSnapshot(snap, { now: NOW }), { asOf: '2026-09-23T20:00:00.000Z' });
  writeAuditRows(7, evaluateSnapshot(snap, { now: NOW }), { asOf: '2026-09-23T21:00:00.000Z' });
  const out = readNumberAudit(7);
  assert.equal(out.broken, 1);
  assert.equal(out.rows[0].check_id, 'title_odds_paths');
  assert.equal(out.rows[0].first_seen_at, '2026-09-23T20:00:00.000Z');
  assert.equal(out.rows[0].as_of, '2026-09-23T21:00:00.000Z');
  assert.deepEqual(out.rows[0].pages_affected.slice(0, 1), ['My team']);
  writeAuditRows(7, evaluateSnapshot(cleanSnapshot(), { now: NOW }), { asOf: '2026-09-23T22:00:00.000Z' });
  const fixed = readNumberAudit(7);
  assert.equal(fixed.broken, 0);
  assert.equal(fixed.rows.find(r => r.check_id === 'title_odds_paths').first_seen_at, '2026-09-23T22:00:00.000Z');
});

test('runNumberAudit: audits each synced league once per sync, isolates a failing league', async () => {
  const leagues = [{ id: 11, fetched_at: 'a' }, { id: 12, fetched_at: 'a' }];
  const seen = [];
  const collect = async lg => {
    seen.push(lg.id);
    if (lg.id === 12) throw new Error('ESPN payload unreadable');
    return cleanSnapshot();
  };
  const memo = new Map();
  const lines = [];
  const r = await runNumberAudit({ collect, leagues, memo, now: () => NOW, log: l => lines.push(l) });
  assert.deepEqual(r.audited.map(a => a.league_id), [11]);
  assert.deepEqual(r.failed.map(f => f.league_id), [12]);
  assert.ok(lines.some(l => /league 12 FAILED ESPN payload unreadable/.test(l)));
  assert.equal(readNumberAudit(11).rows.length, Object.keys(AUDIT.CHECKS).length);
  const again = await runNumberAudit({ collect, leagues, memo, now: () => NOW + 60_000, log: () => {} });
  assert.deepEqual(again.audited, [], 'league 11 is fresh');
  assert.deepEqual(seen, [11, 12, 12], 'the failed league is retried; the fresh one is not');
  const resynced = await runNumberAudit({ collect, leagues: [{ id: 11, fetched_at: 'b' }], memo, now: () => NOW + 120_000, log: () => {} });
  assert.deepEqual(resynced.audited.map(a => a.league_id), [11], 'a new sync is re-audited at once');
});

test('the refresh loop runs the audit after manager signals, and the web server never imports the collector', async () => {
  const LOOP = await import('../scripts/refresh-live-data.mjs');
  const order = [];
  const spawn = (cmd, args) => {
    order.push(path.basename(args.find(a => /\.(mjs|py)$/.test(a))));
    return { status: 0, stdout: 'league_chat_status {"failed_this_run":0,"failed_outstanding":0}\n', stderr: '' };
  };
  const lines = [];
  const numberAudit = LOOP.createNumberAuditStep({ log: l => lines.push(l),
    audit: async () => { order.push('number_audit'); return { audited: [{ league_id: 1 }], failed: [], skipped_fresh: 0 }; } });
  await LOOP.tick({ jobs: [], spawn, log: l => lines.push(l), record: () => {}, inputsKey: () => 'k', numberAudit });
  // Integration order (INTEGRATION-AUDIT-0923 section 2): number_audit, then EVAL-01's brain_report last.
  assert.deepEqual(order.slice(-3), ['build-manager-signals.mjs', 'number_audit', 'run-graders.mjs']);
  assert.ok(lines.some(l => /number_audit\s+ok 1 audited/.test(l)), lines.join('\n'));
  // "No page recomputes": the route imports only the reader, and the service loads the
  // producers lazily inside collectLeagueSnapshot, so importing it runs no simulation.
  const route = fs.readFileSync(new URL('../server/routes/number-audit.js', import.meta.url), 'utf8');
  assert.deepEqual([...route.matchAll(/import \{([^}]+)\} from '..\/services\/number-audit\.js'/g)].map(m => m[1].trim()), ['readNumberAudit']);
  const service = fs.readFileSync(new URL('../server/services/number-audit.js', import.meta.url), 'utf8');
  assert.deepEqual([...service.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]), ['../db/index.js']);
});

// ------------------------------------------------------------------ route
test('GET /api/number-audit returns the stored rows, read-only; a bad id is a 400', async () => {
  const { default: router } = await import('../server/routes/number-audit.js');
  const app = express();
  app.use('/api/number-audit', router);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/number-audit`;
    const snap = cleanSnapshot();
    snap.title_paths[1].title = { 1: 0.26, 2: 0.32, 3: 0.23, 4: 0.19 };
    writeAuditRows(21, evaluateSnapshot(snap, { now: NOW }), { asOf: '2026-09-23T20:00:00.000Z' });
    const before = db.prepare('SELECT COUNT(*) n FROM number_audit').get().n;
    const body = await (await fetch(`${base}?league_id=21`)).json();
    assert.equal(body.broken, 1);
    assert.equal(body.rows[0].status, 'broken');
    assert.match(body.rows[0].detail, /31% vs 26%/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM number_audit').get().n, before, 'a read writes nothing');
    assert.equal((await fetch(`${base}?league_id=abc`)).status, 400);
    const empty = await (await fetch(`${base}?league_id=999`)).json();
    assert.deepEqual([empty.broken, empty.rows.length], [0, 0]);
  } finally { server.close(); }
});

// ------------------------------------------------------------------ client
const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
const source = fs.readFileSync(new URL('../client/src/components/NumberHealth.tsx', import.meta.url), 'utf8');
let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))})(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
for (const [from, to] of [
  ["'../api'", write('api.mjs', 'export function useApi(p) { globalThis.__auditPath = p; return { data: globalThis.__auditPayload, loading: false, error: null, refetch() {} }; }')],
  ["'../state/league'", write('league.mjs', "export function useLeague() { return { activeId: 21, active: { id: 21, name: 'League' } }; }")],
  ["'../lib/errorSanitize'", write('sanitize.mjs', "export function sanitizedMessage(_w, prefix) { return prefix; }")],
  ['"react/jsx-runtime"', runtimeUrl],
]) {
  assert.ok(compiled.includes(from), `the compiled card imports ${from}`);
  compiled = compiled.split(from).join(`'${to}'`);
}
const UI = await import(write('NumberHealth.mjs', compiled));
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

test('the card renders a broken row in plain words: what, pages, what to trust', () => {
  const snap = cleanSnapshot();
  snap.title_paths[1].title = { 1: 0.26, 2: 0.32, 3: 0.23, 4: 0.19 };
  writeAuditRows(21, evaluateSnapshot(snap, { now: NOW }), { asOf: new Date().toISOString() });
  globalThis.__auditPayload = readNumberAudit(21);
  const html = renderToStaticMarkup(React.createElement(UI.default));
  const t = text(html);
  assert.equal(globalThis.__auditPath, '/number-audit?league_id=21', 'reads the selected league');
  assert.match(t, /Number health/);
  assert.match(t, /1 broken/);
  assert.match(t, /Title odds differ between pages/);
  assert.match(t, /My team and Trade Lab title impact disagree on your title odds: 31% vs 26%/);
  assert.match(t, /Pages: My team, Trade Lab \(title impact\), TradeCard title button/);
  assert.match(t, /Meanwhile: Use the Trade Lab \/ TradeCard number/);
  assert.match(html, /data-number-check="title_odds_paths" data-status="broken"/);
  assert.match(html, /data-broken-dot/, 'the card carries the dot too');
  assert.doesNotMatch(html, /data-number-check="inv_no_nan"/, 'passing checks are counted, not listed');
});

test('the nav dot is hidden when 0 are broken and shown when any is', () => {
  globalThis.__auditPayload = { league_id: 21, table_missing: false, as_of: null, broken: 0, warn: 2, ok: 9, rows: [] };
  assert.equal(renderToStaticMarkup(React.createElement(UI.NumberHealthNavDot)), '');
  globalThis.__auditPayload = null;
  assert.equal(renderToStaticMarkup(React.createElement(UI.NumberHealthNavDot)), '', 'no data yet: no dot');
  globalThis.__auditPayload = { league_id: 21, table_missing: false, as_of: null, broken: 2, warn: 0, ok: 9, rows: [] };
  const dot = renderToStaticMarkup(React.createElement(UI.NumberHealthNavDot));
  assert.match(dot, /data-broken-dot/);
  assert.match(dot, /bg-rose-600/);
  assert.match(dot, /aria-label="2 broken numbers in this league"/);
});

test('the card says when the loop has not checked a league yet, or the table is not there', () => {
  const empty = text(renderToStaticMarkup(React.createElement(UI.NumberHealthView,
    { payload: { league_id: 21, table_missing: false, as_of: null, broken: 0, warn: 0, ok: 0, rows: [] } })));
  assert.match(empty, /Not checked yet for this league/);
  const missing = text(renderToStaticMarkup(React.createElement(UI.NumberHealthView,
    { payload: { league_id: 21, table_missing: true, as_of: null, broken: 0, warn: 0, ok: 0, rows: [] } })));
  assert.match(missing, /not set up yet/);
});
