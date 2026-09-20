/**
 * The ESPN transaction collector, as a scheduled job (2026-09-20).
 *
 * The bug being closed is not that the numbers were stale. It is that on the
 * deployed app they were never collected. `league_transactions_raw` had one
 * writer in the whole tree — a script reachable only from
 * `scripts/refresh-live-data.mjs`, which runs on Nick's machine — while six
 * server modules read it. And ESPN's `mTransactions2` view answers with about
 * three days, so a proposal missed inside that window is gone from the source
 * for good. There is no catching up later.
 *
 * So these tests are about the ways moving it could be written and still be
 * useless: a job that quietly asks with somebody else's cookies, a job that
 * drops an unconnected league without saying so, a job that competes with a
 * live draft for Nick's ESPN session, and a wrapper script whose summary line
 * no longer means what the refresh loop parses it to mean.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-tx-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { collectLeagueTransactions, leagueOwnCredentials } =
  await import('../server/services/league-transactions.js');
const { JOBS, resolveOffThread } = await import('../server/services/scheduler.js');

const SERVICE = fs.readFileSync(
  new URL('../server/services/league-transactions.js', import.meta.url), 'utf8');
const SCRIPT = fs.readFileSync(
  new URL('../scripts/collect-league-transactions.mjs', import.meta.url), 'utf8');

/**
 * The file with its comments removed.
 *
 * The "no schema here" assertions below are about what the module DOES, and
 * both files talk about `CREATE TABLE` and `SCHEDULER_DISABLED` in prose
 * explaining why they do not do them. Matching raw text would fail on the
 * explanation and pass on a file that deleted the explanation and kept the
 * statement, which is precisely backwards.
 */
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const SERVICE_CODE = codeOnly(SERVICE);
const SCRIPT_CODE = codeOnly(SCRIPT);

