/**
 * COACH-LINK: the COACH-ANCHOR extension. Three parts, one file.
 *
 * (1) ENTITY MAP (entity-map.js). Players and teams linked across ESPN,
 *     Sleeper, the chat DB (speaker roster, labelled players), news,
 *     trade_outcomes and screenshot trades, each link with its confidence.
 * (2) CONNECT (connect.js). One entity's cross-source timeline, labels only,
 *     cut at as_of.
 * (3) ANSWER MEMORY (recall.js). Grounded answers kept with their served
 *     numbers and sources; recall finds and cites them and marks stale ones.
 *
 * METRIC. A fixed 8-question league-4 set run through askCoach with a stand-in
 * model that must call connect or recall and may only write what came back.
 * `COACH_LINK_METRIC answered=X/8` is the measurement; on a tree without
 * connect.js and recall.js the same file prints the baseline.
 *
 * No network, no paid model call (claude.js#setAnthropicClientForTesting).
 * Every name below is invented; no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-link-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
const CHAT_FILE = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_FILE;
const PLANS_FILE = path.join(temp, 'plans.json');
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;
delete process.env.GRIDIRON_COACH_LINK;

const { run, db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach } = await import('../server/services/coach/ask.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer } = await import('../server/services/coach/verify.js');
const tools = await import('../server/services/coach/tools.js');
const optional = file => import(`../server/services/coach/${file}`).catch(e => {
  if (e?.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw e;
});
const emap = await optional('entity-map.js');
const conn = await optional('connect.js');
const mem = await optional('recall.js');
const noLink = { skip: emap && conn && mem ? false : 'COACH-LINK modules are not on this tree' };

const LEAGUE = 4;

/* ------------------------------------------------------------ fixtures */

const contract = JSON.parse(fs.readFileSync(
  new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
const plansDoc = { ...structuredClone(contract), leagues: [{ ...structuredClone(contract.leagues[0]), league: LEAGUE }] };
const writePlans = doc => fs.writeFileSync(PLANS_FILE, JSON.stringify(doc));
writePlans(plansDoc);

const player = (name, pos, espn, sleeper, gsis) => Number(run(
  `INSERT INTO players (name, position, espn_id, sleeper_id, gsis_id) VALUES (?, ?, ?, ?, ?)`,
  name, pos, espn, sleeper, gsis).lastInsertRowid);
const BELL = player('Kade Bell', 'RB', 3001, '9001', '00-0000001');
const RUIZ = player('Cole Ruiz', 'RB', 3002, '9002', '00-0000002');
const ODUYA = player('Milo Oduya', 'WR', 3003, null, '00-0000003');
player('Sam Park', 'WR', 3004, null, null);
player('Sam Park', 'TE', 3005, null, null);
player('Theo Kline', 'TE', 3006, null, null);

const entry = (id, fullName) => ({ playerId: id, playerPoolEntry: { player: { id, fullName } } });
const espnPayload = {
  members: [{ id: 'm1', firstName: 'Alex', lastName: 'Stone' }, { id: 'm2', firstName: 'Jordan', lastName: 'Vale' },
    { id: 'm3', firstName: 'Riley', lastName: 'Moss' }],
  teams: [
    { id: 1, name: 'Fixture One', owners: ['m1'], roster: { entries: [entry(3001, 'Kade Bell'), entry(3003, 'Milo Oduya')] } },
    { id: 2, name: 'Fixture Two', owners: ['m2'], roster: { entries: [entry(3002, 'Cole Ruiz'), entry(3006, 'Theo Kline')] } },
    { id: 3, name: 'Fixture Three', owners: ['m3'], roster: { entries: [entry(3004, 'Sam Park'), entry(3005, 'Sam Park'), entry(7777, 'Nobody Known')] } }
  ]
};
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, payload) VALUES (?, 'espn', 'fx4', 2026, 'fixture', '1', ?)`,
  LEAGUE, JSON.stringify(espnPayload));
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload) VALUES (5, 'sleeper', 'fx5', 2026, 'fixture s', ?)`,
  JSON.stringify({ users: [{ user_id: 'su1', display_name: 'Alex Stone' }], rosters: [] }));
