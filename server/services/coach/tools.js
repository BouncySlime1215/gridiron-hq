/**
 * What Coach can do, and the one shape everything it does comes back in.
 *
 * Two rules hold this file together, and both are about not becoming a second
 * opinion.
 *
 * ONE SHAPE. Every result becomes rows with named columns, recorded in the
 * ledger, so a claim cites a service answer exactly the way it cites a SQL
 * row. A nested service result becomes one row with dotted column names
 * (`out.0.player`). That is ugly to read and exactly right to cite: a cite has
 * to land on a scalar or it is not evidence.
 *
 * NEVER RE-IMPLEMENT. The existing services ARE the tools. whoPlays already
 * answers "who is the depth", coachingProfile already answers "what is the
 * coach's scheme like", footballContext already answers "what does the game
 * script look like". Each descriptor below names the file and function it
 * calls and a test asserts it, so a second implementation of an existing
 * number cannot be added here quietly. Where a question has no service, Coach
 * writes SQL through the guarded layer rather than growing a model for it.
 *
 * `catalog_lookup` is the one tool whose result does NOT enter the ledger.
 * What Coach may read is metadata about Coach, not evidence about football,
 * and a claim about the world must never be able to cite it.
 */
import { safeSelect } from './select.js';
import { catalog, catalogEntry, readableTables, catalogCoverage } from './catalog.js';
import { whoPlays } from '../who-plays.js';
import { teamTendencies } from '../nfl-team-tendencies.js';
import { coachingProfile, footballContext } from '../football-context.js';
import { sourceTrustScore } from '../beat-reporter-accuracy.js';
import { BRAIN_TOOLS, brainToolsOn, BrainToolInputError } from './brain-tools.js';

export class CoachToolError extends Error {
  constructor(message) { super(message); this.name = 'CoachToolError'; }
}

/** Ceilings that keep one tool result from swallowing the context window. */
const MAX_COLUMNS = 400;
const MAX_ARRAY = 60;

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Flatten anything a service returns into rows of scalars.
 *
 * An array of objects is already rows. An array of scalars becomes a row each
 * under `value`. Anything else becomes ONE row whose columns are the dotted
 * paths to its scalar leaves, arrays included (`out.0.player`). `truncated`
 * says when a ceiling was hit, because a silently shortened answer is the
 * failure mode this whole service exists to remove.
 */
