/**
 * The Coach canary's fixture league, its twelve golden questions, and the grader.
 *
 * Every answer here is known because the fixture is written here: one invented
 * team, five invented players, three weeks of usage, one injury row and one
 * league row. Nothing in it names a real league, manager or player. A golden
 * answer is therefore a fact about this file, not about football, and a canary
 * that fails is Coach drifting (a prompt, a tool, the verifier, the model), not
 * the world changing under it.
 *
 * `sql` and `column` are what the dry-run stand-in asks and cites. A live run
 * sends only `question`; the model has to find the same cell on its own.
 *
 * Importing this file touches no database. `seedFixture` takes the `run`
 * function of whichever database the caller opened.
 */

export const FIXTURE_TEAM = Object.freeze({ id: 901, abbr: 'FXA', name: 'Fixture Alphas' });
export const FIXTURE_SEASON = 2026;
export const FIXTURE_LEAGUE_ID = 901;

const PLAYERS = [
  [9001, 'Fixture Quarterback', 'QB', 1],
  [9002, 'Fixture Runner', 'RB', 1],
  [9003, 'Fixture Receiver A', 'WR', 1],
  [9004, 'Fixture Receiver B', 'WR', 2],
  [9005, 'Fixture Tight End', 'TE', 1]
];

// [player_id, week, targets, carries, target_share, receiving_yards, rushing_yards, passing_yards]
// Targets sum to 20 in every week, so target shares sum to exactly 1.
const USAGE = [
  [9001, 1, 0, 2, 0, 0, 6, 231], [9002, 1, 3, 17, 0.15, 18, 74, 0],
  [9003, 1, 8, 0, 0.40, 96, 0, 0], [9004, 1, 6, 0, 0.30, 41, 0, 0], [9005, 1, 3, 0, 0.15, 30, 0, 0],
  [9001, 2, 0, 3, 0, 0, 11, 251], [9002, 2, 2, 14, 0.10, 9, 61, 0],
  [9003, 2, 9, 0, 0.45, 112, 0, 0], [9004, 2, 5, 0, 0.25, 33, 0, 0], [9005, 2, 4, 0, 0.20, 27, 0, 0],
  [9001, 3, 0, 1, 0, 0, 2, 198], [9002, 3, 4, 19, 0.20, 25, 88, 0],
  [9003, 3, 6, 0, 0.30, 58, 0, 0], [9004, 3, 7, 0, 0.35, 70, 0, 0], [9005, 3, 3, 0, 0.15, 22, 0, 0]
];

/** Write the fixture league into an already-migrated database. Idempotent. */
export function seedFixture(run) {
  const t = FIXTURE_TEAM;
  run(`INSERT OR IGNORE INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'North')`,
    t.id, t.abbr, t.name);
  for (const [id, name, position, depth] of PLAYERS) {
    run(`INSERT OR IGNORE INTO players (id, name, position, team_id, depth_rank) VALUES (?, ?, ?, ?, ?)`,
      id, name, position, t.id, depth);
  }
  for (const [pid, week, targets, carries, share, recYds, rushYds, passYds] of USAGE) {
    const position = PLAYERS.find(p => p[0] === pid)[2];
    run(`INSERT OR IGNORE INTO player_week_usage (player_id, season, week, team, position, targets, carries,
           target_share, receiving_yards, rushing_yards, passing_yards) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      pid, FIXTURE_SEASON, week, t.abbr, position, targets, carries, share, recYds, rushYds, passYds);
  }
  run(`INSERT OR IGNORE INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status,
         practice_status, injury) VALUES (?, 3, 'FX-9004', ?, 'Fixture Receiver B', 'WR', 'Questionable',
         'Limited Participation in Practice', 'Hamstring')`, FIXTURE_SEASON, t.abbr);
  run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, team_count, ppr)
       VALUES (?, 'espn', 'fixture-901', ?, 'Fixture League', 10, 1)`, FIXTURE_LEAGUE_ID, FIXTURE_SEASON);
}

const usage = (select, where) =>
  `SELECT ${select} FROM player_week_usage u JOIN players p ON p.id = u.player_id WHERE ${where}`;

