/**
 * NEGOTIATOR-DEFAULTS on the REAL campaign adapter (scripts/campaign/league-adapter.mjs), made-up league
 * (test/fixtures/producer-speed-league.mjs, no real data).
 *
 * With GRIDIRON_NEGOTIATOR_DEFAULTS=1 the post-loss "tilt window" is gone. A manager who lost last week
 * gets no receptiveness boost, so P(yes) MOVES for him (this is a served number, and the reason the
 * flag is off by default). His send window becomes a cool-off. A margin older than
 * MARGIN_MAX_AGE_DAYS starts no cool-off. Flag off: the adapter is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-negotiator-defaults-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { setupLeague } = await import('./fixtures/producer-speed-league.mjs');
const { db, buildAdapter, leagueId } = await setupLeague({ teams: 6, perTeam: 12, regularWeeks: 9, currentWeek: 5, playoffTeams: 4 });
const { MARGIN_MAX_AGE_DAYS } = await import('../scripts/campaign/league-adapter.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 9, 1, 12);
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
// Roster 2 lost last week by 25 (computed an hour ago); roster 3 by 25, but that row is a month old.
for (const [roster, at] of [['2', NOW - 3600e3], ['3', NOW - 30 * 864e5]]) {
  db.prepare(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
    VALUES (?, ?, 'last_week_margin', -25, 1, 'standings', ?)`).run(leagueId, roster, sqlTime(at));
}
const ON = { GRIDIRON_NEGOTIATOR_DEFAULTS: '1' };
const off = buildAdapter({ now: NOW, env: {} });
const on = buildAdapter({ now: NOW, env: ON });
const give = team => [...off.rosters.get(team)].slice(0, 1);
const get = team => [...off.rosters.get(team)].slice(0, 1);

test('control: the post-loss term is live with the flag off (roster 2 lost last week)', () => {
  assert.ok(MARGIN_MAX_AGE_DAYS >= 1);
  assert.notEqual(off.managers.get('2').send_when.cool_off, true);
});

test('flag on: a fresh loss becomes a cool-off; a month-old margin does not', () => {
  const s2 = on.managers.get('2').send_when;
  assert.equal(s2.when, 'wait');
  assert.equal(s2.cool_off, true);
  assert.equal(s2.until, new Date(NOW + 24 * 3600e3).toISOString());
  assert.notEqual(on.managers.get('3').send_when.cool_off, true);
});

test('flag on: P(yes) drops for the manager who lost (no post-loss boost); a manager with no margin row is untouched', () => {
  const r2 = { off: off.managers.get('2').receptiveness, on: on.managers.get('2').receptiveness };
  assert.ok(Number.isFinite(r2.off) && Number.isFinite(r2.on), JSON.stringify(r2));
  assert.ok(r2.on < r2.off, `receptiveness drops without the post-loss boost: ${JSON.stringify(r2)}`);
  const p = a => a.priceStep('2', get('2'), give('1')).p;
  assert.ok(p(on) <= p(off), 'P(yes) is not raised by the flag');
  // A manager with no margin row is untouched.
  assert.equal(on.managers.get('4').receptiveness, off.managers.get('4').receptiveness);
});
