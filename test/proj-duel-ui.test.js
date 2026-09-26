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
  assert.match(textOf(rows[0]), /Fixture Back \(RB\).*Your starter.*Ours closer.*Ours lower: 3-week carries 11.*What happened: 14 carries vs 17 expected.*14\.2.*9\.1.*4\.0/);
  assert.match(textOf(rows[1]), /Plan target.*ESPN closer/);
  ui.unmount();
});

test('the tab is in My team and the view uses the design system only', () => {
  const t = fs.readFileSync(new URL('../client/src/pages/MyTeam.tsx', import.meta.url), 'utf8');
  assert.match(t, /\{ id: 'duel', label: 'ESPN vs our model' \}/);
  const src = fs.readFileSync(new URL('../client/src/components/lineup/ProjDuel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(?:bg|text|border)-(?:slate|gray|blue|emerald|red|amber)-\d|shadow-|rounded-(?:lg|xl|2xl)|<button/);
});
