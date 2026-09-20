/**
 * Every tab in the sidebar tells the assistant what it is showing.
 *
 * The floating "what am I looking at" assistant reads whatever the current page
 * registered through `usePageExplain()`. Five of the eight sidebar tabs never
 * registered anything, so on League Hub, News, X's & O's, Settings and the Draft
 * hub it fell back to `fallbackSection()` — a section name scraped out of the
 * URL — and answered from the route alone. It did not know how many stories were
 * on screen, which league was active, or whether the page had failed to load; a
 * page showing an error and a page showing nothing looked identical to it.
 *
 * The direction this fails is not deletion. Nobody removes a registration. What
 * happens is that a ninth tab is added and nobody wires it, which is how the
 * first five got this way — so the first test here derives the tab list from
 * `navigation.ts` and the route table in `App.tsx` rather than listing pages by
 * hand, and fails on the tab that forgets.
 *
 * The rest pin the three things a registration can get wrong and still look
 * right: sending a value where presence was the point (Settings carries ESPN
 * cookies, a pairing code and account controls, and this summary is sent to a
 * model), handing over a raw API payload instead of the counts the page already
 * holds, and reporting a count without the state it was counted in, so "no news
 * for this team" and "the news failed to load" arrive as the same zero.
 *
 * Honest limit: node:test, no DOM, source text only. These read the call as it
 * is written, not as it runs. A page could register the right shape and never
 * mount; what is checked is the contract at the call site.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * The text of a call, from its opening paren to the paren that balances it.
 * Quotes are tracked so a paren inside a string does not close the call.
 */
function callText(src, name, what) {
  const at = src.indexOf(`${name}(`);
  assert.ok(at >= 0, `${what}: there is no ${name}( call in this file`);
  let i = at + name.length, depth = 0, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0 && i < src.length, `${what}: the ${name}( call never closes — the reader ran off the end`);
  const text = src.slice(at, i + 1);
  assert.ok(text.endsWith(')'), `${what}: the extracted call does not end at a paren`);
  assert.ok(text.length < 1200, `${what}: the extracted call is ${text.length} chars — the balancer overshot`);
  return text;
}

/** The `{ … }` argument at `index` of a call, as text. */
function argObject(call, index, what) {
  let depth = 0, quote = null, arg = 0, start = -1;
  for (let i = 0; i < call.length; i++) {
    const c = call[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; if (depth === 2 && arg === index && start < 0 && c === '{') start = i; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 1 && start >= 0 && arg === index) return call.slice(start, i + 1); continue; }
    if (c === ',' && depth === 1) arg++;
  }
  assert.fail(`${what}: argument ${index} is not an object literal`);
}

/** `key: value` pairs of an object literal, values kept as written. */
function entries(obj, what) {
  const out = [];
  let depth = 0, quote = null, key = null, valueStart = -1;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; continue; }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0 && key != null) { out.push([key, obj.slice(valueStart, i).trim()]); key = null; }
      continue;
    }
    if (depth !== 1) continue;
    if (c === ':' && key == null) {
      const before = obj.slice(0, i);
      const m = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      assert.ok(m, `${what}: a key before a colon is not a plain identifier`);
      key = m[1];
      valueStart = i + 1;
      continue;
    }
    if (c === ',' && key != null) { out.push([key, obj.slice(valueStart, i).trim()]); key = null; }
  }
  assert.ok(out.length > 0, `${what}: no key/value pairs were read out of the object`);
  return out;
}

const NEWLY_WIRED = {
  'League Hub': 'client/src/pages/LeagueHub.tsx',
  News: 'client/src/pages/News.tsx',
  "X's & O's": 'client/src/pages/Teams.tsx',
  Settings: 'client/src/pages/Settings.tsx',
  'the Draft hub': 'client/src/pages/DraftHub.tsx'
};

