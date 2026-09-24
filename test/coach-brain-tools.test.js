/**
 * COACH-TOOLS: Coach's typed read tools over the brain for one league, and the
 * grounding check that keeps every number, player and probability it says tied
 * to one of their results.
 *
 * Two halves.
 *
 * UNIT. Each tool (plan_read, people_read, pulse_read, brain_read, health_read)
 * reads its producer's output and returns flat, citable rows, or one typed
 * `unknown` row that says why, never a zero. verify.js rejects a fabricated
 * number, a fabricated player and a player the claim did not cite.
 *
 * METRIC. A fixed 12-question league-4 set is run through askCoach with a
 * stand-in model that has to call a tool for every answer and may only write
 * what the tool returned. A question counts as answered when the final answer
 * carries at least one claim and the grounding check found 0 unverified
 * numbers or players. The line `COACH_TOOLS_METRIC answered=X/12` is the
 * measurement (the same file runs on a tree without brain-tools.js, which is
 * the baseline).
 *
 * No network, no paid model call: every Claude call is
 * claude.js#setAnthropicClientForTesting. Fixture plans are the committed
 * warroom contract fixture (its third league, FIXTURE_INDEX: the one whose plan
 * carries a two-step next move and an alternative path) relabelled as league
 * 4, with the three players of the next move renamed initial-style
 * (FIXTURE_NAMES), because the contract fixture writes players as "P4" and the
 * player check looks for names the way the live plans file writes them. No
 * real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-brain-tools-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
const PLANS_FILE = path.join(temp, 'plans.json');
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;

const { run, db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach } = await import('../server/services/coach/ask.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer, groundAnswer } = await import('../server/services/coach/verify.js');
const tools = await import('../server/services/coach/tools.js');
const brain = await import('../server/services/coach/brain-tools.js').catch(e => {
  if (e?.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw e;
});
const noBrain = { skip: brain ? false : 'brain-tools.js is not on this tree' };

const LEAGUE = 4;

/* ------------------------------------------------------------ fixtures */