const ident = (roster, team, espnName, chatName, confidence, method) => run(
  `INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name, match_method, confidence)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, LEAGUE, roster, `m${roster}`, espnName, team, chatName, method, confidence);
ident('1', 'Fixture One', 'Alex Stone', 'Alex Stone', 'exact', 'exact full name');
ident('2', 'Fixture Two', 'Jordan Vale', 'Jordy Vale', 'likely', 'last name + first-name prefix');
ident('3', 'Fixture Three', 'Riley Moss', null, 'unmatched', null);

const news = (id, gsis, name, claim, at) => run(
  `INSERT INTO nfl_news_events (event_id, source_kind, source_ref, content_hash, player_id, player_name, claim_type, claim_text,
     evidence_span, source_name, published_at, first_seen_time, extractor_version)
   VALUES (?, 'news_item', ?, ?, ?, ?, ?, 'SECRET CLAIM TEXT', 'SECRET EVIDENCE SPAN', 'fixture wire', ?, ?, 'fx')`,
  id, id, id, gsis, name, claim, at, at);
news('n1', '00-0000002', 'Cole Ruiz', 'injury_status', '2026-09-18T12:00:00Z');
news('n2', null, 'Cole Ruiz', 'role_change', '2026-09-22T12:00:00Z');
run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
       proposed_at, status, espn_tx_id, resolved_at, created_at)
     VALUES (?, 2026, 'observed', '1', '2', ?, ?, '2026-09-19T15:00:00Z', 'declined', 'tx1', '2026-09-20T15:00:00Z', '2026-09-20T16:00:00Z')`,
LEAGUE, JSON.stringify([{ playerId: 3003, fromTeamId: 1, toTeamId: 2 }]), JSON.stringify([{ playerId: 3002, fromTeamId: 2, toTeamId: 1 }]));

const chat = new DatabaseSync(CHAT_FILE);
chat.exec(`CREATE TABLE participants (handle TEXT PRIMARY KEY, name TEXT, dm_chat_id INTEGER);
  CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT, is_from_me INTEGER,
    ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
  CREATE TABLE jev_chat_signals (msg_id INTEGER, name TEXT, chat_kind TEXT, mentioned_player TEXT, question TEXT,
    probability REAL, evaluated_at TEXT);`);
chat.prepare('INSERT INTO participants VALUES (?, ?, NULL)').run('+15550000001', 'Alex Stone');
chat.prepare('INSERT INTO participants VALUES (?, ?, NULL)').run('+15550000002', 'Jordy Vale');
const say = (id, name, ts, mentioned, question, p) => {
  chat.prepare(`INSERT INTO messages VALUES (?, 'group', 'fx', 'h', ?, 0, ?, 'SECRET MESSAGE TEXT', 0, 0)`).run(id, name, ts);
  chat.prepare(`INSERT INTO jev_chat_signals VALUES (?, ?, 'group', ?, ?, ?, '2026-09-23 00:00:00')`).run(id, name, mentioned, question, p);
};
say(1, 'Alex Stone', '2026-09-17 10:00:00', 'Cole Ruiz', 'intent.shopping', 0.8);
say(2, 'Jordy Vale', '2026-09-21 10:00:00', 'Cole Ruiz', 'intent.wants', 0.9);
say(3, 'Alex Stone', '2026-09-16 10:00:00', 'Sam Park', 'intent.wants', 0.9);
say(4, 'Alex Stone', '2026-09-15 10:00:00', 'Nobody Here', 'intent.wants', 0.7);
say(5, 'Alex Stone', '2026-09-14 10:00:00', 'Kade Bell', 'intent.shopping', 0.2);
chat.close();

