/**
 * The trade outcome ledger's mutation sweep — the SECOND verification pass on
 * Phase 0 item 4.
 *
 *   node docs/tdd/sweeps/trade-outcomes.mutations.mjs
 *
 * RED before GREEN proves the tests were written first. It does not prove any one
 * of them discriminates: the ledger's whole RED commit failed on a single shared
 * cause (ERR_MODULE_NOT_FOUND on a module that did not exist yet), which fifteen
 * tests asserting nothing at all would also have done. This file is the other
 * half. Each row breaks exactly ONE contract in the PRODUCER — the migration's
 * CHECKs and indexes, the service's guards, the two trade-tactics gates — runs the
 * suites that claim to hold it, reverts, and verifies the revert.
 *
 * A row that SURVIVES is the finding, not a pass. It means the contract is stated
 * in prose and nothing tests it. The first run of this file (2026-09-22) killed 19
 * of 27 and the eight survivors were all test defects, in three shapes worth
 * knowing:
 *
 *   1. A TEST THAT PASSED FOR THE WRONG REASON. The status-vocabulary test
 *      inserted a row that was ALSO missing its espn_tx_id, so it was refused by a
 *      different CHECK and passed with the status CHECK stripped out entirely. An
 *      assertion matching /CHECK|constraint/ cannot tell one constraint from
 *      another, so the discrimination has to come from the row: valid in every
 *      respect except the one rule under test.
 *
 *   2. MUTUAL-MASKING PAIRS. Where a rule is held in both the table and the
 *      service, removing either one alone changes nothing a caller can see — the
 *      other still refuses the row, and an assertion that accepts either refusal
 *      passes. M6/M19 and M4/M31 are two such pairs. A single-layer mutation
 *      CANNOT find them; only the paired row can, and the fix is to pin each layer
 *      to its own words. Two guards with one loose assertion is one guard untested.
 *
 *   3. A FIX SHIPPED WITHOUT A TEST. vetoClimate's absence branch, written in the
 *      same commit as the bug class it exists to kill, had nothing behind it.
 *
 * Writing the fix for that last one found the one production defect of the whole
 * exercise: read_state was set on the absent and empty paths and NOT on the
 * populated one, so a consumer checking `read_state === 'present'` got undefined on
 * the one path where the data is really there.
 *
 * THE LANDING PASS (work-queue F-05, merged with main bd56319b) added two kinds
 * of row. M33-M40 put back, one at a time, the shapes the slate recorder used to
 * read and no producer emits (`idea_id`, `{ idea_id, reason }`, `give` / `get`,
 * `counterparty.roster_id`), plus the refused-run and corrupt-items guards. C1-C7
 * mutate the CALL SITE in routes/trades.js, which no row touched before, and
 * C-EQUIV is a designed survivor there: an equivalent mutant that must survive.
 *
 * THE SKEPTIC PASS added three rows for two gaps independent reviewers found on
 * 169ada38. M41 swaps the observed writer's give/get, which passed every suite
 * until G1 asserted the package's direction. C8/C9 put back the route's old
 * proposer (the query string, which the app's own call never sends) and a
 * query-first variant; both are killed by the two route tests added in the RED
 * 1ea59528.
 *
 * Nothing here writes to the repository. It edits a file, runs a suite, and puts
 * the file back byte for byte, refusing to continue if it cannot; `git write-tree`
 * is printed either side so a reader can see the tree did not move.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIG = 'server/migrations/067_outcome_ledgers.js';
const SVC = 'server/services/trade-outcomes.js';
const TAC = 'server/services/trade-tactics.js';
const RTE = 'server/routes/trades.js';
const LEDGER = ['test/trade-outcomes.test.js'];
const TACTICS = ['test/trade-tactics.test.js'];
const ROUTE = ['test/trade-outcomes-route.test.js'];

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();

// Pinned, because the verdict is parsed from the runner's text and the default
// reporter differs by Node version: `tap` for a pipe on Node 22 (CI), `spec` on
// Node 25. Overridable ONLY to prove the unreadable-count guard fires:
//   SWEEP_REPORTER=spec node docs/tdd/sweeps/trade-outcomes.mutations.mjs
// must turn every applied row into BAD_ROW rather than SURVIVED.
const REPORTER = process.env.SWEEP_REPORTER || 'tap';

/**
 * The rows. A single-layer row carries { file, find, replace }; a PAIRED row
 * carries edits: [...] and exists because neither of its halves can be caught
 * alone.
 */
