/**
 * COACH-ROLEPLAY (COACH-ANCHOR job 3): "what would he say?" and "how Nick comes
 * across". Pure functions over the plans contract, a counterpart model
 * (COUNTERPART-01 publicModel shape) and trade_outcomes-shaped rows; no DB,
 * no model call, no clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROLEPLAY_ENV, ROLEPLAY_LEAGUE_ID, SIMULATION_LABEL, M6_REPLY_PRIOR, REPLY_STYLES,
  roleplayFlag, replyMix, simulateReply, comesAcross, toneFlags, roleplay, ROLEPLAY_TOOL
} from '../server/services/coach/roleplay.js';
import { PREVIEW_ENV, PREVIEW_PREFIX } from '../server/services/preview-mode.js';

// The Coach-tool tests below open a DB; point it at a temp file before anything imports db/index.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-roleplay-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const PLANS = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8')).leagues[0];
const STEP = PLANS.alternatives.value[0].steps[0];
const NOW = '2026-09-24T12:00:00.000Z';
const DAY = 864e5;
const ago = d => new Date(Date.parse(NOW) - d * DAY).toISOString();

/** A counterpart model in COUNTERPART-01's publicModel shape. */
const cp = (over = {}) => ({
  team: STEP.partner, version: 'counterpart-01.1', status: 'ok', reason: null,
  wants: [{ player: '7', n: 3, lift: 0.9 }], untouchable: ['22'], shopping: ['23'],
  credibility: {
    untouchable: { value: 0.75, n: 2, kept: 2, broken: 0, open: 0, status: 'follow_through', basis: 'Beta(1,1) on 2 resolved untouchable claims (0 still open)' },
    shop: { value: 0.5, n: 0, kept: 0, broken: 0, open: 1, status: 'prior', basis: 'Beta(1,1) on 0 resolved shop claims (1 still open)' }
  },
  override: { status: 'ok', exclude: false, deprioritize: false, toughen: false, basis: null },
  reply_prior: { ...M6_REPLY_PRIOR, label: 'M6 reply prior' },
  ...over
});
const planDraft = { text: STEP.message.value, give: STEP.give, get: STEP.get };
const sum = m => REPLY_STYLES.reduce((s, k) => s + m[k], 0);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const withEnv = (env, fn) => {
  const keep = { [ROLEPLAY_ENV]: process.env[ROLEPLAY_ENV], [PREVIEW_ENV]: process.env[PREVIEW_ENV] };
  for (const k of Object.keys(keep)) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

/* ------------------------------------------------------------ flag */

test('the flag is off by default, on with its own switch, and on in preview mode with preview fields', () => {
  withEnv({}, () => assert.deepEqual(roleplayFlag(), { enabled: false, preview: false }));
  withEnv({ [ROLEPLAY_ENV]: '1' }, () => assert.deepEqual(roleplayFlag(), { enabled: true, preview: false }));
  withEnv({ [PREVIEW_ENV]: '1' }, () => assert.deepEqual(roleplayFlag(), { enabled: true, preview: true }));
  withEnv({ [ROLEPLAY_ENV]: 'true' }, () => assert.equal(roleplayFlag().enabled, false));
});

test('flag off: roleplay answers { enabled: false } and simulates nothing', () => {
  withEnv({}, () => {
    const r = roleplay({ leagueId: PLANS.league, plans: PLANS, team: STEP.partner, draft: planDraft, history: [], now: NOW });
    assert.deepEqual(r, { enabled: false });
  });
});

test('preview mode labels the simulation as a preview', () => {
  withEnv({ [PREVIEW_ENV]: '1' }, () => {
    const r = roleplay({ leagueId: PLANS.league, plans: PLANS, team: STEP.partner, draft: planDraft, history: [], now: NOW });
    assert.equal(r.preview, true);
    assert.ok(r.preview_reason);
    assert.ok(r.label.startsWith(PREVIEW_PREFIX), r.label);
  });
});

test('target league is leagues.id 4, and a plans section for another league is refused', () => {
  assert.equal(ROLEPLAY_LEAGUE_ID, 4);
  withEnv({ [ROLEPLAY_ENV]: '1' }, () => {
    assert.throws(() => roleplay({ leagueId: 4, plans: PLANS, team: STEP.partner, draft: planDraft, history: [], now: NOW }),
      /plans section is for league 1, not 4/);
  });
});

/* ------------------------------------------------------------ reply mix */

test('with no counterpart, no partner row and no plan step, the mix is the M6 prior and says so', () => {
  const r = replyMix({ team: '99', draft: { text: 'hi', give: [], get: [] } });
  for (const k of REPLY_STYLES) close(r.mix[k], M6_REPLY_PRIOR[k]);
  assert.equal(r.basis[0].feature, 'reply_prior');
  assert.match(r.basis[0].text, /league-wide/);
});

test('P(responds) comes from the plan\'s partners row: ignore = 1 - p_responds, the rest keeps prior proportions', () => {
  const partner = PLANS.partners.value.find(p => p.team === STEP.partner);
  const r = replyMix({ team: STEP.partner, partner, draft: { text: 'hi', give: [], get: [] } });
  close(r.mix.ignore, 1 - partner.p_responds);
  close(sum(r.mix), 1);
  close(r.mix.counter / r.mix.decline, M6_REPLY_PRIOR.counter / M6_REPLY_PRIOR.decline);
  assert.ok(r.basis.some(b => b.feature === 'p_responds' && b.source === 'campaign.plan'));
});

test('a draft that is the plan step takes accept from the engine\'s P(yes), capped at P(responds), and carries its guess badge', () => {
  const partner = PLANS.partners.value.find(p => p.team === STEP.partner);
  const r = replyMix({ team: STEP.partner, partner, step: STEP, draft: planDraft });
  close(r.mix.accept, Math.min(STEP.p_yes.value, partner.p_responds));
  close(sum(r.mix), 1);
  assert.equal(r.guess, STEP.p_yes.guess === true);
  assert.ok(r.basis.some(b => b.feature === 'p_yes' && b.source === STEP.p_yes.source));
});

test('a draft that differs from the plan step does not borrow its P(yes)', () => {
  const r = replyMix({ team: STEP.partner, step: STEP, draft: { text: 'x', give: [STEP.give[0]], get: STEP.get } });
  assert.ok(!r.basis.some(b => b.feature === 'p_yes'));
});

test('he wants a player Nick gives: accept goes up by the model\'s log-lift', () => {
  const base = replyMix({ team: STEP.partner, counterpart: cp({ wants: [] }), draft: { text: '', give: ['7'], get: ['21'] } });
  const up = replyMix({ team: STEP.partner, counterpart: cp(), draft: { text: '', give: ['7'], get: ['21'] } });
  assert.ok(up.mix.accept > base.mix.accept);
  assert.ok(up.basis.some(b => b.feature === 'wants_player' && b.player === '7'));
  close(sum(up.mix), 1);
});

test('asking for a player he called untouchable with credibility >= 0.5: accept is 0 (face cost)', () => {
  const r = replyMix({ team: STEP.partner, counterpart: cp(), draft: { text: '', give: ['5'], get: ['22'] } });
  assert.equal(r.mix.accept, 0);
  close(sum(r.mix), 1);
  assert.ok(r.basis.some(b => b.feature === 'untouchable_talk' && b.effect === 'exclude'));
});

test('a quiet manager (unknown profile) gets no chat feature: unknown is not neutral', () => {
  const r = replyMix({ team: STEP.partner, counterpart: cp({ status: 'unknown', reason: 'no confirmed chat identity' }),
    draft: { text: '', give: ['7'], get: ['22'] } });
  assert.ok(!r.basis.some(b => ['wants_player', 'untouchable_talk', 'shop_talk'].includes(b.feature)));
  assert.ok(r.basis.some(b => b.feature === 'profile' && /no confirmed chat identity/.test(b.text)));
});

test("Nick's deprioritize override halves P(responds) when it came from the prior", () => {
  const r = replyMix({ team: '9', counterpart: cp({ team: '9', override: { status: 'ok', deprioritize: true, basis: 'Nick: slow to answer' } }),
    draft: { text: '', give: [], get: [] } });
  close(1 - r.mix.ignore, (1 - M6_REPLY_PRIOR.ignore) * 0.5);
});

/* ------------------------------------------------------------ simulation */

test('simulateReply is labelled a simulation, seeded, and its draws follow the mix', () => {
  const args = { plans: PLANS, team: STEP.partner, draft: planDraft, counterpart: cp(), samples: 2000 };
  const a = simulateReply(args), b = simulateReply(args);
  assert.equal(a.simulation, true);
  assert.equal(a.label, SIMULATION_LABEL);
  assert.match(a.label, /simulation/i);
  assert.deepEqual(a.draws, b.draws, 'same inputs, same draws');
  assert.equal(REPLY_STYLES.reduce((s, k) => s + a.draws[k], 0), 2000);
  for (const k of REPLY_STYLES) assert.ok(Math.abs(a.draws[k] / 2000 - a.reply_mix[k]) < 0.04, k);
  assert.ok(REPLY_STYLES.includes(a.sampled.style));
  assert.ok(a.sampled.text.startsWith('Simulated'), a.sampled.text);
});

test('the sampled reply carries the plan\'s pre-planned answer for that branch', () => {
  const table = STEP.reply_table.value;
  for (let seed = 1; seed < 40; seed++) {
    const r = simulateReply({ plans: PLANS, team: STEP.partner, draft: planDraft, samples: 1, seed });
    const branch = r.sampled.style === 'ignore' ? 'silence' : r.sampled.style;
    if (table[branch]?.status === 'ok') assert.equal(r.sampled.planned_answer, table[branch].value.do);
  }
});

test('a counter names what he has said he wants from Nick, by roster name, not a quote', () => {
  let found = null;
  for (let seed = 1; seed < 200 && !found; seed++) {
    const r = simulateReply({ plans: PLANS, team: STEP.partner, draft: { text: '', give: ['5'], get: ['21'] },
      counterpart: cp({ wants: [{ player: '6', n: 2, lift: 0.4 }] }), samples: 1, seed });
    if (r.sampled.style === 'counter') found = r;
  }
  assert.ok(found, 'a counter was drawn');
  assert.match(found.sampled.text, new RegExp(PLANS.names['6'].replace(/[.()]/g, '\\$&')));
});

test('traits and credibility are cited as labels with their n, and a prior is said to be ungraded', () => {
  const r = simulateReply({ plans: PLANS, team: STEP.partner, draft: planDraft, counterpart: cp(), samples: 10 });
  assert.equal(r.credibility.untouchable.n, 2);
  assert.equal(r.credibility.shop.status, 'prior');
  assert.ok(r.traits.some(t => /not graded yet/.test(t.text)));
  const partner = PLANS.partners.value.find(p => p.team === STEP.partner);
  for (const l of partner.chat_labels ?? []) assert.ok(r.traits.some(t => t.label === l), l);
});

test('an excluded manager is never simulated: nick_override beats the model', () => {
  const r = simulateReply({ plans: PLANS, team: STEP.partner, draft: planDraft,
    counterpart: cp({ override: { status: 'ok', exclude: true, basis: 'Nick: not a buyer' } }) });
  assert.equal(r.status, 'blocked');
  assert.equal(r.sampled, null);
  assert.match(r.reason, /Nick: not a buyer/);
});

test('a manager who is not in this league is refused', () => {
  assert.throws(() => simulateReply({ plans: PLANS, team: PLANS.me, draft: planDraft }), /is you/);
  assert.throws(() => simulateReply({ plans: PLANS, team: '', draft: planDraft }), /team/);
});

/* ------------------------------------------------------------ how Nick comes across */

const offer = (daysAgo, status, extra = {}) => ({
  league_id: PLANS.league, source: 'app_proposed', proposer_team_id: PLANS.me, counterparty_team_id: STEP.partner,
  proposed_at: ago(daysAgo), resolved_at: status === 'proposed' ? null : ago(Math.max(0, daysAgo - 0.5)), status, ...extra
});

test("that's the third offer to him this week", () => {
  const r = comesAcross({ me: PLANS.me, team: STEP.partner, now: NOW, draft: planDraft,
    history: [offer(2, 'declined'), offer(5, 'declined'), offer(9, 'accepted'), offer(1, 'declined', { counterparty_team_id: '4' })] });
  assert.equal(r.offers_7d, 2);
  assert.equal(r.this_would_be, 3);
  const w = r.warnings.find(x => x.code === 'offer_count');
  assert.ok(w);
  assert.match(w.text, /third offer to him in 7 days/);
});

test('one earlier offer this week is noted, not warned', () => {
  const r = comesAcross({ me: PLANS.me, team: STEP.partner, now: NOW, draft: planDraft, history: [offer(3, 'accepted')] });
  assert.equal(r.this_would_be, 2);
  assert.equal(r.warnings.find(x => x.code === 'offer_count')?.severity, 'info');
});

test('decline streak and an unanswered open offer are both flagged', () => {
  const r = comesAcross({ me: PLANS.me, team: STEP.partner, now: NOW, draft: planDraft,
    history: [offer(20, 'declined'), offer(15, 'ignored'), offer(1, 'proposed')] });
  assert.equal(r.decline_streak, 2);
  assert.ok(r.warnings.some(w => w.code === 'decline_streak'));
  assert.ok(r.warnings.some(w => w.code === 'open_offer'));
});

test('offers from other teams, considered-only rows and future rows do not count', () => {
  const r = comesAcross({ me: PLANS.me, team: STEP.partner, now: NOW, draft: planDraft, history: [
    offer(1, 'declined', { proposer_team_id: '4', source: 'observed' }),
    offer(1, 'not_proposed', { source: 'considered_only' }),
    offer(-1, 'proposed')
  ] });
  assert.equal(r.offers_7d, 0);
  assert.equal(r.warnings.filter(w => w.code !== 'tone').length, 0);
});

test('tone flags: pressure, mocking, all caps, revealing need; a plain message has none', () => {
  assert.deepEqual(toneFlags(STEP.message.value), []);
  const codes = s => toneFlags(s).map(f => f.label).sort();
  assert.deepEqual(codes('Last chance, need an answer today'), ['pressure']);
  assert.deepEqual(codes('lol your team is a mess, this is a steal'), ['mocking']);
  assert.deepEqual(codes('DO THIS DEAL NOW'), ['all_caps']);
  assert.deepEqual(codes('I really need a RB, desperate here'), ['reveals_need']);
});

test('asking for a player he called untouchable is flagged as a face cost', () => {
  const r = comesAcross({ me: PLANS.me, team: STEP.partner, now: NOW, history: [], counterpart: cp(),
    draft: { text: 'hey', give: ['5'], get: ['22'] } });
  assert.ok(r.warnings.some(w => w.code === 'face_cost'));
});

test('warnings are labels and counts: no quote of any chat text', () => {
  const r = comesAcross({ me: PLANS.me, team: STEP.partner, now: NOW, draft: { text: 'Last chance lol', give: [], get: [] },
    history: [offer(2, 'declined'), offer(5, 'declined')] });
  for (const w of r.warnings) assert.ok(!w.text.includes('Last chance lol'), w.text);
});

/* ------------------------------------------------------------ end to end + tool */

test('roleplay (flag on) returns the simulation and the comes-across warnings together', () => {
  withEnv({ [ROLEPLAY_ENV]: '1' }, () => {
    const r = roleplay({ leagueId: PLANS.league, plans: PLANS, team: STEP.partner, draft: planDraft, counterpart: cp(),
      history: [offer(2, 'declined'), offer(5, 'declined')], now: NOW });
    assert.equal(r.enabled, true);
    assert.equal(r.simulation, true);
    assert.equal(r.label, SIMULATION_LABEL);
    assert.equal(r.comes_across.this_would_be, 3);
    assert.ok(!('preview' in r));
  });
});

test('the roleplay tool descriptor is read-only and never sends', () => {
  assert.equal(ROLEPLAY_TOOL.name, 'roleplay');
  assert.equal(ROLEPLAY_TOOL.writes, false);
  assert.match(ROLEPLAY_TOOL.description, /simulation/i);
  assert.match(ROLEPLAY_TOOL.description, /never sends/i);
});

test('the M6 prior matches COUNTERPART-01 when its model is in this tree', async t => {
  const f = new URL('../server/services/people/counterpart.js', import.meta.url);
  if (!fs.existsSync(f)) { t.skip('COUNTERPART-01 (#254) is not merged into this tree yet'); return; }
  const m = await import(f.href);
  assert.deepEqual({ ...M6_REPLY_PRIOR }, { ...m.M6_REPLY_PRIOR });
  assert.equal(m.UNTOUCHABLE_EXCLUDE, 0.5);
  assert.equal(m.SHOP_LOG_LIFT, 0.5);
});

/* ------------------------------------------------------------ Coach tool (league 4) */

const PLANS_FILE = path.join(temp, 'plans.json');
const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { runCoachTool, toolDefinitions, CoachToolError } = await import('../server/services/coach/tools.js');
const { newLedger } = await import('../server/services/coach/ledger.js');

run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'rp-4', 2026, 'Fixture', ?, 10, 1, '{}', '2026-09-23 01:00:00')`, PLANS.me);
const realAgo = d => new Date(Date.now() - d * DAY).toISOString();
for (const [d, status] of [[2, 'declined'], [4, 'declined']]) {
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
         proposed_at, model_p_accept, model_basis, status, resolved_at, created_at)
       VALUES (4, 2026, 'app_proposed', ?, ?, '[]', '[]', ?, 0.3, 'heuristic_unanchored', ?, ?, ?)`,
  PLANS.me, STEP.partner, realAgo(d), status, realAgo(d - 1), realAgo(d));
}
fs.writeFileSync(PLANS_FILE, JSON.stringify({ schema: 'warroom-plans/1', generated_at: NOW, leagues: [{ ...PLANS, league: 4 }] }));
const toolInput = { team: STEP.partner, text: STEP.message.value, give: STEP.give, get: STEP.get };
const withTool = (env, fn) => withEnv(env, () => {
  const keep = process.env.GRIDIRON_WARROOM_PLANS;
  process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
  try { return fn(); } finally { if (keep === undefined) delete process.env.GRIDIRON_WARROOM_PLANS; else process.env.GRIDIRON_WARROOM_PLANS = keep; }
});