const contract = JSON.parse(fs.readFileSync(
  new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
const FIXTURE_INDEX = 2;
const FIXTURE_NAMES = { 4: 'M. Oduya (WR)', 7: 'T. Kline (WR)', 22: 'C. Ruiz (QB)' };
const league4 = { ...structuredClone(contract.leagues[FIXTURE_INDEX]), league: LEAGUE };
Object.assign(league4.names, FIXTURE_NAMES);
const plansDoc = { ...structuredClone(contract), leagues: [league4] };
const writePlans = doc => fs.writeFileSync(PLANS_FILE, JSON.stringify(doc));
writePlans(plansDoc);

// The two producer tables that are not on main yet (077 number_audit, 078
// brain_report), created here with their migration's columns so the tools can
// be tested against the real shape.
db.exec(`
  CREATE TABLE IF NOT EXISTS number_audit (
    league_id INTEGER NOT NULL, check_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'broken')),
    inventory_row TEXT, title TEXT NOT NULL, detail TEXT NOT NULL, cause TEXT, trust TEXT,
    pages_affected TEXT NOT NULL DEFAULT '[]', values_json TEXT NOT NULL DEFAULT '{}',
    as_of TEXT NOT NULL, first_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, check_id));
  CREATE TABLE IF NOT EXISTS brain_report (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, computed_at TEXT NOT NULL,
    check_id TEXT NOT NULL, name TEXT, status TEXT NOT NULL, metric_name TEXT NOT NULL, metric REAL,
    ci_low REAL, ci_high REAL, n INTEGER NOT NULL DEFAULT 0, needs_n INTEGER, needs_unit TEXT,
    needs_text TEXT, pass_bar TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live',
    detail_json TEXT NOT NULL DEFAULT '{}');
`);
const audit = (id, status, title) => run(
  `INSERT INTO number_audit (league_id, check_id, status, title, detail, cause, trust, as_of, first_seen_at)
   VALUES (?, ?, ?, ?, 'fixture detail', 'fixture cause', 'fixture trust', '2026-09-23T10:00:00Z', '2026-09-22T10:00:00Z')`,
  LEAGUE, id, status, title);
audit('title_odds_fresh', 'ok', 'Title odds are fresh');
audit('proj_sum', 'broken', 'Projected points do not add up');
audit('pyes_range', 'warn', 'Chance of yes near the edge');
const report = (runId, at, id, status, metric, n, needs) => run(
  `INSERT INTO brain_report (run_id, computed_at, check_id, name, status, metric_name, metric, n,
     needs_n, needs_unit, needs_text, pass_bar)
   VALUES (?, ?, ?, ?, ?, 'brier_skill', ?, ?, ?, ?, ?, 'beats base rate')`,
  runId, at, id, `check ${id}`, status, metric, n,
  needs ? 38 : null, needs ? 'offers' : null, needs ? 'needs 38 more offers' : null);
report('old', '2026-09-20T06:00:00Z', 'E1', 'failing', 0.01, 5, false);
report('new', '2026-09-23T06:00:00Z', 'E1', 'not_enough_data', 0.04, 12, true);
report('new', '2026-09-23T06:00:00Z', 'E2', 'passing', 0.12, 64, false);

/** The profile reader's contract (people/profile-reader.js#readProfiles), fixture names only. */
const fixtureProfiles = () => ({
  status: 'ok', reason: null, as_of: Date.parse('2026-09-23T12:00:00Z'), version: 'people-01.1',
  byRoster: new Map([
    ['7', { roster_id: '7', status: 'ok', reason: null,
      negotiation: { status: 'ok', messages_read: 240, confidence: 'medium',
        how_to_approach: 'a paraphrase that must not reach Coach',
        values_talk: { status: 'ok', source: 'values_talk',
          talks_up: [], talks_down: [], wants: [{ player: 'M. Oduya', n: 2, at: 1, dated: true }],
          untouchable: [], shopping: [{ player: 'C. Ruiz', n: 3, at: 1, dated: true }] } },
      chat: { status: 'ok', msgs: 400, p_open_to_trade: 0.4 },
      override: { status: 'none', exclude: false, deprioritize: false, toughen: false, basis: 'no override' },
      history: [] }],
    ['2', { roster_id: '2', status: 'ok', reason: null,
      negotiation: { status: 'ok', messages_read: 90, confidence: 'low',
        values_talk: { status: 'ok', source: 'roster_read', talks_up: [], talks_down: [], wants: [],
          untouchable: [{ player: 'A. Brandt', n: 1, at: 1, dated: false }],
          shopping: [{ player: 'I. Rourke', n: 1, at: 1, dated: false }] } },
      chat: { status: 'unknown', reason: 'quiet' },
      override: { status: 'ok', exclude: true, deprioritize: false, toughen: true, basis: 'structured override' },
      history: [] }],
    ['9', { roster_id: '9', status: 'unknown', reason: 'quiet: 4 messages read (< 30)',
      negotiation: { status: 'unknown', reason: 'quiet' }, chat: { status: 'unknown', reason: 'quiet' },
      override: { status: 'none', exclude: false, deprioritize: false, toughen: false }, history: [] }]
  ])
});
if (brain?.setBrainSources) brain.setBrainSources({ profiles: () => fixtureProfiles() });

const withFlag = async (value, fn) => {
  const before = process.env.GRIDIRON_COACH_BRAIN_TOOLS;
  if (value === undefined) delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;
  else process.env.GRIDIRON_COACH_BRAIN_TOOLS = value;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;
    else process.env.GRIDIRON_COACH_BRAIN_TOOLS = before;
  }
};

/* ------------------------------------------------------------ the metric */

const pct = v => `${Math.round(Number(v) * 1000) / 10}%`;
const say = v => String(v);

/**
 * The fixed 12-question set. Each names the tool the stand-in model calls and
 * the cells it may state; `row` picks the row (default 0). The model writes
 * only those cells' values, so an answer exists exactly when the tool does.
 */
const QUESTIONS = [
  { q: 'What is my next move?', tool: 'plan_read', input: { section: 'next_move' },
    claims: [{ cols: ['next_move_steps_0_give_0_name', 'next_move_steps_0_get_0_name'],
      text: ([give, get]) => `Offer ${give} to get ${get}.` }] },
  { q: 'Why that move?', tool: 'plan_read', input: { section: 'next_move' },
    claims: [{ cols: ['next_move_reasoning_value_case_for'], text: ([why]) => why }] },
  { q: 'What is P(yes) of step 1?', tool: 'plan_read', input: { section: 'next_move' },
    claims: [{ cols: ['next_move_steps_0_p_yes_value'], text: ([p]) => `He says yes about ${pct(p)} of the time.` }] },
  { q: 'In what order do I approach partners?', tool: 'plan_read', input: { section: 'alternatives' },
    claims: [{ cols: ['alternatives_0_steps_0_partner', 'alternatives_0_steps_1_partner'],
      text: ([a, b]) => `Team ${a} first, then team ${b}.` }] },
  { q: 'Who is in-market right now?', tool: 'people_read', input: {},
    row: rows => rows.findIndex(r => r.in_market === true),
    claims: [{ cols: ['roster_id', 'shopping'], text: ([team, players]) => `Team ${team} is shopping ${players}.` }] },
  { q: 'Is the brain working?', tool: 'brain_read', input: {},
    claims: [{ cols: ['overall'], text: ([overall]) => `Brain report overall: ${overall}.` }] },
  { q: 'Are any numbers broken?', tool: 'health_read', input: {},
    claims: [{ cols: ['broken_n'], text: ([n]) => `${say(n)} number check is broken.` }] },
  { q: 'Title odds now vs planned?', tool: 'plan_read', input: { section: 'destination' },
    claims: [{ cols: ['destination_title_now_value', 'destination_title_planned_now_value'],
      text: ([now, planned]) => `Title odds are ${pct(now)} now against ${pct(planned)} planned.` }] },
  { q: 'When do I walk away?', tool: 'plan_read', input: { section: 'next_move_playbook' },
    claims: [{ cols: ['next_move_playbook_steps_0_walk_away_value_text'], text: ([t]) => t }] },
  { q: 'What if he counters?', tool: 'plan_read', input: { section: 'next_move_playbook' },
    claims: [{ cols: ['next_move_playbook_steps_0_reply_table_value_counter_value_counter_rules_counter_with'],
      text: ([t]) => t }] },
  { q: 'What is the top flip?', tool: 'plan_read', input: { section: 'flip_map' },
    claims: [{ cols: ['flip_map_0_player_name', 'flip_map_0_spread_value'],
      text: ([p, s]) => `Flip ${p}: it moves title odds ${pct(s)}.` }] },
  { q: 'Can I get to 140 points a week?', tool: 'plan_read', input: { section: 'feasibility' },
    claims: [{ cols: ['feasibility_points_per_week', 'feasibility_projected_points_value', 'feasibility_p_hit_value'],
      text: ([goal, proj, p]) => `Against ${goal} a week you project ${proj}; the plan hits it ${pct(p)} of the time.` }] }
];

/**
 * The stand-in model. Round one: call the question's tool. Round two: read the
 * tool result and write only the named cells, cited; if the tool errored or
 * came back unknown, refuse. A correction turn gets a refusal.
 */
function standIn(spec) {
  const usage = { input_tokens: 10, output_tokens: 10 };
  const says = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage });
  return {
    messages: {
      create: async body => {
        const last = body.messages.at(-1);
        const blocks = Array.isArray(last.content) ? last.content : [];
        const result = blocks.find(b => b.type === 'tool_result');
        if (!result) {
          if (body.messages.length > 1) return says({ claims: [], refusals: ['could not ground it'], as_of: null });
          return { content: [{ type: 'tool_use', id: 'tu1', name: spec.tool, input: { league_id: LEAGUE, ...spec.input } }],
            stop_reason: 'tool_use', usage };
        }
        let summary;
        try { summary = JSON.parse(result.content); } catch { summary = null; }
        if (result.is_error || !summary?.rows?.length) {
          return says({ claims: [], refusals: [`${spec.tool}: ${summary?.error ?? 'no rows'}`], as_of: null });
        }
        const index = spec.row ? spec.row(summary.rows) : 0;
        const row = summary.rows[index];
        if (!row || row.status === 'unknown' || row.status === 'failed') {
          return says({ claims: [], refusals: [`${spec.tool}: ${row?.reason ?? 'no row'}`], as_of: null });
        }
        const claims = [];
        for (const c of spec.claims) {
          if (c.cols.some(col => row[col] === undefined || row[col] === null)) continue;
          claims.push({ text: c.text(c.cols.map(col => row[col])),
            cites: c.cols.map(col => `${summary.cite_prefix}${index}.${col}`) });
        }
        return says({ claims, refusals: claims.length ? [] : ['the tool did not carry that'], as_of: null });
      }
    }
  };
}