/** A league row, with or without its own ESPN pair. */
function addLeague({ leagueId, season = 2026, s2 = null, swid = null, name = 'L' }) {
  db.prepare(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
              VALUES ('espn', ?, ?, ?, ?, ?)`).run(leagueId, season, name, s2, swid);
  return db.prepare(`SELECT id FROM leagues WHERE league_id = ? AND season = ?`)
    .get(leagueId, season).id;
}

function resetLeagues() {
  db.exec('DELETE FROM leagues');
  db.exec('DELETE FROM league_transactions_raw');
}

/** An ESPN answer carrying one transaction. */
const espnAnswer = (tx = {}) => ({
  ok: true,
  json: async () => ({ transactions: [{ id: 'tx1', type: 'TRADE_PROPOSAL', status: 'PENDING',
    proposedDate: 1_758_000_000_000, teamId: 1, isPending: true, items: [], ...tx }] }),
});

test('the job is registered, metered, off the request thread, with a cadence', () => {
  const job = JOBS.league_transactions;
  assert.ok(job, 'league_transactions must exist in JOBS — a body nothing calls is what '
    + 'this whole change is about');
  assert.equal(job.tier, 'metered');
  assert.ok(Number.isFinite(job.maxAgeMinutes) && job.maxAgeMinutes > 0,
    'it needs a staleness threshold, or runIfStale has nothing to decide on');
  assert.equal(resolveOffThread(job), true,
    'the body is a fetch followed by a synchronous BEGIN/upsert/COMMIT over the whole '
    + 'window — exactly the shape that holds the request thread');
  // Three days of window against a 30-minute cadence. If this ever creeps up
  // past the window itself, the job stops being a collector and becomes a
  // sampler that loses rows between runs.
  assert.ok(job.maxAgeMinutes < 3 * 24 * 60,
    'the cadence must stay well inside ESPN\'s ~3 day window');
});

test('a league with no stored credential is reported, not silently dropped', async () => {
  resetLeagues();
  const connected = addLeague({ leagueId: '111', s2: 'a', swid: 'b', name: 'connected' });
  const bare = addLeague({ leagueId: '222', name: 'never connected' });

  const asked = [];
  const detail = await collectLeagueTransactions({
    fetchImpl: async url => { asked.push(url); return espnAnswer(); },
    nowIso: '2026-09-20T06:00:00.000Z',
  });

  // The old query was `WHERE espn_s2 IS NOT NULL AND swid IS NOT NULL`, so an
  // unconnected league was not skipped — it was never in the list at all, and
  // a result of "2 leagues, 2 collected" was indistinguishable from a result
  // that had quietly left one out.
  assert.equal(detail.leagues, 2, 'both leagues must be counted');
  assert.equal(detail.collected, 1);
  assert.equal(detail.skipped, 1);
  assert.equal(detail.failed, 0, 'an unconnected league is not a failure of this job');
  const reason = detail.reasons.find(r => r.league_id === bare);
  assert.ok(reason, 'the unconnected league must appear in reasons by id');
  assert.match(reason.reason, /no credential for this league/);
  assert.equal(asked.length, 1, 'and no request may be made on its behalf');
  assert.ok(asked[0].includes('/leagues/111'), 'the one request is the connected league\'s');
  void connected;
});

test('each request carries that league\'s own cookies and never another\'s', async () => {
  resetLeagues();
  addLeague({ leagueId: '111', s2: 's2-one', swid: 'swid-one' });
  addLeague({ leagueId: '222', s2: 's2-two', swid: 'swid-two' });

  const sent = [];
  await collectLeagueTransactions({
    fetchImpl: async (url, opts) => { sent.push({ url, cookie: opts.headers.Cookie }); return espnAnswer(); },
    nowIso: '2026-09-20T06:00:00.000Z',
  });

  assert.equal(sent.length, 2);
  // The 2026-09-19 bug this must never reintroduce: one global cookie lookup,
  // so whichever league was fetched last made every other league's requests.
  const one = sent.find(s => s.url.includes('/leagues/111'));
  const two = sent.find(s => s.url.includes('/leagues/222'));
  assert.equal(one.cookie, 'espn_s2=s2-one; SWID={swid-one}'.replace('{swid-one}', 'swid-one'),
    'league 111 must be asked with league 111\'s pair');
  assert.equal(two.cookie, 'espn_s2=s2-two; SWID=swid-two',
    'league 222 must be asked with league 222\'s pair');
  assert.notEqual(one.cookie, two.cookie, 'and the two must not be the same pair');
});

test('the credential resolver is a seam with the same shape as the real one', () => {
  // PR #48's server/platform/espn-credentials.js is not on this branch, so the
  // default below is rule 1 of that resolver and nothing else. The contract is
  // pinned here so swapping it in later is a one-line change: `{ s2, swid,
  // source }`, nulls for "none", never a throw and never a fallback.
  assert.deepEqual(leagueOwnCredentials({ espn_s2: 'x', swid: 'y' }),
    { s2: 'x', swid: 'y', source: 'league' });
  assert.deepEqual(leagueOwnCredentials({ espn_s2: null, swid: 'y' }),
    { s2: null, swid: null, source: null });
  assert.deepEqual(leagueOwnCredentials({}), { s2: null, swid: null, source: null });
  assert.match(SERVICE, /espn-credentials\.js/,
    'and the file must say where the real resolver lives, or the seam is just a shortcut');
});

test('a live ESPN draft stops every request this job would make', async () => {
  resetLeagues();
  const lg = addLeague({ leagueId: '111', s2: 'a', swid: 'b' });

  let asked = 0;
  const detail = await collectLeagueTransactions({
    skipEspn: true,
    fetchImpl: async () => { asked++; return espnAnswer(); },
    nowIso: '2026-09-20T06:00:00.000Z',
  });

  // 2026-09-06: the hourly league sweep hit ESPN with the same espn_s2/SWID
  // Nick's browser was drafting on, and ESPN kicked his session. Against a
  // three-day window, waiting out a draft costs nothing.
  assert.equal(asked, 0, 'not one request may go out while a draft is live');
  assert.equal(detail.skipped, 1);
  assert.equal(detail.failed, 0, 'a deliberate wait is not a failure');
  assert.match(detail.reasons.find(r => r.league_id === lg).reason, /draft is live/);
});

test('a second run updates the row in place and keeps when it was first seen', async () => {
  resetLeagues();
  addLeague({ leagueId: '111', s2: 'a', swid: 'b' });

  const first = await collectLeagueTransactions({
    fetchImpl: async () => espnAnswer({ status: 'PENDING' }),
    nowIso: '2026-09-20T06:00:00.000Z',
  });
  assert.equal(first.new, 1);

  const second = await collectLeagueTransactions({
    fetchImpl: async () => espnAnswer({ status: 'ACCEPTED', processDate: 1_758_100_000_000 }),
    nowIso: '2026-09-20T07:00:00.000Z',
  });
  assert.equal(second.new, 0, 'the same transaction id must not be stored twice');

  const stored = rows('SELECT * FROM league_transactions_raw');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'ACCEPTED', 'a decision must overwrite the proposal\'s status');
  // first_seen_at is the only record of when this install first observed the
  // transaction, and ESPN cannot answer for it again once the window closes.
  assert.equal(stored[0].first_seen_at, '2026-09-20T06:00:00.000Z',
    'first_seen_at must survive the update');
  assert.equal(stored[0].last_seen_at, '2026-09-20T07:00:00.000Z',
    'last_seen_at must move, or nothing can tell a refreshed row from an abandoned one');
});

