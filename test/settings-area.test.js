/**
 * Settings area (docs/ui/CONSOLIDATION-MAP.md, area 6): one ESPN connect flow rendered by Settings,
 * the first-run prompt and League → Your leagues; credentials never shown (masked paste field, no
 * cookie inputs on League, nothing echoes a cookie value); Health in one view; AI & developer
 * inside Settings; no "Pull ESPN news" outside Players → News.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('one ESPN flow: the prompt, Settings and League → Your leagues all render EspnConnect', () => {
  assert.match(read('client/src/components/EspnConnectGate.tsx'), /<EspnConnect variant="bare" autoAddAll onDone=\{finished\} \/>/);
  assert.match(read('client/src/pages/Settings.tsx'), /<EspnConnect \/>/);
  assert.match(read('client/src/pages/Leagues.tsx'), /\{form\.platform === 'espn' && <div className="mt-4"><EspnConnect variant="bare" \/><\/div>\}/);
  const gate = read('client/src/components/EspnConnectGate.tsx');
  assert.doesNotMatch(gate, /espn-connect\/cookies|<textarea/, 'the prompt no longer carries its own paste flow');
});

test('credentials: masked paste, no cookie fields on League, no cookie value rendered', () => {
  const c = read('client/src/components/EspnConnect.tsx');
  assert.match(c, /<input type="password" autoComplete="off" spellCheck=\{false\} value=\{paste\}/, 'the pasted cookie string is a masked field');
  assert.doesNotMatch(c, /<textarea/, 'no plain-text box for cookies');
  assert.doesNotMatch(c, /\{paste\}<|>\{paste\}/, 'the pasted value is never rendered as text');
  const leagues = read('client/src/pages/Leagues.tsx');
  assert.doesNotMatch(leagues, /espn_s2|swid/i, 'League → Your leagues has no cookie fields or state');
  for (const p of ['client/src/components/EspnConnect.tsx', 'client/src/components/EspnConnectGate.tsx', 'client/src/pages/Settings.tsx']) {
    assert.doesNotMatch(read(p), /console\.(log|info|debug)\([^)]*(paste|s2|swid|cookie)/i, `${p} logs no credential`);
  }
});

test('disconnect asks before it removes the stored cookies', () => {
  const c = read('client/src/components/EspnConnect.tsx');
  assert.match(c, /onClick=\{\(\) => setConfirmDisconnect\(true\)\}/);
  assert.match(c, /aria-label="Confirm disconnect"/);
  const del = c.indexOf("'/espn-connect/cookies', { method: 'DELETE' }");
  assert.ok(del > c.indexOf('const disconnect = async'), 'DELETE only inside disconnect()');
  assert.match(c, /onClick=\{disconnect\}>Remove</, 'and disconnect() runs only from the confirm step');
});

test('Settings views; no Pull ESPN news; Health and AI & developer inside Settings', () => {
  const s = read('client/src/pages/Settings.tsx');
  assert.match(s, /\{ id: 'connections', label: 'Connections' \}, \{ id: 'health', label: 'Health' \}/);
  assert.doesNotMatch(s, /sync-news/, 'Settings no longer pulls news');
  assert.match(s, /<DataFreshnessDetail \/>/);
  assert.match(s, /<NumberHealthCard \/>/);
  assert.match(s, /<DevPanel \/>/);
  assert.match(read('client/src/components/DevHub.tsx'), /<Link to="\/settings\?view=dev"/, 'the header Dev button opens AI & developer');
  // The only news pull in the app is Players → News.
  const pulls = ['client/src/pages/Settings.tsx', 'client/src/pages/TeamDetail.tsx', 'client/src/pages/News.tsx']
    .filter(p => /sync-news/.test(read(p)));
  assert.deepEqual(pulls, ['client/src/pages/News.tsx']);
});
