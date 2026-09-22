/**
 * The Lineup page's start/sit gate panel (client/src/components/lineup/StartSitGate.tsx),
 * rendered for real: the TSX is compiled with the repo's own TypeScript, its data hook
 * is stubbed with a gate payload, and React renders it to markup.
 *
 * What it must do (plan item C12, standing rule 3, prereg addenda 1 §4 and 2 §7, the
 * Independent Auditor's ruling (b) and A6):
 *  - answer the plan's question from the plan-rule verdict (the projection the app served
 *    vs ESPN's): its chip is the headline, and emerald appears ONLY for a plan-rule
 *    beats_dumb. The season-average result is a plain line below it, "a weaker check",
 *    never a chip and never green; it turns into a rose warning if that floor fails;
 *  - show EVERY failing week, whatever its size or sample (acceptance: "failing weeks
 *    shown, not hidden"), for every graded window and arm, each under the rule it lost
 *    to, ESPN's first;
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

const clean = h => h.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
/** The first element carrying `attr`: its attribute value, its class and its visible text. */
function element(html, attr) {
  const m = html.match(new RegExp(`<(\\w+)([^>]*\\b${attr}="([^"]*)"[^>]*)>([\\s\\S]*?)</\\1>`));
  if (!m) return null;
  return { value: m[3], cls: (m[2].match(/class="([^"]*)"/) ?? [])[1] ?? '', text: clean(m[4]) };
}
const heading = html => clean((html.match(/<h2[^>]*id="gate-heading"[^>]*>([\s\S]*?)<\/h2>/) ?? [])[1] ?? '');
/** Emerald chips (the ruling's `bg-emerald` count), and any emerald class at all. */
const emeraldChips = html => (html.match(/bg-emerald/g) ?? []).length;
const noEmerald = (html, text) => assert.doesNotMatch(html, /emerald/, `${emeraldChips(html)} emerald chip(s) on the panel: ${text}`);

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
/** The plan rule's fields for a state (fixture values; prereg addendum 2 §5). */
const planRule = (verdict, extra = {}) => ({ verdict, reason: verdict === 'not_shown' ? 'too_few_weeks' : null,
  source: 'espn_at_lock', weeks_graded: 1, direction: 'dumb_ahead', mde80: { points: 4.7299, win_rate: 0.1869 },
  gates: [{ id: 'P1', value: -6.5246, passed: false }, { id: 'P2', value: 0.2537, passed: false }, { id: 'P3', value: 1, passed: false }],
  ...extra });
const averageCheck = verdict => ({ verdict, rule: 'the season-to-date average, a weaker check',
  gates: [{ id: 'G1', value: 0.7958, passed: true }, { id: 'G2', value: 0.9566, passed: true },
    { id: 'G3', value: 0.5256, passed: true }, { id: 'G4', value: 2.7923, passed: true }] });
const MEASURED = {
  status: 'measured', stored_at: '2026-09-22 21:30:00', verdict: 'not_shown',
  plan_rule: planRule('not_shown'), average_check: averageCheck('beats_dumb'),
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
};

/* The ruling's own gate run (Independent Auditor, 2026-09-22, gate-run-audit.out: HEAD b97d5ea2 on a
   local copy, not production), trimmed to what the panel reads plus the magnitudes it must never show. */
const RULING_RUN = {
  gate: 'start_sit', model_version: 'configB|shrinkage-fit-1|frozen-2023+fit-2',
  policy: 'Start the higher weekly projection from the app\'s current model settings, replayed week by week with only what was known before each week (weekly role recency, the fitted volume numbers and the blend weights, each chosen by data cutoff).',
  universe: 'Every pair of same-position players (QB, RB, WR, TE) in the same week, both active the week before, not on a bye, and both projected at least 8.0 PPR by both rules. Graded only where the two rules disagree, on what the two picks actually scored (0 if he did not play).',
  scoring: 'PPR',
  sign_convention: 'points = our pick minus the dumb pick, in actual points; positive favours our policy. Win rate is the share of disagreements our pick outscored, a tie counting half; above 0.5 favours our policy.',
  replay_caveat: 'Graded on the weekly replay of production\'s projection. The live number also carries the chance to play, the betting-line adjustment and the coordinator correction, which the replay does not.',
  past: {
    seasons: [2024, 2025], weeks: [5, 18], n: 6633, win_rate: 0.5497, points_per_decision: 1.3703, direction: 'ours_ahead',
    ci90: { player: { points: [0.7958, 1.9428], win_rate: [0.5256, 0.5733] }, week: { points: [0.9566, 1.7702], win_rate: [0.5332, 0.5667], clusters: 28 } },
    mde80: { points: 0.8806, win_rate: 0.0366 }, pair_accuracy: { policy: 0.6056, baseline: 0.5929 },
    failing_weeks: [
      { season: 2024, week: 10, n: 244, win_rate: 0.4816, points_per_decision: -1.3357, failing: true },
      { season: 2024, week: 11, n: 201, win_rate: 0.4602, points_per_decision: -0.8139, failing: true },
      { season: 2024, week: 14, n: 226, win_rate: 0.4668, points_per_decision: -0.6232, failing: true },
      { season: 2025, week: 13, n: 191, win_rate: 0.4372, points_per_decision: -0.6106, failing: true },
      { season: 2025, week: 14, n: 208, win_rate: 0.476, points_per_decision: -0.4519, failing: true }],
  },
  forward: {
    season: 2026, weeks: [2, 2], n: 571, win_rate: 0.5806, points_per_decision: 2.7923, direction: 'ours_ahead',
    label: 'This season, today\'s model settings replayed on this season\'s weeks: not the projection the app served at the time.',
    ci90: { player: { points: [0.3103, 5.5129], win_rate: [0.4908, 0.677] }, week: { points: [2.7923, 2.7923], win_rate: [0.5806, 0.5806], clusters: 1 } },
    mde80: { points: 3.934, win_rate: 0.142 }, failing_weeks: [],
    served: {
      label: 'What the app actually served: the projection it saved before each week\'s first kickoff, graded on the same players and the same scores as the replay.',
      weeks: [{ week: 2, captured_at: '2026-09-17T18:56:10.819Z', weight_fit: ['frozen-2023'], replay_champion: 'fit-2',
        same_weights: false, k_fit_id: 1, k_fitted_at: '2026-09-18T02:52:00.649Z', served_before_k_fit: true }],
      vs_average: { n: 63, rows: 360, win_rate: 0.5556, points_per_decision: 3.4905, direction: 'ours_ahead',
        ci90: { player: { points: [-2.1295, 9.2611], win_rate: [0.3462, 0.7692] }, week: { points: [3.4905, 3.4905], clusters: 1 } },
        mde80: { points: 8.5708, win_rate: 0.3227 }, failing_weeks: [] },
      vs_espn: { n: 286, rows: 153, win_rate: 0.3776, points_per_decision: -3.4207, direction: 'dumb_ahead',
        baseline: 'The literal dumb rule: start the player ESPN projects higher that week (ESPN\'s own weekly projection, one value per player and week, from the synced leagues\' settled lineups).',
        ci90: { player: { points: [-6.5246, -0.3637], win_rate: [0.2537, 0.5057] }, week: { points: [-3.4207, -3.4207], clusters: 1 } },
        mde80: { points: 4.7299, win_rate: 0.1869 },
        failing_weeks: [{ season: 2026, week: 2, n: 286, win_rate: 0.3776, points_per_decision: -3.4207, failing: true }] },
    },
  },
};
const RULING_GATES = [
  { id: 'G1', label: 'points per decision, player-clustered 90% CI lower bound > 0', value: 0.7958, passed: true },
  { id: 'G2', label: 'points per decision, week-clustered 90% CI lower bound > 0', value: 0.9566, passed: true },
  { id: 'G3', label: 'decision win rate, player-clustered 90% CI lower bound > 0.5', value: 0.5256, passed: true },
  { id: 'G4', label: 'forward weeks: points per decision > 0 with at least one disagreement', value: 2.7923, passed: true }];

/** That run as b97d5ea2's latestStartSitGate served it: the average's verdict on top, no plan_rule. */
const REAL_B97D = { ...RULING_RUN, status: 'measured', audit_id: 1, stored_at: '2026-09-22 23:15:00', // fixture time: that run was not stored
  audit_verdict: 'promotion_eligible', version: 'start-sit-gate-v2', verdict: 'beats_dumb', gates: RULING_GATES,
  baseline: 'The dumb rule: start the player with the higher season-to-date PPR average (his average in games played this season before the week). No model.' };

/** The same run as the fixed gate serves it (prereg addendum 2): the plan rule on top, the average as average_check. */
const ESPN_TEXT = 'The plan\'s dumb rule: start the player ESPN projects higher that week (ESPN\'s own weekly projection, one value per player and week, from the synced leagues\' settled lineups).';
const oneWeekCluster = ci => ({ ...ci, week: { points: null, win_rate: null, clusters: 1,
  note: 'fewer than 2 week clusters: one week is one cluster, not an interval' } });
const REAL_FIX = { ...RULING_RUN, status: 'measured', audit_id: 2, stored_at: '2026-09-23 00:30:00', audit_verdict: 'blocked',
  version: 'start-sit-gate-v3', baseline: ESPN_TEXT,
  forward: { ...RULING_RUN.forward, ci90: oneWeekCluster(RULING_RUN.forward.ci90), served: { ...RULING_RUN.forward.served,
    vs_average: { ...RULING_RUN.forward.served.vs_average, ci90: oneWeekCluster(RULING_RUN.forward.served.vs_average.ci90) },
    vs_espn: { ...RULING_RUN.forward.served.vs_espn, baseline: ESPN_TEXT, ci90: oneWeekCluster(RULING_RUN.forward.served.vs_espn.ci90) } } },
  average_check: { verdict: 'beats_dumb', gates: RULING_GATES, prereg: 'docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md',
    rule: 'The weaker check, set before the numbers: start the player with the higher season-to-date PPR average (his average in games played this season before the week). No model.' },
  plan_rule: { ...planRule('not_shown'), prereg: 'docs/evidence/2026-09-22/start-sit-baseline-gate-prereg-addendum-2.md' },
  verdict: 'not_shown' };

/** The rule-3 grep of the evidence file §10: `grep -o -E '[0-9]+(\.[0-9]+)?%|[+-][0-9]+\.[0-9]+'`. */
const RULE3_GREP = /[0-9]+(\.[0-9]+)?%|[+-][0-9]+\.[0-9]+/;
/** Seasons, weeks, timestamps and the universe's two rules removed: any digit left is a magnitude. */
const stripAllowed = text => text
  .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, '')    // when it was measured
  .replace(/at least 8\.0 PPR/g, '')                                      // the startable line: a threshold, not a result
  .replace(/\(0 if he did not play\)/g, '')                              // the scoring rule for a did-not-play
  .replace(/\bW\d{1,2}\b/g, '')                                         // week labels
  .replace(/\bweeks? \d{1,2}(-\d{1,2})?\b/g, '')                        // "weeks 5-18", "week 2"
  .replace(/\b20\d\d\b/g, '');                                         // seasons

