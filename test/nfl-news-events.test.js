import test, { mock as moduleMock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Package E's typed news-event extraction: schema, content-hash caching,
// verbatim-span enforcement against a hostile/hallucinated model response,
// novelty/contradiction detection, the press-conference "unknown" branch,
// and provenance verification. Follows test/page-explain.test.js's exact
// node-fetch mocking convention (node:test --experimental-test-module-mocks;
// see package.json's "test" script) so no real Anthropic call is ever made.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-events-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db, run, rows } = await import('../server/db/index.js');

const originalApiKey = process.env.ANTHROPIC_API_KEY;
function setTestKey() { process.env.ANTHROPIC_API_KEY = 'test-key-not-real'; }
function clearTestKey() {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
}
test.after(() => { clearTestKey(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

let activeFetchHandler = null;
const nodeFetchMock = moduleMock.module('node-fetch', { exports: { default: (url, init) => {
  if (!activeFetchHandler) throw new Error('Test forgot to install an Anthropic fetch mock before making a request');
  return activeFetchHandler(url, init);
} } });
test.after(() => nodeFetchMock.restore());

function mockAnthropicJson(payload) {
  const calls = [];
  activeFetchHandler = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 60 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { activeFetchHandler = null; } };
}

const events = await import('../server/services/nfl-news-events.js');

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (1,'KC','Kansas City Chiefs','AFC','West')`);
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (2,'DEN','Denver Broncos','AFC','West')`);

function insertNewsItem({ id, headline, body, teamId = 1, entities, publishedAt, sourceUrl = 'https://www.espn.com/story/1' }) {
  run(`INSERT INTO news_items (id, date, team_id, headline, body, source, source_url, published_at, entities_json)
       VALUES (?,date('now'),?,?,?,?,?,?,?)`,
    id, teamId, headline, body, 'ESPN', sourceUrl, publishedAt, JSON.stringify({ players: entities }));
}

test('extraction accepts a claim whose evidence span is verbatim in the source, and rejects one that is not', async () => {
  setTestKey();
  insertNewsItem({ id: 1, headline: 'Mahomes injury update', body: 'Patrick Mahomes was listed as questionable with an ankle issue Friday.',
    entities: [{ name: 'Patrick Mahomes', id: 501, confidence: 0.95 }], publishedAt: '2026-09-10T18:00:00.000Z' });

  const mock = mockAnthropicJson([
    // Legitimate: evidence_span occurs verbatim in the story text.
    { ref: 0, player_name: 'Patrick Mahomes', claim_type: 'injury_status', claim_text: 'Listed questionable, ankle',
      evidence_span: 'listed as questionable with an ankle issue', certainty: 0.8 },
    // Hostile/hallucinated: the model invents a span never present in the story — this is exactly the
    // shape a prompt-injection or hallucination attempt would take, and it must be rejected by the plain
    // substring check regardless of how confidently the model asserts it.
    { ref: 0, player_name: 'Patrick Mahomes', claim_type: 'injury_status', claim_text: 'Out for the season',
      evidence_span: 'ruled out for the remainder of the season', certainty: 1.0 }
  ]);
  let result;
  try { result = await events.extractNewsEventsFromItems({ sinceDays: 30, limit: 10 }); }
  finally { mock.restore(); }

  assert.equal(result.accepted, 1, JSON.stringify(result));
  assert.equal(result.rejected, 1);
  const stored = rows(`SELECT * FROM nfl_news_events WHERE player_key=?`, 'patrick mahomes');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].claim_type, 'injury_status');
  assert.equal(stored[0].evidence_span, 'listed as questionable with an ankle issue');
  assert.equal(stored[0].team, 'KC');
  assert.equal(stored[0].certainty_label, 'stated');
  assert.equal(stored[0].novelty_label, 'new');
  clearTestKey();
});