/**
 * expect.kind: `number` (a claim states `value`; a share may be stated as a
 * percent), `text` (a claim contains `value`), or `refusal` (no claim carries a
 * digit and at least one refusal is given).
 */
export const GOLDEN = Object.freeze([
  { id: 'G01', question: 'How many targets did Fixture Receiver A get in week 2 of 2026?',
    sql: usage('u.targets', "p.name = 'Fixture Receiver A' AND u.season = 2026 AND u.week = 2"),
    column: 'targets', expect: { kind: 'number', value: 9 } },
  { id: 'G02', question: 'How many targets did the Fixture Alphas throw in total in week 2 of 2026?',
    sql: "SELECT SUM(targets) AS team_targets FROM player_week_usage WHERE team = 'FXA' AND season = 2026 AND week = 2",
    column: 'team_targets', expect: { kind: 'number', value: 20 } },
  { id: 'G03', question: "What was Fixture Receiver A's target share in week 2 of 2026?",
    sql: usage('u.target_share', "p.name = 'Fixture Receiver A' AND u.season = 2026 AND u.week = 2"),
    column: 'target_share', expect: { kind: 'number', value: 0.45, share: true } },
  { id: 'G04', question: 'How many carries did Fixture Runner have in week 1 of 2026?',
    sql: usage('u.carries', "p.name = 'Fixture Runner' AND u.season = 2026 AND u.week = 1"),
    column: 'carries', expect: { kind: 'number', value: 17 } },
  { id: 'G05', question: 'Who led the Fixture Alphas in receiving yards in week 1 of 2026?',
    sql: usage('p.name', "u.team = 'FXA' AND u.season = 2026 AND u.week = 1 ORDER BY u.receiving_yards DESC LIMIT 1"),
    column: 'name', expect: { kind: 'text', value: 'Fixture Receiver A' } },
  { id: 'G06', question: "What is Fixture Receiver B's injury report status for week 3 of 2026?",
    sql: "SELECT report_status FROM nfl_injuries WHERE full_name = 'Fixture Receiver B' AND season = 2026 AND week = 3",
    column: 'report_status', expect: { kind: 'text', value: 'Questionable' } },
  { id: 'G07', question: 'How many players do you have listed for the Fixture Alphas?',
    sql: 'SELECT COUNT(*) AS player_count FROM players WHERE team_id = 901',
    column: 'player_count', expect: { kind: 'number', value: 5 } },
  { id: 'G08', question: 'How many receiving yards did Fixture Receiver A have over weeks 1 to 3 of 2026 combined?',
    sql: usage('SUM(u.receiving_yards) AS total_yards', "p.name = 'Fixture Receiver A' AND u.season = 2026 AND u.week BETWEEN 1 AND 3"),
    column: 'total_yards', expect: { kind: 'number', value: 266 } },
  { id: 'G09', question: 'How many teams are in the Fixture League?',
    sql: "SELECT team_count FROM leagues WHERE name = 'Fixture League'",
    column: 'team_count', expect: { kind: 'number', value: 10 } },
  { id: 'G10', question: 'How many passing yards did Fixture Quarterback have in week 2 of 2026?',
    sql: usage('u.passing_yards', "p.name = 'Fixture Quarterback' AND u.season = 2026 AND u.week = 2"),
    column: 'passing_yards', expect: { kind: 'number', value: 251 } },
  { id: 'G11', question: 'In how many weeks of 2026 did Fixture Receiver A get 8 or more targets?',
    sql: usage('COUNT(*) AS weeks', "p.name = 'Fixture Receiver A' AND u.season = 2026 AND u.targets >= 8"),
    column: 'weeks', expect: { kind: 'number', value: 2 } },
  { id: 'G12', question: 'What did each manager bid in FAAB on waivers in the Fixture League last week?',
    sql: null, column: null, expect: { kind: 'refusal' } }
]);

const NUMBER = /[-+]?\d[\d,]*(?:\.\d+)?/g;
const numbersIn = text => [...String(text).matchAll(NUMBER)].map(m => Number(m[0].replace(/,/g, '')));
const close = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);

/**
 * Grade one Coach result against its golden answer.
 * @returns {{id, pass: boolean, kind: 'pass'|'drift'|'error'|'budget', reason: string}}
 */