const withEnv = async (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const LINK_ON = { GRIDIRON_COACH_LINK: '1', GRIDIRON_COACH_BRAIN_TOOLS: '1' };
const linkOf = (e, source, space) => e.links.find(l => l.source === source && l.id_space === space);

/* ------------------------------------------------------------ (1) entity map */

test('entity map: a player is linked across ESPN, Sleeper, GSIS, roster, chat, news and trades, with confidence', noLink, () => {
  const map = emap.buildEntityMap(LEAGUE);
  assert.equal(map.status, 'ok');
  const ruiz = map.entities.find(e => e.key === `player:${RUIZ}`);
  assert.equal(ruiz.label, 'Cole Ruiz');
  assert.equal(linkOf(ruiz, 'espn', 'espn_player').confidence, 'exact');
  assert.equal(linkOf(ruiz, 'sleeper', 'sleeper_player').source_id, '9002');
  assert.equal(linkOf(ruiz, 'nflverse', 'gsis').trusted, true);
  assert.equal(linkOf(ruiz, 'espn', 'espn_roster').source_id, '2');
  const chatLabel = linkOf(ruiz, 'chat', 'chat_label');
  assert.deepEqual([chatLabel.confidence, chatLabel.trusted, chatLabel.n], ['name', false, 2]);
  const newsLinks = ruiz.links.filter(l => l.source === 'news');
  assert.equal(newsLinks.length, 1, 'one link per source+space; the stronger confidence wins');
  assert.deepEqual([newsLinks[0].confidence, newsLinks[0].n], ['exact', 2]);
  assert.equal(linkOf(ruiz, 'trade_outcomes', 'trade_player').confidence, 'exact');
  assert.ok(map.entities.some(e => e.key === `player:${ODUYA}` && linkOf(e, 'trade_outcomes', 'trade_player')));
});

test('entity map: a team links ESPN team + member, chat speaker and handle, Sleeper user and the trade ledger', noLink, () => {
  const map = emap.buildEntityMap(LEAGUE);
  const one = map.entities.find(e => e.key === 'team:1');
  assert.equal(one.label, 'Fixture One');
  assert.equal(linkOf(one, 'espn', 'espn_member').source_id, 'm1');
  assert.deepEqual([linkOf(one, 'chat', 'chat_speaker').confidence, linkOf(one, 'chat', 'chat_speaker').trusted], ['exact', true]);
  assert.equal(linkOf(one, 'chat', 'chat_handle').source_id, null, 'a chat handle is never returned');
  assert.deepEqual([linkOf(one, 'sleeper', 'sleeper_user').confidence, linkOf(one, 'sleeper', 'sleeper_user').trusted], ['uncertain', false]);
  assert.equal(linkOf(one, 'trade_outcomes', 'team_id').confidence, 'exact');
  const two = map.entities.find(e => e.key === 'team:2');
  assert.deepEqual([linkOf(two, 'chat', 'chat_speaker').confidence, linkOf(two, 'chat', 'chat_speaker').trusted], ['likely', false]);
  const three = map.entities.find(e => e.key === 'team:3');
  assert.equal(linkOf(three, 'chat', 'chat_speaker'), undefined, 'unmatched stays unlinked');
  const text = JSON.stringify(map.entities);
  assert.ok(!text.includes('+1555'), 'no handle anywhere in the map');
});

test('entity map: every source reports its state; unresolved and ambiguous are counted, never guessed', noLink, () => {
  const { sources } = emap.buildEntityMap(LEAGUE);
  assert.equal(sources.espn.status, 'ok');
  assert.equal(sources.espn.unresolved_n, 1, 'an ESPN id with no players row');
  assert.equal(sources.chat.ambiguous_n, 1, 'two players share the name');
  assert.equal(sources.chat.unresolved_n, 1);
  assert.equal(sources.screenshots.status, 'unknown');
  assert.match(sources.screenshots.reason, /screenshot_proposals/);
  assert.equal(sources.sleeper.linked_n, 1);
});

test('entity map: the chat DB missing is typed unknown, not zero', noLink, async () => {
  await withEnv({ GRIDIRON_CHAT_DB_PATH: path.join(temp, 'absent.sqlite') }, () => {
    const map = emap.buildEntityMap(LEAGUE);
    assert.equal(map.sources.chat.status, 'unknown');
    assert.equal(linkOf(map.entities.find(e => e.key === 'team:1'), 'chat', 'chat_handle'), undefined);
  });
});

test('entity map: resolveEntity takes keys, roster ids, "K. Bell", team names and person names; ambiguity is typed', noLink, () => {
  const map = emap.buildEntityMap(LEAGUE);
  assert.equal(emap.resolveEntity(map, 'C. Ruiz').entity.key, `player:${RUIZ}`);
  assert.equal(emap.resolveEntity(map, 'kade bell').entity.key, `player:${BELL}`);
  assert.equal(emap.resolveEntity(map, '2').entity.key, 'team:2');
  assert.equal(emap.resolveEntity(map, 'Fixture Two').entity.key, 'team:2');
  assert.equal(emap.resolveEntity(map, 'Jordy Vale').entity.key, 'team:2', 'a chat name resolves, and is not returned');
  const amb = emap.resolveEntity(map, 'Sam Park');
  assert.equal(amb.status, 'unknown');
  assert.equal(amb.candidates_n, 2);
  assert.equal(emap.resolveEntity(map, 'Zed Nobody').status, 'unknown');
});

/* ------------------------------------------------------------ (2) connect */

test('connect: a player timeline across news, chat and trades, oldest first, labels only', noLink, () => {
  const rows = conn.connect({ league_id: LEAGUE, entity: 'C. Ruiz' });
  const [head] = rows;
  assert.equal(head.status, 'ok');
  assert.equal(head.player_name, 'Cole Ruiz');
  const events = rows.filter(r => r.row_kind === 'event');
  assert.deepEqual(events.map(e => e.source), ['chat', 'news', 'trade_outcomes', 'trade_outcomes', 'chat', 'news']);
  assert.equal(head.events_n, 6);
  const [fromAlex, , , resolved, fromJordy] = events;
  assert.equal(fromAlex.roster_id, '1', 'a trusted speaker link attributes');
  assert.equal(fromJordy.roster_id, null, 'a likely speaker link does not');
  assert.equal(fromJordy.speaker_link, 'likely');
  assert.deepEqual([resolved.kind, resolved.status], ['trade_resolved', 'declined']);
  const text = JSON.stringify(rows);
  for (const secret of ['SECRET', '+1555', 'Jordy', 'Alex Stone']) assert.ok(!text.includes(secret), `${secret} leaked`);
  for (const r of rows) for (const col of Object.keys(r)) assert.match(col, /^[A-Za-z_][A-Za-z0-9_]*$/);
});

test('connect: as_of keeps what was known then and counts what came after', noLink, () => {
  const [head, ...rest] = conn.connect({ league_id: LEAGUE, entity: `player:${RUIZ}`, as_of: '2026-09-19T00:00:00Z' });
  assert.equal(head.as_of, '2026-09-19T00:00:00.000Z');
  assert.equal(head.events_n, 2);
  assert.equal(head.events_after_as_of_n, 4);
  assert.ok(rest.filter(r => r.row_kind === 'event').every(e => Date.parse(e.at.replace(' ', 'T') + (e.at.includes('Z') ? '' : 'Z')) <= Date.parse(head.as_of)));
  assert.throws(() => conn.connect({ league_id: LEAGUE, entity: 'C. Ruiz', as_of: 'not a date' }), conn.LinkToolInputError);
});

test('connect: a team timeline attributes chat only through a trusted link', noLink, () => {
  const one = conn.connect({ league_id: LEAGUE, entity: 'Fixture One' });
  const chatEvents = one.filter(r => r.source === 'chat');
  assert.equal(chatEvents.length, 3, 'labels at or above 0.5 only');
  assert.ok(chatEvents.some(e => e.player_name === 'Cole Ruiz'));
  assert.equal(one.filter(r => r.source === 'trade_outcomes').length, 2);
  const two = conn.connect({ league_id: LEAGUE, entity: 'team:2' });
  assert.equal(two.filter(r => r.source === 'chat').length, 0);
  assert.match(two[0].note, /below trusted/);
});

test('connect: screenshot trades join the timeline once SHOT-01\'s table exists', noLink, () => {
  db.exec(`CREATE TABLE screenshot_proposals (id INTEGER PRIMARY KEY, league_id INTEGER, partner_roster_id TEXT,
             give_json TEXT, get_json TEXT, status TEXT, captured_at TEXT)`);
  try {
    run(`INSERT INTO screenshot_proposals (league_id, partner_roster_id, give_json, get_json, status, captured_at)
         VALUES (?, '2', ?, ?, 'pending', '2026-09-21T09:00:00Z')`, LEAGUE, JSON.stringify([3001]), JSON.stringify([{ name: 'Cole Ruiz' }]));
    const map = emap.buildEntityMap(LEAGUE);
    assert.equal(map.sources.screenshots.status, 'ok');
    assert.equal(linkOf(map.entities.find(e => e.key === 'team:2'), 'screenshot', 'screenshot_team').confidence, 'exact');
    assert.equal(linkOf(map.entities.find(e => e.key === `player:${RUIZ}`), 'screenshot', 'screenshot_player').confidence, 'name');
    const shots = conn.connect({ league_id: LEAGUE, entity: 'C. Ruiz' }).filter(r => r.source === 'screenshot');
    assert.equal(shots.length, 1);
    assert.equal(shots[0].label, 'player on the get side');
  } finally { db.exec('DROP TABLE screenshot_proposals'); }
});

test('connect: nothing found is typed unknown; a missing entity is a tool error', noLink, async () => {
  const [r] = conn.connect({ league_id: LEAGUE, entity: 'Zed Nobody' });
  assert.equal(r.status, 'unknown');
  assert.throws(() => conn.connect({ league_id: LEAGUE }), conn.LinkToolInputError);
  await withEnv(LINK_ON, () => assert.throws(
    () => tools.runCoachTool('connect', { league_id: LEAGUE }, { ledger: newLedger() }), tools.CoachToolError));
});

/* ------------------------------------------------------------ flag */

test('flag: off offers neither tool; own flag or preview offers both; =0 vetoes preview', noLink, async () => {
  await withEnv({ GRIDIRON_COACH_LINK: undefined }, () => {
    const names = tools.toolDefinitions().map(t => t.name);
    assert.ok(!names.includes('connect') && !names.includes('recall'));
  });
  await withEnv({ GRIDIRON_COACH_LINK: '1' }, () => {
    const names = tools.toolDefinitions().map(t => t.name);
    assert.ok(names.includes('connect') && names.includes('recall'));
  });
  await withEnv({ GRIDIRON_PREVIEW_UNCONFIRMED: '1', GRIDIRON_COACH_LINK: undefined }, () => assert.equal(emap.linkOn(), true));
  await withEnv({ GRIDIRON_PREVIEW_UNCONFIRMED: '1', GRIDIRON_COACH_LINK: '0' }, () => assert.equal(emap.linkOn(), false));
});

/* ------------------------------------------------------------ (3) answer memory + the metric */

const usage = { input_tokens: 10, output_tokens: 10 };
const says = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage });

