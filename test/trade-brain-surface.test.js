/**
 * The Trade Brain has a user-facing surface, and it is an honest one.
 *
 * FANTASY-ENGINE-MASTER-PLAN.md:150 recorded the gap this closes: "The Trade
 * Brain can compute a band, rank ideas and write a sendable proposal — and
 * nothing renders any of it. `GET /:leagueId/proposals` returns proposals no
 * page reads". A grep of client/src for "proposals" returned nothing.
 *
 * These are source-level assertions, in the same style as
 * `availability-honest-degradation.test.js:201` ("a served field nothing
 * renders is not a disclosure") and `trade-route-retirement.test.js:88` (which
 * walks every file under client/src): this repo has no DOM test harness, so the
 * house pattern for a client guarantee is to assert that the page file actually
 * contains the read and the copy. That catches the two regressions that matter
 * here — a route quietly dropped from the app, and an honest-degradation branch
 * deleted as "dead code" — without pretending to be a render test.
 *
 * The one behavioural guarantee worth more than the copy: the proposals call
 * SPENDS MONEY (one Sonnet call against a $0.50/day budget shared across every
 * league — see `liveCaller` in server/services/trade-proposals.js), so it must
 * never be wired to a hook that fetches on mount.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * Comments out, for the assertions that are about what the code DOES.
 *
 * This file's first version asserted `!slate.includes('useApi')` against the raw
 * source and failed on the sentence explaining why `useApi` is not used — and
 * asserted no `/betting/` path remained in navigation.ts while the file's own
 * header names the retired routes it deliberately does not list. A comment that
 * mentions a thing is the opposite of a call to it.
 */
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const page = read('client/src/pages/TradeBrain.tsx');
const board = read('client/src/components/brain/ManagerBoard.tsx');
const slate = read('client/src/components/brain/ProposalSlate.tsx');
const brainTypes = read('client/src/components/brain/types.ts');
const app = read('client/src/App.tsx');
const nav = read('client/src/navigation.ts');
const surface = [page, board, slate, brainTypes].join('\n');

/* ------------------------------------------------------ 1. it is reachable */

test('the Trade Brain page is a lazy route and a registered destination', () => {
  // UI consolidation: the Trades area is the code-split route and it imports Trade Brain.
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/Trades'\)\)/,
    'the Trades area (which holds TradeBrain) is code-split like every other page');
  assert.match(read('client/src/pages/Trades.tsx'), /import TradeBrain from '\.\/TradeBrain'/);
  assert.match(app, /path="\/trades"/, 'the Trades area is mounted at a route');
  assert.match(app, /path="\/trade-brain"/, 'and the old URL is still a route (a redirect), not NotFound');
  // NAV_GROUPS is the single constant that feeds the sidebar, the command
  // palette and the header breadcrumb. A page missing from it renders a
  // breadcrumb of "Workspace" and cannot be reached from ⌘K.
  // UI consolidation: Trade Brain lives in the Trades area (/trades, which renders it) and
  // /trade-brain redirects there, so the nav and the palette name /trades.
  assert.match(nav, /to: '\/trades'/, 'the Trades area is registered in NAV_GROUPS');
  assert.match(nav, /'\/trades':/, 'with a palette note of its own');
  assert.match(read('client/src/pages/Trades.tsx'), /<TradeBrain \/>/, 'the Trades area renders Trade Brain');
});

test('Trade Lab points at it, since building a deal and reading a manager are different jobs', () => {
  assert.match(read('client/src/pages/TradeLab.tsx'), /to="\/trade-brain"/);
});

/* --------------------------------------- 2. every palette destination exists */

test('no "jump to" destination lands on NotFound', () => {
  // Eight did before this: seven /betting/nfl/* subviews and /edge, all listed
  // in DEEP_DESTINATIONS long after their routes were removed. A command
  // palette full of dead links is a bug a user hits on the first try.
  const navCode = code(nav);
  const declared = new Set([...code(app).matchAll(/path="([^"*]+)"/g)].map(m => m[1]));
  const offered = [...navCode.matchAll(/'(\/[a-z0-9/-]*)'/g)].map(m => m[1])
    .filter(p => p !== '/' && !p.includes(':'));
  assert.ok(offered.length >= 10, `sanity: found only ${offered.length} nav paths to check`);
  const dead = [...new Set(offered)].filter(p => !declared.has(p));
  assert.deepEqual(dead, [], 'these palette/nav paths have no route in App.tsx');
  assert.doesNotMatch(navCode, /\/betting\//, 'the retired betting subviews are gone from navigation');
  assert.doesNotMatch(navCode, /'\/edge'/, 'and so is /edge');
});

/* ---------------------------------------------- 3. it reads the three routes */

test('the page reads the three Trade Brain endpoints and no retired one', () => {
  assert.match(surface, /\/trades\/\$\{[^}]+\}\/managers\/signals/, 'the measured signal layer');
  assert.match(surface, /\/trades\/\$\{[^}]+\}\/proposals/, 'the AI-written proposals');
  assert.match(surface, /\/trades\/\$\{[^}]+\}\/brain\/managers/, 'the hand-set tier editor (read)');
  assert.match(board, /method: 'POST'/, 'and writes a tier back');
  // Retired 2026-09-18 and answering 410; trade-route-retirement.test.js fails
  // the build if any client file calls one, so this is belt and braces.
  for (const retired of ['brain/plan', 'brain/sell-high']) {
    assert.ok(!surface.includes(retired), `must not call the retired ${retired}`);
  }
});