test('A6: the ruling\'s real result as b97d5ea2 served it gets no emerald and no "Beats"; ESPN heads the panel', () => {
  // b97d5ea2's panel rendered this payload with 1 emerald chip, 'Beats "start the higher average"'.
  const { html, text } = render(REAL_B97D);
  noEmerald(html, text);
  assert.doesNotMatch(text, /Beats/);
  assert.match(heading(html), /ESPN's projection/);
  const chip = element(html, 'data-gate-chip');
  assert.ok(chip, 'the panel has a verdict chip');
  assert.match(chip.text, /ESPN's projection/);
  assert.doesNotMatch(stripAllowed(text), /\d/, `a magnitude reached the panel: ${stripAllowed(text)}`);
  assert.doesNotMatch(text, RULE3_GREP, 'the evidence file\'s rule-3 grep (percentages, signed decimals) finds nothing');
});

test('A6: the same real result as the fix serves it: amber "Not shown to beat ESPN\'s projection", the week-2 line, the floor below', () => {
  const { html, text } = render(REAL_FIX);
  noEmerald(html, text);
  assert.doesNotMatch(text, /Beats/);
  assert.equal(heading(html), 'Does our projection beat ESPN\'s projection?');
  assert.match(text, /The plan's dumb rule: start whoever ESPN projects higher\./);
  const chip = element(html, 'data-gate-chip');
  assert.equal(chip.value, 'not_shown');
  assert.equal(chip.text, 'Not shown to beat ESPN\'s projection');
  assert.match(chip.cls, /\bbg-amber-50\b/);
  assert.equal(element(html, 'data-plan-line').text, 'In the one week measured (2026 week 2), ESPN\'s pick scored more. '
    + 'ESPN\'s number was read at lineup lock, after news our projection did not have, which favours ESPN. '
    + 'Until this passes, treat our start/sit calls as no better than ESPN\'s projection.');
  const floor = element(html, 'data-average-check');
  assert.equal(floor.text, 'Weaker check, set before the numbers: against "start the higher season average", our pick scored more '
    + 'in 2024-2025 and in 2026 week 2 replayed.');
  assert.doesNotMatch(floor.cls, /emerald|rose|bg-/, 'the floor is plain text: no chip, no green, no warning while it passes');
  assert.ok(html.indexOf('data-gate-chip') < html.indexOf('data-average-check'), 'the floor sits below the verdict');
  assert.doesNotMatch(stripAllowed(text), /\d/, `a magnitude reached the panel: ${stripAllowed(text)}`);
  assert.doesNotMatch(text, RULE3_GREP, 'the evidence file\'s rule-3 grep (percentages, signed decimals) finds nothing');
});

test('A6: emerald only for a plan-rule beats_dumb; every plan-rule state has its own chip and line', () => {
  const at = (verdict, extra) => render({ ...MEASURED, verdict, plan_rule: planRule(verdict, extra) });
  const beats = at('beats_dumb', { weeks_graded: 4, direction: 'ours_ahead' });
  assert.equal(element(beats.html, 'data-gate-chip').text, 'Beats ESPN\'s projection');
  assert.match(element(beats.html, 'data-gate-chip').cls, /\bbg-emerald-50\b/);
  assert.equal(element(beats.html, 'data-plan-line').text, 'Over at least four weeks where they disagreed, our pick scored more '
    + 'than ESPN\'s, and it held up under the test set before the numbers.');
  const loses = at('loses_to_dumb', { weeks_graded: 4, source: 'espn_same_cutoff' });
  assert.equal(element(loses.html, 'data-gate-chip').text, 'Loses to ESPN\'s projection');
  assert.match(element(loses.html, 'data-gate-chip').cls, /\bbg-rose-50\b/);
  assert.match(element(loses.html, 'data-plan-line').text, /same cutoff over at least four weeks, ESPN's pick scored more/);
  const fault = at('instrument_fault');
  assert.equal(element(fault.html, 'data-gate-chip').text, 'Could not grade');
  for (const r of [loses, fault, at('not_shown')]) noEmerald(r.html, r.text);
  // The floor passing never paints anything green.
  const floorPasses = render({ ...MEASURED, average_check: averageCheck('beats_dumb') });
  noEmerald(floorPasses.html, floorPasses.text);
});

test('A6: the not_shown line names the weeks and whose pick scored more, and the at-lock caveat only for at-lock', () => {
  const line = extra => element(render({ ...MEASURED, plan_rule: planRule('not_shown', extra) }).html, 'data-plan-line').text;
  assert.match(line({ direction: 'ours_ahead' }), /^In the one week measured \(2026 week 2\), our pick scored more\. /);
  const sameCutoff = line({ source: 'espn_same_cutoff', weeks_graded: 5, reason: 'not_distinguishable', direction: 'even' });
  assert.doesNotMatch(sameCutoff, /lineup lock/);
  assert.match(sameCutoff, /^In the five weeks measured this season, the two came out even\. Until this passes/);
  const nothing = line({ weeks_graded: 0, direction: 'not_available' });
  assert.equal(nothing, 'No week has been graded against ESPN\'s projection yet. Until this passes, treat our start/sit calls as no '
    + 'better than ESPN\'s projection.');
});

test('A6: the floor line turns into a rose warning when the average check stops passing', () => {
  for (const verdict of ['beats_dumb_unconfirmed_forward', 'not_distinguishable', 'loses_to_dumb']) {
    const floor = element(render({ ...MEASURED, average_check: averageCheck(verdict) }).html, 'data-average-check');
    assert.equal(floor.value, verdict);
    assert.match(floor.cls, /\btext-rose-700\b/, `${verdict}: the failing floor is a rose warning`);
    assert.match(floor.text, /^Warning\. Weaker check, set before the numbers: against "start the higher season average", /);
  }
  const passing = element(render(MEASURED).html, 'data-average-check');
  assert.doesNotMatch(passing.cls, /rose/);
  assert.doesNotMatch(passing.text, /Warning/);
});

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
  assert.deepEqual(Object.keys(g), ['served_vs_espn', 'past', 'replay', 'served_vs_average'],
    'one group per graded window and arm, the plan\'s rule (ESPN) first');
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
  assert.match(g.served_vs_espn.text, /the plan's rule/);
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
  for (const plan of ['beats_dumb', 'not_shown', 'loses_to_dumb', 'instrument_fault']) {
    for (const average of ['beats_dumb', 'beats_dumb_unconfirmed_forward', 'not_distinguishable', 'loses_to_dumb']) {
      const { text } = render({ ...MEASURED, verdict: plan, plan_rule: planRule(plan, { weeks_graded: 4 }),
        average_check: averageCheck(average) });
      const rest = stripAllowed(text);
      assert.doesNotMatch(rest, /\d/, `${plan}/${average}: a number other than a season or week reached the panel: ${rest}`);
    }
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