/** Round 1: call spec.tool. Round 2: write only the cells spec names, cited; else refuse. */
function standIn(spec) {
  return { messages: { create: async body => {
    const last = body.messages.at(-1);
    const result = (Array.isArray(last.content) ? last.content : []).find(b => b.type === 'tool_result');
    if (!result) {
      if (body.messages.length > 1) return says({ claims: [], refusals: ['could not ground it'], as_of: null });
      return { content: [{ type: 'tool_use', id: 'tu1', name: spec.tool, input: { league_id: LEAGUE, ...spec.input } }],
        stop_reason: 'tool_use', usage };
    }
    let summary = null;
    try { summary = JSON.parse(result.content); } catch { summary = null; }
    if (result.is_error || !summary?.rows?.length) return says({ claims: [], refusals: [`${spec.tool}: ${summary?.error ?? 'no rows'}`], as_of: null });
    const index = spec.row ? spec.row(summary.rows) : 0;
    const row = summary.rows[index];
    if (!row || row.status === 'unknown') return says({ claims: [], refusals: [`${spec.tool}: ${row?.reason ?? 'no row'}`], as_of: null });
    const claims = spec.claims.filter(c => c.cols.every(col => row[col] !== undefined && row[col] !== null))
      .map(c => ({ text: c.text(c.cols.map(col => row[col])), cites: c.cols.map(col => `${summary.cite_prefix}${index}.${col}`) }));
    return says({ claims, refusals: claims.length ? [] : ['the tool did not carry that'], as_of: null });
  } } };
}

