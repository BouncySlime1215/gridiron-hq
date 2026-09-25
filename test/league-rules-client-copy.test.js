/**
 * CE-05 — the pages that render /api/model/:id/simulate describe the bracket the
 * sim actually played. Before, Model.tsx and MyTeam.tsx both said "weeks 15–17"
 * while two of the five synced leagues play [[15,16],[17,18]] and [[14,15],[16,17]].
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { playoffWeeksText } = await import('../client/src/copy-constants.ts');

test('CE-05: playoffWeeksText describes one-week rounds', () => {
  assert.equal(playoffWeeksText([[15], [16], [17]]), 'NFL weeks 15–17');
});

test('CE-05: playoffWeeksText describes two-week rounds and a 13-week season', () => {
  assert.equal(playoffWeeksText([[15, 16], [17, 18]]), 'NFL weeks 15–18, two weeks per round');
  assert.equal(playoffWeeksText([[14, 15], [16, 17]]), 'NFL weeks 14–17, two weeks per round');
});

test('CE-05: playoffWeeksText says nothing rather than guess when the weeks are absent', () => {
  assert.equal(playoffWeeksText(undefined), null);
  assert.equal(playoffWeeksText([]), null);
});

for (const page of ['client/src/pages/MyTeam.tsx']) { // Model.tsx was retired (batch D 8c)
  test(`CE-05: ${page} renders the sim's playoff_weeks, not hard-coded weeks`, () => {
    const src = fs.readFileSync(page, 'utf8');
    assert.doesNotMatch(src, /15[–-]17/, 'no hard-coded "weeks 15–17"');
    assert.match(src, /playoffWeeksText\([^)]*playoff_weeks\)/, 'formats the payload field');
  });
}
