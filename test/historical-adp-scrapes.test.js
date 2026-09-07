import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-adp-scrapes-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const {
  syncHistoricalAdpScrapes, adpScrapesFor, adpScrapeCoverage
} = await import('../server/services/historical-adp-scrapes.js');
const { syncHistoricalAdp, historicalAdpFor } = await import('../server/services/historical-adp.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const HEADER = 'page_type,player,pos,tm,ecr,sd,mergename,ecr_type,scrape_date';
// Same shape as historical-adp.test.js's fixture, with the one thing that file
// deliberately throws away: a player observed on FOUR separate scrape dates.
// This table exists only to keep that movement, so the fixture has to contain
// movement worth keeping.
const ROWS = [
  'redraft-overall,Christian McCaffrey,RB,SF,1,0,christian mccaffrey,ro,2021-07-09',
  'redraft-overall,Christian McCaffrey,RB,SF,1.2,0.1,christian mccaffrey,ro,2021-08-06',
  'redraft-overall,Christian McCaffrey,RB,SF,1.4,0.2,christian mccaffrey,ro,2021-08-20',
  'redraft-overall,Christian McCaffrey,RB,SF,1.5,0.2,christian mccaffrey,ro,2021-09-03',
  'redraft-overall,Christian McCaffrey,RB,SF,99,0,christian mccaffrey,bo,2021-08-20',  // wrong ecr_type
  'redraft-overall,Christian McCaffrey,RB,SF,50,0,christian mccaffrey,ro,2021-09-12',  // after kickoff
  'redraft-idp,Roquan Smith,LB,BAL,1.9,0.6,roquan smith,ro,2021-08-20',                // IDP under ecr_type='ro'
  'redraft-overall,Justin Jefferson,WR,MIN,2,0.3,justin jefferson,ro,2022-08-15',
  'redraft-overall,Justin Jefferson,WR,MIN,3,0.4,justin jefferson,ro,2022-08-22',
];

function stubFetch() {
  const csv = [HEADER, ...ROWS].join('\n') + '\n';
  globalThis.fetch = async () => ({ ok: true, body: Readable.toWeb(Readable.from(gzipSync(Buffer.from(csv, 'utf8')))) });
}

test('retains every preseason scrape date per player-season, not just the newest', async () => {
  stubFetch();
  const result = await syncHistoricalAdpScrapes([2021, 2022]);
  assert.equal(result.stored, 6, '4 McCaffrey scrapes + 2 Jefferson scrapes');

  const cmc = adpScrapesFor(2021).filter(r => r.name === 'Christian McCaffrey');
  assert.equal(cmc.length, 4, 'all four scrape dates must survive ingestion');
  assert.deepEqual(cmc.map(r => r.scrape_date),
    ['2021-07-09', '2021-08-06', '2021-08-20', '2021-09-03'], 'returned oldest-first');
  assert.deepEqual(cmc.map(r => r.ecr_rank), [1, 1.2, 1.4, 1.5],
    'the ECR at each date must be preserved — this table exists to measure the movement between them');
});

test('applies the same row filters as the single-snapshot table', async () => {
  stubFetch();
  await syncHistoricalAdpScrapes([2021, 2022]);
  const all = adpScrapesFor(2021);
  assert.ok(!all.some(r => r.name === 'Roquan Smith'),
    'an IDP page_type sharing ecr_type=\'ro\' must not enter as offensive consensus');
  assert.ok(!all.some(r => r.ecr_rank === 99), 'a non-\'ro\' ecr_type row must not enter');
  assert.ok(!all.some(r => r.scrape_date >= '2021-09-09'),
    'a post-kickoff scrape must not enter — it would be lookahead into the season');
});

test('agrees with historical-adp.js about the terminal snapshot', async () => {
  stubFetch();
  await syncHistoricalAdpScrapes([2021, 2022]);
  await syncHistoricalAdp([2021, 2022]);
  for (const season of [2021, 2022]) {
    for (const snapshot of historicalAdpFor(season)) {
      const series = adpScrapesFor(season).filter(r => r.player_key === snapshot.player_key);
      const last = series.at(-1);
      assert.equal(last.scrape_date, snapshot.scrape_date,
        'the last retained scrape must be exactly the row the collapsed table keeps');
      assert.equal(last.ecr_rank, snapshot.ecr_rank,
        'the two tables must never disagree about what the market said at the end');
    }
  }
});

test('a re-sync replaces rather than duplicates a season', async () => {
  stubFetch();
  await syncHistoricalAdpScrapes([2021]);
  await syncHistoricalAdpScrapes([2021]);
  assert.equal(adpScrapesFor(2021).filter(r => r.name === 'Christian McCaffrey').length, 4,
    'a second sync must not double the series');
});

test('coverage exposes scrapes-per-player, the number that was 1 before this table', async () => {
  stubFetch();
  await syncHistoricalAdpScrapes([2021, 2022]);
  const s2021 = adpScrapeCoverage().find(c => c.season === 2021);
  assert.equal(s2021.scrape_dates, 4);
  assert.equal(s2021.players, 1);
  assert.ok(s2021.scrapes_per_player > 1,
    'a retention count of 1 would mean the collapse is back and no velocity is measurable');
  assert.equal(s2021.first_scrape, '2021-07-09');
  assert.equal(s2021.last_scrape, '2021-09-03');
});