test('the proposals call is never fired by mounting a component', () => {
  // useApi() fetches on mount. This endpoint runs the finder and then pays for
  // a Sonnet call, so it has to be a button the user presses.
  assert.doesNotMatch(code(slate), /\buseApi\s*[<(]/,
    'ProposalSlate must not use the fetch-on-mount hook');
  assert.doesNotMatch(code(page), /\/proposals/, 'and the page itself must not read it either');
  assert.match(slate, /disabled=\{busy\}/, 'the button guards against a double spend');
  assert.match(slate, /\$0\.50\/day/, 'and states the cost implication before it is pressed');
});

/* ------------------------------------------------------------ 4. honesty */

test('a league with no chat corpus is described, not left blank', () => {
  assert.match(board, /Four of the five connected leagues have no chat corpus/,
    'the normal state for most leagues is named as normal, not as a fault');
  assert.match(board, /No league chat for this manager/,
    'a manager with no corpus says so on their own row');
  assert.match(board, /Nothing measured about this manager/,
    'and a manager with nothing at all gets a sentence, never an empty panel');
  // "What would produce it" is half the point of saying what is missing.
  assert.match(board, /To fix:/, 'the gap says what would produce the missing layer');
  assert.match(board, /scripts\/build-manager-archetypes\.mjs/, 'down to the build that fills it');
});

test('a thin sample reads as thin, and never as a measured neutral', () => {
  assert.match(board, /Not enough data yet/, 'the explicit label for a value we will not stand behind');
  assert.match(brainTypes, /priceable === false/, 'priceable: false is thin by definition');
  assert.match(brainTypes, /MIN_OBSERVATIONS/, 'and so is a handful of observations');
  assert.match(board, /n=\{signal\.n == null \? '—' : signal\.n\}/,
    'n travels with every value shown, measured or thin');
  assert.match(board, /descriptive only, never prices a deal/,
    'a source the engine refuses to price is labelled as such');
});

test('the signal layer being absent is a named state, not a blank half-page', () => {
  // The endpoint is new; on a server that does not serve it yet the page must
  // still be correct and must not present the hand-set tiers as the whole story.
  assert.match(board, /404/, 'a 404 from the signals route is reported as "nothing there to read"');
  assert.match(board, /available === false/, 'and so is an explicit available: false');
  assert.match(board, /identity_warnings/, 'an uncertain identity is surfaced, not quietly priced');
  assert.match(board, /signals\.data\.reason/, 'the server\'s own reason is rendered, not swallowed');
});

test('"no proposals" is rendered as three distinct answers', () => {
  // proposalsFor() distinguishes them by `refused` and `source`, not by the
  // length of the list — see server/services/trade-proposals.js:466.
  assert.match(slate, /Nothing to propose in this league right now/, 'the finder came back empty');
  assert.match(slate, /We could not ask the model/, 'no key, or the budget is gone');
  assert.match(slate, /nothing survived verification/, 'the model answered and the verifier rejected it all');
  assert.match(slate, /result\.refused === true/, 'the distinction is drawn from refused, not from length');
  assert.match(slate, /result\.source === 'model'/, 'and from which source answered');
  assert.match(slate, /result\.reason/, 'and the server\'s reason is always shown');
});

test('cache versus a fresh model call is visible, because one of them costs money', () => {
  assert.match(slate, /Served from cache/);
  assert.match(slate, /Fresh model call/);
});

test('the opener and the ask are copyable, because they are the deliverable', () => {
  assert.match(slate, /CopyLine/, 'the proposal renders copy affordances');
  assert.match(slate, /Opening message/);
  assert.match(slate, /What to ask for/);
  const copy = read('client/src/components/brain/CopyLine.tsx');
  assert.match(copy, /navigator\.clipboard/);
  assert.match(copy, /select-all/, 'and stays hand-copyable where the clipboard API is unavailable');
});

/* ------------------------------------- 5. the contract the page is built on */

test('the live endpoints the page depends on are still the ones the server serves', () => {
  const routes = read('server/routes/trades.js');
  assert.match(routes, /r\.get\('\/:leagueId\/proposals'/, 'the proposals route');
  assert.match(routes, /r\.get\('\/:leagueId\/brain\/managers'/, 'the tier read');
  assert.match(routes, /r\.post\('\/:leagueId\/brain\/managers\/:rosterId'/, 'the tier write');
});

test('the page renders every field a proposal is required to carry', () => {
  const required = ['idea_ids', 'package', 'why_they_say_yes', 'opener', 'ask', 'fair', 'floor',
    'timing', 'risk', 'data_used'];
  const missing = required.filter(f => !slate.includes(f));
  assert.deepEqual(missing, [], 'a served field nothing renders is not a deliverable');
});
