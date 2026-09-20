/**
 * The bookmarklet panel renders what the server sends it.
 *
 * `GET /drafts/:id/capture-bookmarklet` answers with nine fields. SourcePill
 * destructured one, `href`, and dropped the rest — including `warnings`, which
 * says in the server's own words that no tunnel is registered and the https
 * ESPN page will block the script. A user dragged a bookmarklet to their bar,
 * clicked it in the draft room, and nothing happened. The app had been told
 * exactly why and threw it away.
 *
 * It also never asked for a key. The route requires `?ingest_key=…`, so every
 * click came back 400 and printed the route's own parameter documentation at
 * the user.
 *
 * Both halves are pinned here, plus the served-field rule itself: every field
 * the route returns is either rendered or named as dropped with a reason.
 *
 * Source text only: node:test has no build step and cannot import a .tsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const pill = read('client/src/components/draft/SourcePill.tsx');
const route = read('server/routes/draft-capture.js');
const css = read('client/src/index.css');

/** The fields the route actually puts on the wire, read from the route. */
const SERVED = (() => {
  const body = route.slice(route.indexOf('res.json({'), route.indexOf('} catch (error) { next(error); }'));
  assert.ok(body.includes('href'), 'the capture-bookmarklet response body could not be located');
  return ['href', 'href_dry', 'loader_url', 'origin', 'draft_id', 'tunnel_up', 'key_source', 'href_bytes', 'warnings']
    .filter(f => body.includes(f));
})();

test('the route still serves the nine fields this panel was written against', () => {
  assert.equal(SERVED.length, 9, `the response shape changed: ${SERVED.join(', ')}`);
});

test('the warning the user never saw is rendered, in the server\'s own words', () => {
  // This is the whole reason the file changed. The server's sentence already
  // names the cause and the command that fixes it; rewording it here would put
  // a second version of the claim in a second place, free to drift.
  assert.match(pill, /d\?\.warnings\?\.map\(/, 'warnings are dropped again');
  assert.match(pill, /className="capture-warning">\{w\}</, 'the warning is not rendered verbatim');
  // Matched without the backticks: they are escaped in the route's template
  // literal, so a pattern containing them matches the rendered string and not
  // the source this test reads.
  assert.match(route, /npm run tunnel/, 'the server stopped saying how to fix it');
  assert.match(route, /mixed content/, 'the server stopped saying why it fails');
  // And it is styled as a warning, not as a decorative note: the action the
  // user is about to take is known not to work.
  const rules = css.slice(css.indexOf('.capture-warning {'), css.indexOf('.capture-note {'));
  // The stripe specifically, not "--warn appears somewhere in the rule". The
  // first draft asserted the latter, and the mutation that turned the stripe to
  // --edge stayed green because the rule also sets `color: var(--warn)`.
  assert.match(rules, /border-left: 3px solid var\(--warn\)/, 'the warning lost its stripe');
  assert.match(rules, /color: var\(--warn\)/, 'the warning is no longer coloured as one');
});

test('the panel mints a key, so the button is not a 400 with documentation in it', () => {
  assert.match(pill, /`\/drafts\/\$\{draftId\}\/ingest-key`, \{ method: 'POST' \}/,
    'the panel no longer mints a key and the route will reject it');
  assert.match(pill, /capture-bookmarklet\?ingest_key=\$\{encodeURIComponent\(minted\.key\)\}/,
    'the key is not passed to the route that requires it');
  assert.match(route, /ingest_key required/, 'the route stopped requiring a key — recheck this panel');
});

test('the key is a credential and never reaches the screen or the state', () => {
  // Read a value's presence, never its content. The key goes into the one call
  // that spends it and nowhere else; what is rendered is the href the server
  // built with it, which is what an href is for.
  assert.doesNotMatch(pill, /setBm\(\{[^}]*key/, 'the ingest key is being held in component state');
  assert.doesNotMatch(pill, /console\.(log|warn|error)/, 'the panel logs, and the key is in scope where it does');
  assert.doesNotMatch(pill, /\{minted\.key\}|\{key\}/, 'the key is being rendered');
});

test('every served field is rendered or named as dropped, with a reason', () => {
  // The served-field rule: render it or stop serving it. A field that is
  // neither is a decision nobody made.
  const header = pill.slice(0, pill.indexOf('interface Bookmarklet'));
  const decisions = header.slice(header.indexOf('SERVED-FIELD DECISIONS'));
  assert.ok(decisions.length > 200, 'the served-field decisions are gone from the header');
  for (const f of SERVED) {
    assert.match(decisions, new RegExp(`\\b${f}\\b`), `${f} has no render-or-drop decision`);
  }
  // The two dropped ones are named as dropped, so "not rendered" is a decision
  // rather than an oversight.
  assert.match(decisions, /draft_id\s+dropped/, 'draft_id is not accounted for');
  assert.match(decisions, /key_source\s+dropped/, 'key_source is not accounted for');
  // Everything else is actually REACHABLE on screen. Checking that the
  // identifier appears somewhere is not enough: the first draft did that, and
  // the mutations that replaced `{d.loader_url && (` and `{d.href_dry && (`
  // with `{false && (` both stayed green, because the identifier was still
  // there inside the block that now never renders. So each field is pinned to
  // the guard that decides whether its markup runs.
  const GUARDS = {
    href: '{d?.href && (',
    href_dry: '{d.href_dry && (',
    loader_url: '{d.loader_url && (',
    origin: '{d.origin && <span>{d.origin}</span>}',
    tunnel_up: "{d.tunnel_up ? 'over a tunnel' : 'from this machine'}",
    href_bytes: '{d.href_bytes != null && ',
    warnings: '{d?.warnings?.map('
  };
  for (const [f, guard] of Object.entries(GUARDS)) {
    assert.ok(pill.includes(guard), `${f} is claimed as rendered but its markup is unreachable`);
  }
  // And nothing renders behind a constant, which is how a field stops being
  // shown without anybody editing the decision list above.
  assert.doesNotMatch(pill.slice(pill.indexOf('return (')), /\{false &&|\{\[\]\.map\(/,
    'part of the panel is switched off by a literal');
});

test('re-opening the panel invalidates the old bookmarklet, and says so', () => {
  // mintIngestKey replaces the draft's key (draft-ingest.js). A user who drags
  // the new one beside the old one has two bookmarks and one works.
  const ingest = read('server/services/draft-ingest.js');
  assert.match(ingest, /UPDATE drafts SET ingest_key_hash = \?/, 'minting no longer replaces the previous key');
  assert.match(pill, /stops working\. Drag the new one over it\./, 'the panel no longer warns that the old copy dies');
});
