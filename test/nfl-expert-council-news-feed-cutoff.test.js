/**
 * Regression coverage for the ingested_at receipt-clock fix in
 * nfl-expert-council.js's newsFor: the `feedStories` count that decides
 * between an honest `null` abstain and a real, "observed" numeric `0`
 * forecast (`feedStories >= 3 ? 0 : null`) was previously checking only
 * news_items.published_at, never news_items.ingested_at (this pipeline's own
 * receipt clock -- see server/news/store.js's upsertNormalizedNewsItem,
 * which only advances ingested_at when content genuinely changes). A story
 * published before a decision cutoff but not actually ingested until after
 * it is not knowable at that cutoff, and must not be counted toward
 * feedStories -- the same class of look-ahead risk already closed in
 * nfl-news-signal.js's playerNewsSignal/teamNewsSignals (created_at).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-expert-council-news-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { __test } = await import('../server/services/nfl-expert-council.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Each test uses its own team pair so news_items seeded by one test can never
// bleed into another test's feedStories count (all tests share one cutoff
// window on the same in-process db).
let nextTeamId = 901, nextNewsId = 9001;
function seedTeamPair() {
  const homeId = nextTeamId++, awayId = nextTeamId++;
  const home = `Z${homeId}`, away = `Z${awayId}`;
  run(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES (?,?,?,'AFC','East')`, homeId, home, home);
  run(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES (?,?,?,'AFC','East')`, awayId, away, away);
  return { home, away, homeId, awayId };
}

function seedNewsItem({ team_id, published_at, ingested_at, headline = 'Depth chart note' }) {
  const id = nextNewsId++;
  run(`INSERT INTO news_items (id,date,team_id,headline,source,published_at,ingested_at)
    VALUES (?,?,?,?,'test',?,?)`, id, published_at.slice(0, 10), team_id, headline, published_at, ingested_at);
}

const CUTOFF = '2026-11-02T00:00:00.000Z';

test('newsFor: 3+ stories published before cutoff but ingested after it do not count toward feedStories, forecast falls back to null', () => {
  const { home, away, homeId, awayId } = seedTeamPair();
  seedNewsItem({ team_id: homeId, published_at: '2026-11-01T10:00:00.000Z', ingested_at: '2026-11-03T00:00:00.000Z' });
  seedNewsItem({ team_id: homeId, published_at: '2026-11-01T11:00:00.000Z', ingested_at: '2026-11-03T00:00:00.000Z' });
  seedNewsItem({ team_id: awayId, published_at: '2026-11-01T12:00:00.000Z', ingested_at: '2026-11-03T00:00:00.000Z' });

  const result = __test.newsFor({ home, away }, CUTOFF);
  assert.equal(result.feed_stories, 0,
    'stories not actually ingested by the cutoff must not count toward feedStories');
  assert.equal(result.forecast, null,
    'with zero verified claims and feedStories below 3, the expert must honestly abstain (null), not report a false observed 0');
  assert.equal(result.evidence_state, 'feed_coverage_missing');
});

test('newsFor: 3+ stories published AND ingested before cutoff still count (happy path preserved)', () => {
  const { home, away, homeId, awayId } = seedTeamPair();
  seedNewsItem({ team_id: homeId, published_at: '2026-11-01T10:00:00.000Z', ingested_at: '2026-11-01T10:05:00.000Z' });
  seedNewsItem({ team_id: homeId, published_at: '2026-11-01T11:00:00.000Z', ingested_at: '2026-11-01T11:05:00.000Z' });
  seedNewsItem({ team_id: awayId, published_at: '2026-11-01T12:00:00.000Z', ingested_at: '2026-11-01T12:05:00.000Z' });

  const result = __test.newsFor({ home, away }, CUTOFF);
  assert.equal(result.feed_stories, 3,
    'stories genuinely ingested before the cutoff must still be counted');
  assert.equal(result.forecast, 0,
    'with zero verified claims and feedStories >= 3, the expert reports a real observed neutral forecast of 0');
  assert.equal(result.evidence_state, 'observed_no_material_claim');
});

test('newsFor: mixing on-time and late-ingested stories only counts the on-time ones (feedStories can only shrink, never grow, from the fix)', () => {
  // Two genuinely knowable-by-cutoff stories plus two more that were not
  // actually ingested until after the cutoff: pre-fix this reads as 4 (>=3,
  // forecast 0); post-fix it must read as 2 (<3, forecast null).
  const { home, away, homeId, awayId } = seedTeamPair();
  seedNewsItem({ team_id: homeId, published_at: '2026-11-01T09:00:00.000Z', ingested_at: '2026-11-01T09:05:00.000Z' });
  seedNewsItem({ team_id: awayId, published_at: '2026-11-01T09:30:00.000Z', ingested_at: '2026-11-01T09:35:00.000Z' });
  seedNewsItem({ team_id: homeId, published_at: '2026-11-01T10:00:00.000Z', ingested_at: '2026-11-03T00:00:00.000Z' });
  seedNewsItem({ team_id: awayId, published_at: '2026-11-01T10:30:00.000Z', ingested_at: '2026-11-03T00:00:00.000Z' });

  const result = __test.newsFor({ home, away }, CUTOFF);
  assert.equal(result.feed_stories, 2, 'only the two stories actually ingested before the cutoff must count');
  assert.equal(result.forecast, null, 'feedStories below 3 must abstain rather than report an observed 0');
});