test('one league failing does not stop the others, and is counted as a failure', async () => {
  resetLeagues();
  const bad = addLeague({ leagueId: '111', s2: 'a', swid: 'b' });
  addLeague({ leagueId: '222', s2: 'c', swid: 'd' });

  const detail = await collectLeagueTransactions({
    fetchImpl: async url => (url.includes('/leagues/111')
      ? { ok: false, status: 401, json: async () => ({}) }
      : espnAnswer()),
    nowIso: '2026-09-20T06:00:00.000Z',
  });

  assert.equal(detail.failed, 1);
  assert.equal(detail.collected, 1, 'the healthy league must still be collected');
  assert.equal(detail.skipped, 0, 'a refusal is a failure, not a skip — only one of the two '
    + 'should back the job off');
  assert.match(detail.reasons.find(r => r.league_id === bad).reason, /401/,
    'and the reason must carry what ESPN actually said');
});

test('the service creates no schema and sets no environment', () => {
  // db/index.js's rule, proved by scripts/schema-snapshot.mjs: a service may
  // not create tables, or the baseline and full snapshots stop matching.
  assert.doesNotMatch(SERVICE_CODE, /CREATE TABLE/i,
    'the table is migration 066\'s; a service that creates it breaks the schema snapshot');
  assert.doesNotMatch(SERVICE_CODE, /CREATE INDEX/i);
  // The script sets SCHEDULER_DISABLED because it is a CLI. The service runs
  // inside a server whose whole job is to be scheduling things.
  assert.doesNotMatch(SERVICE_CODE, /SCHEDULER_DISABLED/,
    'that line belongs to the script and must not travel into the registry job');
  assert.match(SCRIPT_CODE, /SCHEDULER_DISABLED/, 'and must stay in the script');
  // The migration is where it went, so the claim is checked rather than assumed.
  const migration = fs.readFileSync(
    new URL('../server/migrations/066_league_transactions_raw.js', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS league_transactions_raw/);
});

test('the script is a wrapper over the same body, and keeps the line the refresh loop parses', () => {
  // scripts/refresh-live-data.mjs's transactionsCapture reads /failed (\d+)/
  // off the LAST output line to decide ok vs ERROR. Reshaping this line turns
  // every failed collection into a reported success there.
  assert.match(SCRIPT, /transactions: seen \$\{detail\.seen\}, new \$\{detail\.new\}, failed \$\{detail\.failed\}/,
    'the summary line must keep the shape refresh-live-data.mjs parses');
  assert.match(SCRIPT_CODE, /collectLeagueTransactions/,
    'the script must call the service, not carry its own copy of the body');
  assert.doesNotMatch(SCRIPT_CODE, /INSERT INTO league_transactions_raw/,
    'a second copy of the upsert is how the two paths would drift apart');
  assert.match(SCRIPT_CODE, /recordSync\(\s*'league_transactions'/,
    'a hand-run must count as the job having run, like build-manager-signals.mjs does');
});
