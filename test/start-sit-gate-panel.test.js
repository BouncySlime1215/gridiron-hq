/**
 * The Lineup page's start/sit gate panel (client/src/components/lineup/StartSitGate.tsx),
 * rendered for real: the TSX is compiled with the repo's own TypeScript, its data hook
 * is stubbed with a gate payload, and React renders it to markup.
 *
 * What it must do (plan item C12, standing rule 3, prereg addendum 1 §4):
 *  - show EVERY failing week, whatever its size or sample (acceptance: "failing weeks
 *    shown, not hidden"), for every graded window and arm, each under the rule it lost
 *    to (the literal "start the highest projection", ESPN's, included);
 *  - say why a served week is not today's replay, and only when it is not;
 *  - show direction only: no replay magnitude and no lineup rate reaches Nick. The only
 *    digits on the panel are season and week labels and the time it was measured.
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-start-sit-panel-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const source = fs.readFileSync(new URL('../client/src/components/lineup/StartSitGate.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
const apiUrl = write('api.mjs', `export function useApi(p) {
  globalThis.__gatePath = p;
  return { data: globalThis.__gatePayload, loading: false, error: null, refetch() {} };
}`);
const stateUrl = write('page-state.mjs', 'export function PageLoading() { return null; }\nexport function PageError() { return null; }');
// The component's JSX runtime must be the same React the test renders with.
const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))})(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
let compiled = outputText;
for (const [from, to] of [["'../../api'", apiUrl], ["'../PageState'", stateUrl], ['"react/jsx-runtime"', runtimeUrl]]) {
  assert.ok(compiled.includes(from), `the compiled panel imports ${from}`);
  compiled = compiled.split(from).join(`'${to}'`);
}
const { default: StartSitGate } = await import(write('StartSitGate.mjs', compiled));

function render(payload) {
  globalThis.__gatePayload = payload;
  const html = renderToStaticMarkup(React.createElement(StartSitGate));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  return { html, text };
}

/** Each failing-weeks group on the panel: its visible text and its chips, in order. */
function lostGroups(html) {
  const out = {};
  for (const part of html.split('data-failing-group="').slice(1)) {
    const arm = part.slice(0, part.indexOf('"'));
    const seg = part.split('<details')[0];
    out[arm] = {
      chips: [...seg.matchAll(/data-failing-week="([^"]+)"/g)].map(m => m[1]),
      text: seg.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim(),
    };
  }
  return out;
}

/** Distinct, easy-to-spot magnitudes: none of them may appear on the panel in any form. */
const failingWeek = (season, week, n) => ({ season, week, n, win_rate: 0.4137, points_per_decision: -1.3377, failing: true });
const FAILING = [failingWeek(2024, 10, 244), failingWeek(2024, 11, 201), failingWeek(2024, 14, 226),
  failingWeek(2025, 3, 12), failingWeek(2025, 13, 191), failingWeek(2025, 14, 208), failingWeek(2025, 17, 7)];
