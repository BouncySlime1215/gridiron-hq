/**
 * NUMBER-DOT (#330, WR-E2E): the War Room's number-health dot reads the plans contract's
 * number_health shape (plans-schema.js: { overall, broken, warn, ok, checks[] }), not the
 * { status, open } shape no producer writes. ok -> green, warn -> amber, broken -> red, each
 * with the broken / warn counts and the check names on hover (compact) or in the list
 * (full). Unknown or failed stays grey and says why. The brain dot names the report's
 * `overall` (passing / failing / not enough data yet), not the field's status.
 *
 * WR_NUMBER_DOT_PLANS=<plans.json> also renders the SERVED league-4 view built from that
 * plans file and prints `NUMBER-DOT served: league=4 overall=<o> dot=<color> ...`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const ENTRY = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/ui-contract-plans.json', import.meta.url), 'utf8')).leagues[0];

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { HealthDot, BrainDot, default: BrainCheckCard } = await wr.mod('BrainCheckCard');

const CHECKS = [
  { check_id: 'projection_basis', status: 'broken', title: 'Projection basis', detail: 'Projections are older than a week.' },
  { check_id: 'weekly_range', status: 'warn', title: 'Weekly range' },
  { check_id: 'source_age', status: 'ok', title: 'Source age' },
  { check_id: 'inv_no_nan', status: 'ok', title: 'No NaN' },
];
/** A contract-shaped number_health field (the producer's readNumberHealth output). */
function health(overall) {
  const checks = overall === 'ok' ? CHECKS.map(c => ({ ...c, status: 'ok' }))
    : overall === 'warn' ? CHECKS.map(c => (c.status === 'broken' ? { ...c, status: 'warn' } : c)) : CHECKS;
  const n = s => checks.filter(c => c.status === s).length;
  return { status: 'ok', source: 'audit.numbers', as_of: '2026-09-24T07:00:00Z',
    value: { overall, broken: n('broken'), warn: n('warn'), ok: n('ok'), checks } };
}
const UNKNOWN = { status: 'unknown', source: 'audit.numbers', reason: 'The number audit has not run for this league yet.' };
const FAILED = { status: 'failed', source: 'audit.numbers', reason: 'The number audit could not be read: disk I/O error' };

const dot = h => renderToStaticMarkup(React.createElement(HealthDot, { health: h }));
const compact = h => renderToStaticMarkup(React.createElement(HealthDot, { health: h, compact: true }));
const colorOf = html => html.match(/data-health="([a-z]+)"/)?.[1];
const titleOf = html => html.match(/title="([^"]*)"/)?.[1]?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

test('fixtures are contract-shaped (plans-schema.js number_health validates them)', () => {
  for (const o of ['ok', 'warn', 'broken']) {
    const { errors } = validateLeague({ ...structuredClone(ENTRY), number_health: health(o) });
    assert.deepEqual(errors.filter(e => e.path.includes('number_health')), [], `${o} fixture`);
  }
  // The check is live: the retired { status, open } shape fails it.
  const { errors } = validateLeague({ ...structuredClone(ENTRY), number_health: { status: 'ok', source: 'audit.numbers', value: { status: 'ok', open: [] } } });
  assert.ok(errors.some(e => e.path.includes('number_health')));
});

test('overall ok / warn / broken -> green / amber / red, with counts', () => {
  const rows = { ok: dot(health('ok')), warn: dot(health('warn')), broken: dot(health('broken')) };
  console.log(`NUMBER-DOT fixtures: ok=${colorOf(rows.ok)} warn=${colorOf(rows.warn)} broken=${colorOf(rows.broken)} unknown=${colorOf(dot(UNKNOWN))} failed=${colorOf(dot(FAILED))}`);
  assert.equal(colorOf(rows.ok), 'green');
  assert.equal(colorOf(rows.warn), 'amber');
  assert.equal(colorOf(rows.broken), 'red');
  assert.match(textOf(rows.ok), /all 4 checks pass/);
  assert.match(textOf(rows.warn), /2 warnings/);
  assert.match(textOf(rows.broken), /1 broken, 1 warning/);
  for (const html of Object.values(rows)) assert.doesNotMatch(textOf(html), /not computed/);
});