const UNVERIFIED = new Set(['ungrounded_number', 'ungrounded_player', 'bad_cite', 'uncited_claim']);

async function runMetric() {
  const results = [];
  for (const spec of QUESTIONS) {
    setAnthropicClientForTesting(standIn(spec));
    let result;
    try {
      result = await askCoach({ question: spec.q, leagueId: LEAGUE });
    } finally { setAnthropicClientForTesting(null); }
    const unverified = (result.verification?.violations ?? []).filter(v => UNVERIFIED.has(v.kind)).length;
    const answered = result.answer.claims.length > 0 && result.verification.ok && unverified === 0;
    results.push({ q: spec.q, answered, unverified, refusals: result.answer.refusals });
  }
  return results;
}

test('METRIC: 12-question league-4 set answered from tool results with 0 unverified numbers', async () => {
  const results = await withFlag('1', runMetric);
  const answered = results.filter(r => r.answered).length;
  const unverified = results.reduce((a, r) => a + r.unverified, 0);
  console.log(`COACH_TOOLS_METRIC answered=${answered}/${QUESTIONS.length} unverified_in_answers=${unverified}`);
  for (const r of results) console.log(`  ${r.answered ? 'ANSWERED' : 'NOT     '} ${r.q}${r.answered ? '' : ` -- ${r.refusals.join(' | ')}`}`);
  if (brain) assert.ok(answered >= 11, `answered ${answered}/12`);
});

