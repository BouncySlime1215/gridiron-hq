/**
 * INT-168-1 (from the CE-05 audit, #168): the season sim's own `median_game`
 * field (league-rules.js#inferMedian, served by `GET /model/:leagueId/simulate`
 * — season-sim.js:439) is `null` when the median-game rule is genuinely
 * unknown. inferMedian has two null paths, and each pushes its own reason,
 * prefixed `median_game:`, into `rules.unknown`, served as `rules_unknown`:
 *   - no regular-season week decided yet (league-rules.js:160-162);
 *   - weeks decided, but records per decided week are neither 1 nor 2
 *     (league-rules.js:165-167).
 * The notice must never state a cause of its own: it shows the sim's entry.
 *
 * Three levels, each with known-positive controls:
 *  1. producer -> component: leagueRules() on synthetic ESPN payloads for both
 *     null paths, fed straight into MedianGameNotice; the rendered reason is
 *     the producer's, and the no-decided-week cause never appears on the
 *     mixed-ratio path.
 *  2. the component alone: null renders, true/false/undefined render nothing.
 *  3. page level: MyTeam.tsx (title-odds card; Model.tsx, the orphan page that also
 *     drew it, was retired in batch D 8c) is compiled with the repo's own TypeScript, their data hooks
 *     stubbed with a /simulate response, and rendered with react-dom/server.
 *     The notice appears for median_game:null and not for median_game:true, so
 *     a call site that is present in the source but can never render (e.g.
 *     wrapped in `false &&`) fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { leagueRules } from '../server/services/league-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-int-168-1-'));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };

const repoRequire = createRequire(path.join(root, 'package.json'));
const rtPath = repoRequire.resolve('react/jsx-runtime');
// Compiled TSX must use the same React the test renders with.
const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(rtPath)})(${JSON.stringify(rtPath)});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const reactUrl = write('react.mjs', `import { createRequire } from 'node:module';
const R = createRequire(${JSON.stringify(rtPath)})(${JSON.stringify(repoRequire.resolve('react'))});
export default R; export const { useState, useEffect, useMemo, useRef, useCallback, createContext, useContext, forwardRef } = R;`);

/** Compile a TSX/TS file and point each listed import at a replacement URL. Every relative import must be mapped. */
function compile(rel, name, map) {
  let out = ts.transpileModule(read(rel), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  map = { '"react/jsx-runtime"': runtimeUrl, "'react'": reactUrl, ...map };
  for (const [from, to] of Object.entries(map)) {
    if (out.includes(from)) out = out.split(from).join(`'${to}'`);
  }
  const left = out.match(/from '\.{1,2}\/[^']+'/g);
  assert.equal(left, null, `${rel}: unmapped relative imports ${left}`);
  return write(name, out);
}

const noticeUrl = compile('client/src/components/MedianGameNotice.tsx', 'MedianGameNotice.mjs', {});
const { default: MedianGameNotice } = await import(noticeUrl);
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const renderNotice = props => renderToStaticMarkup(React.createElement(MedianGameNotice, props));

/* ------------------------------------------------ synthetic ESPN payloads */
const settings = { scheduleSettings: {
  matchupPeriodCount: 14, matchupPeriodLength: 1, playoffTeamCount: 4, playoffMatchupPeriodLength: 1,
  playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 4 }] } };
const team = (id, w, l) => ({ id, divisionId: 0, record: { overall: { wins: w, losses: l, ties: 0 } } });
const game = (wk, h, a, winner) => ({ matchupPeriodId: wk, home: { teamId: h }, away: { teamId: a }, winner });
const espn = (teams, schedule) => ({ platform: 'espn', payload: JSON.stringify({ settings, teams, schedule }) });
// No decided regular-season week.
const NO_WEEK = espn([team(1, 0, 0), team(2, 0, 0), team(3, 0, 0), team(4, 0, 0)],
  [game(1, 1, 2, 'UNDECIDED'), game(1, 3, 4, 'UNDECIDED')]);