async function ask(spec) {
  setAnthropicClientForTesting(standIn(spec));
  try { return await askCoach({ question: spec.q, leagueId: LEAGUE }); } finally { setAnthropicClientForTesting(null); }
}

const pct = v => `${Math.round(Number(v) * 1000) / 10}%`;
const PYES = { q: 'What is P(yes) of step 1?', tool: 'plan_read', input: { section: 'next_move' },
  claims: [{ cols: ['next_move_steps_0_p_yes_value'], text: ([p]) => `He says yes about ${pct(p)} of the time.` }] };
const NEXT = { q: 'What is my next move?', tool: 'plan_read', input: { section: 'next_move' },
  claims: [{ cols: ['next_move_steps_0_give_0_name', 'next_move_steps_0_get_0_name'], text: ([g, t]) => `Offer ${g} to get ${t}.` }] };
const ev = pred => rows => rows.findIndex(pred);

test('memory: a grounded answer is kept with its served numbers, sources and stamps; a failed one is not', noLink, async () => {
  await withEnv(LINK_ON, async () => {
    const good = await ask(PYES);
    assert.equal(good.verification.ok, true);
    assert.ok(Number.isInteger(good.memory_id));
    const m = mem.memoryRow(good.memory_id);
    assert.deepEqual(JSON.parse(m.served_json).map(s => [s.value, s.tool]), [[0.38, 'plan_read']]);
    assert.ok('warroom_plans_file' in JSON.parse(m.stamps_json));
    const bad = await ask({ ...PYES, claims: [{ cols: ['next_move_steps_0_p_yes_value'], text: () => 'He says yes 61% of the time.' }] });
    assert.equal(bad.verification.ok, false);
    assert.equal(bad.memory_id, null);
  });
  await withEnv({ GRIDIRON_COACH_BRAIN_TOOLS: '1', GRIDIRON_COACH_LINK: undefined }, async () => {
    assert.equal((await ask(PYES)).memory_id, null, 'flag off: nothing is kept');
  });
});

