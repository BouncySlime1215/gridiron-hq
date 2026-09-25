/**
 * COACH-PARTNER: "gimme a trade to send to <manager>" is a request for a trade
 * IDEA aimed at one league-mate, not a request for Coach to send anything.
 *
 * Pinned here:
 *   - the send refusal fires only when Coach is asked to do the sending
 *     ("send it for me", "submit it", "propose it on ESPN"), never when "send"
 *     is what Nick will do ("a trade to send to <manager>")
 *   - a partner-scoped question resolves the manager by ESPN name, first name
 *     or team name from the identity table (league_member_identity), never a
 *     hard-coded list, and answers from the War Room plans file: the best
 *     served plan through him, else the best flip leg with him, else the
 *     partners read of him plus an honest "nothing clears with him"
 *   - every claim is cited and grounded, $0, no model call
 *   - "what else u got" / "next one" / "something else" answer the next
 *     alternative in the deck, in full, and move the deck with it
 * Names below are made up (public repo). Plans from the producer fixture (FIX-03).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-partner-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';

const FIXTURE = new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url);
const PLANS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const plans = () => structuredClone(PLANS);
const PLANS_FILE = path.join(temp, 'plans.json');
const writePlans = file => fs.writeFileSync(PLANS_FILE, JSON.stringify(file));
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
writePlans(plans());

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { routeIntent } = await import('../server/services/warroom-actions/intent.js');
const { resolvePartner } = await import('../server/services/coach/partner.js');

/* ------------------------------------------------ made-up identity table */
run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
const IDENTITIES = [
  ['1', 'Nico Tester', 'Tester Tigers', null],
  ['2', 'Barnaby Finch', 'Finch Falcons', null],
  ['3', 'Quincy Marlowe', 'Marlowe Mariners', 'Q Marlowe'],
  ['4', 'Delphine Oakes', 'Oakes Owls', null]
];
for (const [roster, espn, team, chat] of IDENTITIES) {
  run(`INSERT OR REPLACE INTO league_member_identity (league_id, roster_id, espn_name, team_name, chat_name, match_method, confidence)
       VALUES (4, ?, ?, ?, ?, 'fixture', 'confirmed')`, roster, espn, team, chat);
}

const READERS = 40;
for (let i = 0; i < READERS; i++) {
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, ?, 'Reader')`, 9601 + i, `coach-partner-${i}`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
       VALUES (?, ?, datetime('now','+1 day'))`, 9601 + i, hashSessionToken(`partner-token-${i}`));
}
let reader = 0;
let modelCalls = 0;
setAnthropicClientForTesting({ messages: { create: async () => { modelCalls += 1; throw new Error('no model in this test'); } } });

const app = express();
app.use(express.json());
app.use('/api/coach', coachRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/coach`;
test.after(() => { server.close(); setAnthropicClientForTesting(null); fs.rmSync(temp, { recursive: true, force: true }); });

const ask = async (question, leagueId = 4) => (await fetch(`${base}/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer partner-token-${reader++ % READERS}` },
  body: JSON.stringify({ question, league_id: leagueId,
    context: { surface: 'war_room', route: '/trade-brain?view=war-room', league: leagueId } }) })).json();
const texts = body => (body.answer?.claims ?? []).map(c => c.text).join('\n');

function citesResolve(body) {
  const cells = new Set();
  for (const q of body.ledger?.queries ?? []) (q.rows ?? []).forEach((row, i) => Object.keys(row).forEach(k => cells.add(`${q.id}#${i}.${k}`)));
  for (const d of body.ledger?.derived ?? []) cells.add(d.id);
  return (body.answer?.claims ?? []).every(c => c.cites.length && c.cites.every(x => cells.has(x)));
}
const grounded = body => {
  assert.equal(body.verification?.ok, true, JSON.stringify(body.verification));
  assert.equal(body.verification?.dropped ?? 0, 0, JSON.stringify(body.dropped));
  assert.ok(citesResolve(body), 'every cite resolves');
  assert.equal(body.cost_usd, 0);
};

/* ------------------------------------------------------ send refusal */

test('Coach refuses only when asked to do the sending itself', () => {
  for (const q of ['send it for me', 'Send it for me please', 'submit it', 'propose it on ESPN',
    'send the offer to team 7', 'can you send it to him', 'go ahead and send it', 'message him for me']) {
    assert.ok(routeIntent(q)?.refuse, `should refuse: ${q}`);
  }
  for (const q of ['gimme a trade to send to Quincy', "what's a trade you like to send to Quincy",
    'what should I send to Delphine', 'what trade would you send to the Oakes Owls', 'any offer I can send Barnaby?']) {
    assert.equal(routeIntent(q)?.refuse, undefined, `should not refuse: ${q}`);
  }
});

/* -------------------------------------------------- partner resolution */