test('R1: every sidebar tab registers what it is showing, derived from the nav and the route table', () => {
  const nav = read('client/src/navigation.ts');
  const app = read('client/src/App.tsx');

  const groups = nav.slice(nav.indexOf('export const NAV_GROUPS'), nav.indexOf('const NAV_NOTES'));
  const routes = [...groups.matchAll(/\{ to: '([^']+)'/g)].map(m => m[1]);
  assert.equal(routes.length, 8, `the sidebar declares ${routes.length} tabs, not the 8 this test was written against — re-read it before trusting the rest`);

  // route -> component name, then component name -> page file, both from App.tsx
  // rather than from a list kept here. A tab pointed at a different page is a
  // change this test should follow, not one it should hide.
  const elementFor = new Map([...app.matchAll(/<Route path="([^"]+)" element=\{<([A-Za-z]+) \/>\}/g)].map(m => [m[1], m[2]]));
  const fileFor = new Map([...app.matchAll(/const ([A-Za-z]+) = lazy\(\(\) => import\('\.\/(pages\/[A-Za-z]+)'\)\)/g)].map(m => [m[1], m[2]]));

  const unregistered = [];
  for (const route of routes) {
    const component = elementFor.get(route);
    assert.ok(component, `the sidebar offers ${route} and App.tsx has no route for it`);
    const page = fileFor.get(component);
    assert.ok(page, `${route} renders ${component} and App.tsx does not import it as a page`);
    const src = read(`client/src/${page}.tsx`);
    if (!src.includes('usePageExplain(')) unregistered.push(`${route} (${page})`);
  }
  assert.deepEqual(unregistered, [],
    `these tabs never tell the assistant what they show, so it answers them from the URL alone: ${unregistered.join(', ')}`);
});

test('R2: each newly wired page uses the shared hook and does not grow its own', () => {
  for (const [name, path] of Object.entries(NEWLY_WIRED)) {
    const src = read(path);
    assert.match(src, /import \{ usePageExplain \} from '\.\.\/components\/PageExplainContext'/,
      `${name} calls usePageExplain without importing it from the one module that defines it`);
    assert.doesNotMatch(src, /^(const|function) usePageExplain\b/m,
      `${name} has grown its own copy of the registration hook`);
  }
});

test('R3: Settings registers presence, never a value', () => {
  // This page carries ESPN cookies, an eight-digit pairing code and account
  // controls, and the summary is sent to a model. CLAUDE.md's rule is the whole
  // test: read a value's presence, never its content.
  const src = read('client/src/pages/Settings.tsx');
  const summary = argObject(callText(src, 'usePageExplain', 'Settings'), 2, 'Settings');
  const pairs = entries(summary, 'Settings summary');

  assert.deepEqual(pairs.map(([k]) => k).sort(),
    ['google_sign_in_configured', 'install', 'pairing_available', 'sync_running'],
    'the Settings summary has grown a key nobody vetted — every key here goes to a model');

  assert.doesNotMatch(summary, /espn|swid|s2\b|cookie|token|secret|api[_A-Za-z]*key|email|origin|code/i,
    'the Settings summary is reading something that identifies an account or a secret, not whether one is present');

  // Every value is a boolean, a null, or one of three words naming the install.
  const ALLOWED_LITERALS = new Set(["'local'", "'hosted'", "'unknown'"]);
  for (const [key, value] of pairs) {
    for (const literal of value.match(/'[^']*'/g) ?? []) {
      assert.ok(ALLOWED_LITERALS.has(literal),
        `Settings sends ${literal} for ${key}; the only strings allowed here name which install this is`);
    }
  }
});

test('R4: no page hands over a raw API payload', () => {
  // The hook's own documentation: small and honest, built from what the page
  // already has in hand for its own rendering, never the response object. A
  // bare payload identifier as a value is that mistake in its readable form.
  const PAYLOADS = ['data', 'items', 'teams', 'leagues', 'roundup', 'status', 'rows', 'picks', 'deployment'];
  for (const [name, path] of Object.entries(NEWLY_WIRED)) {
    const summary = argObject(callText(read(path), 'usePageExplain', name), 2, name);
    for (const [key, value] of entries(summary, `${name} summary`)) {
      assert.ok(!PAYLOADS.includes(value),
        `${name} registers the whole ${value} payload as ${key} instead of what it counted out of it`);
    }
  }
});

test('R5: a count arrives with the state it was counted in', () => {
  // Zero stories because this team has no news, and zero stories because the
  // request failed, are different answers. A summary that carries the count and
  // not the state hands the assistant the same zero for both.
  for (const name of ['League Hub', 'News', "X's & O's"]) {
    const summary = argObject(callText(read(NEWLY_WIRED[name]), 'usePageExplain', name), 2, name);
    const state = entries(summary, `${name} summary`).find(([k]) => k === 'state');
    assert.ok(state, `${name} reports a count with no state beside it`);
    for (const word of ['loading', 'failed', 'ready']) {
      assert.match(state[1], new RegExp(`'${word}'`),
        `${name}'s state cannot say '${word}', so that case arrives as one of the others`);
    }
  }
});

test('R6: the Draft hub stands aside for the live board rather than fighting it', () => {
  // Two registrations in one tree write to the same slot: the later effect wins
  // and the loser's cleanup clears it. LiveDraft registers its own summary, so
  // the hub's must not be mounted alongside it.
  const src = read('client/src/pages/DraftHub.tsx');
  const from = src.indexOf('export default function DraftHub');
  assert.ok(from >= 0, 'DraftHub is no longer this file\'s default export');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  assert.match(body, /<\/div>;\s*$/, 'the DraftHub slice does not reach the end of its return');
  assert.ok(body.length < 2000, `the DraftHub slice is ${body.length} chars — it ran past the component`);

  const live = body.indexOf('<LiveDraft');
  const explain = body.indexOf('<DraftHubExplain');
  assert.ok(live >= 0, 'DraftHub no longer renders the live board — re-read this test');
  assert.ok(explain >= 0, 'the Draft hub renders no registration at all');
  assert.ok(explain > live, 'the hub registers a summary on the same branch that renders the live board');
  assert.match(body.slice(0, live), /view === 'live' \?\s*$/,
    'the live board is no longer the true branch of a test for the live view');
  assert.match(body.slice(live, explain), /^[^?]*:/,
    'the registration is no longer on the far side of that branch, so both can mount at once');
  assert.equal((body.match(/<DraftHubExplain/g) ?? []).length, 1,
    'the hub mounts its registration more than once');
});

test('R7: the draft modes are declared once, and the registration names the mode from that list', () => {
  // The tab strip and the summary saying different words for the same screen is
  // the drift navigation.ts was pulled out to stop. One list, both readers.
  const src = read('client/src/pages/DraftHub.tsx');
  assert.equal((src.match(/'Mock & boards'/g) ?? []).length, 1,
    'a mode label is written twice — the tab strip and the summary can now drift');
  assert.match(src, /\{DRAFT_MODES\.map\(/, 'the tab strip no longer renders the one mode list');
  assert.match(src, /usePageExplain\('draft', modeLabel\(view\), \{ draft_mode: modeLabel\(view\) \}\)/,
    'the draft registration no longer names its mode from the shared list');
});

test('R8: what is specific and in view goes to the event context, not the summary', () => {
  // The fourth argument is what lets the assistant's tool loop target a record
  // instead of guessing. It takes identifiers; anything a reader would want
  // rendered belongs in the summary.
  const ID_KEYS = new Set(['league_id', 'team_abbr', 'player_id', 'season', 'week', 'game_id']);
  for (const [name, path] of Object.entries(NEWLY_WIRED)) {
    const call = callText(read(path), 'usePageExplain', name);
    let context;
    try { context = argObject(call, 3, name); } catch { continue; }
    for (const [key] of entries(context, `${name} event context`)) {
      assert.ok(ID_KEYS.has(key),
        `${name} puts ${key} in the event context, which takes identifiers for one record`);
    }
  }
});
