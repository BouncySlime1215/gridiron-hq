/**
 * FP-GUARD (RULES-EVERYWHERE): Nick's rule is FantasyPros is never displayed or committed, and a client
 * payload that carries its ranks is exposure even when no page renders them. Every client-facing view
 * built here must carry no key matching /^fp_|fantasypros/i (and the War Room none named `fp`).
 *
 * Views: every /api JSON response (the fantasyProsGuard middleware server/index.js mounts on /api),
 * the War Room view (GET /api/trades/:id/war-room, the blue-chip board is where the ranks lived),
 * and Coach's plan_read of that board (its ledger goes to the client). Made-up players and ranks only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fp-guard-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const plansFile = path.join(temp, 'plans.json');
process.env.GRIDIRON_WARROOM_PLANS = plansFile;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { FP_KEY, stripFantasyPros, hasFantasyPros, fantasyProsGuard } = await import('../server/services/fantasypros-guard.js');
const { blueChipsSection } = await import('../server/services/campaign/view.js');
const { warRoomView } = await import('../server/services/war-room-view.js');
const { planRead } = await import('../server/services/coach/brain-tools.js');

const EXPOSED = /^fp_|fantasypros/i;
/** Every key path in `value` that matches EXPOSED (plus `also`). */
function exposed(value, also = [], at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => exposed(v, also, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (EXPOSED.test(k) || also.includes(k)) out.push(`${at}.${k}`);
      exposed(v, also, `${at}.${k}`, out);
    }
  }
  return out;
}

test('stripFantasyPros removes every fp_* / FantasyPros key at any depth and leaves a clean value untouched', () => {
  const clean = { a: 1, list: [{ b: 2 }], fc_value: 3, fpx: 4 };
  assert.equal(stripFantasyPros(clean), clean, 'no copy when nothing matches');
  const dirty = { a: 1, fp_rank: 2, nested: [{ FantasyProsTake: 'x', ok: 1, deeper: { fp_prev_rank: 3, keep: true } }] };
  const out = stripFantasyPros(dirty);
  assert.deepEqual(out, { a: 1, nested: [{ ok: 1, deeper: { keep: true } }] });
  assert.deepEqual(exposed(out), []);
  assert.ok(hasFantasyPros(dirty) && !hasFantasyPros(out));
  assert.equal(FP_KEY.source, EXPOSED.source, 'the guard and this test read the same key rule');
});

test('every /api JSON response goes out without FantasyPros keys (the middleware server/index.js mounts)', async () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /app\.use\('\/api', fantasyProsGuard\)/, 'mounted on /api');
  assert.ok(src.indexOf("app.use('/api', fantasyProsGuard)") < src.indexOf("app.use('/api/"), 'mounted before every router');
  const app = express();
  app.use('/api', fantasyProsGuard);
  app.get('/api/x', (_req, res) => res.json({ rows: [{ id: 1, fp_ros_rank: 4, fp_rank: 3, fantasypros: { ecr: 1 } }], coverage: { fp_ros_rank: 0.9, score: 1 } }));
  const server = app.listen(0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/x`)).json();
    assert.deepEqual(body, { rows: [{ id: 1 }], coverage: { score: 1 } });
  } finally { server.close(); }
});

/* The War Room view and Coach's plan_read over a plans file whose blue-chip board carries FantasyPros ranks. */
const PRODUCER = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
const LEAGUE = PRODUCER.leagues[0].league;
const board = {
  status: 'ok', weights: { pick: 0.5, production: 0.5, basis: 'fixture' }, labels: ['Blue chip'],
  rows: [{ player: '1', name: 'P1', position: 'QB', mine: true, score: 88, label: 'Blue chip', hurt: false,
    parts: { pick_pct: 90, prod_basis: 'season_ppg', prod_pct: 86, games: 2, team_games: 2, missed: 0 },
    model_value: 3000, model_rank: 4, fp_ros_rank: 7, fp_pos_rank: 2, fp_rank: 6, fp_prev_rank: 9, gaps: [], protected: true }],
  coverage: { rostered: 1, board: 1, score: 1, model_value: 1, fp_ros_rank: 1 },
  fp: { status: 'ok', sync: 'ok', scrape_date: '2026-09-20' }, draft: { season: 2026, picks: 170 },
};
const section = blueChipsSection(board, {});
assert.ok(exposed(section, ['fp']).length > 0, 'premise: the producer section carries FantasyPros keys');
const plans = structuredClone(PRODUCER);
plans.leagues[0].blue_chips = section;
fs.writeFileSync(plansFile, JSON.stringify(plans));

test('the War Room view carries no FantasyPros key, not even the board\'s fp sync block', async () => {
  const was = process.env.GRIDIRON_WARROOM_ENABLED;
  process.env.GRIDIRON_WARROOM_ENABLED = '1';
  try {
    const view = await warRoomView(LEAGUE);
    assert.equal(view.enabled, true);
    assert.equal(view.blue_chips?.status, 'ok', `the board is served (${JSON.stringify(view.blue_chips)?.slice(0, 200)})`);
    assert.equal(view.blue_chips.value.rows[0].score, 88, 'the board itself is still served');
    assert.deepEqual(exposed(view, ['fp']), []);
  } finally { if (was === undefined) delete process.env.GRIDIRON_WARROOM_ENABLED; else process.env.GRIDIRON_WARROOM_ENABLED = was; }
});

test('Coach plan_read of the blue-chip board (its ledger reaches the client) carries no FantasyPros column', () => {
  const rows = planRead({ league_id: LEAGUE, section: 'blue_chips' });
  assert.equal(rows[0].status, 'ok');
  assert.ok(Object.keys(rows[0]).some(k => k.includes('score')), 'the board is read');
  assert.deepEqual(Object.keys(rows[0]).filter(k => /(^|_)fp(_|$)|fantasypros/i.test(k)), []);
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