test('the partner is resolved from the identity rows by name, first name or team name; Nick himself never', () => {
  const entry = PLANS.leagues.find(e => e.league === 4);
  const identities = IDENTITIES.map(([roster_id, espn_name, team_name, chat_name]) => ({ roster_id, espn_name, team_name, chat_name }));
  const r = q => resolvePartner(q, { entry, identities });
  assert.equal(r('gimme a trade to send to quincy').roster, '3');
  assert.equal(r('a trade for Quincy Marlowe?').roster, '3');
  assert.equal(r("what would the Marlowe Mariners take").roster, '3');
  assert.equal(r("what's Delphine's price").roster, '4');
  assert.equal(r('trade with team 2').roster, '2');
  assert.equal(r('a trade to send to Nico'), null, 'Nick is not a partner');
  assert.equal(r('a trade to send to Zebulon'), null, 'an unknown name resolves to nobody');
  // A manager who shares a first name with a player: the player named in full is not the manager.
  const clash = { ...entry, names: { ...entry.names, 99: 'Quincy Harlow (WR)' } };
  assert.equal(resolvePartner('a trade for Quincy Harlow', { entry: clash, identities }), null);
  assert.equal(resolvePartner('a trade to send to Quincy', { entry: clash, identities }).roster, '3');
});

/* ------------------------------------------------------- partner answer */

test('"gimme a trade to send to <manager>" answers with the served plan through him, not a refusal', async () => {
  const body = await ask('gimme a trade to send to Quincy');
  const t = texts(body);
  assert.deepEqual(body.answer.refusals, []);
  assert.doesNotMatch(t, /never sends/i);
  assert.match(t, /Quincy Marlowe \(Marlowe Mariners\)/);
  assert.match(t, /P4 \(WR\) \+ P6 \(RB\) for P21 \(WR\)/);
  assert.match(t, /Chance he says yes: 53%, a guess/);
  assert.match(t, /\+11\.6 pts/);
  grounded(body);
  assert.equal(modelCalls, 0);
});

test('"what\'s a trade you like to send to <team name>" resolves the team name the same way', async () => {
  const body = await ask("what's a trade you like to send to the marlowe mariners");
  assert.match(texts(body), /P4 \(WR\) \+ P6 \(RB\) for P21 \(WR\)/);
  grounded(body);
});

test('no served plan through him: the best flip leg with him', async () => {
  const body = await ask('gimme a trade to send to Delphine');
  const t = texts(body);
  assert.match(t, /No served plan goes through Delphine Oakes/);
  assert.match(t, /flip/i);
  assert.match(t, /P22 \(QB\)/);
  grounded(body);
});

test('nothing with him at all: his partners read and an honest "nothing clears with him"', async () => {
  const file = plans();
  const e = file.leagues.find(x => x.league === 4);
  e.flip_map.value = e.flip_map.value.filter(f => f.buy_from !== '2' && f.sell_to !== '2');
  writePlans(file);
  try {
    const body = await ask('any trade I can send to Barnaby?');
    const t = texts(body);
    assert.match(t, /No fair trade with Barnaby Finch \(Finch Falcons\) clears your rules right now/);
    assert.match(t, /15% chance he responds/);
    assert.match(t, /needs WR/i);
    grounded(body);
  } finally { writePlans(plans()); }
});

test('a name nobody has falls through to the ordinary answer, never a guess', async () => {
  const body = await ask("what's the best trade to send to Zebulon");
  assert.doesNotMatch(texts(body), /Zebulon/);
  assert.equal(body.cost_usd, 0);
});

/* ---------------------------------------------------------- what else */

test('"what else u got" answers the next alternative in the deck, in full, and moves the deck', async () => {
  await ask("What's my next move and why?");
  const body = await ask("i don't like that, what else u got");
  const t = texts(body);
  assert.deepEqual(body.answer.refusals, []);
  assert.match(t, /P4 \(WR\) \+ P5 \(TE\) for P21 \(WR\)/, 'alternative 2, not the next move again');
  assert.match(t, /Chance he says yes: 53%/);
  assert.deepEqual(body.actions.map(a => a.type), ['next']);
  grounded(body);
  const again = await ask('next one');
  assert.match(texts(again), /P5 \(TE\) \+ P7 \(WR\) for P21 \(WR\)/);
  grounded(again);
  const more = await ask('something else?');
  assert.match(texts(more), /P6 \(RB\) \+ P7 \(WR\) for P21 \(WR\)/);
});

test('past the last card: says so, and sends no deck move', async () => {
  await ask("What's my next move and why?");
  for (let i = 0; i < 4; i++) await ask('what else');
  const body = await ask('what else');
  assert.match(texts(body) + body.answer.refusals.join(' '), /last (move|alternative) in the deck/);
  assert.deepEqual(body.actions, []);
});

/* --------------------------------- the real plans file, when it is here */

const LOCAL = new URL('../.local-plans/plans.json', import.meta.url);
test('real plans copy (local only, never committed): every partner in every league gets a grounded answer', { skip: !fs.existsSync(LOCAL) }, async () => {
  const { partnerClaimsFor } = await import('../server/services/coach/partner.js');
  const { groundStarter } = await import('../server/services/coach/starter-answers.js');
  const { newLedger } = await import('../server/services/coach/ledger.js');
  const file = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  const shapes = {};
  let answered = 0;
  let total = 0;
  for (const entry of file.leagues) {
    for (const p of entry.partners?.value ?? []) {
      total += 1;
      const ledger = newLedger();
      const out = partnerClaimsFor({ entry, roster: String(p.team), label: `Team ${p.team}`, ledger });
      const g = groundStarter(out.claims, ledger);
      assert.deepEqual(g.dropped, [], `league ${entry.league} roster ${p.team}`);
      assert.ok(g.claims.length >= 1);
      shapes[out.source] = (shapes[out.source] ?? 0) + 1;
      answered += 1;
    }
  }
  console.log('# LOCAL ' + JSON.stringify({ answered: `${answered}/${total}`, shapes }));
});