const MEASURED = {
  status: 'measured', stored_at: '2026-09-22 21:30:00', verdict: 'beats_dumb',
  policy: 'our weekly projection, replayed', baseline: 'the season-to-date average', universe: 'startable pairs',
  scoring: 'PPR', sign_convention: 'points are ours minus theirs', replay_caveat: 'the replay is not the live number',
  past: {
    seasons: [2024, 2025], weeks: [5, 18], n: 6633, pairs: 52297, agreement_share: 0.8731,
    win_rate: 0.5497, points_per_decision: 1.3703, direction: 'ours_ahead',
    ci90: { player: { points: [0.7958, 1.9428], win_rate: [0.5256, 0.5733] }, week: { points: [0.9566, 1.7712] } },
    mde80: { points: 0.8812, win_rate: 0.0371 }, pair_accuracy: { policy: 0.6056, baseline: 0.5929 },
    failing_weeks: FAILING,
  },
  forward: {
    season: 2026, weeks: [2, 2], n: 571, win_rate: 0.5806, points_per_decision: 2.7923, direction: 'ours_ahead',
    failing_weeks: [],
    label: 'today’s configuration, replayed on this season’s weeks, not the projection the app served at the time',
    pair_accuracy: { policy: 0.6357, baseline: 0.5874 },
    served: {
      label: 'what the app served before each week',
      weeks: [{ week: 2, captured_at: '2026-09-17T18:56:10.819Z', weight_fit: ['frozen-2023'], replay_champion: 'fit-2',
        same_weights: false, k_fit_id: 1, k_fitted_at: '2026-09-18T02:52:00.649Z', served_before_k_fit: true }],
      vs_average: { n: 63, win_rate: 0.5556, points_per_decision: 3.4905, direction: 'ours_ahead', failing_weeks: [] },
      vs_espn: { n: 41, win_rate: 0.4412, points_per_decision: -0.7719, direction: 'dumb_ahead', baseline: 'ESPN’s projection',
        failing_weeks: [failingWeek(2026, 2, 41)] },
    },
  },
  gates: [{ id: 'G1', value: 0.7958, passed: true }, { id: 'G2', value: 0.9566, passed: true },
    { id: 'G3', value: 0.5256, passed: true }, { id: 'G4', value: 2.7923, passed: true }],
};

test('the panel reads the gate route', () => {
  render(MEASURED);
  assert.equal(globalThis.__gatePath, '/gates/start-sit');
});

test('every failing week is on the panel, whatever its sample size, in order', () => {
  const { html, text } = render(MEASURED);
  const past = lostGroups(html).past;
  assert.ok(past, 'the past window has a failing-weeks group');
  assert.deepEqual(past.chips, FAILING.map(w => `${w.season}-${w.week}`));
  for (const w of FAILING) assert.ok(text.includes(`${w.season} W${w.week}`), `${w.season} W${w.week} is shown`);
});

test('no failing week: the panel says none, and shows no chip', () => {
  const { html } = render({ ...MEASURED, past: { ...MEASURED.past, failing_weeks: [] } });
  const past = lostGroups(html).past;
  assert.deepEqual(past.chips, []);
  assert.match(past.text, /none/i);
});

