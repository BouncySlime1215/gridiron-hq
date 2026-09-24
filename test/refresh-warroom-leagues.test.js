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
 *  - mergeKept re-ranks attention across the merged file: every ok entry says
 *    "rank r of N" with N = all leagues and no two share a rank (review of #347:
 *    a league-4-only run wrote rank 1 of 1 next to kept rank 1 of 5). A kept
 *    entry's attention is the only field that can change.
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
const { parseLeagueList, mergeKept, storedExpected } = await import('../scripts/campaign/produce-plans.mjs');

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
// attention/next_move as buildPlansFile writes them; expected defaults to league/100, so ranks are 5,4,..,1 -> 1..5.
const att = (rank, of, reason) => ({ status: 'ok', value: { rank, of, reason }, source: 'campaign.plan' });
const entry = (league, extra = {}, expected = league / 100) => ({
  league, me: { team_id: league * 3, name: 'Team' }, error: null,
  attention: att(1, 1, 'placeholder'),
  destination: { status: 'ok', value: { p_title: 0.1 + 0.2, weeks: [1, 2, 3], by_team: { 10: 0.5, 2: 1e-7 } } },
  next_move: { status: 'ok', value: { move_id: `L${league}-x`, expected: { status: 'ok', value: expected, source: 'plan.path' } } },
  _run: { changed: { changed: false, next_key: `${league}|x` }, runtime_ms: 123456.789 }, ...extra,
});
const withoutAttention = e => JSON.stringify({ ...e, attention: null });

test('mergeKept: the ran league is new, every other league keeps its previous entry byte-for-byte, in league order', () => {
  // Kept entries carry the attention a full run over leagues 1, 2, 4, 5 would give them (2 failed -> of 4).
  const before = JSON.stringify({ schema: 'warroom-plans/1', generated_at: 'old', leagues: [
    entry(1, { attention: att(3, 4, 'best move worth 1.0 pts') }), entry(2, { error: 'world failed: x' }),
    entry(4, { attention: att(2, 4, 'best move worth 4.0 pts') }), entry(5, { attention: att(1, 4, 'best move worth 5.0 pts') })] });
  const parsed = JSON.parse(before);                                   // what readPrevious holds
  const previous = new Map(parsed.leagues.map(e => [String(e.league), e]));
  const fresh = { schema: 'warroom-plans/1', generated_at: 'new', leagues: [entry(4, { fresh: true, attention: att(1, 1, 'best move worth 4.0 pts') })] };
  const merged = mergeKept(fresh, previous, { order: [1, 2, 3, 4, 5], ran: [4] });

  assert.equal(merged.generated_at, 'new');
  assert.deepEqual(merged.leagues.map(e => e.league), [1, 2, 4, 5], 'league 3 has no previous entry: nothing invented');
  assert.equal(merged.leagues[2].fresh, true);
  assert.deepEqual(merged.leagues[2].attention, att(2, 4, 'best move worth 4.0 pts'), 'the ran league is ranked across the merged file');
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

test('mergeKept re-ranks attention across the merged file: no "rank 1 of 1" next to "rank 1 of 5" (review of #347)', () => {
  // Previous full run: league 5 best (rank 1) ... league 1 worst (rank 5).
  const prevEntries = [1, 2, 3, 4, 5].map(l => entry(l, { attention: att(6 - l, 5, `best move worth ${l}.0 pts`) }));
  const previous = new Map(JSON.parse(JSON.stringify(prevEntries)).map(e => [String(e.league), e]));
  // League-4-only run: its own buildPlansFile ranked it alone (rank 1 of 1), and its best move is now the biggest.
  const fresh = { leagues: [entry(4, { attention: att(1, 1, 'best move worth 9.0 pts') }, 0.09)] };
  const merged = mergeKept(fresh, previous, { order: [1, 2, 3, 4, 5], ran: [4] });

  const ranks = merged.leagues.map(e => [e.league, e.attention.value.rank, e.attention.value.of]);
  assert.deepEqual(ranks, [[1, 5, 5], [2, 4, 5], [3, 3, 5], [4, 1, 5], [5, 2, 5]]);
  assert.equal(new Set(ranks.map(r => r[1])).size, 5, 'no two leagues share a rank');
  assert.equal(merged.leagues[3].attention.value.reason, 'best move worth 9.0 pts');
  // Kept entries: only attention may change; one whose rank did not move is the same bytes.
  for (const l of [1, 2, 3, 5]) {
    const was = prevEntries[l - 1], now = merged.leagues[l - 1];
    assert.equal(withoutAttention(now), withoutAttention(was), `league ${l}: nothing but attention changed`);
  }
  for (const l of [1, 2, 3]) assert.equal(JSON.stringify(merged.leagues[l - 1]), JSON.stringify(prevEntries[l - 1]), `league ${l} rank unchanged: byte-identical`);
  assert.deepEqual(Object.keys(merged.leagues[4]), Object.keys(prevEntries[4]), 'key order kept when attention is rewritten');

  // A failed kept entry is not ranked and keeps its bytes; it still counts in "of".
  const withFail = new Map(previous); withFail.set('2', entry(2, { error: 'world failed: x', attention: undefined }));
  const m2 = mergeKept(fresh, withFail, { order: [1, 2, 3, 4, 5], ran: [4] });
  assert.equal(JSON.stringify(m2.leagues[1]), JSON.stringify(withFail.get('2')));
  assert.deepEqual(m2.leagues.filter(e => !e.error).map(e => e.attention.value.rank).sort(), [1, 2, 3, 4]);
  assert.ok(m2.leagues.filter(e => !e.error).every(e => e.attention.value.of === 5));
});

test('storedExpected reads next_move.value.expected; 0 when there is no ok move', () => {
  assert.equal(storedExpected(entry(3, {}, 0.042)), 0.042);
  assert.equal(storedExpected({ next_move: { status: 'unknown', reason: 'none' } }), 0);
  assert.equal(storedExpected({ next_move: { status: 'ok', value: { expected: { status: 'unknown' } } } }), 0);
  assert.equal(storedExpected({}), 0);
});