export function gradeAnswer(golden, { result = null, error = null } = {}) {
  const { id, expect } = golden;
  if (error) {
    const budget = error.code === 'LLM_BUDGET_EXHAUSTED';
    return { id, pass: false, kind: budget ? 'budget' : 'error', reason: String(error.message ?? error).slice(0, 200) };
  }
  const claims = result?.answer?.claims ?? [];
  const refusals = result?.answer?.refusals ?? [];
  const text = claims.map(c => c.text).join(' ');
  const verified = result?.verification?.ok === true;

  if (expect.kind === 'refusal') {
    const ok = refusals.length > 0 && numbersIn(text).length === 0;
    return { id, pass: ok, kind: ok ? 'pass' : 'drift',
      reason: ok ? 'refused, as it should' : `expected a refusal, got claims: ${text.slice(0, 160)}` };
  }
  if (!verified) {
    return { id, pass: false, kind: 'drift', reason: `answer did not pass verification: ${refusals.join(' ').slice(0, 160)}` };
  }
  if (expect.kind === 'number') {
    const found = numbersIn(text);
    const ok = found.some(n => close(n, expect.value) || (expect.share && close(n, expect.value * 100)));
    return { id, pass: ok, kind: ok ? 'pass' : 'drift',
      reason: ok ? `stated ${expect.value}` : `expected ${expect.value}, claims said: ${text.slice(0, 160)}` };
  }
  const ok = text.toLowerCase().includes(String(expect.value).toLowerCase());
  return { id, pass: ok, kind: ok ? 'pass' : 'drift',
    reason: ok ? `named ${expect.value}` : `expected "${expect.value}", claims said: ${text.slice(0, 160)}` };
}

/**
 * The run's verdict, and the sync_log status it writes. Any drift or error is
 * the alert (`error`). Budget skips alone are `partial`: the cap stopped the
 * run, which is the cost guard working, not Coach drifting.
 */
export function canaryVerdict(grades) {
  const count = kind => grades.filter(g => g.kind === kind).length;
  const failed = grades.filter(g => g.kind === 'drift' || g.kind === 'error');
  const status = failed.length ? 'error' : count('budget') ? 'partial' : 'ok';
  return {
    status,
    passed: count('pass'), total: grades.length, budget_skipped: count('budget'),
    failures: failed.map(g => ({ id: g.id, kind: g.kind, reason: g.reason }))
  };
}

// ---------------------------------------------------------------- dry-run stand-in

const usageBlock = { input_tokens: 0, output_tokens: 0 };
const says = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage: usageBlock });
const toolUse = (id, input) =>
  ({ content: [{ type: 'tool_use', id: `tu-${id}`, name: 'sql_select', input }], stop_reason: 'tool_use', usage: usageBlock });

/** The value in the last tool result the stand-in received. */
function lastToolValue(messages, column) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    const result = content.find(block => block.type === 'tool_result');
    if (result) return JSON.parse(result.content)?.rows?.[0]?.[column];
  }
  return undefined;
}

/**
 * A stand-in Anthropic client that answers one golden question the way a
 * well-behaved model would: one SQL lookup through Coach's real tool, then a
 * claim citing the cell it got back. It reads the value from the real tool
 * result, so the fixture, the guarded query layer, the ledger and the verifier
 * are all exercised; only the model is replaced. `injectWrong` makes it state a
 * different value, which is what a drifting model looks like.
 *
 * `sent` collects every request body, for the live-cost estimate.
 */
export function dryRunClient(golden, { injectWrong = false, sent = [] } = {}) {
  return {
    messages: {
      create: async body => {
        sent.push(body);
        if (golden.expect.kind === 'refusal') {
          return says({ claims: [], refusals: ['Coach does not read waiver or FAAB bids; no catalogued table holds them.'], as_of: null });
        }
        const askedAlready = body.messages.some(m => m.role === 'assistant');
        if (!askedAlready) return toolUse(golden.id, { sql: golden.sql });
        let value = lastToolValue(body.messages, golden.column);
        if (injectWrong) value = typeof value === 'number' ? value + 7 : 'Somebody Else';
        const cite = `r1#0.${golden.column}`;
        return says({ claims: [{ text: `The answer is ${value}.`, cites: [cite] }], refusals: [], as_of: null });
      }
    }
  };
}
