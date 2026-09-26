/**
 * NUMBERS-PEOPLE, the tab (Trades → Numbers & People), rendered and clicked:
 *   - the summary line, the read time and a working Refresh (thinking animation while it runs)
 *   - one card per item (the shared NumbersPeopleCard), in the server's best-first order, Differ highlighted, Claude
 *     (numbers) and Jev (people) side by side with a stance chip and a why, Jev's lane labelled
 *     "chat read (ungraded)", a verdict badge
 *   - "Going forward": "not enough outcomes yet" under the minimum, the score once it is met
 *   - a budget stop: the last reads plus the notice, no error
 *   - "Ask Coach about this" puts the item in the thread's focus, then opens Coach on it
 * Made-up names only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, domRenderer, click, textOf, one, byAttr, button, waitFor } from './helpers/warroom-render.js';

installDom();
const { loadClientModule } = await import('./helpers/client-tsx.mjs');
const c = await loadClientModule('components/trade/NumbersPeople.tsx');
const { default: NumbersPeople } = await c.mod();
const { React, mount } = await domRenderer();
test.after(() => c.cleanup());

const lane = (stance, why, extra = {}) => ({ stance, basis: 'price', why, why_withheld: false, cites: [{ label: 'Yes on step one (guess)', value: '52%' }], ...extra });
const item = (key, verdict, title, numbers, people, extra = {}) => {
  const [item_type, item_id] = key.split(':');
  return { key, item_type, item_id, title, subtitle: 'With Team Two', players: [{ id: '21', name: 'P21 (WR)' }], partner: '3',
    numbers, people: { ...people, label: 'chat read (ungraded)' }, verdict, history: [{ week: 2, numbers: 'go', people: 'go', verdict: 'agree' }, { week: 3, numbers: numbers.stance, people: people.stance ?? null, verdict }], ...extra };
};
const VIEW = {
  enabled: true, status: 'ok', refreshing: false, read_at: '2026-09-25T20:00:00.000Z', week: 3, stale: false, notice: null,
  summary: { agree: 1, differ: 1, same_but: 1, no_people_read: 0, both_go: 2, split: 1, both_wait: 0, both_avoid: 0 },
  items: [
    item('move:M1', 'differ', 'Get P21 (WR) for P4 (WR)', lane('go', 'The odds gain is worth the price.'), lane('avoid', 'They call this receiver untouchable.')),
    item('target:11', 'same_but', 'P11 (RB)', lane('go', 'Big gain if landed.'), lane('go', 'Their manager is shopping backs.')),
    item('partner:4', 'agree', 'Team Four', lane('go', 'They reply often.'), lane('go', 'They are in the market.'))
  ],
  scoreboard: { n: 2, min_n: 5, enough: false, numbers_right: 1, people_right: 1, both_right: 0, pending: 3 }
};

function setup(view, { onCall } = {}) {
  const calls = [];
  globalThis.__warRoomApi = { '/numbers-people/4': view, '/players': [{ id: 21, headshot: 'https://a.espncdn.com/x/21.png' }] };
  globalThis.__warRoomApiCall = async (p, opts) => { calls.push({ p, body: opts?.body ? JSON.parse(opts.body) : null }); return onCall ? onCall(p) : {}; };
  const asked = [];
  const ui = mount(React.createElement(NumbersPeople, { leagueId: 4, onAsk: q => asked.push(q) }));
  return { ui, calls, asked };
}

test('now: the summary, the server order kept, Differ highlighted, both lanes side by side, verdict badges', async () => {
  const { ui } = setup(VIEW);
  await waitFor(() => one(ui.container, 'data-testid', 'np-summary'), 2000, 'the summary');
  assert.equal(textOf(one(ui.container, 'data-testid', 'np-summary')), 'Both say go on 2 · Split on 1 · Both say avoid on 0');
  const cards = byAttr(ui.container, 'data-testid', 'np-card');
  assert.deepEqual(cards.map(x => x.getAttribute('data-verdict')), ['differ', 'same_but', 'agree']);
  const first = cards[0];
  assert.match(textOf(first), /Get P21 \(WR\) for P4 \(WR\).*Differ/);
  assert.match(textOf(one(first, 'data-testid', 'np-lane-numbers')), /Claude\s*numbers\s*Go.*The odds gain is worth the price\..*52%/);
  assert.match(textOf(one(first, 'data-testid', 'np-lane-people')), /Jev\s*people\s*Avoid.*chat read \(ungraded\).*untouchable/);
  assert.match(textOf(cards[1]), /Same call, different reasons/);
  assert.match(textOf(cards[2]), /Agree/);
  // Going forward: honest n, and the week-by-week chips.
  assert.match(textOf(one(ui.container, 'data-testid', 'np-score-thin')), /Not enough outcomes yet: 2 of the 5/);
  assert.equal(one(ui.container, 'data-testid', 'np-score'), null);
  assert.match(textOf(one(ui.container, 'data-testid', 'np-timeline')), /Wk 2 · Claude Go · Jev Go.*Wk 3 · Claude Go · Jev Avoid/);
  ui.unmount();
});

test('the score shows once enough outcomes have settled', async () => {
  const { ui } = setup({ ...VIEW, scoreboard: { n: 6, min_n: 5, enough: true, numbers_right: 2, people_right: 3, both_right: 1, pending: 0 } });
  await waitFor(() => one(ui.container, 'data-testid', 'np-score'), 2000, 'the score');
  assert.match(textOf(one(ui.container, 'data-testid', 'np-score')), /Claude right 2.*Jev right 3.*Both right 1.*of 6 settled/);
  ui.unmount();
});

test('Refresh runs the job on demand with the thinking animation, then shows the new reads', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const newer = { ...VIEW, summary: { agree: 3, differ: 0, same_but: 0, no_people_read: 0, both_go: 3, split: 0, both_wait: 0, both_avoid: 0 }, items: VIEW.items.map(i => ({ ...i, verdict: 'agree' })) };
  const { ui, calls } = setup(VIEW, { onCall: async p => { if (p.endsWith('/refresh')) { await gate; return newer; } return {}; } });
  await waitFor(() => one(ui.container, 'data-testid', 'np-summary'), 2000, 'the summary');
  click(button(ui.container, 'Refresh'));
  await waitFor(() => one(ui.container, 'data-testid', 'np-thinking'), 2000, 'the thinking animation');
  assert.equal(calls.at(-1).p, '/numbers-people/4/refresh');
  release();
  await waitFor(() => /Both say go on 3/.test(textOf(one(ui.container, 'data-testid', 'np-summary'))), 2000, 'the new reads');
  assert.equal(one(ui.container, 'data-testid', 'np-thinking'), null);
  ui.unmount();
});

test('budget used up: the last reads and the notice, no error', async () => {
  const { ui } = setup({ ...VIEW, notice: { kind: 'budget', text: "Today's AI allowance for these reads is used up, so they were not refreshed. Showing the last reads. It resets at midnight.", at: '2026-09-25T21:00:00Z' } });
  await waitFor(() => one(ui.container, 'data-testid', 'np-notice'), 2000, 'the notice');
  assert.match(textOf(one(ui.container, 'data-testid', 'np-notice')), /used up.*Showing the last reads/);
  assert.equal(byAttr(ui.container, 'data-testid', 'np-card').length, 3, 'the last reads are shown');
  assert.equal(byAttr(ui.container, 'role', 'alert').length, 0, 'no error');
  ui.unmount();
});

test('Ask Coach about this: the item goes into the thread focus (ids only), then Coach opens on it', async () => {
  const { ui, calls, asked } = setup(VIEW);
  await waitFor(() => byAttr(ui.container, 'data-testid', 'np-card').length === 3, 2000, 'the cards');
  click(button(byAttr(ui.container, 'data-testid', 'np-card')[0], 'Ask Coach about this'));
  await waitFor(() => asked.length === 1, 2000, 'Coach opened');
  const focus = calls.find(x => x.p === '/coach/thread/4/focus');
  assert.deepEqual(focus.body, { move_id: 'M1', partner: '3', players: ['21'] });
  assert.match(asked[0], /^Claude and Jev disagree on Get P21 \(WR\) for P4 \(WR\)/);
  ui.unmount();
});

test('the tab sits in the Trades tab row and uses the design system only', () => {
  const trades = fs.readFileSync(new URL('../client/src/pages/Trades.tsx', import.meta.url), 'utf8');
  assert.match(trades, /\{ id: 'np', label: 'Numbers & People' \}/);
  assert.match(trades, /view === 'np' && activeId && <NumbersPeople leagueId=\{activeId\} onAsk=\{coach\.open\} \/>/);
  for (const f of ['NumbersPeople.tsx', 'numbersPeopleParts.tsx', 'NumbersPeopleCard.tsx']) {
    const src = fs.readFileSync(new URL(`../client/src/components/trade/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\b(?:bg|text|border)-(?:slate|gray|blue|emerald|red|amber)-\d/, `${f}: no stock Tailwind colours`);
    assert.doesNotMatch(src, /shadow-|rounded-(?:lg|xl|2xl)/, `${f}: no ad-hoc shadows or radii`);
  }
});

test('a long list folds after four cards (the best four), "Show all" opens it', async () => {
  const many = { ...VIEW, items: [...VIEW.items, ...[5, 6, 7].map(n => ({ ...VIEW.items[2], key: `partner:${n}`, item_id: String(n) }))] };
  const { ui } = setup(many);
  await waitFor(() => byAttr(ui.container, 'data-testid', 'np-card').length === 4, 2000, 'four cards');
  click(button(ui.container, 'Show all 6'));
  await waitFor(() => byAttr(ui.container, 'data-testid', 'np-card').length === 6, 2000, 'all cards');
  ui.unmount();
});
