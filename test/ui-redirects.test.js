/**
 * UI consolidation (docs/ui/CONSOLIDATION-MAP.md section 5): every URL from before the seven
 * areas redirects to its new home, and the pages that keep a URL still render (they are not
 * redirects). Source-level, like test/ux-11-my-team-tab.test.js: App.tsx mounts one MovedTo per
 * old route, and components/Redirects.tsx#OLD_TO_NEW maps each to its target.
 *
 * test/route-deletion-impact.test.js covers server API routes with no caller, not client URLs;
 * no API route loses its last caller here (every page's calls move with its features).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const app = read('client/src/App.tsx');

/** The table in the map, written out by hand so a wrong target in either file fails here. */
const EXPECTED = {
  '/leagues': [{}, '', '/league'],
  '/lineup': [{}, '', '/my-team?view=lineup'],
  '/trade-lab': [{}, '', '/trades?view=find'],
  '/trade-brain': [{}, '', '/trades'],
  '/teams': [{}, '', '/players/teams'],
  '/teams/:abbr': [{ abbr: 'KC' }, '', '/players/teams/KC'],
  '/news': [{}, '', '/players?view=news'],
  '/rankings': [{}, '', '/players?view=rankings'],
  '/projections': [{}, '', '/players?view=board'],
  '/drafts': [{}, '', '/draft'],
  '/drafts/:id': [{ id: '12' }, '', '/draft/12'],
  '/live-draft': [{}, '', '/draft?view=live'],
  '/live-draft/:id': [{ id: '7' }, '', '/draft/live/7'],
};

// Compile Redirects.tsx's table (TS only; the JSX component is not rendered here).
const src = read('client/src/components/Redirects.tsx');
const table = src.slice(src.indexOf('export const OLD_TO_NEW'), src.indexOf('};', src.indexOf('export const OLD_TO_NEW')) + 2);
const js = ts.transpileModule(table, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { OLD_TO_NEW } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test('every old URL has a route in App.tsx that renders its redirect', () => {
  for (const from of Object.keys(EXPECTED)) {
    const esc = from.replace(/[/:]/g, c => `\\${c}`);
    assert.match(app, new RegExp(`<Route path="${esc}" element=\\{<MovedTo from="${esc}" \\/>\\} \\/>`), `${from} is not mounted as a redirect`);
  }
});

test('each redirect lands on the table in the consolidation map', () => {
  assert.deepEqual(Object.keys(OLD_TO_NEW).sort(), Object.keys(EXPECTED).sort(), 'Redirects.tsx and the map list different old URLs');
  for (const [from, [params, search, to]] of Object.entries(EXPECTED)) {
    assert.equal(OLD_TO_NEW[from](params, new URLSearchParams(search)), to, from);
  }
});

test("Trade Brain's own tab choice carries over", () => {
  assert.equal(OLD_TO_NEW['/trade-brain']({}, new URLSearchParams('view=managers')), '/trades?view=managers');
  assert.equal(OLD_TO_NEW['/trade-brain']({}, new URLSearchParams('view=proposals')), '/trades?view=proposals');
});

test('the pages that keep a URL still render, not redirect', () => {
  const pages = { '/': 'Today', '/trades': 'Trades', '/my-team': 'MyTeam', '/league': 'LeagueHub', '/players': 'Players',
    '/players/teams': 'Teams', '/players/teams/:abbr': 'TeamDetail', '/players/:id': 'PlayerDetail',
    '/draft': 'DraftHub', '/draft/:id': 'DraftRoom', '/draft/live/:id': 'LiveDraft', '/settings': 'Settings', '/pair': 'Pair' };
  for (const [path, comp] of Object.entries(pages)) {
    const esc = path.replace(/[/:]/g, c => `\\${c}`);
    assert.match(app, new RegExp(`<Route path="${esc}" element=\\{<${comp} \\/>\\} \\/>`), `${path} should render <${comp} />`);
  }
  assert.doesNotMatch(app, /<Navigate /, 'redirects go through MovedTo, one table');
});

test('the in-app links point at the new URLs, not through a redirect', () => {
  const files = ['client/src/components/PlayerCard.tsx', 'client/src/components/TeamSchedule.tsx', 'client/src/pages/Teams.tsx',
    'client/src/pages/News.tsx', 'client/src/pages/PlayerDetail.tsx', 'client/src/pages/TeamDetail.tsx', 'client/src/pages/Drafts.tsx',
    'client/src/pages/DraftRoom.tsx', 'client/src/pages/LiveDraft.tsx', 'client/src/components/SidePanel.tsx', 'client/src/components/LeagueSwitcher.tsx'];
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /to=\{?[`"]\/(teams|drafts|live-draft|rankings|leagues)\b/, `${f} still links to an old URL`);
    assert.doesNotMatch(s, /nav\(`\/(drafts|live-draft)\//, `${f} still navigates to an old URL`);
  }
});

test('NotFound offers the areas, not dead links', () => {
  const nf = read('client/src/pages/NotFound.tsx');
  assert.doesNotMatch(nf, /'\/betting'|'\/players' ,|Command Center/);
  for (const to of ["'/'", "'/trades'", "'/my-team'", "'/players'"]) assert.ok(nf.includes(`to: ${to}`), to);
});
