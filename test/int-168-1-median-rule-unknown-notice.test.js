/**
 * INT-168-1 (from the CE-05 audit, #168): the season sim's own `median_game`
 * field (league-rules.js#inferMedian, served on `simulateSeason`'s return and
 * by `GET /model/:leagueId/simulate` — season-sim.js:439) is `null` when ESPN
 * publishes no median-game setting and no regular-season week has been decided
 * yet to infer it from: the standings rule is genuinely unknown, not merely
 * absent. `true`/`false` mean the sim knows the rule either way.
 *
 * Model.tsx's championship-odds panel and MyTeam.tsx's "your title odds"
 * card both render off that same `/model/:id/simulate` response
 * (Model.tsx:240, MyTeam.tsx:63) but neither said anything when the field
 * came back `null` before this change — a silent unknown next to a
 * confidently-rendered percentage.
 *
 * client/src/components/MedianGameNotice.tsx is the one producer of the
 * notice text, so this test renders it directly (TSX compiled with the
 * repo's own TypeScript, rendered with react-dom/server — same harness
 * shape as test/start-sit-gate-panel.test.js) and a second test greps both
 * consumer pages to confirm each one actually renders it off the sim's field,
 * not a page that merely imports it unused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const COMPONENT = 'client/src/components/MedianGameNotice.tsx';

/** Renders the component for real, no stubs needed: it takes one prop and reads no hook or API. */
async function loadNotice() {
  const source = read(COMPONENT);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  const file = path.join(root, 'test', '.int-168-1-median-notice.generated.mjs');
  fs.writeFileSync(file, outputText);
  try {
    return (await import(`${file}?t=${Date.now()}`)).default;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the notice renders only when median_game is null (unknown), not true, false, or undefined (still loading)', async () => {
  const MedianGameNotice = await loadNotice();
  assert.equal(typeof MedianGameNotice, 'function', `${COMPONENT} does not default-export a component`);

  const render = medianGame => renderToStaticMarkup(React.createElement(MedianGameNotice, { medianGame }));

  // The RED case: the sim reports the rule as unknown.
  const unknown = render(null);
  assert.notEqual(unknown, '', 'median_game === null (unknown) renders nothing; the notice should appear');
  assert.match(text(unknown), /unknown|not (yet )?known/i, `the "unknown" render does not say the rule is unknown: ${text(unknown)}`);

  // Known-nonzero-style controls: the same component, told the rule IS known
  // (either way), or not answered yet, must render nothing — otherwise the
  // "unknown" match above could just be a notice that always renders.
  for (const [label, value] of [['median_game === true', true], ['median_game === false', false], ['median_game === undefined (sim not loaded yet)', undefined]]) {
    assert.equal(render(value), '', `with ${label}, the notice should render nothing but rendered: ${render(value)}`);
  }
});

/**
 * Page-reachability check with a known-reachable control: greps Model.tsx and
 * MyTeam.tsx for a render of MedianGameNotice fed from the sim response's
 * median_game field, the same way it already reads that response's other
 * fields (title_odds, playoff_weeks) so this is not a different, unreachable
 * copy of the odds data.
 */
function assertWired(fileRel, simVar) {
  const src = read(fileRel);
  assert.match(src, /import MedianGameNotice from ['"]\.\.\/components\/MedianGameNotice['"]/,
    `${fileRel} does not import the shared MedianGameNotice component`);
  // Known-reachable control: the file does read the sim response's other
  // fields from the same variable, so a miss below is this file's own gap,
  // not a bad regex.
  assert.match(src, new RegExp(`${simVar}\\?\\.playoff_weeks`), `control: ${fileRel} does not even read ${simVar}?.playoff_weeks; this check needs rewriting`);
  assert.match(src, new RegExp(`<MedianGameNotice[^>]*medianGame=\\{${simVar}\\?\\.median_game\\}`),
    `${fileRel} does not render <MedianGameNotice medianGame={${simVar}?.median_game} />`);
}

test('Model.tsx renders the notice off the same simulate response it reads title_odds from', () => {
  assertWired('client/src/pages/Model.tsx', 'data');
});

test('MyTeam.tsx renders the notice off the same simulate response it reads title_odds from', () => {
  assertWired('client/src/pages/MyTeam.tsx', 'sim');
});
