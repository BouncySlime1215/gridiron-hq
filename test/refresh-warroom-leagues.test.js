/**
 * REFRESH-L4: GRIDIRON_WARROOM_LEAGUES limits the refresh loop's War Room producer
 * (scripts/refresh-live-data.mjs step 7 -> scripts/campaign/produce-plans.mjs --leagues)
 * to the listed leagues, and a subset run keeps every other league's previous entry
 * byte-identical in the plans file.
 *
 * Guarantees:
 *  - unset / empty / 'all': the launch args are exactly the old ones (behaviour unchanged).
 *  - '4' or ' 1, 4 ': the producer gets --leagues with the list.
 *  - parseLeagueList (the one parser): ids only; anything else reads as every league.
 *  - mergeKept: the ran leagues come from the new file, the rest are the previous
 *    entries serialised to the same bytes, in league order; nothing kept -> the file itself.
 * No child process is started: the launcher is a fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-wr-leagues-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const LOOP = await import('../scripts/refresh-live-data.mjs');
const { parseLeagueList, mergeKept } = await import('../scripts/campaign/produce-plans.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const quiet = () => {};
const on = () => ({ enabled: true, preview: false });
const BASE = ['--env-file-if-exists=.env', 'scripts/campaign/produce-plans.mjs'];

function launchWith(value) {
  const dir = fs.mkdtempSync(path.join(temp, 'wr-'));
  const files = { plans: path.join(dir, 'plans.json'), lock: path.join(dir, 'plans.json.lock'), log: path.join(dir, 'producer.log') };
  const env = { ...process.env };
  delete env.GRIDIRON_WARROOM_LEAGUES;
  if (value !== undefined) env.GRIDIRON_WARROOM_LEAGUES = value;
  const launched = [];
  const lines = [];
  LOOP.warRoomPlans({ launch: (cmd, args, opts) => { launched.push({ cmd, args, opts }); return 7; },
    log: l => lines.push(l), record: quiet, env, files, flag: on });
  assert.equal(launched.length, 1);
  return { args: launched[0].args, env: launched[0].opts.env, line: lines.at(-1) };
}

test('unset, empty or "all": the producer is launched with the old args (every league)', () => {
  for (const v of [undefined, '', '  ', 'all', 'ALL']) {
    const { args, line } = launchWith(v);
    assert.deepEqual(args, BASE, `value ${JSON.stringify(v)}`);
    assert.doesNotMatch(line, /leagues/);
  }
});

test('GRIDIRON_WARROOM_LEAGUES=4 launches the producer with --leagues 4 and says so', () => {
  const { args, env, line } = launchWith('4');
  assert.deepEqual(args, [...BASE, '--leagues', '4']);
  assert.equal(env.GRIDIRON_WARROOM_LEAGUES, '4');
  assert.match(line, /launched \(pid 7, leagues 4\)/);
  assert.deepEqual(launchWith(' 1, 4 ').args, [...BASE, '--leagues', '1,4']);
});

test('warRoomLeagues reads only its own variable', () => {
  assert.equal(LOOP.WARROOM_LEAGUES_ENV, 'GRIDIRON_WARROOM_LEAGUES');
  assert.equal(LOOP.warRoomLeagues({}), null);
  assert.equal(LOOP.warRoomLeagues({ GRIDIRON_WARROOM_LEAGUES: '4' }), '4');
});

test('parseLeagueList: a comma list of ids, else every league (null)', () => {
  assert.deepEqual(parseLeagueList('4'), [4]);
  assert.deepEqual(parseLeagueList(' 1, 4 ,4'), [1, 4]);
  for (const bad of [undefined, null, '', 'all', 'four', '4,', ',4', '4;5', '-4', '4.5']) {
    assert.equal(parseLeagueList(bad), null, `value ${JSON.stringify(bad)}`);
  }
});

// A plans file shaped like the real one: nested objects, floats, numeric-looking keys.
const entry = (league, extra = {}) => ({
  league, me: { team_id: league * 3, name: 'Team' }, error: null,
  destination: { status: 'ok', value: { p_title: 0.1 + 0.2, weeks: [1, 2, 3], by_team: { 10: 0.5, 2: 1e-7 } } },
  _run: { changed: { changed: false, next_key: `${league}|x` }, runtime_ms: 123456.789 }, ...extra,
});

test('mergeKept: the ran league is new, every other league keeps its previous entry byte-for-byte, in league order', () => {
  const before = JSON.stringify({ schema: 'warroom-plans/1', generated_at: 'old', leagues: [entry(1), entry(2, { error: 'world failed: x' }), entry(4), entry(5)] });
  const parsed = JSON.parse(before);                                   // what readPrevious holds
  const previous = new Map(parsed.leagues.map(e => [String(e.league), e]));
  const fresh = { schema: 'warroom-plans/1', generated_at: 'new', leagues: [entry(4, { fresh: true })] };
  const merged = mergeKept(fresh, previous, { order: [1, 2, 3, 4, 5], ran: [4] });

  assert.equal(merged.generated_at, 'new');
  assert.deepEqual(merged.leagues.map(e => e.league), [1, 2, 4, 5], 'league 3 has no previous entry: nothing invented');
  assert.equal(merged.leagues[2].fresh, true);
  const text = JSON.stringify(merged);
  const old = JSON.parse(before).leagues;
  for (const i of [0, 1, 3]) {
    const bytes = JSON.stringify(old[i]);
    assert.ok(text.includes(bytes), `league ${old[i].league} kept byte-identical`);
    assert.equal(JSON.stringify(merged.leagues.find(e => e.league === old[i].league)), bytes);
  }
  assert.equal(merged.leagues[1].error, 'world failed: x', 'a failed entry for another league is kept as it was');
});

test('mergeKept: no previous entry to keep -> the new file itself; a league no longer in the DB is not carried', () => {
  const fresh = { leagues: [entry(4)] };
  assert.equal(mergeKept(fresh, new Map(), { order: [1, 4], ran: [4] }), fresh);
  const previous = new Map([['9', entry(9)], ['4', entry(4, { old: true })]]);
  assert.equal(mergeKept(fresh, previous, { order: [4], ran: [4] }), fresh, 'league 9 is gone from leagues: dropped as before');
  const failedRun = { leagues: [entry(4, { error: 'boom' })] };
  const m = mergeKept(failedRun, new Map([['1', entry(1)], ['4', entry(4, { old: true })]]), { order: [1, 4], ran: [4] });
  assert.equal(m.leagues[1].error, 'boom', 'the ran league takes this run\'s result, even a failure');
  assert.equal(m.leagues[1].old, undefined);
});