test('memory: recall finds a fresh answer by question or entity; its number restates with a cite', noLink, async () => {
  await withEnv(LINK_ON, async () => {
    await ask(NEXT);
    const byQuestion = mem.recall({ league_id: LEAGUE, query: 'P(yes) step 1' });
    assert.equal(byQuestion[0].stale, false);
    assert.equal(byQuestion[0].served_0_value, 0.38);
    const byEntity = mem.recall({ league_id: LEAGUE, entity: 'M. Oduya' });
    assert.equal(byEntity[0].question, 'What is my next move?');
    const ledger = newLedger();
    tools.runCoachTool('recall', { league_id: LEAGUE, query: 'P(yes) step 1', limit: 1 }, { ledger });
    const v = verifyAnswer({ ledger, answer: { claims: [
      { text: 'Coach said he says yes about 38% of the time.', cites: ['r1#0.served_0_value'] },
      { text: 'He says yes about 38% of the time.', cites: ['r1#0.claim_text'] }] } });
    assert.equal(v.ok, true, JSON.stringify(v.violations));
  });
});

test('memory: a changed source marks the answer stale and withholds its numbers; so does age', noLink, async () => {
  await withEnv(LINK_ON, async () => {
    writePlans({ ...plansDoc, generated_at: '2026-09-25T06:00:00.000Z' });
    try {
      const [r] = mem.recall({ league_id: LEAGUE, query: 'P(yes) step 1' });
      assert.equal(r.stale, true);
      assert.match(r.stale_reason, /warroom_plans_file changed/);
      assert.equal(r.claim_text, undefined);
      assert.equal(r.served_0_value, undefined);
      const ledger = newLedger();
      tools.runCoachTool('recall', { league_id: LEAGUE, query: 'P(yes) step 1', limit: 1 }, { ledger });
      const v = verifyAnswer({ ledger, answer: { claims: [
        { text: 'He says yes about 38% of the time.', cites: ['r1#0.stale_claim_text'] }] } });
      assert.deepEqual(v.violations.map(x => x.kind), ['ungrounded_number'], 'a stale number never restates from memory');
    } finally { writePlans(plansDoc); }
    const later = Date.now() + 8 * 86_400_000;
    const [old] = mem.recall({ league_id: LEAGUE, query: 'P(yes) step 1' }, { now: later });
    assert.deepEqual([old.stale, old.stale_reason], [true, 'older than 7 days']);
  });
});

