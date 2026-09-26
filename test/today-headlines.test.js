/**
 * Today → "Your players' headlines" (polish backlog): the three freshest checked news items about
 * players on your rosters, one per player, linked to Players → News; nothing when the feed is not
 * scoped to your players or has nothing. One label map for Today and Players → News.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-headlines-'));
const file = path.join(dir, 'm.mjs');
fs.writeFileSync(file, ts.transpileModule(read('client/src/features/news/signalLabels.ts'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { freshestHeadlines, SIGNAL_LABEL, SIGNAL_CHIP } = await import(file);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const s = (player_name, status, published_at) => ({ player_name, status, published_at });

test('the freshest three, one per player', () => {
  const out = freshestHeadlines([s('A', 'out', '2026-09-20'), s('B', 'limited', '2026-09-24'), s('A', 'role_up', '2026-09-23'),
    s('C', 'questionable', '2026-09-22'), s('D', 'out', '2026-09-21')]);
  assert.deepEqual(out.map(x => `${x.player_name}:${x.status}`), ['B:limited', 'A:role_up', 'C:questionable']);
  assert.deepEqual(freshestHeadlines(undefined), []);
  assert.equal(freshestHeadlines([s('A', 'out', '2026-09-20')]).length, 1);
});

test('every status has a label and a chip tone', () => {
  assert.deepEqual(Object.keys(SIGNAL_CHIP).sort(), Object.keys(SIGNAL_LABEL).sort());
});

test('Today mounts the headlines after the week\'s actions, from the roster-scoped feed, linked to Players → News', () => {
  const today = read('client/src/pages/Today.tsx');
  assert.ok(today.indexOf('<CommandCenter />') < today.indexOf('<TodayHeadlines />'), 'after the Command Center: a late answer never pushes it down');
  const c = read('client/src/components/TodayHeadlines.tsx');
  assert.match(c, /useApi<[^>]*>\('\/news\/signals'\)/);
  assert.match(c, /if \(!data \|\| data\.scope !== 'my_roster'\) return null;/);
  assert.match(c, /freshestHeadlines\(data\.signals, 3\)/);
  assert.match(c, /to="\/players\?view=news"/);
  assert.match(c, /s\.story_headline && /, 'the story headline, with the checked quote under it');
  assert.match(read('server/routes/news.js'), /n\.headline AS story_headline/);
  assert.match(read('client/src/pages/News.tsx'), /import \{ SIGNAL_LABEL \} from '\.\.\/features\/news\/signalLabels';/, 'one label map');
});
