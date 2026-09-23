/**
 * UX-11: "My team" becomes its own top-level tab route.
 *
 * WORK-QUEUE.md UX-11 row + 2026-09-23 08:20Z decision ("my my team good" =
 * My team becomes its own tab route; X's & O's folds into News to hold nav
 * at 8, "unless Nick names a tab to replace"). docs/handoff/local/ui/UX-02-ia.md
 * item 1 says the same: `/my-team` stops redirecting into League Hub and
 * renders `MyTeam.tsx` directly, and it is first in the nav.
 *
 * This repo has no DOM test harness (see trade-brain-surface.test.js's own
 * note on that), so — same house pattern — these are source-level
 * assertions against navigation.ts (imported directly; Node 22+ strips TS
 * types natively, confirmed by `node -e "import('./client/src/navigation.ts')"`
 * succeeding on this tree) and against App.tsx / LeagueHub.tsx's source text.
 *
 * Known-nonzero control (rule 8): NAV_GROUPS today (pre-fix) already has a
 * nonzero, non-8 item count with My team NOT first, so a bug that left nav
 * item count unchanged would show up as a genuine failure here, not a
 * vacuous pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('nav has exactly 8 items with My team first', async () => {
  const { NAV_GROUPS } = await import('../client/src/navigation.ts');
  const items = NAV_GROUPS.flatMap(g => g.items);
  assert.equal(items.length, 8, `expected 8 nav items, got ${items.length}: ${items.map(i => i.label).join(', ')}`);
  assert.equal(items[0].label, 'My team', `expected 'My team' first, got '${items[0].label}'`);
  assert.equal(items[0].to, '/my-team');
});

test('App.tsx routes /my-team to MyTeam, not a redirect', () => {
  const src = read('client/src/App.tsx');
  const myTeamRoute = src.match(/<Route path="\/my-team"[^/]*\/>/);
  assert.ok(myTeamRoute, 'no /my-team route found in App.tsx');
  assert.ok(
    /<MyTeam\s*\/>/.test(myTeamRoute[0]),
    `/my-team route does not render <MyTeam /> directly: ${myTeamRoute[0]}`
  );
  assert.ok(!/Navigate/.test(myTeamRoute[0]), `/my-team still redirects instead of rendering: ${myTeamRoute[0]}`);
});

test('the old inner-tab deep link (/league?view=team) redirects to /my-team', () => {
  const src = read('client/src/pages/LeagueHub.tsx');
  assert.ok(
    /view.*===.*'team'[\s\S]{0,80}Navigate to="\/my-team"/.test(src) ||
    /Navigate to="\/my-team"[\s\S]{0,80}view.*===.*'team'/.test(src),
    "LeagueHub.tsx does not redirect ?view=team to /my-team"
  );
});