export function toRows(value, { maxColumns = MAX_COLUMNS, maxArray = MAX_ARRAY } = {}) {
  if (value === null || value === undefined) return { rows: [], columns: [], truncated: false };
  if (Array.isArray(value)) {
    if (!value.length) return { rows: [], columns: [], truncated: false };
    const capped = value.slice(0, maxArray);
    if (value.every(isPlainObject)) {
      const columns = [...new Set(capped.flatMap(row => Object.keys(row)))];
      return { rows: capped.map(row => ({ ...row })), columns, truncated: capped.length < value.length };
    }
    return { rows: capped.map(item => ({ value: item })), columns: ['value'],
      truncated: capped.length < value.length };
  }
  if (!isPlainObject(value)) return { rows: [{ value }], columns: ['value'], truncated: false };

  const row = {};
  let truncated = false;
  const walk = (node, prefix) => {
    if (Object.keys(row).length >= maxColumns) { truncated = true; return; }
    if (node === null || typeof node !== 'object') { row[prefix] = node; return; }
    if (Array.isArray(node)) {
      if (node.length > maxArray) truncated = true;
      node.slice(0, maxArray).forEach((item, index) => walk(item, `${prefix}.${index}`));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  walk(value, '');
  const columns = Object.keys(row).slice(0, maxColumns);
  if (columns.length < Object.keys(row).length) truncated = true;
  return { rows: [Object.fromEntries(columns.map(c => [c, row[c]]))], columns, truncated };
}

/** Provenance for a service tool, taken from the catalog for the tables it reads. */
function provenanceFor(tables) {
  const provenance = {};
  for (const table of tables) {
    const entry = catalogEntry(table);
    if (entry) provenance[table] = { collection: entry.collection, freshness: entry.freshness, grain: entry.grain };
  }
  return provenance;
}

const int = (value, field) => {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new CoachToolError(`${field} must be a whole number, got ${JSON.stringify(value)}.`);
  return number;
};
const team = value => {
  const abbr = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(abbr)) throw new CoachToolError(`team must be an NFL abbreviation, got ${JSON.stringify(value)}.`);
  return abbr;
};
const nonEmptyString = (value, field) => {
  const s = String(value ?? '').trim();
  if (!s) throw new CoachToolError(`${field} must be a non-empty string, got ${JSON.stringify(value)}.`);
  return s;
};

/**
 * A tool that calls an existing service. `source` is the file and function it
 * calls; `tables` is what that service reads, so the result carries the same
 * provenance a direct query would.
 */
const service = ({ name, description, source, tables, input_schema, call }) => ({
  name, description, source, tables, input_schema, kind: 'service',
  run(input) { return { value: call(input), tables }; }
});

export const COACH_TOOLS = Object.freeze([
  {
    name: 'catalog_lookup',
    kind: 'meta',
    source: 'server/services/coach/catalog.js#catalog',
    tables: [],
    description: 'What Coach may read: every table it can query, what one row of it is, what it means, ' +
      'how it is refreshed and whether it is collected automatically or by hand. Call this with a table name ' +
      'before writing SQL against a table you have not used in this conversation: it returns the real column ' +
      'names, and a guessed column name wastes a round. A table absent from here cannot be read at all, and the ' +
      'honest answer to a question about it is that Coach does not read it.',
    input_schema: { type: 'object', properties: {
      table: { type: 'string', description: 'one table to describe; omit for the whole list' } } },
    run(input) {
      if (input?.table) {
        const entry = catalogEntry(input.table);
        if (!entry) throw new CoachToolError(`Coach does not read ${input.table}.`);
        return { meta: { entry } };
      }
      return { meta: { tables: readableTables(), coverage: catalogCoverage(), catalog: catalog() } };
    }
  },
  {
    name: 'sql_select',
    kind: 'query',
    source: 'server/services/coach/select.js#safeSelect',
    tables: [],
    description: 'Run one read-only SELECT (or WITH ... SELECT) over the catalogued tables, with bound ' +
      'parameters. This is how any question gets answered when no service already answers it, and how any ' +
      'total, average, rank or count is computed — do the arithmetic in SQL rather than in your head.',
    input_schema: { type: 'object', required: ['sql'], properties: {
      sql: { type: 'string', description: 'one SELECT statement, with ? placeholders for every value' },
      params: { type: 'array', description: 'values for the placeholders, in order' },
      max_rows: { type: 'integer', description: 'row ceiling, default 200' } } },
    run(input) {
      const result = safeSelect(input?.sql, input?.params ?? [],
        input?.max_rows ? { maxRows: int(input.max_rows, 'max_rows') } : {});
      return { result };
    }
  },
  {
    name: 'compute',
    kind: 'derive',
    source: 'server/services/coach/ledger.js#derive',
    tables: [],
    description: 'Work out one number from cells already retrieved, recording the formula. Use this rather ' +
      'than doing arithmetic in prose: a number you calculate in your head cannot be cited and will be ' +
      'rejected. Operations: sum, difference, product, quotient, mean, min, max, percent_of.',
    input_schema: { type: 'object', required: ['op', 'inputs'], properties: {
      op: { type: 'string' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'cites, e.g. ["r1#0.targets","r1#1.targets"]' },
      label: { type: 'string' } } },
    run() { throw new CoachToolError('compute is handled by the ledger, not by run().'); }
  },
  service({
    name: 'who_plays',
    source: 'server/services/who-plays.js#whoPlays',
    tables: ['nfl_injuries', 'nfl_news_signals', 'nfl_snaps', 'news_source_validation'],
    description: 'Who is available for one team this week and how confident the app is about each answer: ' +
      'the official injury report, typed beat-reporter signals and snap share joined into one list with the ' +
      'sources behind each call. This is the depth-chart and availability question.',
    input_schema: { type: 'object', required: ['season', 'week', 'team'], properties: {
      season: { type: 'integer' }, week: { type: 'integer' }, team: { type: 'string' } } },
    call: input => whoPlays(int(input.season, 'season'), int(input.week, 'week'), team(input.team))
  }),
  service({
    name: 'team_tendencies',
    source: 'server/services/nfl-team-tendencies.js#teamTendencies',
    tables: ['nfl_team_week_features'],
    description: "One team's measured identity — pace, pass rate, situational splits — every number stated " +
      'as a percentile against the other 31 teams in the same season, which is the form it is useful in.',
    input_schema: { type: 'object', required: ['team'], properties: {
      team: { type: 'string' }, season: { type: 'integer' } } },
    call: input => teamTendencies(team(input.team),
      input.season ? { season: int(input.season, 'season') } : {})
  }),
  service({
    name: 'coaching_profile',
    source: 'server/services/football-context.js#coachingProfile',
    tables: ['nfl_team_week_features'],
    description: 'What this coaching staff actually does, as league percentiles from completed weeks only: ' +
      'how much they throw in neutral situations, pace, aggression. This is the "what is the scheme like" ' +
      'question, answered from play-by-play rather than from the scouting paragraph.',
    input_schema: { type: 'object', required: ['team', 'season', 'week'], properties: {
      team: { type: 'string' }, season: { type: 'integer' }, week: { type: 'integer' } } },
    call: input => coachingProfile(team(input.team), int(input.season, 'season'), int(input.week, 'week'))
  }),
  service({
    name: 'football_context',
    source: 'server/services/football-context.js#footballContext',
    tables: ['game_lines', 'nfl_team_week_features', 'nfl_injuries', 'nfl_game_weather'],
    description: 'The football around one game rather than the arithmetic in front of it: who is hurt, who ' +
      'the defence cannot cover, whether the coach throws, and whether the wind is up. This is the game-script ' +
      'question. Cutoff-safe — it reads nothing published after kickoff.',
    input_schema: { type: 'object', required: ['season', 'week', 'home', 'away'], properties: {
      season: { type: 'integer' }, week: { type: 'integer' },
      home: { type: 'string' }, away: { type: 'string' } } },
    call: input => footballContext(int(input.season, 'season'), int(input.week, 'week'),
      team(input.home), team(input.away))
  }),
  service({
    name: 'source_trust',
    source: 'server/services/beat-reporter-accuracy.js#sourceTrustScore',
    tables: ['beat_reporter_claim_resolutions'],
    description: 'How often one beat reporter\'s injury_status claims have actually been confirmed by what ' +
      'happened, from resolved claims only — this is the "who actually predicts outcomes vs. who cried wolf" ' +
      'question. state is "none" (zero resolved claims — no score, never read this as measured-and-bad), ' +
      '"pooled" (fewer than 5 resolved claims — the raw rate is blended toward the claim-type baseline so one ' +
      'lucky or unlucky call does not read as a measured 100% or 0%), or "measured" (5 or more — the raw rate ' +
      'stands). Raw SQL cannot reproduce the pooled-shrinkage math, which is why this is a tool and not a query.',
    input_schema: { type: 'object', required: ['handle'], properties: {
      handle: { type: 'string', description: 'reporter_handle exactly as stored in nfl_news_events' },
      claim_type: { type: 'string', description: 'restrict to one claim type, e.g. "injury_status"; omit for all types' } } },
    call: input => sourceTrustScore(nonEmptyString(input.handle, 'handle'),
      { claimType: input.claim_type ? nonEmptyString(input.claim_type, 'claim_type') : null })
  })
]);

/**
 * The tools Coach is offered on this call: COACH_TOOLS, plus the brain read
 * tools (brain-tools.js) when GRIDIRON_COACH_BRAIN_TOOLS or preview mode is on.
 * Read per call, so the flag flips without a restart.
 */
export function activeTools() {
  return brainToolsOn() ? [...COACH_TOOLS, ...BRAIN_TOOLS] : COACH_TOOLS;
}

/** The tool blocks handed to Claude: no functions, no internals. */
export function toolDefinitions() {
  return activeTools().map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Run one tool and record what it returned.
 *
 * @returns {{entry: object|null, summary: object}} `entry` is the ledger entry a
 *   claim can cite, or null for metadata. `summary` is what goes back to the
 *   model: small, and enough to write the next cite.
 * @throws {CoachToolError} unknown tool or bad arguments
 * @throws refusals and SQL errors from the guarded query layer, unchanged
 */
export function runCoachTool(name, input, { ledger } = {}) {
  const tools = activeTools();
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new CoachToolError(
      `There is no tool called ${name}. Coach has: ${tools.map(t => t.name).join(', ')}.`);
  }
  if (!ledger) throw new CoachToolError('A tool call needs the turn\'s ledger.');

  if (tool.kind === 'meta') {
    return { entry: null, summary: tool.run(input).meta };
  }

  if (tool.kind === 'derive') {
    const entry = ledger.derive({ op: input?.op, inputs: input?.inputs, label: input?.label });
    return { entry, summary: { cite: entry.id, value: entry.value, formula: entry.formula } };
  }

  if (tool.kind === 'query') {
    const { result } = tool.run(input);
    const entry = ledger.record(result);
    return { entry, summary: summarise(entry) };
  }

  let ran;
  try {
    ran = tool.run(input);
  } catch (e) {
    if (e instanceof BrainToolInputError) throw new CoachToolError(e.message);
    throw e;
  }
  const { value, tables } = ran;
  const { rows, columns, truncated } = toRows(value);
  const entry = ledger.record({
    tool: name, sql: null, params: [], tables, columns, rows,
    row_count: rows.length, truncated, provenance: provenanceFor(tables)
  });
  return { entry, summary: summarise(entry) };
}

/** What the model gets back: the rows, plus how to cite them. */
function summarise(entry) {
  return {
    cite_prefix: `${entry.id}#`,
    columns: entry.columns,
    row_count: entry.row_count,
    truncated: entry.truncated,
    tables: entry.tables,
    provenance: entry.provenance,
    rows: entry.rows
  };
}
