/**
 * NEGOTIATOR-SAFETY (a) + (b) on Coach's live negotiation copilot (coach/negotiator.js), deep-queue item 11.
 *
 * Same made-up league and plan as test/coach-negotiator.test.js (the contract producer's league 4, the
 * made-up adapter as the engine). With GRIDIRON_NEGOTIATOR_SAFETY=1:
 *   (a) Coach says take or counter-with only on the engine's re-price of the package it names. With the
 *       engine removed it gives no verdict and drafts nothing; the walk-away rule still walks.
 *   (b) every draft goes through the message filter; a counter the engine prices below the plan's backup
 *       is never drafted (the backup is worth more: walk).
 * Flag off, the same replies behave as before (the pre-registration's flag-off check).
 * No real data, no model calls, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-neg-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_NEGOTIATE;
delete process.env.GRIDIRON_COACH_NAV;
delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;
delete process.env.GRIDIRON_NEGOTIATOR_SAFETY;

const LEAGUE = 4;

/** Letters-only names for the made-up league (real names carry no digits). */
const NAMES = {
  1: 'A. Aaron', 2: 'B. Brook', 3: 'C. Cole', 4: 'D. Dell', 5: 'E. Eads', 6: 'F. Frye', 7: 'G. Gore',
  11: 'H. Hale', 12: 'I. Irons', 13: 'J. Jett', 14: 'L. Lamb', 15: 'N. Nash',
  21: 'K. Knox', 22: 'L. Lane', 23: 'O. Ortiz', 24: 'Q. Quinn', 25: 'M. Moss',
  31: 'R. Rios', 32: 'S. Sims', 33: 'T. Tate', 34: 'U. Upton', 35: 'V. Vance'
};
const PRODUCER = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
const renamed = JSON.parse(JSON.stringify(PRODUCER.leagues.find(l => l.league === LEAGUE))
  .replace(/\bP(\d{1,2})\b/g, (m, id) => NAMES[id] ?? m));
const PLANS = { ...PRODUCER, leagues: PRODUCER.leagues.map(l => (l.league === LEAGUE ? renamed : l)) };
const plansFile = path.join(temp, 'plans.json');
fs.writeFileSync(plansFile, JSON.stringify(PLANS));
process.env.GRIDIRON_WARROOM_PLANS = plansFile;

const { db, run, row } = await import('../server/db/index.js');
const { priceForRules } = await import('./fixtures/rule-gate.mjs');
await (await import('../server/db/migrate.js')).runMigrations();
const { newLedger } = await import('../server/services/coach/ledger.js');
const tools = await import('../server/services/coach/tools.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const neg = await import('../server/services/coach/negotiator.js');

run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (${LEAGUE}, 'espn', 'neg-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
// RULES-EVERYWHERE: the made-up league priced for Nick's rule gate (Nick's P1-P7 low, the rest high);
// the rules themselves are covered by test/rules-everywhere.test.js.
priceForRules(db, { leagueId: LEAGUE, mine: [1, 2, 3, 4, 5, 6, 7], theirs: [11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35] });

const ADAPTER = makeAdapter();
const withEngine = () => neg.setNegotiatorSources({ engine: id => (id === LEAGUE ? ADAPTER : null) });
const noEngine = () => neg.setNegotiatorSources({ engine: () => null });

function withEnv(vars, fn) {
  const was = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const ask = (reply, safety = '1') => withEnv({ GRIDIRON_COACH_NEGOTIATE: '1', GRIDIRON_NEGOTIATOR_SAFETY: safety },
  () => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply }, { ledger: newLedger() }));

const LOWBALL = "I'd do Moss instead of Knox for your Dell and Frye";
const INSIDE = 'How about just Dell for Knox?';
const RICHER = "Make it Dell and Gore for Knox and it's done";
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

test('(a) engine present: a take carries the engine price of his package; the counter-with carries the price of ours', () => {
  withEngine();
  const take = ask(INSIDE).summary;
  assert.equal(take.recommendation.do, 'take');
  const his = take.reprice.find(p => p.package === 'his_counter');
  assert.ok(his && Number.isFinite(his.title_after) && sameSet(his.give, ['4']) && sameSet(his.get, ['21']));
  assert.match(take.draft, /Deal/);

  const low = ask(LOWBALL).summary;
  const ours = low.reprice.find(p => p.package === 'counter_with');
  if (low.recommendation.do === 'counter') {
    assert.ok(ours && Number.isFinite(ours.title_after), 'a counter-with names its engine price');
    assert.ok(low.draft, 'priced, above the backup: drafted');
  } else {
    // (b) the engine priced our counter below the backup: never drafted, walk to the backup.
    assert.equal(low.recommendation.do, 'walk');
    assert.deepEqual(low.recommendation.filtered, ['worse_than_plan']);
    assert.equal(low.draft, null);
  }
});

test('(a) engine removed: no take and no counter-with, no draft; the walk-away rule still walks', () => {
  noEngine();
  try {
    for (const reply of [INSIDE, LOWBALL]) {
      const s = ask(reply).summary;
      assert.equal(s.kind, 'counter');
      // No verdict: either 'wait' (held for the engine) or none at all (a player it cannot place without the engine).
      assert.ok(!['take', 'counter'].includes(s.recommendation?.do), `${reply} -> ${s.recommendation?.do}`);
      if (s.recommendation) assert.match(s.recommendation.held, /_unpriced$/);
      assert.equal(s.draft, null);
      assert.equal(s.reprice.length, 0);
      assert.ok(s.refusals.some(r => /no call on this counter/.test(r)));
      assert.ok(s.grounded);
    }
    // A richer ask is never taken: walk (the plan's rule) or no call when the engine cannot place a player.
    const walk = ask(RICHER).summary;
    assert.ok([undefined, 'walk'].includes(walk.recommendation?.do));
    assert.equal(walk.draft === null || !/deal|accept/i.test(walk.draft), true);
  } finally { withEngine(); }
});

test('flag off, engine removed: the same counter is judged on the walk-away alone (as before this unit)', () => {
  noEngine();
  try {
    const s = ask(INSIDE, null).summary;
    assert.equal(s.recommendation.do, 'take');
    assert.match(s.recommendation.because, /not re-priced/);
  } finally { withEngine(); }
});

test('(b) the lowball\'s counter-with is checked against the backup: the verdict and the filter agree', () => {
  withEngine();
  const s = ask(LOWBALL).summary;
  const ours = s.reprice.find(p => p.package === 'counter_with');
  assert.ok(ours, 'the engine priced the counter Coach considered');
  const backup = 0.4879062333328974; // the fixture plan's decline row odds_after
  if (ours.title_after < backup) assert.equal(s.recommendation.do, 'walk');
  else assert.equal(s.recommendation.do, 'counter');
});

test('(b) Coach free-text drafts: a pressure line is refused with the flag on, kept with it off', () => {
  const draft = { type: 'draft_message', text: 'Last chance, I have other offers on the table.', tone: 'neutral' };
  const on = withEnv({ GRIDIRON_NEGOTIATOR_SAFETY: '1' }, () => tools.runCoachTool('warroom_draft_message', draft));
  assert.equal(on.dropped_by_rule, 1);
  assert.deepEqual(on.summary.filtered, ['pressure']);
  const off = withEnv({ GRIDIRON_NEGOTIATOR_SAFETY: null }, () => tools.runCoachTool('warroom_draft_message', draft));
  assert.ok(off.action, 'flag off: the draft reaches the dock as before');
});
