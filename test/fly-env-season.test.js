/**
 * The deployment must declare which NFL season it is playing (2026-09-19).
 *
 * `[env]` in fly.toml held only HOST, so `NFL_SEASON` was unset in production.
 * That is invisible rather than broken, which is why it survived: 79 sites
 * read the variable as `Number(process.env.NFL_SEASON) || <fallback>`, and the
 * fallback is not the same everywhere. Some hard-code 2026; the rest call
 * `new Date().getFullYear()` or `getUTCFullYear()`. During the 2026 calendar
 * year both produce 2026, so nothing disagrees and nothing looks wrong.
 *
 * On 2027-01-01 they split. The calendar-year sites move to 2027 while the
 * hard-coded ones stay on 2026, in the middle of the 2026 playoffs, and the
 * app holds two different opinions about what season it is at once. Half the
 * app querying a season with no rows in it is the shape this project keeps
 * finding: healthy-looking and not working.
 *
 * The assertion is on the config text rather than on `process.env`, because
 * fly.toml is not read by node — nothing at runtime, in a test or in CI, can
 * observe whether the deployment sets it. The file is the only place the
 * answer exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fly = readFileSync(join(ROOT, 'fly.toml'), 'utf8');

test('fly.toml declares NFL_SEASON as a four-digit year', () => {
  const declared = /^\s*NFL_SEASON\s*=\s*"(\d{4})"\s*$/m.exec(fly);
  assert.ok(declared, 'fly.toml [env] must set NFL_SEASON; without it every '
    + 'calendar-year fallback in the app disagrees with every hard-coded one '
    + 'from January 1st onward');
  const season = Number(declared[1]);
  // A sanity band, not a freshness check. A test cannot know the current
  // season without becoming the very calendar-year assumption this pins down,
  // so it checks the value is a plausible NFL season and leaves the annual
  // bump to the comment in fly.toml next to the value.
  assert.ok(season >= 2026 && season <= 2100, `implausible NFL_SEASON ${season}`);
});

test('NFL_SEASON is declared inside [env], not in some other table', () => {
  // A key in the wrong table is accepted by TOML and does nothing, which would
  // pass the test above while leaving production exactly as it was.
  const env = /^\[env\]$([\s\S]*?)(?=^\[|\Z)/m.exec(fly);
  assert.ok(env, 'fly.toml must have an [env] table');
  assert.match(env[1], /^\s*NFL_SEASON\s*=/m);
});