test('flag off: Coach has no roleplay tool, on the War Room or anywhere else', () => {
  withTool({}, () => {
    assert.ok(!toolDefinitions({ warRoom: true }).some(t => t.name === 'roleplay'));
    assert.throws(() => runCoachTool('roleplay', toolInput, { ledger: newLedger() }), CoachToolError);
  });
});

test('flag on: the War Room surface gets the roleplay tool; other surfaces do not', () => {
  withTool({ [ROLEPLAY_ENV]: '1' }, () => {
    assert.equal(toolDefinitions({ warRoom: true }).filter(t => t.name === 'roleplay').length, 1);
    assert.ok(!toolDefinitions().some(t => t.name === 'roleplay'));
  });
});

test("Coach's roleplay tool reads league 4's plan and trade_outcomes, and its numbers enter the ledger", () => {
  withTool({ [ROLEPLAY_ENV]: '1' }, () => {
    const ledger = newLedger();
    const { entry, summary } = runCoachTool('roleplay', toolInput, { ledger });
    assert.ok(entry, 'recorded, so a number Coach says about it can be cited');
    const r = entry.rows[0];
    assert.match(r.label, /^Simulation/);
    assert.equal(r.status, 'ok');
    assert.equal(r.this_would_be, 3);
    assert.ok(Number.isFinite(r['reply_mix.accept']));
    assert.ok(Object.keys(r).some(k => k.startsWith('warnings.') && /third offer/.test(r[k])));
    assert.deepEqual(entry.tables, ['trade_outcomes', 'leagues']);
    assert.equal(summary.cite_prefix, `${entry.id}#`);
  });
});

test('no plans file: the tool answers unknown with a reason instead of failing', () => {
  withEnv({ [ROLEPLAY_ENV]: '1' }, () => {
    const keep = process.env.GRIDIRON_WARROOM_PLANS;
    process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'missing.json');
    try {
      const { entry } = runCoachTool('roleplay', toolInput, { ledger: newLedger() });
      assert.equal(entry.rows[0].status, 'unknown');
      assert.match(entry.rows[0].reason, /plans file does not exist/);
    } finally { if (keep === undefined) delete process.env.GRIDIRON_WARROOM_PLANS; else process.env.GRIDIRON_WARROOM_PLANS = keep; }
  });
});

test('asking Coach to role-play Nick himself is refused, not crashed', () => {
  withTool({ [ROLEPLAY_ENV]: '1' }, () => {
    assert.throws(() => runCoachTool('roleplay', { ...toolInput, team: PLANS.me }, { ledger: newLedger() }),
      e => e instanceof CoachToolError && /is you/.test(e.message));
  });
});