/* ------------------------------------------------------------ flag */

test('flag off: Coach is offered exactly the tools it had before', noBrain, async () => {
  await withFlag(undefined, () => {
    const names = tools.toolDefinitions().map(t => t.name);
    for (const t of brain.BRAIN_TOOLS) assert.ok(!names.includes(t.name), `${t.name} offered with the flag off`);
    assert.throws(() => tools.runCoachTool('plan_read', { league_id: LEAGUE }, { ledger: newLedger() }),
      tools.CoachToolError);
  });
});

test('flag on (own flag or preview): the five brain tools are offered; =0 vetoes preview', noBrain, async () => {
  await withFlag('1', () => {
    const names = tools.toolDefinitions().map(t => t.name);
    for (const n of ['plan_read', 'people_read', 'pulse_read', 'brain_read', 'health_read']) assert.ok(names.includes(n), n);
  });
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    await withFlag(undefined, () => assert.equal(brain.brainToolsOn(), true));
    await withFlag('0', () => assert.equal(brain.brainToolsOn(), false));
  } finally { delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; }
});

/* ------------------------------------------------------------ plan_read */

test('plan_read: a section comes back as one flat citable row, players named', noBrain, () => {
  const rows = brain.planRead({ league_id: LEAGUE, section: 'next_move' });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.status, 'ok');
  assert.equal(r.league_id, LEAGUE);
  assert.equal(r.next_move_steps_0_p_yes_value, league4.next_move.value.steps[0].p_yes.value);
  assert.equal(r.next_move_steps_0_give_0, '4');
  assert.equal(r.next_move_steps_0_give_0_name, 'M. Oduya (WR)');
  assert.equal(r.next_move_steps_0_walk_away_value_text, undefined, 'the playbook is its own view');
  const [book] = brain.planRead({ league_id: LEAGUE, section: 'next_move_playbook' });
  assert.equal(book.next_move_playbook_steps_0_walk_away_value_text, 'Stop at P5 + P6: past that, your backup plan is worth more.');
  assert.equal(r.plans_generated_at, contract.generated_at);
  for (const col of Object.keys(r)) assert.match(col, /^[A-Za-z_][A-Za-z0-9_]*$/, `${col} must be citable`);
});