// Week 1 decided; teams 1-2 carry 1 record per week, teams 3-4 carry 2: mixed ratios.
const MIXED = espn([team(1, 1, 0), team(2, 0, 1), team(3, 2, 0), team(4, 0, 2)],
  [game(1, 1, 2, 'HOME'), game(1, 3, 4, 'HOME')]);
// Known control: every team carries 2 records per decided week -> median game ON.
const KNOWN = espn([team(1, 2, 0), team(2, 0, 2), team(3, 1, 1), team(4, 1, 1)],
  [game(1, 1, 2, 'HOME'), game(1, 3, 4, 'HOME')]);
const NO_WEEK_CAUSE = /no regular-season week (has been|is) decided/i;

test('producer -> notice: each null path shows the sim\'s own reason, never another path\'s cause', () => {
  const noWeek = leagueRules(NO_WEEK);
  const mixed = leagueRules(MIXED);
  const known = leagueRules(KNOWN);
  assert.equal(known.median_game, true, 'control: a consistent 2-records-per-week league must infer median_game = true');
  assert.equal(noWeek.median_game, null);
  assert.equal(mixed.median_game, null);

  const a = text(renderNotice({ medianGame: noWeek.median_game, rulesUnknown: noWeek.unknown }));
  assert.match(a, /still unknown/i, a);
  assert.match(a, NO_WEEK_CAUSE, `no-decided-week path should carry the producer's reason: ${a}`);

  const b = text(renderNotice({ medianGame: mixed.median_game, rulesUnknown: mixed.unknown }));
  assert.match(b, /still unknown/i, b);
  assert.match(b, /records per decided week are 1, 2/, `mixed-ratio path should carry the producer's reason: ${b}`);
  assert.doesNotMatch(b, NO_WEEK_CAUSE, `mixed-ratio path must not claim no week is decided: ${b}`);

  assert.equal(renderNotice({ medianGame: known.median_game, rulesUnknown: known.unknown }), '');
});

test('the notice renders only for null; no reason is invented when the sim gives none', () => {
  const bare = text(renderNotice({ medianGame: null, rulesUnknown: [] }));
  assert.match(bare, /still unknown/i, bare);
  assert.doesNotMatch(bare, /Why:/, `no median_game entry in rules_unknown, yet a reason was shown: ${bare}`);
  assert.doesNotMatch(text(renderNotice({ medianGame: null, rulesUnknown: ['seeding: something else'] })), /Why:/);
  for (const v of [true, false, undefined]) assert.equal(renderNotice({ medianGame: v, rulesUnknown: [] }), '', `median_game=${v}`);
});

/* ---------------------------------------------------------- page level */
const apiUrl = write('api.mjs', `export function useApi(p) {
  const hit = p && Object.entries(globalThis.__apiByPrefix ?? {}).find(([k]) => p.startsWith(k));
  return { data: hit ? hit[1] : undefined, loading: false, error: null, refetch() {} };
}
export async function api() { return {}; }
export function headshotUrl() { return ''; }`);
const leagueUrl = write('league.mjs', 'export function useLeague() { return globalThis.__league; }');
const nullComp = n => `export function ${n}() { return null; }`;
const stubUrl = (name, names, dflt = true) =>
  write(name, names.map(nullComp).join('\n') + (dflt ? '\nexport default function Stub() { return null; }' : ''));
const copyUrl = compile('client/src/copy-constants.ts', 'copy-constants.mjs', {});
const routerUrl = write('router.mjs', nullComp('Link') + '\nexport function useSearchParams() { return [new URLSearchParams(), () => {}]; }');
// UX-08b/08c route alert() through the real errorSanitize (pure; compiled, not stubbed).
const errorSanitizeUrl = compile('client/src/lib/errorSanitize.ts', 'errorSanitize.mjs', {});