test('every graded arm lists its own failing weeks under the rule it lost to', () => {
  const fw = (season, week) => failingWeek(season, week, 30);
  const { html } = render({ ...MEASURED, forward: { ...MEASURED.forward, weeks: [2, 3], failing_weeks: [fw(2026, 3)],
    served: { ...MEASURED.forward.served,
      vs_average: { ...MEASURED.forward.served.vs_average, failing_weeks: [fw(2026, 2)] },
      vs_espn: { ...MEASURED.forward.served.vs_espn, failing_weeks: [fw(2026, 2), fw(2026, 3)] } } } });
  const g = lostGroups(html);
  assert.deepEqual(Object.keys(g), ['past', 'replay', 'served_vs_average', 'served_vs_espn'], 'one group per graded window and arm, in order');
  assert.deepEqual(g.replay.chips, ['2026-3']);
  assert.deepEqual(g.served_vs_average.chips, ['2026-2']);
  assert.deepEqual(g.served_vs_espn.chips, ['2026-2', '2026-3'], 'the literal rule\'s losses are shown, not hidden');
  assert.match(g.past.text, /past seasons/i);
  assert.match(g.past.text, /"start the higher average"/);
  assert.match(g.replay.text, /today's model replayed/i);
  assert.match(g.replay.text, /average/);
  assert.match(g.served_vs_average.text, /as the app served it/i);
  assert.match(g.served_vs_average.text, /average/);
  assert.doesNotMatch(g.served_vs_average.text, /ESPN/);
  assert.match(g.served_vs_espn.text, /as the app served it/i);
  assert.match(g.served_vs_espn.text, /ESPN's projection/);
});

test('the real week-2 payload shape: the ESPN arm\'s lost week is a chip, the other forward arms say none', () => {
  const { html } = render(MEASURED);
  const g = lostGroups(html);
  assert.deepEqual(g.served_vs_espn.chips, ['2026-2']);
  for (const arm of ['replay', 'served_vs_average']) {
    assert.deepEqual(g[arm].chips, [], `${arm} lost no week`);
    assert.match(g[arm].text, /none/i, `${arm} says none`);
  }
});

test('an arm that was not graded, or a season not measured yet, gets no failing-weeks group', () => {
  const notAvailable = { status: 'not_available', reason: 'no settled ESPN projection', direction: 'not_available' };
  const noEspn = lostGroups(render({ ...MEASURED, forward: { ...MEASURED.forward,
    served: { ...MEASURED.forward.served, vs_espn: notAvailable } } }).html);
  assert.deepEqual(Object.keys(noEspn), ['past', 'replay', 'served_vs_average']);
  const noServed = lostGroups(render({ ...MEASURED, forward: { ...MEASURED.forward, served: undefined } }).html);
  assert.deepEqual(Object.keys(noServed), ['past', 'replay']);
  const noSeason = lostGroups(render({ ...MEASURED, forward: { status: 'not_available', reason: 'no 2026 week graded yet',
    direction: 'not_available' } }).html);
  assert.deepEqual(Object.keys(noSeason), ['past']);
});

test('direction only: the only digits on the panel are seasons, weeks and when it was measured', () => {
  for (const verdict of ['beats_dumb', 'beats_dumb_unconfirmed_forward', 'not_distinguishable', 'loses_to_dumb']) {
    const { text } = render({ ...MEASURED, verdict });
    const rest = text
      .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, '')    // when it was measured
      .replace(/\bW\d{1,2}\b/g, '')                                         // week labels
      .replace(/\bweeks? \d{1,2}(-\d{1,2})?\b/g, '')                        // "weeks 5-18", "week 2"
      .replace(/\b20\d\d\b/g, '');                                          // seasons
    assert.doesNotMatch(rest, /\d/, `${verdict}: a number other than a season or week reached the panel: ${rest}`);
  }
});

test('the forward lines give the direction of each arm and why the served number differs from the replay', () => {
  const { text } = render(MEASURED);
  assert.match(text, /replay/i);
  assert.match(text, /served/i);
  assert.match(text, /ESPN/);
  assert.match(text, /our pick scored more/i, 'the replay and served-vs-average arms point our way');
  assert.match(text, /ESPN's pick scored more|ESPN’s pick scored more/i, 'the ESPN arm points the other way');
});

/** The forward payload with week 2's served-settings flags set as given. */
const servedWeek = (flags) => ({ ...MEASURED, forward: { ...MEASURED.forward, served: { ...MEASURED.forward.served,
  weeks: [{ ...MEASURED.forward.served.weeks[0], ...flags }] } } });

test('a week served on older settings says so, naming each reason', () => {
  const both = render(servedWeek({ same_weights: false, served_before_k_fit: true })).text;
  assert.match(both, /The week 2 projection was served on older settings/);
  assert.match(both, /before the fitted volume numbers existed/);
  assert.match(both, /different blend weights/);
  assert.match(both, /not the same projection/);

  const kOnly = render(servedWeek({ same_weights: true, served_before_k_fit: true })).text;
  assert.match(kOnly, /served on older settings \(before the fitted volume numbers existed\)/);
  assert.doesNotMatch(kOnly, /different blend weights/);

  const weightsOnly = render(servedWeek({ same_weights: false, served_before_k_fit: false })).text;
  assert.match(weightsOnly, /served on older settings \(different blend weights\)/);
  assert.doesNotMatch(weightsOnly, /fitted volume numbers/);
});

test('a week served on today\'s settings gets no older-settings line', () => {
  for (const flags of [{ same_weights: true, served_before_k_fit: false }, { same_weights: true, served_before_k_fit: null }]) {
    const { text } = render(servedWeek(flags));
    assert.doesNotMatch(text, /older settings/, `no reason line for ${JSON.stringify(flags)}`);
    assert.doesNotMatch(text, /not the same projection/);
  }
});

test('before any run the panel says so in words', () => {
  const { text } = render({ status: 'not_run', gate: 'start_sit', reason: 'The weekly start/sit gate job has not stored a result yet.' });
  assert.match(text, /has not stored a result yet/);
});