test('memory: an answer that stands only on recall is not kept again; no match is typed', noLink, async () => {
  await withEnv(LINK_ON, async () => {
    const again = await ask({ q: 'What did Coach say about P(yes)?', tool: 'recall', input: { query: 'P(yes) step 1' },
      claims: [{ cols: ['claim_text'], text: ([t]) => t }] });
    assert.equal(again.verification.ok, true);
    assert.equal(again.memory_id, null);
    const [none] = mem.recall({ league_id: LEAGUE, query: 'zebra crossing' });
    assert.equal(none.status, 'unknown');
    assert.throws(() => mem.recall({ league_id: LEAGUE }), conn.LinkToolInputError);
  });
});

const QUESTIONS = [
  { q: 'What has happened with C. Ruiz?', tool: 'connect', input: { entity: 'C. Ruiz' },
    claims: [{ cols: ['player_name', 'events_n'], text: ([p, n]) => `${p} has ${n} events on file across sources.` }] },
  { q: 'What did we know about C. Ruiz on the 19th?', tool: 'connect', input: { entity: 'C. Ruiz', as_of: '2026-09-19T00:00:00Z' },
    claims: [{ cols: ['events_n', 'events_after_as_of_n'], text: ([n, a]) => `${n} events were known then; ${a} came after.` }] },
  { q: 'What came of the C. Ruiz trade?', tool: 'connect', input: { entity: 'C. Ruiz' }, row: ev(r => r.kind === 'trade_resolved'),
    claims: [{ cols: ['status', 'roster_id', 'partner_roster_id'], text: ([s, a, b]) => `Team ${a}'s offer to team ${b} was ${s}.` }] },
  { q: 'Is team 1 linked to the chat?', tool: 'connect', input: { entity: 'team:1' }, row: ev(r => r.id_space === 'chat_speaker'),
    claims: [{ cols: ['confidence', 'method'], text: ([c, m]) => `Yes, ${c}: ${m}.` }] },
  { q: 'Can I trust team 2\'s chat link?', tool: 'connect', input: { entity: 'team:2' }, row: ev(r => r.id_space === 'chat_speaker'),
    claims: [{ cols: ['confidence'], text: ([c]) => `Not yet: the link is only ${c}.` }] },
  { q: 'What did Coach say about P(yes)?', tool: 'recall', input: { query: 'P(yes) step 1' },
    claims: [{ cols: ['claim_text', 'age_days'], text: ([t, d]) => `${d} days ago Coach said: ${t}` }] },
  { q: 'What did Coach say about M. Oduya?', tool: 'recall', input: { entity: 'M. Oduya' },
    claims: [{ cols: ['claim_text'], text: ([t]) => `Coach said: ${t}` }] },
  { q: 'Is that old answer still good?', tool: 'recall', input: { query: 'next move' },
    claims: [{ cols: ['stale'], text: ([s]) => (s ? 'It is out of date.' : 'It still stands.') }] }
];

test('METRIC: 8-question league-4 set answered from connect/recall with 0 unverified numbers or players', async () => {
  const UNVERIFIED = new Set(['ungrounded_number', 'ungrounded_player', 'bad_cite', 'uncited_claim']);
  const results = await withEnv(LINK_ON, async () => {
    if (mem) { await ask(PYES); await ask(NEXT); }
    const out = [];
    for (const spec of QUESTIONS) {
      const r = await ask(spec);
      const unverified = (r.verification?.violations ?? []).filter(v => UNVERIFIED.has(v.kind)).length;
      out.push({ q: spec.q, answered: r.answer.claims.length > 0 && r.verification.ok && unverified === 0, unverified,
        refusals: r.answer.refusals });
    }
    return out;
  });
  const answered = results.filter(r => r.answered).length;
  const unverified = results.reduce((a, r) => a + r.unverified, 0);
  console.log(`COACH_LINK_METRIC answered=${answered}/${QUESTIONS.length} unverified_in_answers=${unverified}`);
  for (const r of results) console.log(`  ${r.answered ? 'ANSWERED' : 'NOT     '} ${r.q}${r.answered ? '' : ` -- ${r.refusals.join(' | ')}`}`);
  if (emap) {
    const map = emap.buildEntityMap(LEAGUE);
    const links = map.entities.flatMap(e => e.links);
    console.log(`COACH_LINK_MAP entities=${map.entities.length} links=${links.length} trusted=${links.filter(l => l.trusted).length}`);
  }
  assert.equal(answered, QUESTIONS.length, `answered ${answered}/${QUESTIONS.length}`);
  assert.equal(unverified, 0);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
