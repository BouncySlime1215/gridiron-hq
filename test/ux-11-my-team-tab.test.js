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

// UI consolidation (docs/ui/CONSOLIDATION-MAP.md, decision 2): seven areas, Today first,
// My team still its own top-level route (it was first of eight before).
test('nav has exactly 7 areas with Today first and My team a top-level item', async () => {
  const { NAV_GROUPS } = await import('../client/src/navigation.ts');
  const items = NAV_GROUPS.flatMap(g => g.items);
  assert.equal(items.length, 7, `expected 7 nav items, got ${items.length}: ${items.map(i => i.label).join(', ')}`);
  assert.equal(items[0].label, 'Today', `expected 'Today' first, got '${items[0].label}'`);
  assert.equal(items[0].to, '/');
  const mine = items.find(i => i.to === '/my-team');
  assert.ok(mine, 'My team is still a nav item');
  assert.equal(mine.label, 'My team');
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
  // Skeptic mutant M3: `const MyTeam = lazy(() => import('./pages/LeagueHub'))`
  // kept the JSX text but rendered the wrong page. Pin what MyTeam is bound to.
  const bindings = [...src.matchAll(/const MyTeam\s*=\s*(.+);/g)].map(m => m[1].trim());
  assert.deepEqual(bindings, ["lazy(() => import('./pages/MyTeam'))"], `MyTeam is bound to ${JSON.stringify(bindings)}`);
  assert.ok(!/import\s+MyTeam\b/.test(src), 'App.tsx also imports a MyTeam identifier statically');
  assert.match(read('client/src/pages/MyTeam.tsx'), /export default function MyTeam\(/);
});

test('the sidebar renders every NAV_GROUPS item (no filter/slice at the call site)', () => {
  // Skeptic mutant M4: `group.items.slice(...)` in App.tsx's NavLink loop hid
  // My team from the rendered nav while NAV_GROUPS still had 8 items.
  const src = read('client/src/App.tsx');
  const navStart = src.indexOf('<nav aria-label="Primary navigation"');
  const navEnd = src.indexOf('</nav>', navStart);
  assert.ok(navStart > 0 && navEnd > navStart, 'primary <nav> block not found in App.tsx');
  const nav = src.slice(navStart, navEnd);
  assert.match(nav, /\{NAV_GROUPS\.map\(group => /, 'nav does not map NAV_GROUPS directly');
  assert.match(nav, /\{group\.items\.map\(item => <NavLink /, 'nav does not map group.items directly into NavLink');
  assert.doesNotMatch(nav, /\.(filter|slice|splice|reverse|sort)\(/, 'nav block narrows or reorders the items it renders');
  assert.equal((nav.match(/<NavLink /g) ?? []).length, 1, 'expected exactly one NavLink render site in the nav');
});

test('legacyLeagueRedirect: ?view=team goes to /my-team, nothing else redirects', async () => {
  const { legacyLeagueRedirect } = await import('../client/src/navigation.ts');
  const q = s => new URLSearchParams(s);
  assert.equal(legacyLeagueRedirect(q('view=team')), '/my-team');
  assert.equal(legacyLeagueRedirect(q('view=connections')), null);
  assert.equal(legacyLeagueRedirect(q('')), null);
  assert.equal(legacyLeagueRedirect(q('xview=team')), null);
});

test('the old inner-tab deep link (/league?view=team) redirects via legacyLeagueRedirect', () => {
  // Skeptic mutants M1 (`&& false`) and M2 (`xview`) broke the redirect while
  // a loose text regex still passed. The predicate is now tested as a function
  // above; here the call site must hand its result straight to <Navigate>.
  const src = read('client/src/pages/LeagueHub.tsx');
  assert.match(src, /const \[params\] = useSearchParams\(\);/);
  assert.match(
    src,
    /const (\w+) = legacyLeagueRedirect\(params\);\s*if \(\1\) return <Navigate to=\{\1\} replace \/>;/,
    'LeagueHub.tsx does not redirect with legacyLeagueRedirect(params) unconditionally'
  );
});

test('leagueGate: loading/error are never shown as "no league connected"', async () => {
  const { leagueGate } = await import('../client/src/state/leagueGate.ts');
  assert.equal(leagueGate({ loading: true, error: null, leagues: [] }), 'loading');
  assert.equal(leagueGate({ loading: false, error: 'HTTP 500', leagues: [] }), 'error');
  assert.equal(leagueGate({ loading: false, error: null, leagues: [] }), 'empty');
  assert.equal(leagueGate({ loading: true, error: null, leagues: [{ id: 1 }] }), 'ready');
  assert.equal(leagueGate({ loading: false, error: 'stale', leagues: [{ id: 1 }] }), 'ready');
});

test('MyTeam (now its own route) gates on leagues loading/error before the empty state', () => {
  // Structure skeptic: HEAD e1d70c74 dropped the guard LeagueHub used to wrap
  // around <MyTeam />, so /my-team flashed (or stuck on) "Connect a league".
  const src = read('client/src/pages/MyTeam.tsx');
  const gateAt = src.search(/const gate = leagueGate\(\{ loading: \w+, error: \w+, leagues \}\);/);
  const loadingAt = src.search(/if \(gate === 'loading'\) return <PageLoading /);
  const errorAt = src.search(/if \(gate === 'error'\) return <PageError /);
  const emptyAt = src.search(/if \(gate === 'empty'\) \{/);
  const connectAt = src.indexOf('Connect a league to see your roster');
  assert.ok(gateAt > 0, 'MyTeam does not compute leagueGate(...)');
  assert.ok(loadingAt > gateAt && errorAt > gateAt, 'MyTeam does not return PageLoading/PageError on the gate');
  assert.ok(emptyAt > loadingAt && emptyAt > errorAt && connectAt > emptyAt, 'empty state is not behind the loading/error guard');
  assert.doesNotMatch(src, /if \(!leagues\.length\)/, 'an unguarded !leagues.length branch remains');
  assert.match(src, /loading: (\w+), error: (\w+),[^}]*\} = useLeague\(\)/, 'MyTeam does not read loading/error from useLeague()');
  assert.match(read('client/src/pages/LeagueHub.tsx'), /leagueGate\(\{ loading, error, leagues \}\)/, 'LeagueHub no longer shares the gate');
});
