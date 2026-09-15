import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = '/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-review-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, dbPath } = await import(`${root}/server/db/index.js`);
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH);
try {
  await (await import(`${root}/server/db/migrate.js`)).runMigrations();
  const { upsertNormalizedNewsItem } = await import(`${root}/server/news/store.js`);
  const { syncStructuredNewsSignals, playerNewsSignal } = await import(`${root}/server/services/nfl-news-signal.js`);
  const source = {
    headline: 'Test Runner is questionable', summary: 'Test Runner is questionable with an ankle injury.',
    source: 'NFL', source_url: 'https://www.nfl.com/news/review-fixture', source_type: 'news',
    canonical_url: 'https://www.nfl.com/news/review-fixture', duplicate_group_id: 'review-fixture',
    published_at: '2026-09-09T09:00:00.000Z', ingested_at: '2026-09-09T10:00:00.000Z',
    updated_at: '2026-09-09T10:00:00.000Z', entities: { players: [{name:'Test Runner', confidence:1}] }
  };
  upsertNormalizedNewsItem(source);
  syncStructuredNewsSignals({sinceDays:3650});
  db.prepare('UPDATE nfl_news_signals SET created_at=?').run('2026-09-09T10:01:00.000Z');
  const cutoff = '2026-09-10T12:00:00.000Z';
  const before = playerNewsSignal('Test Runner', {before:cutoff});
  upsertNormalizedNewsItem({...source, headline:'Test Runner is ruled out', summary:'Test Runner will not play.',
    ingested_at:'2026-09-11T18:00:00.000Z', updated_at:'2026-09-11T18:00:00.000Z'});
  syncStructuredNewsSignals({sinceDays:3650});
  const after = playerNewsSignal('Test Runner', {before:cutoff});
  assert.equal(before.availability.status, 'questionable');
  assert.equal(after.availability.status, 'out');
  const revisedArticle = db.prepare('SELECT ingested_at FROM news_items').get();
  console.log('REVIEW_RESULT ' + JSON.stringify({probe:'revised_news_changes_past_snapshot', cutoff,
    before:before.availability.status, after:after.availability.status,
    article_received_at:revisedArticle.ingested_at, signal_created_at:after.availability.created_at}));

  db.prepare('UPDATE nfl_news_signals SET created_at=?').run('2026-09-10 20:00:00');
  const late = playerNewsSignal('Test Runner', {before:cutoff});
  assert.ok(late, 'Confirms bug: same-day evening extraction is admitted before noon.');
  console.log('REVIEW_RESULT ' + JSON.stringify({probe:'sqlite_clock_string_order',cutoff,
    extraction_at:late.availability.created_at, admitted:!!late}));

  const { probabilitiesFromTriple } = await import(`${root}/server/betting/nfl/forecast/spread-family-adapters.js`);
  const { validateSpreadProbabilities } = await import(`${root}/server/betting/nfl/contracts/spread-probabilities.js`);
  const p = probabilitiesFromTriple({win:0.4834,push:0.0334,loss:0.4832,handicap:-3,method:'fixture'});
  const checked = validateSpreadProbabilities(p);
  assert.equal(p.available, true);
  assert.equal(checked.ok, false);
  console.log('REVIEW_RESULT ' + JSON.stringify({probe:'adapter_rounding_breaks_contract',output:p,validator:checked}));
} finally {
  db.close();
  fs.rmSync(temp,{recursive:true,force:true});
}