const M = [

  // ---- the migration's CHECK constraints: the contract stated in SQL ----
  { id: 'M1', file: MIG, suites: LEDGER,
    claim: "a considered_only row is always not_proposed",
    find: "      CHECK (source <> 'considered_only' OR status = 'not_proposed'),\n", replace: '' },
  { id: 'M2', file: MIG, suites: LEDGER,
    claim: "a not_proposed row always carries its reason",
    find: "      CHECK (status <> 'not_proposed' OR not_proposed_reason IS NOT NULL),\n", replace: '' },
  { id: 'M3', file: MIG, suites: LEDGER,
    claim: "an observed row always carries the ESPN id it came from",
    find: "      CHECK (source <> 'observed' OR espn_tx_id IS NOT NULL),\n", replace: '' },
  { id: 'M4', file: MIG, suites: LEDGER,
    claim: "an app_proposed row always carries model_p_accept",
    find: "      CHECK (source <> 'app_proposed' OR model_p_accept IS NOT NULL),\n", replace: '' },
  { id: 'M5', file: MIG, suites: LEDGER,
    claim: "low <= mid <= high: the table refuses a midpoint outside its own band",
    find: `      CHECK (model_p_accept_low IS NULL
             OR (model_p_accept_low >= 0 AND model_p_accept_high <= 1
                 AND model_p_accept_low <= model_p_accept
                 AND model_p_accept <= model_p_accept_high)),\n`, replace: '' },
  { id: 'M6', file: MIG, suites: LEDGER,
    claim: "a recorded midpoint always says which kind of claim it was",
    find: "      CHECK (model_p_accept IS NULL OR model_basis IS NOT NULL)\n", replace: '      CHECK (1 = 1)\n' },
  { id: 'M9', file: MIG, suites: LEDGER,
    claim: "the observed-side unique index is what makes settle idempotent",
    find: `    CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_outcomes_espn
      ON trade_outcomes(league_id, season, espn_tx_id)
      WHERE espn_tx_id IS NOT NULL;`,
    replace: `    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_espn
      ON trade_outcomes(league_id, season, espn_tx_id);` },
  { id: 'M10', file: MIG, suites: LEDGER,
    claim: "the app-side index includes source, so one idea may be sent in one slate and dropped in another",
    find: `      ON trade_outcomes(league_id, season, idea_id, source)`,
    replace: `      ON trade_outcomes(league_id, season, idea_id)` },
  { id: 'M11', file: MIG, suites: LEDGER,
    claim: "the real table has no sim_run_id, so a synthetic row has nowhere to hide in it",
    find: `    CREATE TABLE IF NOT EXISTS trade_outcomes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id            INTEGER NOT NULL,`,
    replace: `    CREATE TABLE IF NOT EXISTS trade_outcomes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      sim_run_id           TEXT,
      league_id            INTEGER NOT NULL,` },
  { id: 'M12', file: MIG, suites: LEDGER,
    claim: "a synthetic row cannot describe itself as real",
    find: `      label                TEXT NOT NULL DEFAULT 'synthetic'
        CHECK (label = 'synthetic'),`,
    replace: `      label                TEXT NOT NULL DEFAULT 'synthetic',` },

  // ---- the service: absence, vocabulary, silence, the band, the cache ----
  { id: 'M13', file: SVC, suites: LEDGER,
    claim: "settle reports WHICH absence it is, not an empty result",
    find: "    return { ...result, state: 'raw_table_absent', reason: RAW_ABSENT_REASON };",
    replace: '    return { ...result };' },
  { id: 'M14', file: SVC, suites: LEDGER,
    claim: "the ESPN proposal type is TRADE_PROPOSAL",
    find: "const PROPOSAL = 'TRADE_PROPOSAL';", replace: "const PROPOSAL = 'TRADE_PROPOSE';" },
  { id: 'M15', file: SVC, suites: LEDGER,
    claim: "silence is not a decline",
    find: "    const status = a ? a.verdict : 'proposed';",
    replace: "    const status = a ? a.verdict : 'declined';" },
  { id: 'M16', file: SVC, suites: LEDGER,
    claim: "an answer whose proposal was never collected is skipped, not attached to a guess",
    find: "    if (!target || !proposalIds.has(target)) {", replace: '    if (!target) {' },
  { id: 'M17', file: SVC, suites: LEDGER,
    claim: "a proposal with no readable counterparty is skipped, not written with a guess",
    find: "    return { error: 'the raw row names no counterparty in its items, and a deal with one side is not a deal' };",
    replace: "    return { proposer, counterparty: '999', give: [], get: [] };" },
  { id: 'M18', file: SVC, suites: LEDGER,
    claim: "a bare midpoint is refused: the model states a band, never a point",
    find: '  if (low == null || high == null) {', replace: '  if (false) {' },
  { id: 'M19', file: SVC, suites: LEDGER,
    claim: "a prediction with no basis is refused",
    find: '  if (!basis) {', replace: '  if (false) {' },
  { id: 'M20', file: SVC, suites: LEDGER,
    claim: "a cache hit records nothing, because no decision was made on that request",
    find: "  if (!result || result.source === 'cache') {", replace: '  if (!result) {' },
  { id: 'M21', file: SVC, suites: LEDGER,
    claim: "a dropped idea with no stated reason gets an honest sentence, not an invented one",
    find: "          ?? 'the model did not select it from the slate, and the run gave no reason of its own',",
    replace: "          ?? 'rejected by the model'," },
  { id: 'M22', file: SVC, suites: LEDGER,
    claim: "an idea with no acceptance band is skipped, never written unscoreable",
    find: '      if (common.acceptance?.band?.mid == null) { out.skipped++; continue; }',
    replace: '      if (false) { out.skipped++; continue; }' },
  { id: 'M23', file: SVC, suites: LEDGER,
    claim: "an unreadable counterparty on an idea stays null rather than being guessed",
    find: '  return v == null ? null : String(v);', replace: "  return v == null ? '1' : String(v);" },
  { id: 'M24', file: SVC, suites: LEDGER,
    claim: "a second fresh run over the same slate adds nothing",
    find: '    if (already) { out.skipped++; continue; }',
    replace: '    if (false) { out.skipped++; continue; }' },
  { id: 'M25', file: SVC, suites: LEDGER,
    claim: "the reader reads the REAL table and never the synthetic one",
    find: '  return rows(`SELECT * FROM trade_outcomes WHERE league_id = ? AND season = ?',
    replace: '  return rows(`SELECT * FROM trade_outcomes_synthetic WHERE league_id = ? AND season = ?' },

  // ---- trade-tactics: the two gates, and the catch that must stay removed ----
  { id: 'M26', file: TAC, suites: TACTICS,
    claim: "the decisions min_n sentence runs only when the store was actually read",
    find: `    } else if (txPresent) {
      // ONLY WHEN THE STORE WAS ACTUALLY READ. This sentence says "we counted his`,
    replace: `    } else {
      // ONLY WHEN THE STORE WAS ACTUALLY READ. This sentence says "we counted his` },
  { id: 'M27', file: TAC, suites: TACTICS,
    claim: "the active-hours min_n sentence runs only when the store was actually read",
    find: `    } else if (txPresent) {
      // ONLY WHEN THE STORE WAS ACTUALLY READ, for the same reason as the`,
    replace: `    } else {
      // ONLY WHEN THE STORE WAS ACTUALLY READ, for the same reason as the` },
  { id: 'M28', file: TAC, suites: TACTICS,
    claim: "a programming error in the timing query throws instead of arriving as an empty history",
    find: `  const tx = txPresent
    ? rows(\`SELECT tx_id, type, execution_type, team_id, related_tx_id, proposed_at
            FROM league_transactions_raw WHERE league_id = ? AND (? IS NULL OR season = ?)\`,
    leagueId, yr, yr)
    : [];`,
    replace: `  let tx = [];
  try {
    tx = rows(\`SELECT tx_id, type, execution_type, team_id, related_tx_id, proposed_at
                FROM league_transactions_raw WHERE league_id = ? AND (? IS NULL OR season = ?)\`,
    leagueId, yr, yr);
  } catch { tx = []; }` },
  { id: 'M29', file: TAC, suites: TACTICS,
    claim: "vetoClimate says the store is absent rather than reporting a league that never vetoes",
    find: "    return { ...climate, read_state: 'source_table_absent', reason: TX_ABSENT_REASON };",
    replace: '    return climate;' },

  // ---- the two vocabulary CHECKs, anchored past the synthetic table ----
  // Both tables share a column block, so a short anchor matches twice and the row
  // is refused rather than applied to the wrong one.
  { id: 'M7', suites: LEDGER, claim: 'the status vocabulary is closed (table CHECK)',
    edits: [{ file: MIG,
      find: `      status               TEXT NOT NULL
        CHECK (status IN ('proposed', 'accepted', 'declined', 'countered',
                          'expired', 'ignored', 'not_proposed')),
      not_proposed_reason  TEXT,
      counter_json         TEXT,
      espn_tx_id           TEXT,
      idea_id              TEXT,
      resolved_at          TEXT,
      created_at           TEXT NOT NULL,`,
      replace: `      status               TEXT NOT NULL,
      not_proposed_reason  TEXT,
      counter_json         TEXT,
      espn_tx_id           TEXT,
      idea_id              TEXT,
      resolved_at          TEXT,
      created_at           TEXT NOT NULL,` }] },
  { id: 'M8', suites: LEDGER, claim: 'the source vocabulary is closed (table CHECK)',
    edits: [{ file: MIG,
      find: `      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id            INTEGER NOT NULL,
      season               INTEGER NOT NULL,
      source               TEXT NOT NULL
        CHECK (source IN ('observed', 'app_proposed', 'considered_only')),`,
      replace: `      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id            INTEGER NOT NULL,
      season               INTEGER NOT NULL,
      source               TEXT NOT NULL,` }] },

  // ---- the service half of each layered rule, and the pairs ----
  { id: 'M31', suites: LEDGER, claim: 'the SERVICE refuses an app_proposed row with no midpoint',
    edits: [{ file: SVC,
      find: "    throw new Error('trade-outcomes: model_p_accept is required and was not given');",
      replace: '    return { mid: null, low: null, high: null, basis: null };' }] },
  { id: 'M30-PAIR', suites: LEDGER,
    claim: 'a midpoint with no basis is refused by SOMETHING — both layers removed at once',
    edits: [
      { file: MIG, find: "      CHECK (model_p_accept IS NULL OR model_basis IS NOT NULL)\n",
        replace: '      CHECK (1 = 1)\n' },
      { file: SVC, find: '  if (!basis) {', replace: '  if (false) {' }] },
  { id: 'M32-PAIR', suites: LEDGER,
    claim: 'an app_proposed row with no midpoint is refused by SOMETHING — both layers at once',
    edits: [
      { file: MIG, find: "      CHECK (source <> 'app_proposed' OR model_p_accept IS NOT NULL),\n",
        replace: '' },
      { file: SVC,
        find: "    throw new Error('trade-outcomes: model_p_accept is required and was not given');",
        replace: '    return { mid: null, low: null, high: null, basis: null };' }] },

  // ---- the landing pass (F-05): the recorder read against the PRODUCERS' shapes ----
  // Each of these puts back one piece of the shape the recorder used to read and
  // no producer emits. All eight were live defects until 031e4931; the RED at
  // 88ed3722 is what failed on them.
  { id: 'M33', file: SVC, suites: LEDGER,
    claim: 'what was sent is read from idea_ids, the verifier\'s own field',
    find: '  const sent = new Set((result.proposals ?? []).flatMap(citedIdeas));',
    replace: '  const sent = new Set((result.proposals ?? []).map(p => p?.idea_id).filter(Boolean).map(String));' },
  { id: 'M34', file: SVC, suites: LEDGER,
    claim: 'idea_ids is a list: a proposal merging two ideas sends both',
    find: '  return (Array.isArray(proposal?.idea_ids) ? proposal.idea_ids : [])',
    replace: '  return (Array.isArray(proposal?.idea_ids) ? proposal.idea_ids.slice(0, 1) : [])' },
  { id: 'M35', file: SVC, suites: LEDGER,
    claim: 'a rejection\'s violations land on the ideas its proposal cited',
    find: '    for (const id of citedIdeas(r?.proposal)) {', replace: '    for (const id of citedIdeas(r)) {' },
  { id: 'M36', file: SVC, suites: LEDGER,
    claim: 'the package is the engine\'s i_give / i_get',
    find: '      give: idea?.i_give ?? [], get: idea?.i_get ?? [],',
    replace: '      give: idea?.give ?? [], get: idea?.get ?? [],' },
  { id: 'M37', file: SVC, suites: LEDGER,
    claim: 'the other side is the engine\'s partner_id',
    find: '  const v = idea?.partner_id ?? null;', replace: '  const v = idea?.counterparty?.roster_id ?? null;' },
  { id: 'M38', file: SVC, suites: LEDGER,
    claim: 'a run that made no selection writes no rows',
    find: "  if (result.refused && result.problem !== 'all_rejected') {", replace: '  if (false) {' },
  { id: 'M39', file: SVC, suites: LEDGER,
    claim: 'an all-rejected run is still a decision, and records the verifier\'s words',
    find: "  if (result.refused && result.problem !== 'all_rejected') {", replace: '  if (result.refused) {' },
  { id: 'M40', file: SVC, suites: LEDGER,
    claim: 'an unparseable items_json is named, not read as a deal with no counterparty',
    find: '    return { error: `its items_json is not valid JSON (${e.message}), so the parties cannot be read` };',
    replace: '    return { items: [] };' },
  // M41 (skeptic pass): the observed package's direction. Before 74d0ad7c no
  // assertion read give_json or get_json, and this swap passed every suite.
  { id: 'M41', file: SVC, suites: LEDGER,
    claim: 'the observed writer files what left the proposer as give, what arrived as get',
    edits: [{ file: SVC, find: '    if (String(i?.fromTeamId) === proposer) give.push(i);',
      replace: '    if (String(i?.fromTeamId) === proposer) get.push(i);' },
    { file: SVC, find: '    else if (String(i?.toTeamId) === proposer) get.push(i);',
      replace: '    else if (String(i?.toTeamId) === proposer) give.push(i);' }] },

  // ---- the CALL SITE: routes/trades.js, the recorder's only caller ----
  // A rule tested only through the service is not a rule about what the route
  // passes it. Each row changes one argument or one line of the route's own
  // handling; the route suite is what must notice.
  { id: 'C1', file: RTE, suites: ROUTE,
    claim: 'the route hands the recorder the live result, not a cache-shaped one',
    find: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,',
    replace: "        ideas, result: { ...result, source: 'cache' }, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null," },
  { id: 'C2', file: RTE, suites: ROUTE,
    claim: 'the route hands the recorder the whole slate',
    find: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,',
    replace: '        ideas: [], result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,' },
  { id: 'C3', file: RTE, suites: ROUTE,
    claim: 'the route stamps the prompt version that made the decision',
    find: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,',
    replace: '        ideas, result, modelVersion: null, proposerTeamId: found?.me?.roster_id ?? null,' },
  { id: 'C4', file: RTE, suites: ROUTE,
    claim: 'the route records which team the slate was priced for',
    find: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,',
    replace: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: null,' },
  { id: 'C5', file: RTE, suites: ROUTE,
    claim: 'the route files rows under the league\'s own season',
    find: '      ledger = recordProposalSlate(lg.id, lg.season ?? null, {',
    replace: '      ledger = recordProposalSlate(lg.id, 2025, {' },
  { id: 'C6', file: RTE, suites: ROUTE,
    claim: 'the ledger state reaches the response surface',
    find: '    res.json({ ...result, outcome_ledger: ledger });', replace: '    res.json(result);' },
  { id: 'C7', file: RTE, suites: ROUTE,
    claim: 'a failed ledger write never fails the proposals',
    find: "      ledger = { state: 'write_failed', reason: String(e?.message ?? e) };",
    replace: '      throw e;' },
  // C8/C9 (skeptic pass): the proposer is the ENGINE's team. C8 puts back the
  // line as it shipped, which stamped NULL on every row the app's own call writes
  // (the client sends no team_id). C9 keeps the engine's team but lets the query
  // win, which is wrong exactly when the engine could not find the asked-for team.
  { id: 'C8', file: RTE, suites: ROUTE,
    claim: 'the proposer is not read from the query string (the client sends none)',
    find: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,',
    replace: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: req.query.team_id ?? null,' },
  { id: 'C9', file: RTE, suites: ROUTE,
    claim: 'the engine\'s team wins over the query\'s when the two differ',
    find: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,',
    replace: '        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: req.query.team_id ?? found?.me?.roster_id ?? null,' },

  // ---- designed survivor: an EQUIVALENT mutant at the call site ----
  // `lg.season` comes from a real column, so it is null or a number, never
  // undefined, and the service's requireFields treats null and undefined alike
  // (`== null`). Dropping `?? null` changes nothing any caller can observe. It
  // must come back SURVIVED. If it is ever KILLED, a test is pinning the route's
  // spelling rather than its behaviour, and every call-site kill above is suspect.
  { id: 'C-EQUIV', file: RTE, suites: ROUTE, expectSurvive: true,
    claim: 'an equivalent mutant at the call site (designed survivor)',
    find: '      ledger = recordProposalSlate(lg.id, lg.season ?? null, {',
    replace: '      ledger = recordProposalSlate(lg.id, lg.season, {' },

  // ---- control: no change at all. Must come back GREEN, or the harness lies ----
  { id: 'CONTROL', suites: LEDGER, claim: 'the harness itself',
    edits: [{ file: SVC, find: 'const RAW_TABLE = ', replace: 'const RAW_TABLE = ' }] },

  // ---- control: a pattern that CANNOT match. Must come back BAD_ROW ----
  // CONTROL above proves the harness notices when it changed nothing. It does not
  // prove the bad-row detector works, because no row is designed to trip it, and a
  // detector nothing ever fires is a detector nobody has tested. A row whose `find`
  // is absent from the file must be reported as not-applied; if it is ever scored
  // KILLED or SURVIVED instead, every other row's verdict is worth nothing, because
  // the harness would be scoring mutations it never made.
  { id: 'NOTAPPLIED', suites: LEDGER, expectBad: true,
    claim: 'the not-applied detector itself',
    edits: [{ file: SVC, find: 'this string is not in trade-outcomes.js and must never be',
      replace: 'unreachable' }] },
];

const treeBefore = git('write-tree');
// Not "the tree is clean" but "the tree did not MOVE": this is meant to be runnable
// mid-unit, on a working tree that has uncommitted work in it. What would void a run
// is an edit landing while it is in flight, or a revert that did not take.
const dirtyBefore = git('status', '--porcelain');
const results = [];

for (const m of M) {
  const edits = m.edits ?? [{ file: m.file, find: m.find, replace: m.replace }];
  const saved = new Map();
  let bad = '';

  for (const e of edits) {
    const p = path.join(REPO, e.file);
    const before = readFileSync(p, 'utf8');
    if (!saved.has(p)) saved.set(p, before);
    const hits = before.split(e.find).length - 1;
    // Exactly one, always. A find that matches twice would edit the wrong table.
    if (hits !== 1) { bad = `${e.file}: find matched ${hits} times, needs exactly 1`; break; }
    writeFileSync(p, before.replace(e.find, e.replace));
  }

  // A mutation that does not parse proves nothing about any assertion.
  if (!bad) {
    for (const p of saved.keys()) {
      try { execFileSync('node', ['--check', p], { stdio: 'pipe' }); }
      catch (err) { bad = `does not parse: ${String(err.stderr ?? '').split('\n')[0]}`; }
    }
  }

  let out = '';
  let nFail = null;
  if (!bad) {
    try {
      out = execFileSync('node', ['--experimental-test-module-mocks', '--test',
        `--test-reporter=${REPORTER}`, ...m.suites],
      { cwd: REPO, encoding: 'utf8', stdio: 'pipe', timeout: 180000,
        env: { ...process.env, SCHEDULER_DISABLED: '1' } });
    } catch (err) { out = String(err.stdout ?? '') + String(err.stderr ?? ''); }
    // The count is READ, never defaulted. This line used to fall back to 0 when
    // the runner printed no `# fail N`, and Node 25's default reporter for a pipe
    // is `spec`, which prints `ℹ fail 1` instead. So on Node 25 every row read
    // fail=0 and scored SURVIVED even while its failing test lines were listed
    // right next to the verdict. A count the harness could not read is a row it
    // cannot score.
    const counted = out.match(/^# fail (\d+)$/m);
    if (counted) nFail = Number(counted[1]);
    else bad = `the runner printed no "# fail N" line (reporter ${REPORTER}), so no count was read`;
  }

  for (const [p, before] of saved) {
    writeFileSync(p, before);
    if (readFileSync(p, 'utf8') !== before) {
      throw new Error(`${m.id}: REVERT FAILED on ${p} — stop and restore it by hand`);
    }
  }

  results.push({
    id: m.id, claim: m.claim, bad, nFail, expectSurvive: !!m.expectSurvive,
    failed: [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(x => x[1]),
    sites: [...new Set([...out.matchAll(/(test\/[\w-]+\.test\.js):(\d+):\d+/g)]
      .map(x => `${x[1]}:${x[2]}`))],
    verdict: bad ? 'BAD_ROW' : nFail > 0 ? 'KILLED' : 'SURVIVED',
  });
}

const treeAfter = git('write-tree');
const dirtyAfter = git('status', '--porcelain');
const moved = treeAfter !== treeBefore || dirtyAfter !== dirtyBefore;
console.log(`\ntree before: ${treeBefore}\ntree after:  ${treeAfter}`);
console.log(`working tree: ${dirtyAfter ? `${dirtyAfter.split('\n').length} file(s) modified` : 'clean'}`
  + ` — unchanged across the run: ${!moved}\n`);
for (const r of results) {
  console.log(`${r.id.padEnd(10)} ${r.verdict.padEnd(9)} fail=${r.nFail ?? '-'}`
    + ` @ ${r.sites.slice(0, 2).join(', ') || '-'}`);
  console.log(`           ${r.claim}`);
  for (const f of r.failed.slice(0, 3)) console.log(`           killed by: ${f}`);
  if (r.bad) console.log(`           detail: ${r.bad}`);
  if (r.verdict === 'SURVIVED' && r.id !== 'CONTROL' && !r.expectSurvive) {
    console.log('           *** NOTHING FAILED — this contract has no test ***');
  }
}

const control = results.find(r => r.id === 'CONTROL');
// A designed survivor is SUPPOSED to survive; it becomes the finding the moment
// it is killed, because then a test is pinning spelling rather than behaviour.
const expectedSurvive = new Set(M.filter(m => m.expectSurvive).map(m => m.id));
const survivors = results.filter(r => r.verdict === 'SURVIVED' && r.id !== 'CONTROL'
  && !expectedSurvive.has(r.id));
const designedSurvivorFailed = results.filter(r => expectedSurvive.has(r.id) && r.verdict !== 'SURVIVED');
// A row carrying expectBad is SUPPOSED to come back BAD_ROW, so it is not a fault —
// but it becomes one the moment it does not, which is the whole point of having it.
const expectedBad = new Set(M.filter(m => m.expectBad).map(m => m.id));
const badRows = results.filter(r => r.verdict === 'BAD_ROW' && !expectedBad.has(r.id));
const detectorFailed = results.filter(r => expectedBad.has(r.id) && r.verdict !== 'BAD_ROW');
console.log(`\nrows ${results.length} | killed ${results.filter(r => r.verdict === 'KILLED').length}`
  + ` | survived ${survivors.length} | bad ${badRows.length} | control ${control?.verdict}`
  + ` | not-applied control ${results.find(r => r.id === 'NOTAPPLIED')?.verdict}`
  + ` | designed survivor ${[...expectedSurvive].map(id => results.find(r => r.id === id)?.verdict).join(',') || '-'}`);
console.log(`survivors: ${survivors.map(r => r.id).join(', ') || 'none'}`);

if (moved) {
  console.error('\nTHE TREE MOVED DURING THE RUN — every figure above is void. Restore it first.');
  process.exit(2);
}
for (const r of detectorFailed) {
  console.error(`\n${r.id} was expected to come back BAD_ROW and came back ${r.verdict}.`
    + ' The not-applied detector did not fire, so no verdict in this run can be trusted.');
}
for (const r of designedSurvivorFailed) {
  console.error(`\n${r.id} was designed to SURVIVE and came back ${r.verdict}.`
    + ' A test is pinning the call site\'s spelling, not its behaviour.');
}
if (control?.verdict !== 'SURVIVED' || badRows.length || survivors.length
    || detectorFailed.length || designedSurvivorFailed.length) process.exit(1);
