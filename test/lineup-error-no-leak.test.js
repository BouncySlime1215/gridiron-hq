/**
 * UX-08 (plan item D23, UI rule 9): the Lineup page (client/src/pages/Lineup.tsx)
 * rendered a server error straight onto the Start/Sit screen, including a file
 * path and a table name (docs/handoff/local/ui/UX-01-audit.md, "grep Lineup":
 * "the fitted chance-to-play role layer is not running:
 * nfl_availability_role_rates is missing/empty (docs/tdd/play-chance.tdd.md)").
 *
 * This renders the real Lineup.tsx (TSX compiled with the repo's own
 * TypeScript, its data hooks and child components stubbed, React renders it to
 * markup) with the lineup fetch failing with that exact server text, and
 * asserts the rendered page shows no path/table text — only the shared,
 * plain-words error state. It also asserts the page's own header (its "nav"
 * within this component — Lineup.tsx renders no app nav itself) is unchanged:
 * the same title and copy render whether the lineup call succeeds or fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { availabilityDegradation } from '../server/services/contingency.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-page-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };

const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))})(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const reactUrl = write('react.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react'))})(${JSON.stringify(repoRequire.resolve('react'))});
export default rt; export const useMemo = rt.useMemo; export const useState = rt.useState;`);

// One call site per useApi() call in Lineup.tsx, in the order it calls them:
// lineup, waivers, posture, rosters. Only the lineup call fails.
// The call counter lives on globalThis and is reset before every render: the
// stub module is imported once, so a module-level counter would keep counting
// across tests and hand the lineup slot's data to a later call.
const apiUrl = write('api.mjs', `export function useApi(p) {
  const n = (globalThis.__apiN = (globalThis.__apiN ?? 0) + 1);
  if (n === 1) return { data: globalThis.__lineupData ?? null, loading: false, error: globalThis.__lineupError ?? null, refetch: () => {} };
  return { data: null, loading: false, error: null, refetch: () => {} };
}`);
const leagueUrl = write('league.mjs', 'export function useLeague() { return { activeId: 1 }; }');
const evidenceUrl = write('evidence-strip.mjs',
  'export default function EvidenceStrip() { return null; }\nexport function RecordLine() { return null; }');
const explainUrl = write('page-explain.mjs', 'export function usePageExplain() {}');
const waiverUrl = write('waiver-wire.mjs',
  'export default function WaiverWire() { return null; }\nexport function WaiverTeaser() { return null; }\nexport function onATeam() { return true; }');
const postureUrl = write('matchup-posture.mjs', 'export default function MatchupPosture() { return null; }');
const gateUrl = write('start-sit-gate.mjs', 'export default function StartSitGate() { return null; }');

async function loadPageState() {
  const source = fs.readFileSync(new URL('../client/src/components/PageState.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const linkStubUrl = write('react-router-dom.mjs', 'export function Link({ children }) { return children ?? null; }');
  let compiled = outputText;
  for (const [from, to] of [["'react-router-dom'", linkStubUrl], ['"react/jsx-runtime"', runtimeUrl]]) {
    compiled = compiled.split(from).join(`'${to}'`);
  }
  return write(`page-state-${Date.now()}-${Math.random()}.mjs`, compiled);
}

async function loadLineup() {
  const pageStateUrl = await loadPageState();
  const source = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  let compiled = outputText;
  const swaps = [
    ["'react'", reactUrl],
    ["'../api'", apiUrl],
    ["'../state/league'", leagueUrl],
    ["'../components/lineup/EvidenceStrip'", evidenceUrl],
    ["'../components/PageExplainContext'", explainUrl],
    ["'../components/PageState'", pageStateUrl],
    ["'../components/lineup/WaiverWire'", waiverUrl],
    ["'../components/lineup/MatchupPosture'", postureUrl],
    ["'../components/lineup/StartSitGate'", gateUrl],
    ['"react/jsx-runtime"', runtimeUrl],
  ];
  for (const [from, to] of swaps) {
    assert.ok(compiled.includes(from), `the compiled Lineup page imports ${from}`);
    compiled = compiled.split(from).join(`'${to}'`);
  }
  const { default: Lineup } = await import(write(`Lineup-${Date.now()}-${Math.random()}.mjs`, compiled));
  return Lineup;
}

const clean = h => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const LEAKY_ERROR = 'the fitted chance-to-play role layer is not running: ' +
  'nfl_availability_role_rates is missing/empty (docs/tdd/play-chance.tdd.md)';

test('Lineup page: a server error with a path and table name shows no path/table text; page header unchanged', async () => {
  const Lineup = await loadLineup();
  globalThis.__lineupError = LEAKY_ERROR;
  const html = (globalThis.__apiN = 0, renderToStaticMarkup(React.createElement(Lineup)));
  const text = clean(html);

  // Raw markup, not tag-stripped text, so attribute leaks fail too.
  assert.ok(!html.includes('nfl_availability_role_rates'), `page leaked the table name: ${html}`);
  assert.ok(!html.includes('docs/tdd/'), `page leaked the file path: ${html}`);
  assert.ok(!text.includes(LEAKY_ERROR), 'page leaked the raw server message verbatim');

  // Plain-words shared error state, still present.
  assert.match(text, /couldn't load this/i);
  assert.match(text, /retry/i);

  // The page's own header ("nav" within this component — it renders no app
  // nav itself) is unchanged: same title on the error path as on success.
  assert.match(text, /Who to start/);
});

test('control: the page header renders the same way when the lineup call succeeds (known-good case)', async () => {
  const Lineup = await loadLineup();
  globalThis.__lineupError = null;
  const html = (globalThis.__apiN = 0, renderToStaticMarkup(React.createElement(Lineup)));
  const text = clean(html);
  assert.match(text, /Who to start/);
  assert.ok(!/couldn't load this/i.test(text), 'no error card when the call succeeds');
});

// Skeptic finding (UX-08 review 1): the audited string never came through the
// error path. It is the SUCCESS payload's `availability_note`, written by
// availabilityDegradation() (server/services/contingency.js) and served as
// lineup-brain.js `availability_note`. This renders Lineup with the REAL producer
// output as `data`, not a paraphrase as `error`.
test('Lineup page: a real availability_note payload shows plain words, no table/doc/script text', async () => {
  const Lineup = await loadLineup();
  const note = availabilityDegradation({ basis: 'pooled', missing: ['nfl_availability_role_rates'] });
  // Known-nonzero control: the producer really does carry the internal detail.
  assert.match(note.reason, /nfl_availability_role_rates/);
  assert.match(note.fix, /scripts\/fit-availability\.mjs/);
  globalThis.__lineupError = null;
  globalThis.__lineupData = { availability_note: note, lineup: [], bench: [], warnings: [] };
  const seen = []; const orig = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  let html;
  try { html = (globalThis.__apiN = 0, renderToStaticMarkup(React.createElement(Lineup))); }
  finally { console.error = orig; globalThis.__lineupData = null; }
  for (const m of ['nfl_availability_role_rates', 'docs/tdd/', 'scripts/', 'fit-availability']) {
    assert.ok(!html.includes(m), `Lineup leaked "${m}": ${html}`);
  }
  // The notice itself still renders, with its plain-words effect line.
  assert.match(html, /Chance-to-play numbers are degraded/);
  assert.match(html, /pooled injury-report rate/);
  // Detail is logged, not lost.
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates') && s.includes('fit-availability')));
});
