/**
 * Players area (docs/ui/CONSOLIDATION-MAP.md, area 4): one news list, one pull action, the Board's
 * VOR column and phone row, no headshot request for a team defence, and the Edge cut.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('one news list: News, team pages and player pages all render NewsList', () => {
  for (const p of ['client/src/pages/News.tsx', 'client/src/pages/TeamDetail.tsx', 'client/src/pages/PlayerDetail.tsx']) {
    const src = read(p);
    assert.match(src, /import NewsList from '\.\.\/components\/NewsList';/, `${p} imports NewsList`);
    assert.match(src, /<NewsList /, `${p} renders it`);
    assert.doesNotMatch(src, /\/news\/\$\{[^}]+\}\/explain/, `${p} has no explain call of its own`);
  }
});

test('one pull action: only Players → News pulls ESPN news; a team page links there filtered', () => {
  assert.match(read('client/src/pages/News.tsx'), /api\(`\/espn\/sync-news/);
  const team = read('client/src/pages/TeamDetail.tsx');
  assert.doesNotMatch(team, /sync-news/, 'the team page no longer pulls news itself');
  assert.match(team, /to=\{`\/players\?view=news&team=\$\{team\.abbr\}`\}/);
  assert.match(read('client/src/pages/News.tsx'), /const linkedTeam = params\.get\('team'\) \?\? '';/, 'News opens filtered to the linked team');
});

test('Board: VOR from /edge/vor, and a phone row keeps the name and the value', () => {
  const b = read('client/src/pages/Projections.tsx');
  assert.match(b, /useApi<any\[\]>\('\/edge\/vor'\)/);
  assert.equal((b.match(/hidden w-(?:12|14) (?:shrink-0 )?text-right[^"]*sm:block/g) ?? []).length, 6, 'trend, ADP and VOR (header + cells) hide below sm');
  assert.match(b, /\bphonePos\b/);
});

test('a team defence (negative ESPN id) gets no ESPN headshot URL', async () => {
  const { outputText } = ts.transpileModule(read('client/src/api.ts').match(/export function headshotUrl[\s\S]*?\n\}/)[0],
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const { headshotUrl } = await import(`data:text/javascript,${encodeURIComponent(outputText)}`);
  assert.equal(headshotUrl({ espn_id: -16007 }), null);
  assert.match(headshotUrl({ espn_id: 3139477 }), /players\/full\/3139477\.png$/, 'known-nonzero control');
});

test('Edge.tsx is gone and nothing imports it', () => {
  assert.ok(!fs.existsSync(new URL('../client/src/pages/Edge.tsx', import.meta.url)));
});
