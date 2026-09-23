/**
 * The health check must not start judging the app before the app has booted
 * (2026-09-20).
 *
 * `grace_period` was 60s. This app's cold start was measured at 60 to 180
 * seconds on 2026-09-19, and a boot carrying pending migrations additionally
 * runs them and a `VACUUM INTO` of a ~445 MB database, all before
 * `app.listen`. So the check began before a normal boot had finished, and well
 * before a migration boot.
 *
 * What that costs is not a restart loop, which is the intuition the old
 * comment was written from. On Fly the health check and the restart policy are
 * independent: a failing check takes the machine out of the routing pool and
 * never restarts it — only a process exit does. This app runs one machine,
 * updated in place, so there is nothing else to route to. An evicted machine
 * is a 502 with an empty body for as long as the check keeps failing, while
 * the app is booting perfectly well.
 *
 * The assertions are on the config text, because fly.toml is not read by node:
 * nothing at runtime can observe what the deployment configured. The file is
 * the only place the answer exists. What a test CANNOT settle is whether 300s
 * is enough on the real machine — only a deploy shows that. It can settle that
 * the number honours the boot this app is measured to have, and that it is in
 * the table Fly actually reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fly = readFileSync(join(ROOT, 'fly.toml'), 'utf8');

/** The `[[services.http_checks]]` table body, and nothing around it. */
function httpCheckTable() {
  // Not `\Z`: JavaScript has no such anchor, it is a literal Z. This table is
  // the last one in the file, so the end of input has to be spelled out or the
  // match never terminates and the whole check silently reads nothing.
  const m = /^[ \t]*\[\[services\.http_checks\]\][ \t]*$([\s\S]*?)(?=^[ \t]*\[|(?![\s\S]))/m.exec(fly);
  return m ? m[1] : null;
}

const seconds = v => {
  const m = /^(\d+)(s|m)$/.exec(v);
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : null;
};

// The measured upper bound of a cold start on this app, 2026-09-19. Not a
// round number chosen for comfort: if this is ever re-measured lower, this
// constant moves and the assertion below moves with it.
const MEASURED_COLD_START_S = 180;

test('the health check grace period clears this app\'s measured cold start', () => {
  const body = httpCheckTable();
  assert.ok(body, 'fly.toml must declare [[services.http_checks]]');
  const declared = /^\s*grace_period\s*=\s*"([^"]+)"\s*$/m.exec(body);
  assert.ok(declared, 'the http check must set grace_period explicitly');
  const grace = seconds(declared[1]);
  assert.ok(grace !== null, `unparseable grace_period ${declared[1]}`);
  assert.ok(grace > MEASURED_COLD_START_S,
    `grace_period is ${grace}s against a cold start measured at up to `
    + `${MEASURED_COLD_START_S}s; a check that starts first evicts the machine `
    + 'from routing while it is booting perfectly well, and nothing restarts it');
});

test('grace_period is inside the http check table, not a stray key', () => {
  // TOML accepts a key in the wrong table and does nothing with it, which
  // would leave the assertion above reading a value Fly never sees.
  const body = httpCheckTable();
  assert.match(body, /^\s*grace_period\s*=/m);
  // And the other two values it sits beside, so a rewrite of this table that
  // drops one is caught here rather than on the deploy.
  assert.match(body, /^\s*interval\s*=\s*"15s"\s*$/m);
  assert.match(body, /^\s*timeout\s*=\s*"5s"\s*$/m);
});

test('the grace period is not so long that a real wedge goes unnoticed', () => {
  // The other direction. The check exists because the app wedged for three
  // hours; a grace period measured in tens of minutes would hand that back.
  const grace = seconds(/^\s*grace_period\s*=\s*"([^"]+)"\s*$/m.exec(httpCheckTable())[1]);
  assert.ok(grace <= 600, `grace_period ${grace}s is long enough to hide a real wedge`);
});

test('it is still an HTTP check, not a TCP one', () => {
  // The reason this check exists at all: a TCP check is satisfied by the
  // kernel accepting a connection onto the listen backlog, whether or not the
  // event loop is turning. Raising the grace period is only safe while the
  // check still executes JavaScript.
  assert.match(fly, /^\s*\[\[services\.http_checks\]\]/m);
  assert.doesNotMatch(fly, /^\s*\[\[services\.tcp_checks\]\]/m);
});