test('plan_read: every schema section is readable; an unknown section is a tool error', noBrain, async () => {
  for (const section of brain.PLAN_SECTIONS) {
    const [r] = brain.planRead({ league_id: LEAGUE, section });
    assert.equal(r.status, 'ok', `${section}: ${r.reason}`);
  }
  assert.throws(() => brain.planRead({ league_id: LEAGUE, section: 'nope' }), brain.BrainToolInputError);
  await withFlag('1', () => assert.throws(
    () => tools.runCoachTool('plan_read', { league_id: LEAGUE, section: 'nope' }, { ledger: newLedger() }),
    tools.CoachToolError));
});

test('plan_read: missing file, missing league and a contract break are typed, never zero', noBrain, () => {
  const [missingLeague] = brain.planRead({ league_id: 99, section: 'next_move' });
  assert.equal(missingLeague.status, 'unknown');
  assert.match(missingLeague.reason, /league 99/);

  const broken = structuredClone(plansDoc);
  delete broken.leagues[0].next_move.value.steps[0].p_yes;
  writePlans(broken);
  try {
    const [r] = brain.planRead({ league_id: LEAGUE, section: 'next_move' });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /contract/);
    assert.equal(r.next_move_steps_0_p_yes_value, undefined);
  } finally { writePlans(plansDoc); }

  fs.renameSync(PLANS_FILE, `${PLANS_FILE}.away`);
  try {
    const [r] = brain.planRead({ league_id: LEAGUE, section: 'next_move' });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /plans file/);
  } finally { fs.renameSync(`${PLANS_FILE}.away`, PLANS_FILE); }
});

test('plan_read: an unknown section field stays unknown with its reason', noBrain, () => {
  const doc = structuredClone(plansDoc);
  doc.leagues[0].flip_map = { status: 'unknown', reason: 'no flips priced yet', source: 'campaign.plan' };
  writePlans(doc);
  try {
    const [r] = brain.planRead({ league_id: LEAGUE, section: 'flip_map' });
    assert.equal(r.status, 'ok');
    assert.equal(r.flip_map_status, 'unknown');
    assert.equal(r.flip_map_reason, 'no flips priced yet');
    assert.equal(r.flip_map_0_player_name, undefined);
  } finally { writePlans(plansDoc); }
});

/* ------------------------------------------------------------ people_read */

test('people_read: labels and counts only, override honoured, quiet is unknown', noBrain, () => {
  const rows = brain.peopleRead({ league_id: LEAGUE });
  const by = Object.fromEntries(rows.map(r => [r.roster_id, r]));
  assert.equal(by['7'].in_market, true);
  assert.equal(by['7'].shopping, 'C. Ruiz');
  assert.equal(by['7'].wants, 'M. Oduya');
  assert.equal(by['7'].p_open_to_trade, 0.4);
  assert.equal(by['7'].nick_override, 'none');
  assert.equal(by['2'].nick_override, 'exclude');
  assert.equal(by['2'].in_market, false, 'nick_override beats everything');
  assert.equal(by['9'].status, 'unknown');
  assert.equal(by['9'].in_market, null, 'unknown is not "not in market"');
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('paraphrase'), 'free-text profile fields never reach Coach');
  const one = brain.peopleRead({ league_id: LEAGUE, roster_id: '7' });
  assert.equal(one.length, 1);
});

test('people_read: no profile reader on this build is typed unknown', noBrain, () => {
  brain.setBrainSources({ profiles: null });
  try {
    const [r] = brain.peopleRead({ league_id: LEAGUE });
    assert.equal(r.status, 'unknown');
  } finally { brain.setBrainSources({ profiles: () => fixtureProfiles() }); }
});

/* ------------------------------------------------------------ pulse, brain, health */

