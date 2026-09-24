/**
 * PEOPLE-01 parity: switching the three chat-psychology readers to
 * server/services/people/profile-reader.js does not change one served value.
 *
 * The golden file was written by THIS test against main at 12a6de9, before any
 * consumer was switched (PEOPLE_GOLDEN_WRITE=1). After the switch the same
 * calls on the same fixture must produce the same JSON, field for field:
 *   counterparty-pricing  negotiationProfilesFor, counterpartyDataKey
 *   manager-signals       buildManagerSignals' chat + sentiment rows, chatCorpusState
 *   coach/people          personVariables
 * The fixture is main's shape (no new keys, no notes, no alias map), which is
 * what those consumers serve today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildTodayChat, seedLeague, LEAGUE } from './helpers/people-chat-fixture.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/people-profile-parity.golden.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-people-parity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'app.sqlite');
const CHAT = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT;
process.env.SCHEDULER_DISABLED = '1';
buildTodayChat(CHAT);

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/services/manager-identity.js');
const signals = await import('../server/services/manager-signals.js');
const pricing = await import('../server/services/counterparty-pricing.js');
const { personVariables } = await import('../server/services/coach/people/variables.js');
await runMigrations();
seedLeague(run);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const plain = v => JSON.parse(JSON.stringify(v, (_, x) => (x instanceof Map ? [...x.entries()] : x)));

function snapshot() {
  const profiles = pricing.negotiationProfilesFor(LEAGUE);
  const dataKey = pricing.counterpartyDataKey(LEAGUE);
  const built = signals.buildManagerSignals(LEAGUE);
  assert.ok(!built.error, built.error);
  const chatRows = rows(`SELECT roster_id, metric, value, n, source FROM manager_signals
                         WHERE league_id = ? AND source IN ('chat', 'nick') ORDER BY roster_id, metric`, LEAGUE);
  const views = rows(`SELECT roster_id, player_name, sentiment, n, last_mention FROM manager_player_view
                      WHERE league_id = ? ORDER BY roster_id, player_name`, LEAGUE);
  const { path: _p, ...corpus } = signals.chatCorpusState();
  const chat = new DatabaseSync(CHAT, { readOnly: true });
  let variables;
  try {
    variables = Object.fromEntries(['P-Alpha', 'P-Bravo', 'Nobody'].map(n => [n, personVariables(n, { corpus: chat })]));
  } finally { chat.close(); }
  return plain({ profiles, dataKey, chatRows, views, corpus, variables });
}

test('parity: the three consumers serve exactly what main served on the same chat DB', () => {
  const now = snapshot();
  if (process.env.PEOPLE_GOLDEN_WRITE === '1') {
    fs.writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  // Section by section, so a failure names the consumer that moved.
  for (const k of Object.keys(golden)) assert.deepEqual(now[k], golden[k], `${k} changed`);
  assert.deepEqual(Object.keys(now).sort(), Object.keys(golden).sort());
});

test('parity: the golden record is not vacuous', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.equal(golden.profiles.available, true);
  assert.deepEqual(golden.profiles.byRoster.map(([k]) => k), ['2', '3'], 'P-Alpha and P-Bravo attach');
  assert.equal(golden.profiles.self.name, 'ME');
  assert.ok(golden.profiles.invalid.some(i => i.name === 'P-Charlie'), 'the leaked-markup profile is invalid');
  assert.ok(golden.profiles.unmapped.includes('P-Delta'), 'a likely identity does not attach');
  assert.ok(golden.chatRows.some(r => r.metric === 'chat_msgs' && r.roster_id === '2'), 'chat signals were written');
  assert.ok(golden.views.length >= 2, 'sentiment reached manager_player_view');
  assert.equal(golden.corpus.rows, 4);
  assert.match(golden.dataKey, /id:5:2026-09-18 03:00:00\|.*np:5:2026-09-18 05:50:00/);
  assert.ok(golden.variables['P-Alpha'].some(v => v.id === 'night_share' && v.value === 0.1));
});
