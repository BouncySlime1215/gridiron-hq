/**
 * `syncEspnMarket` fetched anyway when the league had no ESPN cookie pair.
 *
 * `if (lg.espn_s2 && lg.swid) headers.Cookie = ...` set the header when it
 * could and otherwise sent the request bare. ESPN answers a bare request — with
 * a thin PUBLIC payload, not the league's — and the loop below wrote it into
 * `espn_player_market` under a `fetched_at` of now. The module's own docstring
 * promises `appliedTotal` "in the league's scoring", which an unauthenticated
 * read cannot deliver, and nothing downstream can tell the two apart: the draft
 * board would report "collected, minutes ago" over public ADP.
 *
 * This was harmless only because nothing on main calls `syncEspnMarket` at all.
 * PR #50 registers `refreshEspnMarket` on the growth tier at 12-hour intervals,
 * which makes it the deployed writer of that table for the first time — so this
 * fix must land before #50, not after.
 *
 * It now throws `EspnMarketCredentialsMissing`, naming the league, before the fetch.
 * A named refusal a caller can catch beats a silent substitution it cannot see.
 *
 * `fetch` is replaced with a recording stub rather than mocked at module level:
 * the assertion that matters is that NO request is made at all, and a stub that
 * counts calls states that directly.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-market-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db, rows, run } = await import('../server/db/index.js');
const { syncEspnMarket, espnMarketFreshness, EspnMarketCredentialsMissing } =
  await import('../server/services/espn-market.js');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

let calls = [];
beforeEach(() => { calls = []; });

function stubFetch(payload) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, cookie: opts?.headers?.Cookie ?? null });
    return { ok: true, status: 200, json: async () => payload };
  };
}

const PUBLIC_PAYLOAD = {
  players: [{ player: { id: 4242, ownership: { averageDraftPosition: 12.5, percentOwned: 99 },
    draftRanksByRankType: { PPR: { rank: 10 } }, stats: [] } }]
};

function league(id, { cookies = true } = {}) {
  run('DELETE FROM leagues WHERE id = ?', id);
  run(`INSERT INTO leagues (id, platform, league_id, season, name, espn_s2, swid)
       VALUES (?, 'espn', ?, 2026, ?, ?, ?)`,
    id, `espn-${id}`, `League ${id}`, cookies ? 's2-value' : null, cookies ? '{swid}' : null);
  return id;
}

test('a league with no cookie pair is refused, by name', async () => {
  stubFetch(PUBLIC_PAYLOAD);
  const id = league(8101, { cookies: false });
  await assert.rejects(() => syncEspnMarket(id), err => {
    assert.ok(err instanceof EspnMarketCredentialsMissing);
    assert.match(err.message, /league 8101/);
    assert.match(err.message, /no stored ESPN cookies/);
    return true;
  });
});

test('and no request is made at all', async () => {
  // The assertion the old code could not satisfy: not "the response was
  // ignored" but "nothing was asked".
  stubFetch(PUBLIC_PAYLOAD);
  await assert.rejects(() => syncEspnMarket(league(8102, { cookies: false })));
  assert.deepEqual(calls, [], 'an unauthenticated ESPN request must never leave the process');
});

test('and nothing is written, so the board still says never collected', async () => {
  stubFetch(PUBLIC_PAYLOAD);
  await assert.rejects(() => syncEspnMarket(league(8103, { cookies: false })));
  assert.equal(rows('SELECT * FROM espn_player_market').length, 0);
  const fresh = espnMarketFreshness();
  assert.equal(fresh.collected, false);
  assert.equal(fresh.as_of, null);
  assert.equal(fresh.label, 'ESPN market: never collected');
});

test('half a pair is not a pair', async () => {
  // s2 without swid, and swid without s2. ESPN treats either as anonymous, so
  // the guard has to as well — a partial pair is the likeliest real-world state
  // after a half-finished connect.
  stubFetch(PUBLIC_PAYLOAD);
  const half = id => {
    run('DELETE FROM leagues WHERE id = ?', id);
    run(`INSERT INTO leagues (id, platform, league_id, season, name, espn_s2, swid)
         VALUES (?, 'espn', ?, 2026, ?, ?, ?)`,
      id, `espn-${id}`, `League ${id}`, id === 8104 ? 's2-only' : null, id === 8104 ? null : '{swid-only}');
    return id;
  };
  await assert.rejects(() => syncEspnMarket(half(8104)), EspnMarketCredentialsMissing);
  await assert.rejects(() => syncEspnMarket(half(8105)), EspnMarketCredentialsMissing);
  assert.deepEqual(calls, []);
});

test('a league WITH cookies still syncs, and sends them', async () => {
  // The control. A refusal that also broke the working path would be a
  // regression dressed as a fix.
  stubFetch(PUBLIC_PAYLOAD);
  const id = league(8106, { cookies: true });
  const out = await syncEspnMarket(id);
  assert.equal(out.synced, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cookie, 'espn_s2=s2-value; SWID={swid}');
});

test('once a row exists the freshness reads the table, not a job log', async () => {
  stubFetch(PUBLIC_PAYLOAD);
  await syncEspnMarket(league(8107, { cookies: true }));
  const fresh = espnMarketFreshness();
  assert.equal(fresh.collected, true);
  assert.ok(fresh.as_of, 'as_of comes from the newest fetched_at actually in the table');
  assert.match(fresh.label, /^ESPN market: as collected for league /);
  // A job that ran and wrote nothing must not be able to make this say
  // "collected" — which is why it is a row count, not a log entry.
  run('DELETE FROM espn_player_market');
  assert.equal(espnMarketFreshness().collected, false);
});

test('the label names whose market it is, because the table can only hold one', async () => {
  // espn_player_market's primary key is espn_id alone, so league B's sync
  // overwrites league A's while the module promises a per-league read. Keying
  // the table per league is a migration and a product decision, not this
  // change. The interim is that the rows say which sync wrote them, so nobody
  // reads league A's ADP as league B's.
  stubFetch(PUBLIC_PAYLOAD);
  await syncEspnMarket(league(8108, { cookies: true }));
  const first = espnMarketFreshness();
  assert.equal(first.source.espn_league_id, 'espn-8108');
  assert.match(first.label, /as collected for league espn-8108/);

  await syncEspnMarket(league(8109, { cookies: true }));
  const second = espnMarketFreshness();
  assert.equal(second.source.espn_league_id, 'espn-8109',
    'the second sync overwrote the first, and the label has to admit it');
  assert.match(second.label, /as collected for league espn-8109/);
});

test('rows from before this record existed say so rather than guessing', async () => {
  // A third state. Rows written by an older build have no source record, and
  // labelling them with the most recent league would be a fabrication — the
  // one thing worse than not knowing.
  stubFetch(PUBLIC_PAYLOAD);
  await syncEspnMarket(league(8110, { cookies: true }));
  run(`DELETE FROM app_settings WHERE key = 'espn_player_market_source'`);
  const fresh = espnMarketFreshness();
  assert.equal(fresh.collected, true);
  assert.equal(fresh.source, null);
  assert.match(fresh.label, /is not recorded$/);
});
