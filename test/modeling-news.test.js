import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalkForwardSplits, openFinalHoldout, runWalkForward } from '../server/modeling/walk-forward.js';
import { MemoryModelStore, ModelRegistry } from '../server/modeling/registry.js';
import { clusterNews, extractEntities, normalizeNewsItem } from '../server/news/normalize.js';
import { requireLeagueId } from '../server/modeling/league-context.js';

const observation = (season, week, player = 1, extra = {}) => ({ player_id: player, season, week,
  as_of: `${season}-09-${String(week).padStart(2, '0')}T12:00:00Z`, features: { x: season + week }, outcome: season + week, ...extra });

test('timestamp guard rejects future features and duplicate observations', () => {
  assert.throws(() => createWalkForwardSplits([observation(2023, 1, 1, { features: { x: { value: 1, available_at: '2023-10-01T00:00:00Z' } } })]), /future-data leakage/);
  assert.throws(() => createWalkForwardSplits([observation(2023, 1), observation(2023, 1)]), /duplicate observation/);
});

test('walk-forward splits are chronological and final season remains sealed', () => {
  const data = [observation(2021, 1), observation(2021, 2), observation(2022, 1), observation(2023, 1)];
  const plan = createWalkForwardSplits(data, { holdoutSeason: 2023 });
  assert.equal(plan.holdout.state, 'sealed');
  assert.deepEqual(plan.holdout.evaluate.map(x => x.season), [2023]);
  for (const split of plan.splits) assert.ok(split.train.every(row => row.season * 100 + row.week < split.cutoff));
});

test('walk-forward reruns are deterministic and retain prediction failures', () => {
  const data = [observation(2021, 1), observation(2021, 2), observation(2022, 1), observation(2023, 1)];
  const candidate = { name: 'deterministic baseline', fit: train => ({ predict: (_features, row) => {
    if (row.week === 2) throw new Error('missing provider feature');
    return { prediction: train.length };
  } }) };
  const a = runWalkForward(data, candidate, { holdoutSeason: 2023 });
  const b = runWalkForward(data, candidate, { holdoutSeason: 2023 });
  assert.deepEqual(a, b);
  assert.equal(a.holdout.state, 'sealed');
  assert.ok(a.folds.flatMap(x => x.predictions).some(x => x.status === 'failed'));
  assert.throws(() => openFinalHoldout(data, candidate, a), /explicit authorization/);
});

test('registry promotion is permissioned and requires every risk gate', () => {
  const store = new MemoryModelStore(); const registry = new ModelRegistry(store);
  const trainer = { id: 'dev', permissions: ['model:train'] };
  const x = registry.create({ family: 'baseline', seasons: [2021, 2022] }, trainer);
  registry.transition(x.id, 'running');
  registry.transition(x.id, 'completed', { result: { gates: { schema: true, leakage: true, data_quality: true, baseline_improvement: false, tests: true } } });
  assert.throws(() => registry.promote(x.id, { id: 'admin', permissions: ['model:promote'] }), /baseline_improvement/);
});

test('projection context requires the selected league instead of silently choosing one', () => {
  assert.equal(requireLeagueId({ params: {}, query: { league_id: '42' }, headers: {} }), 42);
  assert.equal(requireLeagueId({ params: {}, query: {}, headers: { 'x-active-league-id': '9' } }), 9);
  assert.throws(() => requireLeagueId({ params: {}, query: {}, headers: {} }), /active league is required/);
});

test('news normalization attributes sources, canonicalizes URLs, extracts entities, and clusters duplicates', () => {
  const identity = { players: [{ id: 7, name: 'Amon-Ra St. Brown', aliases: ['Amon Ra St Brown'] }], teams: [{ id: 8, name: 'Detroit Lions', aliases: ['Lions'] }] };
  const raw = { source: 'Detroit Lions', source_type: 'official', source_url: 'https://EXAMPLE.com/story/?utm_source=x',
    published_at: '2026-08-01T12:00:00Z', headline: 'Lions update Amon Ra St Brown workload' };
  const a = normalizeNewsItem(raw, { identity, ingestedAt: '2026-08-01T12:01:00Z' });
  const b = normalizeNewsItem({ ...raw, source: 'Wire', source_type: 'publisher', source_url: 'https://example.com/story' }, { identity, ingestedAt: '2026-08-01T12:02:00Z' });
  assert.equal(a.canonical_url, 'https://example.com/story');
  assert.deepEqual(extractEntities(raw.headline, identity).players.map(x => x.id), [7]);
  const clusters = clusterNews([b, a]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].preferred.source_type, 'official');
  assert.throws(() => normalizeNewsItem({ ...raw, source: 'AI analysis' }), /not a valid reporting source/);
});
