// RL-12-3: the player card (/api/players/:id news, also the AI Buy/Sell facts)
// and the News page (/api/news/desk player links) must agree on which stories
// are about a player. Before this unit the card ran its own substring LIKE
// (routes/players.js newsFor) while the desk read the ingest's resolved ids.
// Fixture names are invented so no real player or league appears.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-player-news-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await runMigrations();
seedIfEmpty();
const { default: newsRouter } = await import('../server/routes/news.js');
const { default: playersRouter } = await import('../server/routes/players.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const claude = await import('../server/services/claude.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO users (subject) VALUES ('player-news:desk')`);
const userId = row(`SELECT id FROM users WHERE subject='player-news:desk'`).id;
run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken('player-news-token'));

const app = express();
app.use(express.json());
app.use('/api/news', newsRouter);
app.use('/api/players', playersRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));

async function request(url, { token, method = 'GET' } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const req = new Readable({ read() { this.push(null); } });
  req.url = url; req.method = method; req.headers = headers;
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null }); };
    app.handle(req, res, reject);
  });
}

const teamId = abbr => row('SELECT id FROM nfl_teams WHERE abbr = ?', abbr).id;
const CAR = teamId('CAR'), PIT = teamId('PIT'), NYJ = teamId('NYJ');
const addPlayer = (name, position, team) => Number(run(
  `INSERT INTO players (name, position, team_id, fantasy_relevant) VALUES (?,?,?,1)`, name, position, team).lastInsertRowid);
const brook = addPlayer('Quarrel Brookhaven', 'RB', CAR);
const pitts = addPlayer('Marlon Pittsworth Jr.', 'WR', PIT);
const wex = addPlayer('Javonte Wexley', 'RB', NYJ);

const resolved = (...players) => JSON.stringify({ players: players.map(([id, name]) => ({ id, name, confidence: 1, method: 'alias_exact' })), teams: [] });
const addStory = ({ headline, team = null, date, published, entities = JSON.stringify({ players: [], teams: [] }) }) => Number(run(
  `INSERT INTO news_items (date, team_id, headline, importance, source, entities_json, published_at) VALUES (?,?,?,2,'fixture',?,?)`,
  date, team, headline, entities, published).lastInsertRowid);

// (a) resolved to Brookhaven by the ingest, surname-only headline, team_id NULL
const surgery = addStory({ headline: 'Sources: Panthers RB Brookhaven set for surgery', date: '2026-09-21',
  published: '2026-09-21T15:00:00.000Z', entities: resolved([brook, 'Quarrel Brookhaven']) });
// (b) surname fallback: resolver found nobody, team_id NULL, his team named in the headline
const outWeeks = addStory({ headline: "Panthers' Brookhaven out weeks", date: '2026-09-20',
  published: '2026-09-20T12:00:00.000Z' });
// (d) control: full-name headline, resolved
const fullName = addStory({ headline: 'Quarrel Brookhaven runs for 120 yards', date: '2026-09-20',
  published: '2026-09-20T20:00:00.000Z', entities: resolved([brook, 'Quarrel Brookhaven']) });
// (c) wrong-player rows the old matcher attached through the "Jr." token and a same-team namesake
const suffixStory = addStory({ headline: 'Steelers CB Dorian Vantreese Jr. limited at practice', team: PIT,
  date: '2026-09-21', published: '2026-09-21T10:00:00.000Z' });
const namesake = addStory({ headline: 'Jets DT Quinnen Wexley signs extension', team: NYJ,
  date: '2026-09-21', published: '2026-09-21T11:00:00.000Z' });
const firstNameUse = addStory({ headline: 'Jets waive TE Wexley Barnes', team: NYJ,
  date: '2026-09-19', published: '2026-09-19T11:00:00.000Z' });

const cardIds = async id => {
  const { status, payload } = await request(`/api/players/${id}`);
  assert.equal(status, 200);
  return payload.news.map(n => n.id);
};
const deskIdsFor = async id => {
  const { status, payload } = await request('/api/news/desk?limit=120', { token: 'player-news-token' });
  assert.equal(status, 200);
  return payload.stories.filter(s => (JSON.parse(s.entities_json).players ?? []).some(p => Number(p.id) === id)).map(s => s.id);
};

test('a story the ingest resolved to him reaches his card even when the headline has only his surname', async () => {
  assert.ok((await cardIds(brook)).includes(surgery), 'resolved surname-only story missing from the card');
});

test('surname fallback: his team named with his bare surname counts, suffix tokens and namesakes do not', async () => {
  assert.ok((await cardIds(brook)).includes(outWeeks), "\"Panthers' Brookhaven out weeks\" missing from the card");
  assert.ok(!(await cardIds(pitts)).includes(suffixStory), 'a "Jr." token matched a different player');
  assert.ok(!(await cardIds(wex)).includes(namesake), 'a same-team namesake (different first name) matched');
  assert.ok(!(await cardIds(wex)).includes(firstNameUse), 'his surname used as someone else\'s first name matched');
});

test('the card is newest-published first, and the full-name control still appears', async () => {
  assert.deepEqual(await cardIds(brook), [surgery, fullName, outWeeks]);
});

test('contract: the card and the News page list the same stories for the player', async () => {
  for (const id of [brook, pitts, wex]) {
    assert.deepEqual([...await cardIds(id)].sort((a, b) => a - b), [...await deskIdsFor(id)].sort((a, b) => a - b), `player ${id}`);
  }
});

test('the AI Buy/Sell evidence packet reads the same stories as the card', async () => {
  const prompts = [];
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  claude.setAnthropicClientForTesting({ messages: { create: async body => {
    prompts.push(body.messages[0].content);
    return { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"verdict":"HOLD","evidence_ids":[]}' }], usage: { input_tokens: 10, output_tokens: 5 } };
  } } });
  try {
    const { status } = await request(`/api/players/${brook}/analyze`, { method: 'POST' });
    assert.equal(status, 200);
    const packet = JSON.parse(prompts[0].match(/EVIDENCE: (.*)/)[1]);
    const newsFacts = packet.filter(fact => fact.id.startsWith('news.')).map(fact => fact.text);
    assert.deepEqual(newsFacts, ['[2026-09-21] Sources: Panthers RB Brookhaven set for surgery',
      '[2026-09-20] Quarrel Brookhaven runs for 120 yards', "[2026-09-20] Panthers' Brookhaven out weeks"]);
  } finally {
    claude.setAnthropicClientForTesting(null);
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});
