/**
 * PROJ-DUEL, the view (My team -> ESPN vs our model): the testing label, the scoreboard with an honest
 * n and "Not proven yet", rows in the server's order with the drivers line and, after games, the
 * "what happened" line and a closer chip; primitives only. Made-up names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, domRenderer, textOf, one, byAttr, waitFor } from './helpers/warroom-render.js';

installDom();
const { loadClientModule } = await import('./helpers/client-tsx.mjs');
const c = await loadClientModule('components/lineup/ProjDuel.tsx');
const { default: ProjDuel } = await c.mod();
const { React, mount } = await domRenderer();
test.after(() => c.cleanup());

const VIEW = {
  status: 'ok', label: 'Our model is in testing and not used for your numbers.', week: 3, final: true, weeks: [4, 3], current_week: 4,
  scoreboard: { weeks: 1, won: 0, lost: 1, tied: 0, n: 312, mae_ours: 5.9, mae_espn: 5.4, verdict_text: 'Not proven yet' },
  rows: [
    { player_id: '1', name: 'Fixture Back', position: 'RB', espn: 14.2, ours: 9.1, gap: -5.1, starter: true, target: false, actual: 4, closer: 'ours',
      why: 'Ours lower: 3-week carries 11, team implied 20.5.', happened: '14 carries vs 17 expected, 0 TDs, team scored 13 vs 24 implied.' },
    { player_id: '2', name: 'Fixture End', position: 'TE', espn: 8, ours: 9, gap: 1, starter: false, target: true, actual: 12, closer: 'espn', why: null, happened: null }
  ]
};

test('the label, the scoreboard, and each row with its reasons and the closer side', async () => {
  globalThis.__warRoomApi = { '/proj-duel/4': VIEW, '/players': [] };
  const ui = mount(React.createElement(ProjDuel, { leagueId: 4 }));
  await waitFor(() => one(ui.container, 'data-testid', 'proj-duel'), 2000, 'the view');
  assert.match(textOf(one(ui.container, 'data-testid', 'proj-duel-label')), /in testing and not used for your numbers/);
  assert.match(textOf(one(ui.container, 'data-testid', 'proj-duel-board')), /0 of 1.*5\.9 pts.*5\.4 pts.*312/);
  assert.match(textOf(ui.container), /Not proven yet/);
  const rows = byAttr(ui.container, 'data-testid', 'proj-duel-row');
  assert.match(textOf(rows[0]), /Fixture Back.*RB.*Your starter.*Ours closer.*What happened: 14 carries vs 17 expected.*14\.2.*9\.1.*4\.0/);
  assert.match(textOf(rows[1]), /Plan target.*ESPN closer/);
  assert.equal(rows[0].tagName, 'BUTTON', 'the whole row opens the breakdown');
  ui.unmount();
});

test('the tab is in My team and the view uses the design system only', () => {
  const t = fs.readFileSync(new URL('../client/src/pages/MyTeam.tsx', import.meta.url), 'utf8');
  assert.match(t, /\{ id: 'duel', label: 'ESPN vs our model' \}/);
  for (const f of ['ProjDuel.tsx', 'ProjDuelSheet.tsx']) {
    const src = fs.readFileSync(new URL(`../client/src/components/lineup/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\b(?:bg|text|border)-(?:slate|gray|blue|emerald|red|amber)-\d|shadow-|rounded-(?:lg|xl|2xl)|ds-btn/, f);
  }
});

test('tapping a row opens the breakdown: all drivers as bars, usage expected vs actual, recent weeks, Ask Coach', async () => {
  const B = { player_id: '1', name: 'Fixture Back', position: 'RB', team: 'AAA', week: 3, label: VIEW.label, espn: 25.3, ours: 17.5, actual: 22, closer: 'espn',
    why: 'Ours lower even though 83% of snaps last game and last season 21.6 a game: the model tops out below ESPN for top players.', happened: null,
    drivers: [{ label: 'snap share last game', value: '83% of snaps last game', contribution: 3.66 }, { label: 'week of the season', value: null, contribution: -0.4 }],
    drivers_note: null, usage: [{ label: 'Carries', expected: 17, actual: 14, unit: '' }, { label: 'Snap share', expected: 70, actual: 62, unit: '%' }],
    team_implied: 24, team_scored: 13, history: [{ week: 1, espn: 20, ours: 15, actual: 18 }, { week: 2, espn: 22, ours: 16, actual: 30 }, { week: 3, espn: 25.3, ours: 17.5, actual: 22 }] };
  globalThis.__warRoomApi = { '/proj-duel/4': VIEW, '/players': [], '/proj-duel/4/player/1?week=3': B };
  const calls = [];
  globalThis.__warRoomApiCall = async (p, o) => { calls.push(p); return {}; };
  const ui = mount(React.createElement(ProjDuel, { leagueId: 4 }));
  await waitFor(() => byAttr(ui.container, 'data-testid', 'proj-duel-row').length === 2, 2000, 'rows');
  const { click } = await import('./helpers/warroom-render.js');
  click(byAttr(ui.container, 'data-testid', 'proj-duel-row')[0]);
  const sheet = await waitFor(() => one(ui.container.ownerDocument.body, 'data-testid', 'duel-sheet'), 2000, 'the sheet');
  const t = textOf(ui.container.ownerDocument.body);
  assert.match(t, /ESPN\s*25\.3.*Ours\s*17\.5.*Scored\s*22\.0/);
  assert.match(t, /tops out below ESPN for top players/);
  assert.equal(byAttr(ui.container.ownerDocument.body, 'data-testid', 'duel-bars')[0].childNodes.length, 2, 'every driver as a bar');
  assert.match(textOf(one(ui.container.ownerDocument.body, 'data-testid', 'duel-usage')), /Carries.*17 expected · 14.*Snap share.*70% expected · 62%/);
  assert.match(t, /Team implied total\s*24\.0 · scored 13\.0/);
  assert.ok(one(ui.container.ownerDocument.body, 'data-testid', 'duel-history'));
  ui.unmount();
});
