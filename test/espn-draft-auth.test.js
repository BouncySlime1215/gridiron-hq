import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../client/src/pages/LiveDraft.tsx', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../server/services/espn-draft.js', import.meta.url), 'utf8');

test('live draft authentication failure is terminal for the polling episode', () => {
  assert.match(source, /e\.message === 'ESPN authentication failed'/);
  assert.match(source, /setAuthRequired\(true\);\s*setLive\(false\)/);
  assert.match(source, /if \(!live\) return;\s*const iv = setInterval\(tick, 4000\)/);
});

test('reconnect notice is singular and explicit retry resumes polling', () => {
  assert.equal(source.match(/ESPN reconnect required/g)?.length, 1);
  assert.match(source, /const retryConnection = \(\) => \{[\s\S]*setLive\(true\);[\s\S]*void tick\(\)/);
  assert.match(source, /last mirrored draft state is preserved/);
  assert.match(source, /Retry connection/);
});

test('authentication failure does not clear mirrored draft state or picks', () => {
  const authBranch = source.slice(source.indexOf("if (e.message === 'ESPN authentication failed')"), source.indexOf('} finally {', source.indexOf("if (e.message === 'ESPN authentication failed')")));
  assert.doesNotMatch(authBranch, /setState\(|setState\(null\)|setSnipes\(\[\]\)/);
});

test('resume reconciliation validates then replaces only the linked authoritative board', () => {
  assert.match(service, /normalizeAuthoritativeSnapshot\(data, draft\)/);
  assert.match(service, /BEGIN IMMEDIATE/);
  assert.match(service, /DELETE FROM draft_picks WHERE draft_id=\?/);
  assert.match(service, /espn_snapshot_hash/);
  assert.match(service, /picks_mirrored: count/);
});