test('content-hash cache makes a second identical extraction pass a strict no-op (duplicate-article control)', async () => {
  setTestKey();
  // Same underlying news_items rows as the previous test are still present — re-running the extractor
  // over the same window must not re-ask the model anything, because nothing new has appeared.
  const before = rows(`SELECT COUNT(*) n FROM nfl_news_events`)[0].n;
  const mock = mockAnthropicJson([{ ref: 0, player_name: 'Patrick Mahomes', claim_type: 'injury_status',
    claim_text: 'duplicate', evidence_span: 'listed as questionable with an ankle issue', certainty: 0.8 }]);
  let result;
  try { result = await events.extractNewsEventsFromItems({ sinceDays: 30, limit: 10 }); }
  finally { mock.restore(); }
  assert.equal(result.candidates, 0, 'the story was already cached by content hash; nothing should be sent to the model');
  assert.equal(mock.calls.length, 0, 'a fully cached pass must not call the model at all');
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_news_events`)[0].n, before);
  clearTestKey();
});

test('a contradicting later claim is marked superseded with a reason; a restated claim is marked a restatement', async () => {
  setTestKey();
  insertNewsItem({ id: 2, headline: 'Mahomes cleared', body: 'Patrick Mahomes practiced fully and is good to go Sunday.',
    entities: [{ name: 'Patrick Mahomes', id: 501, confidence: 0.95 }], publishedAt: '2026-09-11T18:00:00.000Z' });
  let mock = mockAnthropicJson([{ ref: 0, player_name: 'Patrick Mahomes', claim_type: 'injury_status',
    claim_text: 'Cleared, good to go', evidence_span: 'is good to go Sunday', certainty: 0.9 }]);
  let result;
  try { result = await events.extractNewsEventsFromItems({ sinceDays: 30, limit: 10 }); }
  finally { mock.restore(); }
  assert.equal(result.accepted, 1, JSON.stringify(result));

  const history = events.playerNewsEvents('Patrick Mahomes').events;
  const latest = history[0]; // most recent first
  assert.equal(latest.claim_text, 'Cleared, good to go');
  assert.ok(latest.superseded_event_id, 'a "good to go" claim after a "questionable" claim should contradict it');
  assert.match(latest.contradiction_reason, /contradicts prior/);
  assert.equal(latest.novelty_label, 'new');

  // Now restate the exact same information a different way — high token overlap with the prior claim,
  // no status-polarity flip, should be flagged a restatement rather than fresh information.
  insertNewsItem({ id: 3, headline: 'Mahomes still good to go', body: 'Patrick Mahomes is good to go Sunday, per the team.',
    entities: [{ name: 'Patrick Mahomes', id: 501, confidence: 0.95 }], publishedAt: '2026-09-12T12:00:00.000Z' });
  mock = mockAnthropicJson([{ ref: 0, player_name: 'Patrick Mahomes', claim_type: 'injury_status',
    claim_text: 'Cleared, good to go', evidence_span: 'is good to go Sunday', certainty: 0.9 }]);
  try { result = await events.extractNewsEventsFromItems({ sinceDays: 30, limit: 10 }); }
  finally { mock.restore(); }
  assert.equal(result.accepted, 1, JSON.stringify(result));
  const latest2 = events.playerNewsEvents('Patrick Mahomes').events[0];
  assert.equal(latest2.novelty_label, 'restatement');
  assert.equal(latest2.superseded_event_id, null);
  clearTestKey();
});

test('an ambiguous claim is stored with certainty_label "unknown" and no numeric certainty', async () => {
  setTestKey();
  insertNewsItem({ id: 4, headline: 'Kelce update', body: 'Travis Kelce is week to week with a knee issue, coach says.',
    entities: [{ name: 'Travis Kelce', id: 502, confidence: 0.9 }], publishedAt: '2026-09-13T12:00:00.000Z' });
  const mock = mockAnthropicJson([{ ref: 0, player_name: 'Travis Kelce', claim_type: 'injury_status',
    claim_text: 'Week to week, ambiguous', evidence_span: 'week to week with a knee issue', certainty: 'unknown' }]);
  let result;
  try { result = await events.extractNewsEventsFromItems({ sinceDays: 30, limit: 10 }); }
  finally { mock.restore(); }
  assert.equal(result.accepted, 1);
  const stored = rows(`SELECT * FROM nfl_news_events WHERE player_key=?`, 'travis kelce')[0];
  assert.equal(stored.certainty_label, 'unknown');
  assert.equal(stored.certainty, null);
  clearTestKey();
});

// ------------------------------------------------- press-conference branch --

run(`CREATE TABLE IF NOT EXISTS yt_channels (team TEXT PRIMARY KEY, handle TEXT, channel_id TEXT, title TEXT,
  subscribers TEXT, verdict TEXT, checked_at TEXT)`);
run(`INSERT INTO yt_channels (team, handle, verdict) VALUES ('KC','KansasCityChiefs','valid')`);
run(`INSERT INTO press_conferences (video_id, team, title, published_at, is_presser, transcript, chars, fetched_at)
     VALUES ('vid1','KC','Presser','2026-09-09T20:00:00.000Z',1,'...','3',datetime('now'))`);
// Ordering note: extractPressConferenceRoleSignals sorts candidates by
// published_at DESC, id DESC — the row inserted LAST becomes candidate ref 0.
// Insert the vague quote first so the specific "snap count" quote (inserted
// second) is ref 0 and the vague "day to day" quote is ref 1, matching the
// mocked response below (ref 0 -> confident scenario, ref 1 -> unknown).
run(`INSERT INTO press_availability (video_id, team, published_at, player, keyword, quote)
     VALUES ('vid1','KC','2026-09-09T20:00:00.000Z','Isiah Pacheco','day to day','we will see how he is day to day, hard to say more than that')`);
run(`INSERT INTO press_availability (video_id, team, published_at, player, keyword, quote)
     VALUES ('vid1','KC','2026-09-09T20:00:00.000Z','Isiah Pacheco','snap count','his snap count has really opened up the last two weeks')`);

test('press-conference branch stores a scenario distribution when the model gives one, and "unknown" when it does not', async () => {
  setTestKey();
  const mock = mockAnthropicJson([
    { ref: 0, rationale: 'Coach describes an expanding role in the run game.', unknown: false,
      scenario: { expanded_role: 0.6, reduced_role: 0.1, no_change: 0.3 } },
    { ref: 1, rationale: 'Too vague to say anything about role.', unknown: true }
  ]);
  let result;
  try { result = await events.extractPressConferenceRoleSignals({ sinceDays: 30, limit: 10 }); }
  finally { mock.restore(); }
  assert.equal(result.accepted, 2, JSON.stringify(result));
  assert.equal(result.unknown, 1);
  assert.equal(result.scenario_accepted, 1);

  const stored = rows(`SELECT * FROM nfl_news_events WHERE player_key='isiah pacheco' ORDER BY evidence_span`);
  const withScenario = stored.find(r => r.scenario_json);
  const unknownRow = stored.find(r => !r.scenario_json);
  assert.ok(withScenario, 'the confident-scenario quote should have a stored scenario_json');
  const scenario = JSON.parse(withScenario.scenario_json);
  assert.ok(Math.abs(scenario.expanded_role + scenario.reduced_role + scenario.no_change - 1) < 0.01);
  assert.equal(withScenario.certainty_label, 'stated');
  assert.equal(withScenario.risk_branch, events.RISK_BRANCH_PRESS_ROLE);
  assert.equal(unknownRow.certainty_label, 'unknown');
  assert.equal(unknownRow.certainty, null);
  assert.equal(unknownRow.evidence_span, 'we will see how he is day to day, hard to say more than that',
    'evidence_span must be the original verbatim quote, never re-asked of the model');
  clearTestKey();
});

test('press-conference claims are only verified when the team channel itself was validated', async () => {
  setTestKey();
  run(`INSERT INTO yt_channels (team, handle, verdict) VALUES ('DEN','Broncos','suspect')`);
  run(`INSERT INTO press_conferences (video_id, team, title, published_at, is_presser, transcript, chars, fetched_at)
       VALUES ('vid2','DEN','Presser','2026-09-09T20:00:00.000Z',1,'...','3',datetime('now'))`);
  run(`INSERT INTO press_availability (video_id, team, published_at, player, keyword, quote)
       VALUES ('vid2','DEN','2026-09-09T20:00:00.000Z','Bo Nix','role','his role has clearly expanded these last two games')`);
  const mock = mockAnthropicJson([{ ref: 0, rationale: 'Role appears to be expanding.', unknown: false,
    scenario: { expanded_role: 0.7, reduced_role: 0.1, no_change: 0.2 } }]);
  let result;
  try { result = await events.extractPressConferenceRoleSignals({ sinceDays: 30, limit: 10 }); }
  finally { mock.restore(); }
  assert.equal(result.accepted, 1);
  const stored = rows(`SELECT * FROM nfl_news_events WHERE player_key='bo nix'`)[0];
  assert.equal(stored.verification_state, 'quarantined');
  assert.match(stored.verification_reason, /not verified valid/);
  clearTestKey();
});

// -------------------------------------------------------------- provenance --

test('verifyNewsEventProvenance flags a claim observed before its own publication time', () => {
  run(`INSERT INTO nfl_news_events (event_id, source_kind, source_ref, content_hash, player_key, player_name,
      team, claim_type, claim_text, evidence_span, published_at, first_seen_time, certainty_label, extractor_version,
      verification_state, verification_reason)
    VALUES ('leaktest','news_item','999','hash999','leaky player','Leaky Player','KC','injury_status','x','y',
      '2026-09-20T00:00:00.000Z','2026-09-19T00:00:00.000Z','stated','v1','verified','ok')`);
  const report = events.verifyNewsEventProvenance();
  assert.ok(report.flagged >= 1);
  const flagged = report.examples.find(e => e.event_id === 'leaktest');
  assert.ok(flagged, 'the impossible-clock row must be flagged');
  assert.equal(flagged.reason, 'observed_before_published');
  assert.match(report.verdict, /leak found/);
});

test('coverage summary counts events, verified/quarantined, and press-conference signals', () => {
  const coverage = events.newsEventCoverage();
  assert.ok(coverage.events >= 5);
  assert.ok(coverage.press_role_signals >= 2);
});