// My team draws its tabs with the design system (compiled for real) and hosts Start/Sit (stubbed).
const iconsUrl = compile('client/src/components/warroom/icons.tsx', 'icons.mjs', {});
const rovingUrl = compile('client/src/lib/rovingFocus.ts', 'rovingFocus.mjs', {});
const designUrl = compile('client/src/components/ui/DesignSystem.tsx', 'DesignSystem.mjs', { "'../warroom/icons'": iconsUrl, "'../../lib/rovingFocus'": rovingUrl });
const myTeamUrl = compile('client/src/pages/MyTeam.tsx', 'MyTeam.mjs', {
  "'../components/ui/DesignSystem'": designUrl,
  "'./Lineup'": stubUrl('Lineup.mjs', []),
  "'react-router-dom'": routerUrl, "'../api'": apiUrl, "'../state/league'": leagueUrl, "'../copy-constants'": copyUrl,
  "'../components/FormationView'": stubUrl('FormationView.mjs', []),
  "'../components/TeamScout'": stubUrl('TeamScout.mjs', []),
  "'../components/PostDraftPlan'": stubUrl('PostDraftPlan.mjs', []),
  "'../components/PlayerRow'": stubUrl('PlayerRow.mjs', ['Headshot'], false),
  "'../components/PageState'": stubUrl('PageState2.mjs', ['PageError', 'PageLoading'], false),
  // main's #180 gates the page on the real leagueGate (pure; compiled, not stubbed).
  "'../state/leagueGate'": compile('client/src/state/leagueGate.ts', 'leagueGate.mjs', {}),
  "'../components/MedianGameNotice'": noticeUrl,
  "'../lib/errorSanitize'": errorSanitizeUrl,
});
const { default: MyTeam } = await import(myTeamUrl);
// Registered here, after the last top-level await: node:test starts running the tests
// already registered above while this module is still awaiting these imports, so a
// test.after registered at the top raced them and removed `temp` before MyTeam.mjs
// was imported (CI: ERR_MODULE_NOT_FOUND on MyTeam.mjs, "asynchronous activity after
// the test ended"). Same fix as test/start-sit-ceiling-uncalibrated.test.js.
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const LEAGUE = { id: 7, platform: 'espn', name: 'L', my_team_id: '1' };
const sim = extra => ({ runs: 2000, weeks: 10, playoff_weeks: [[15], [16]], teams: [
  { roster_id: 1, owner: 'A', title_odds: 0.3, title_odds_95: [0.28, 0.32], playoff_odds: 0.6, expected_wins: 8 },
  { roster_id: 2, owner: 'B', title_odds: 0.2, title_odds_95: [0.18, 0.22], playoff_odds: 0.5, expected_wins: 7 }], ...extra });
const MIXED_REASON = 'median_game: records per decided week are 1, 2, neither 1 nor 2';

function page(which, simResponse) {
  globalThis.__league = { leagues: [LEAGUE], active: LEAGUE, activeId: LEAGUE.id, refetch() {} };
  globalThis.__apiByPrefix = {
    '/model/7/simulate': simResponse,
    '/leagues/7/data': { platform: 'espn', payload: { teams: [{ id: 1, name: 'T1' }, { id: 2, name: 'T2' }], schedule: [] } },
  };
  const el = React.createElement(MyTeam);
  const html = renderToStaticMarkup(el);
  return { html, text: text(html) };
}

for (const [which, anchor] of [['MyTeam', /Your title odds right now/]]) {
  test(`${which} page renders the notice (with the sim's reason) for median_game:null and not for true`, () => {
    const unknown = page(which, sim({ median_game: null, rules_unknown: [MIXED_REASON] }));
    assert.match(unknown.text, anchor, `control: the odds section itself did not render on ${which}: ${unknown.text.slice(0, 300)}`);
    assert.match(unknown.text, /median score is still unknown/i, `${which}: odds rendered but no median-game notice for median_game:null`);
    assert.match(unknown.text, /records per decided week are 1, 2/, `${which}: the notice does not carry the sim's rules_unknown reason`);
    assert.doesNotMatch(unknown.text, NO_WEEK_CAUSE);

    const known = page(which, sim({ median_game: true, rules_unknown: [] }));
    assert.match(known.text, anchor, `control: the odds section did not render on ${which} for median_game:true`);
    assert.doesNotMatch(known.text, /median score/i, `${which}: notice shown although the rule is known`);
  });
}
