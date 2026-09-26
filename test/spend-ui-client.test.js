/**
 * SPEND-UI, the screen: Settings -> AI & developer draws the server's display block and computes
 * nothing. Order API spend > Daily budgets > API key; the meter's level; the breakdown as three
 * cards at 900 px or wider, one card with tabs below; the empty and anomaly states; budgets Edit
 * then Set through PUT /dev/budgets/:key; ?budget=<key> lands on its row; the key never shown.
 * The cross-links: a Watching row for an anomaly, the brief spend line, a budget-reached message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, domRenderer, click, textOf, one, all, button, waitFor, type as typeInto } from './helpers/warroom-render.js';

installDom();
const { loadClientModule } = await import('./helpers/client-tsx.mjs');
const c = await loadClientModule('components/settings/ApiSpend.tsx');
const spendMod = await c.mod();
const { default: ApiSpend, Breakdown, THREE_CARDS_MIN_PX } = spendMod;
const today = await loadClientModule('components/warroom/today.ts');
const { watchItems } = await today.mod();
const { React, mount } = await domRenderer();
test.after(() => { c.cleanup(); today.cleanup(); });

const part = (label, cost, calls, share) => ({ label, cost_usd: cost, calls, share });
const SPEND = (over = {}) => ({
  empty: false,
  today: { spent_usd: 2.9, budget_usd: 3.5, all_sources_usd: 3.1, calls: 41, share: 0.829, level: 'warn', line: '$2.90 of $3.50 daily budget', resets: 'Resets at midnight ET', estimate: true },
  last_7: { days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => ({ date: `2026-09-${20 + i}`, label, cost_usd: 0.1 * (i + 1), calls: i + 1, height: (i + 1) / 7 })),
    avg_usd: 0.4, avg_height: 0.571, avg_line: '7-day average $0.40' },
  breakdown: { feature: [part('Coach', 2.5, 30, 0.8), part('News', 0.6, 11, 0.2)], model: [part('Sonnet 5', 2.2, 20, 0.7), part('Haiku 4.5', 0.9, 21, 0.3)],
    source: [part('App', 2.9, 38, 0.9), part('Tests & builds', 0.2, 3, 0.1)] },
  brief_line: 'Yesterday: $0.42 API, 31 calls',
  anomaly: null,
  budgets: [
    { key: 'coach', anchor: 'budget-coach', label: 'Coach', budget_usd: 1, spent_usd: 1, is_default: true, share: 1, level: 'over', editable: true, off: false },
    { key: 'numbers_people', anchor: 'budget-numbers_people', label: 'Numbers & People', budget_usd: 2, spent_usd: 0.4, is_default: true, share: 0.2, level: 'ok', editable: true, off: false },
    { key: 'trade_proposals:league-4', anchor: 'budget-trade_proposals-league-4', label: 'Trade proposals (league 4)', budget_usd: 0.5, spent_usd: 0.45, is_default: true, share: 0.9, level: 'warn', editable: false, off: false }
  ],
  verified_note: "Not yet verified against Anthropic's billing.",
  credit_errors_today: 0,
  ...over
});
const RAW = /claude-|coach:|trade_proposals|numbers_people|sk-ant|undefined|NaN/;
const setSpend = (spend, configured = true) => { globalThis.__warRoomApi = { '/dev/spend': { spend, api_key: { configured } } }; };
const render = (props = {}) => mount(React.createElement(ApiSpend, props));
const testid = (root, id) => all(root, e => e.getAttribute?.('data-testid') === id);

test('order API spend > Daily budgets > API key; Today, 7-day bars with the average, brief line, the note; no raw ids', async () => {
  setSpend(SPEND());
  const ui = render();
  await waitFor(() => one(ui.container, 'data-testid', 'ai-settings'), 2000, 'the section');
  const text = textOf(ui.container);
  const at = s => text.indexOf(s);
  assert.ok(at('API spend') >= 0 && at('API spend') < at('Daily budgets') && at('Daily budgets') < at('API key'), 'the spec order');
  assert.equal(textOf(one(ui.container, 'data-testid', 'spend-today-line')), '$2.90 of $3.50 daily budget');
  assert.match(text, /Estimate/);
  assert.match(text, /Resets at midnight ET/);
  assert.equal(one(ui.container, 'data-testid', 'spend-meter').getAttribute('data-level'), 'warn', 'amber at 80%');
  assert.equal(all(one(ui.container, 'data-testid', 'spend-bars'), e => e.getAttribute?.('class') === 'spend-bar').length, 7);
  assert.ok(one(ui.container, 'data-testid', 'spend-avg'), 'the dashed average line');
  assert.match(text, /7-day average \$0\.40/);
  assert.equal(textOf(one(ui.container, 'data-testid', 'spend-brief-line')), 'Morning brief: Yesterday: $0.42 API, 31 calls.');
  assert.equal(textOf(one(ui.container, 'data-testid', 'spend-verified-note')), "Not yet verified against Anthropic's billing.");
  assert.match(text, /Sonnet 5.*Haiku 4\.5|Coach/);
  assert.doesNotMatch(text, RAW);
  assert.doesNotMatch(text, /SETTINGS/, 'no eyebrow');
  ui.unmount();
});

test('the meter is red at 100%', async () => {
  setSpend(SPEND({ today: { ...SPEND().today, share: 1.2, level: 'over', line: '$4.20 of $3.50 daily budget' } }));
  const ui = render();
  const meter = await waitFor(() => one(ui.container, 'data-testid', 'spend-meter'), 2000, 'the meter');
  assert.equal(meter.getAttribute('data-level'), 'over');
  assert.match(meter.getAttribute('aria-valuetext'), /^Budget reached: /);
  ui.unmount();
});

test('breakdown: three cards at 900 px or wider, one card with tabs below; Source hidden when the server has none', async () => {
  assert.equal(THREE_CARDS_MIN_PX, 900);
  const parts = SPEND().breakdown;
  let ui = mount(React.createElement(Breakdown, { parts, wide: true }));
  let box = await waitFor(() => one(ui.container, 'data-testid', 'spend-breakdown'), 2000, 'cards');
  assert.equal(box.getAttribute('data-layout'), 'cards');
  assert.match(textOf(box), /By feature.*By source.*By model/);
  ui.unmount();
  ui = mount(React.createElement(Breakdown, { parts, wide: false }));
  box = await waitFor(() => one(ui.container, 'data-testid', 'spend-breakdown'), 2000, 'tabs');
  assert.equal(box.getAttribute('data-layout'), 'tabs');
  assert.match(textOf(box), /Coach/);
  click(button(box, 'By model'));
  await waitFor(() => /Sonnet 5/.test(textOf(box)), 2000, 'the model tab');
  ui.unmount();
  ui = mount(React.createElement(Breakdown, { parts: { ...parts, source: null }, wide: true }));
  box = await waitFor(() => one(ui.container, 'data-testid', 'spend-breakdown'), 2000, 'no source');
  assert.doesNotMatch(textOf(box), /By source/);
  ui.unmount();
});

test('empty and anomaly states', async () => {
  setSpend(SPEND({ empty: true }));
  let ui = render();
  await waitFor(() => /No AI calls yet/.test(textOf(ui.container)), 2000, 'empty');
  assert.equal(one(ui.container, 'data-testid', 'spend-meter'), null);
  assert.ok(one(ui.container, 'data-testid', 'spend-verified-note'), 'the note is always on');
  ui.unmount();
  setSpend(SPEND({ anomaly: { line: 'AI spend today is 6x the 7-day average ($0.60 vs $0.10), mostly Coach.', tone: 'red' } }));
  ui = render();
  const a = await waitFor(() => one(ui.container, 'data-testid', 'spend-anomaly'), 2000, 'anomaly');
  assert.match(textOf(a), /6x the 7-day average/);
  ui.unmount();
});

test('Daily budgets: Edit then Set sends PUT /dev/budgets/:key; a league pot is not editable; ?budget= lands on its row', async () => {
  setSpend(SPEND());
  const sent = [];
  globalThis.__warRoomApiCall = async (p, opts) => { sent.push([p, opts?.method, JSON.parse(opts?.body ?? 'null')]); return { spend: SPEND() }; };
  const ui = render({ focusBudget: 'trade_proposals:league-4' });
  await waitFor(() => testid(ui.container, 'spend-budget-row').length === 3, 2000, 'rows');
  const rows = testid(ui.container, 'spend-budget-row');
  assert.equal(rows[2].getAttribute('class'), 'spend-row-focus', 'the linked row is highlighted');
  assert.equal(rows[0].getAttribute('id'), 'budget-coach');
  assert.equal(button(rows[2], /Edit/), null, 'a league pot shares its feature\'s budget');
  assert.match(textOf(rows[0]), /Reached/);
  click(button(rows[0], /Edit/));
  const input = await waitFor(() => all(rows[0], e => e.localName === 'input')[0], 2000, 'the input');
  typeInto(input, '2.5');
  click(await waitFor(() => button(rows[0], 'Set'), 2000, 'Set'));
  await waitFor(() => sent.length === 1, 2000, 'the PUT');
  assert.deepEqual(sent[0], ['/dev/budgets/coach', 'PUT', { usd: 2.5 }]);
  await waitFor(() => /Coach: \$2\.50 a day\./.test(textOf(ui.container)), 2000, 'saved');
  ui.unmount();
});

test('API key: "Connected" and "Replace key", a password field, the key never shown', async () => {
  setSpend(SPEND());
  const ui = render();
  const card = await waitFor(() => one(ui.container, 'data-testid', 'spend-key'), 2000, 'the key card');
  assert.equal(textOf(one(ui.container, 'data-testid', 'spend-key-state')), 'Connected');
  click(button(ui.container, 'Replace key'));
  const input = await waitFor(() => all(ui.container, e => e.localName === 'input' && e.getAttribute('aria-label') === 'New Anthropic API key')[0], 2000, 'field');
  assert.equal(input.getAttribute('type'), 'password');
  assert.ok(card);
  typeInto(input, 'sk-ant-typed-not-real');
  assert.doesNotMatch(textOf(ui.container), /sk-ant/, 'the typed key is never echoed as text');
  ui.unmount();
});

test('cross-links: an anomaly is the first Watching row and opens Settings; the brief spend line and budget messages link there', () => {
  const view = { number_health: { status: 'ok', value: { checks: [{ check_id: 'x', status: 'warn', title: 'A warning', detail: '' }] } } };
  const items = watchItems(view, null, { line: 'AI spend today is 3x the 7-day average ($0.90 vs $0.30), mostly Coach.', tone: 'amber' });
  assert.deepEqual([items[0].id, items[0].href, items[0].tone], ['ai-spend', '/settings?view=dev', 'amber']);
  assert.equal(watchItems(view, null, null).some(i => i.id === 'ai-spend'), false, 'no anomaly, no row');
  const read = p => fs.readFileSync(new URL(`../client/src/${p}`, import.meta.url), 'utf8');
  assert.match(read('components/warroom/ScreenToday.tsx'), /it\.href \? <AppLink href=\{it\.href\}/);
  assert.match(read('components/warroom/TodayPanel.tsx'), /spendAnomaly=\{spendAnomaly\}/);
  assert.match(read('components/warroom/useWarRoom.ts'), /useApi<[^>]+>\('\/dev\/spend'\)/, 'the War Room\'s one reader reads it');
  assert.match(read('components/warroom/coach/CoachBrief.tsx'), /claim\.section === 'spend' \? <AppLink href=\{AI_SETTINGS\}/);
  assert.match(read('components/trade/NumbersPeople.tsx'), /view\.notice\.kind === 'budget' && <> <BudgetLink budgetKey="numbers_people" \/>/);
  assert.match(read('components/brain/ProposalSlate.tsx'), /<BudgetLink budgetKey=\{result\.budget_key\}>/);
  assert.match(read('pages/Settings.tsx'), /<ApiSpend focusBudget=\{params\.get\('budget'\)\} \/>/);
  assert.doesNotMatch(read('pages/Settings.tsx'), /eyebrow=/, 'the SETTINGS eyebrow is gone');
});