test('the check names show on hover (compact) and in the list (full)', () => {
  const c = compact(health('broken'));
  assert.equal(colorOf(c), 'red');
  const t = titleOf(c);
  assert.match(t, /Broken: Projection basis/);
  assert.match(t, /Warning: Weekly range/);
  assert.doesNotMatch(t, /Source age/, 'passing checks are not listed');
  const full = textOf(dot(health('broken')));
  assert.match(full, /Projection basis/);
  assert.match(full, /Projections are older than a week\./);
  assert.match(full, /Weekly range/);
  assert.match(titleOf(compact(health('ok'))), /all 4 checks pass/);
});

test('unknown and failed stay grey and say why', () => {
  const u = dot(UNKNOWN);
  assert.equal(colorOf(u), 'grey');
  assert.equal(titleOf(u), UNKNOWN.reason);
  assert.match(textOf(u), /not computed yet/);
  const f = dot(FAILED);
  assert.equal(colorOf(f), 'grey');
  assert.equal(titleOf(f), FAILED.reason);
  assert.match(textOf(f), /number check failed/);
  assert.equal(colorOf(dot(undefined)), 'grey');
  // A value in the retired { status, open } shape is not trusted as a colour.
  assert.equal(colorOf(dot({ status: 'ok', value: { status: 'ok', open: [] } })), 'grey');
});

test('the brain dot names the report overall, not the field status', () => {
  const brain = overall => ({ status: 'ok', source: 'eval.check', value: { overall, checks: [], blocks: [] } });
  const b = o => renderToStaticMarkup(React.createElement(BrainDot, { brain: o }));
  assert.match(b(brain('passing')), /data-brain="passing"/);
  assert.match(b(brain('passing')), /wr-dot-green/);
  assert.match(b(brain('failing')), /wr-dot-red/);
  const ned = b(brain('not_enough_data'));
  assert.match(ned, /data-brain="not_enough_data"/);
  assert.match(textOf(ned), /not enough data yet/);
  assert.doesNotMatch(textOf(ned), /not computed/);
  const unk = b({ status: 'unknown', reason: 'The brain report was not read for this run.' });
  assert.match(unk, /data-brain="unknown"/);
  assert.match(titleOf(unk), /not read for this run/);
  // The card shows both dots.
  const card = renderToStaticMarkup(React.createElement(BrainCheckCard, { brain: brain('not_enough_data'), health: health('warn'), big: true }));
  assert.match(card, /data-brain="not_enough_data"/);
  assert.match(card, /data-health="amber"/);
});

test('served league-4 view (WR_NUMBER_DOT_PLANS): the dot matches the audit', { skip: !process.env.WR_NUMBER_DOT_PLANS }, () => {
  const doc = JSON.parse(fs.readFileSync(process.env.WR_NUMBER_DOT_PLANS, 'utf8'));
  const plans = { status: 'ok', entries: doc.leagues, as_of: doc.generated_at, id: 'plans@copy', head: {} };
  const view = buildWarRoomView(4, plans, { enabled: true, preview: false });
  const h = view.number_health;
  const html = compact(h);
  const want = { ok: 'green', warn: 'amber', broken: 'red' }[h?.value?.overall] ?? 'grey';
  console.log(`NUMBER-DOT served: league=4 field=${h?.status} overall=${h?.value?.overall} broken=${h?.value?.broken} warn=${h?.value?.warn} dot=${colorOf(html)} brain=${view.brain_report?.value?.overall ?? view.brain_report?.status}`);
  assert.equal(colorOf(html), want);
});
