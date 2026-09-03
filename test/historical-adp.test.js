import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-historical-adp-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row } = await import('../server/db/index.js');
const {
  syncHistoricalAdp, historicalAdpFor, historicalAdpCoverage, SEASON_WEEK1_KICKOFF
} = await import('../server/services/historical-adp.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const HEADER = 'page_type,player,pos,tm,ecr,sd,mergename,ecr_type,scrape_date';
// A tiny, hand-built slice shaped exactly like the real db_fpecr.csv.gz: two
// seasons, a player scraped multiple times (the later scrape must win), one
// non-'ro' row that must be excluded, one row scraped AFTER that season's
// real kickoff that must also be excluded (no lookahead), and one IDP row —
// ecr_type='ro' is shared by standard offense AND individual-defensive-player
// rankings in the real file, distinguished only by page_type; a real bug
// caught live before this test existed had linebackers outranking Ja'Marr
// Chase because that distinction was missed.
const ROWS = [
  'redraft-overall,Christian McCaffrey,RB,SF,1,0,christian mccaffrey,ro,2021-08-20',
  'redraft-overall,Christian McCaffrey,RB,SF,1.5,0.2,christian mccaffrey,ro,2021-09-03', // later scrape, same season — must win
  'redraft-overall,Christian McCaffrey,RB,SF,99,0,christian mccaffrey,bo,2021-09-03',    // wrong ecr_type — must be excluded
  'redraft-overall,Christian McCaffrey,RB,SF,50,0,christian mccaffrey,ro,2021-09-12',    // after 2021 kickoff (09-09) — must be excluded
  'redraft-idp,Roquan Smith,LB,BAL,1.9,0.6,roquan smith,ro,2021-09-03',                  // IDP page_type under ecr_type='ro' — must be excluded
  'redraft-overall,Justin Jefferson,WR,MIN,2,0.3,justin jefferson,ro,2022-08-15',
];

function stubFetch() {
  const csv = [HEADER, ...ROWS].join('\n') + '\n';
  const gz = gzipSync(Buffer.from(csv, 'utf8'));
  globalThis.fetch = async () => ({ ok: true, body: Readable.toWeb(Readable.from(gz)) });
}

test('syncs the last preseason scrape per season/player, excluding wrong ecr_type and post-kickoff rows', async () => {
  stubFetch();
  const result = await syncHistoricalAdp([2021, 2022]);
  assert.equal(result.stored, 2, 'one row for McCaffrey (2021) and one for Jefferson (2022)');

  const cmc = historicalAdpFor(2021).find(r => r.name === 'Christian McCaffrey');
  assert.ok(cmc, 'McCaffrey must be stored for 2021');
  assert.equal(cmc.ecr_rank, 1.5, 'the later (09-03) scrape must win over the earlier (08-20) one');
  assert.equal(cmc.scrape_date, '2021-09-03');
  assert.equal(historicalAdpFor(2021).length, 1, 'the wrong-ecr_type and post-kickoff rows must not appear');
  assert.ok(!historicalAdpFor(2021).some(r => r.name === 'Roquan Smith'),
    'an IDP-page-type row sharing ecr_type=\'ro\' must not be mistaken for standard offense consensus');

  const jj = historicalAdpFor(2022).find(r => r.name === 'Justin Jefferson');
  assert.ok(jj, 'Jefferson must be stored for 2022');
  assert.equal(jj.ecr_rank, 2);
});

test('a re-sync replaces rather than duplicates a season\'s rows', async () => {
  stubFetch();
  await syncHistoricalAdp([2021]);
  await syncHistoricalAdp([2021]);
  assert.equal(historicalAdpFor(2021).length, 1, 'a second sync must not create a duplicate row');
});

test('coverage reports real row counts and the scrape-date range actually used, per season', () => {
  const coverage = historicalAdpCoverage();
  const s2021 = coverage.find(c => c.season === 2021);
  assert.ok(s2021 && s2021.players >= 1);
  assert.equal(s2021.latest_used_here, '2021-09-03', 'must reflect the kept scrape, not a discarded later one');
});

test('every configured season has a real, verifiable Week 1 kickoff date, not a placeholder', () => {
  for (const [season, kickoff] of Object.entries(SEASON_WEEK1_KICKOFF)) {
    assert.match(kickoff, /^\d{4}-\d{2}-\d{2}$/, `${season}'s kickoff date must be a real ISO date`);
    assert.equal(String(season), kickoff.slice(0, 4));
  }
});