test('pulse_read: typed unknown until PULSE-01 is on this build, and it queries no table', noBrain, () => {
  const [none] = brain.pulseRead({ league_id: LEAGUE });
  assert.equal(none.status, 'unknown');
  assert.equal(none.reason, brain.PULSE_NOT_BUILT);
  // A stray legacy table must not be read: nothing writes it.
  db.exec(`CREATE TABLE pulse_statements (league_id INTEGER, label TEXT, at TEXT)`);
  try {
    run(`INSERT INTO pulse_statements VALUES (?, 'shopping', ?)`, LEAGUE, new Date().toISOString());
    const rows = brain.pulseRead({ league_id: LEAGUE, days: 14 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'unknown');
  } finally { db.exec('DROP TABLE pulse_statements'); }
  assert.throws(() => brain.pulseRead({ league_id: LEAGUE, days: 0 }), /days/);
});

test('brain_read: newest run from brain_report, summary row first', noBrain, () => {
  const rows = brain.brainRead({ league_id: LEAGUE });
  assert.equal(rows[0].row_kind, 'summary');
  assert.equal(rows[0].overall, 'not_enough_data');
  assert.equal(rows[0].run_id, 'new');
  const e1 = rows.find(r => r.check_id === 'E1');
  assert.equal(e1.status, 'not_enough_data');
  assert.equal(e1.needs_text, 'needs 38 more offers');
  assert.equal(rows.filter(r => r.row_kind === 'check').length, 2);
});

test('brain_read: without the table it falls back to the plan, then to unknown', noBrain, () => {
  db.exec('ALTER TABLE brain_report RENAME TO brain_report_away');
  try {
    const rows = brain.brainRead({ league_id: LEAGUE });
    assert.equal(rows[0].origin, 'plans file');
    assert.equal(rows[0].overall, league4.brain_report.value.overall);
    fs.renameSync(PLANS_FILE, `${PLANS_FILE}.away`);
    try {
      const [r] = brain.brainRead({ league_id: LEAGUE });
      assert.equal(r.status, 'unknown');
    } finally { fs.renameSync(`${PLANS_FILE}.away`, PLANS_FILE); }
  } finally { db.exec('ALTER TABLE brain_report_away RENAME TO brain_report'); }
});

test('health_read: summary counts then broken-first rows; no table is unknown', noBrain, () => {
  const rows = brain.healthRead({ league_id: LEAGUE });
  assert.deepEqual([rows[0].ok_n, rows[0].warn_n, rows[0].broken_n], [1, 1, 1]);
  assert.equal(rows[1].status, 'broken');
  assert.equal(rows[1].title, 'Projected points do not add up');
  db.exec('ALTER TABLE number_audit RENAME TO number_audit_away');
  try {
    const [r] = brain.healthRead({ league_id: LEAGUE });
    assert.equal(r.status, 'unknown');
  } finally { db.exec('ALTER TABLE number_audit_away RENAME TO number_audit'); }
});

/* ------------------------------------------------------------ verify.js */

function planLedger(section = 'next_move') {
  const ledger = newLedger();
  return withFlag('1', () => {
    tools.runCoachTool('plan_read', { league_id: LEAGUE, section }, { ledger });
    return ledger;
  });
}

test('verify: a fabricated number next to a real cite is rejected', noBrain, async () => {
  const ledger = await planLedger();
  const ok = verifyAnswer({ ledger, answer: { claims: [
    { text: 'He says yes 59.3% of the time.', cites: ['r1#0.next_move_steps_0_p_yes_value'] }] } });
  assert.equal(ok.ok, true, JSON.stringify(ok.violations));
  const bad = verifyAnswer({ ledger, answer: { claims: [
    { text: 'He says yes 52% of the time.', cites: ['r1#0.next_move_steps_0_p_yes_value'] }] } });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].kind, 'ungrounded_number');
  assert.equal(bad.violations[0].number, '52');
});

test('verify: a digit inside a cited text cell is grounded by that cell', noBrain, async () => {
  const ledger = await planLedger('next_move_playbook');
  const v = verifyAnswer({ ledger, answer: { claims: [
    { text: 'If he says yes: Send the next step to Team 2.',
      cites: ['r1#0.next_move_playbook_steps_0_reply_table_value_accept_value_do'] }] } });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  const off = verifyAnswer({ ledger, answer: { claims: [
    { text: 'If he says yes: Send the next step to Team 3.',
      cites: ['r1#0.next_move_playbook_steps_0_reply_table_value_accept_value_do'] }] } });
  assert.deepEqual(off.violations.map(x => x.number), ['3']);
});

