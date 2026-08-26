import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../client/src/pages/LiveDraft.tsx', import.meta.url), 'utf8');
const syncHook = fs.readFileSync(new URL('../client/src/hooks/useLiveDraftSync.ts', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../server/services/espn-draft.js', import.meta.url), 'utf8');

test('live draft authentication failure is terminal for the polling episode', () => {
  assert.match(syncHook, /apiErr\?\.code === 'ESPN_AUTHENTICATION_FAILED'/);
  assert.match(syncHook, /authRequiredRef\.current = true;\s*setAuthRequired\(true\)/);
  assert.match(syncHook, /return; \/\/ do not reschedule/);
});

test('reconnect notice is singular and explicit retry resumes polling', () => {
  assert.equal(source.match(/ESPN reconnect required/g)?.length, 1);
  assert.match(syncHook, /const reconnect = useCallback\(\(\) => \{[\s\S]*authRequiredRef\.current = false;[\s\S]*void run\(\)/);
  assert.match(syncHook, /if \(!authRequiredRef\.current && !invalidDataRef\.current\) scheduleNext/);
  assert.match(source, /last mirrored draft state is preserved/);
  assert.match(source, /Retry connection/);
});

test('authentication failure does not clear mirrored draft state or picks', () => {
  const start = syncHook.indexOf("if (apiErr?.code === 'ESPN_AUTHENTICATION_FAILED'");
  const authBranch = syncHook.slice(start, syncHook.indexOf('return; // do not reschedule', start));
  assert.doesNotMatch(authBranch, /setBoard\(|setBoard\(null\)/);
});

test('resume reconciliation validates then replaces only the linked authoritative board', () => {
  assert.match(service, /normalizeAuthoritativeSnapshot\(data, draft\)/);
  assert.match(service, /BEGIN IMMEDIATE/);
  assert.match(service, /DELETE FROM draft_picks WHERE draft_id=\?/);
  assert.match(service, /espn_snapshot_hash/);
  assert.match(service, /picks_mirrored: count/);
});