test('verify: a text cell from a non-brain tool grounds no number (flag-off behaviour unchanged)', () => {
  const ledger = newLedger();
  ledger.record({ sql: 'SELECT ...', params: [], tool: 'query', tables: ['games'], columns: ['game_date', 'team'],
    rows: [{ game_date: '2024-11-03', team: 'Team 2' }], row_count: 1, truncated: false });
  const v = verifyAnswer({ ledger, answer: { claims: [
    { text: 'He scored 11 touchdowns in 2024.', cites: ['r1#0.game_date'] },
    { text: 'Send step 2 to Team 2.', cites: ['r1#0.team'] }] } });
  assert.deepEqual(v.violations.map(x => [x.claim_index, x.number]), [[0, '11'], [0, '2024'], [1, '2'], [1, '2']]);
});

test('verify: a player the claim did not cite, or one no tool returned, is rejected', noBrain, async () => {
  const ledger = await planLedger();
  const uncited = verifyAnswer({ ledger, answer: { claims: [
    { text: 'Offer T. Kline for C. Ruiz.', cites: ['r1#0.next_move_steps_0_get_0_name'] }] } });
  assert.equal(uncited.ok, false);
  assert.deepEqual(uncited.violations.map(v => [v.kind, v.player]), [['ungrounded_player', 'T. Kline']]);

  const invented = verifyAnswer({ ledger, answer: { claims: [
    { text: 'Ask for Z. Madeup instead of C. Ruiz.', cites: ['r1#0.next_move_steps_0_get_0_name'] }] } });
  assert.deepEqual(invented.violations.map(v => [v.kind, v.player]), [['ungrounded_player', 'Z. Madeup']]);

  const good = verifyAnswer({ ledger, answer: { claims: [
    { text: 'Offer M. Oduya and T. Kline for C. Ruiz.', cites: ['r1#0.next_move_steps_0_give_0_name',
      'r1#0.next_move_steps_0_give_1_name', 'r1#0.next_move_steps_0_get_0_name'] }] } });
  assert.equal(good.ok, true, JSON.stringify(good.violations));
});

test('verify: groundAnswer drops exactly the claims that failed and says so', noBrain, async () => {
  const ledger = await planLedger();
  const answer = { claims: [
    { text: 'He says yes 59.3% of the time.', cites: ['r1#0.next_move_steps_0_p_yes_value'] },
    { text: 'He says yes 52% of the time.', cites: ['r1#0.next_move_steps_0_p_yes_value'] }
  ], refusals: [], as_of: null };
  const verification = verifyAnswer({ ledger, answer });
  const grounded = groundAnswer(answer, verification);
  assert.equal(grounded.claims.length, 1);
  assert.equal(grounded.claims[0].text, 'He says yes 59.3% of the time.');
  assert.equal(grounded.dropped, 1);
  assert.match(grounded.refusals[0], /dropped 1 claim/);
  assert.equal(verifyAnswer({ ledger, answer: grounded }).ok, true);
});

test('askCoach: a fabricated probability from a brain tool never ships', noBrain, async () => {
  const usage = { input_tokens: 10, output_tokens: 10 };
  let turn = 0;
  setAnthropicClientForTesting({ messages: { create: async () => {
    turn += 1;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'plan_read',
      input: { league_id: LEAGUE, section: 'next_move' } }], stop_reason: 'tool_use', usage };
    return { content: [{ type: 'text', text: JSON.stringify({ claims: [
      { text: 'He says yes 61% of the time.', cites: ['r1#0.next_move_steps_0_p_yes_value'] }], refusals: [] }) }],
    stop_reason: 'end_turn', usage };
  } } });
  try {
    const result = await withFlag('1', () => askCoach({ question: 'P(yes)?', leagueId: LEAGUE }));
    assert.equal(result.answer.claims.length, 0);
    assert.match(result.answer.refusals.join(' '), /61/);
  } finally { setAnthropicClientForTesting(null); }
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
