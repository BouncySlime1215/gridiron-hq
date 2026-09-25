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
import { NAV_TOOL, navOn, NavigatorError } from './navigator.js';
import { NEG_TOOL, negotiateOn, warmNegotiator, NegotiatorError } from './negotiator.js';
import { validateAction, ACTION_TYPES, PANELS, PLUG_IN_FIELDS, PLAN_CHANGING } from '../warroom-actions/schema.js';
// RULES-EVERYWHERE: Nick's hard rules, the one gate (campaign/never-give.js).
import { row as dbRow, rows as dbRows } from '../../db/index.js';
import { draftNamesBlocked } from '../campaign/never-give.js';

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
 * WR-COACH: Coach's War Room tools. Each returns ONE typed UI action (the
 * schema is server/services/warroom-actions/schema.js) for the client
 * dispatcher to apply; nothing enters the ledger, because an action is not
 * evidence about football. The client refuses any action outside the schema,
 * and plan-changing actions only open a trade-off preview that waits for
 * Nick's Confirm tap. No tool here can send anything to a league-mate.
 */
const uiTool = ({ name, types, description, properties }) => ({
  name, kind: 'ui_action', source: 'server/services/warroom-actions/schema.js#validateAction', tables: [],
  types: Object.freeze(types), description,
  input_schema: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: types }, ...properties } },
  run(input) {
    if (!types.includes(input?.type)) {
      throw new CoachToolError(`${name} does ${types.join(', ')}; ${JSON.stringify(input?.type)} is not one of them.`);
    }
    const checked = validateAction(input);
    if (!checked.ok) throw new CoachToolError(`Refused: ${checked.error}.`);
    return { action: checked.action };
  }
});

const VIEW_TYPES = ACTION_TYPES.filter(t => !PLAN_CHANGING.includes(t) && !['plug_in', 'draft_message'].includes(t));

export const WARROOM_TOOLS = Object.freeze([
  uiTool({
    name: 'warroom_view',
    types: VIEW_TYPES,
    description: 'Change what the War Room dashboard shows. focus_panel switches league (league = the number on ' +
      'the league switcher) and brings a panel into the main slot; filter / sort apply to the panel; pin_card keeps ' +
      'a player or offer on screen; arrange_layout resizes or moves a panel; reset_layout restores the default grid; ' +
      'undo reverts the last change; next skips the current offer in the deck; explain highlights the reason chain. ' +
      'Every change is one-tap undoable.',
    properties: {
      panel: { type: 'string', enum: [...PANELS] }, league: { type: 'integer' },
      position: { type: 'string' }, by: { type: 'string' }, player_id: { type: 'string' }, move_id: { type: 'string' },
      size: { type: 'string', enum: ['normal', 'large'] }, order: { type: 'integer' }
    }
  }),
  uiTool({
    name: 'warroom_plug_in',
    types: ['plug_in'],
    description: 'Add a card to the dashboard bound to one engine field, shown as a number, list, sparkline or table. ' +
      'You choose WHICH field and HOW to show it; the value is read from the engine, never written by you. Fields: ' +
      Object.entries(PLUG_IN_FIELDS).map(([f, v]) => `${f} (${v.join('/')})`).join(', ') + '.',
    properties: { field: { type: 'string', enum: Object.keys(PLUG_IN_FIELDS) }, view: { type: 'string' }, title: { type: 'string' } }
  }),
  uiTool({
    name: 'warroom_plan_change',
    types: [...PLAN_CHANGING],
    description: 'Propose a change to the plan: set_objective (goal title / playoffs / get_player / points, optional ' +
      'arrive_by week), add_stop, remove_stop, set_risk_mode (safe / balanced / all_in, optional until_week), ' +
      "set_tolerance. Nothing changes when you call this: the dashboard shows the engine's trade-off preview and waits " +
      'for Nick to tap Confirm. Never state the trade-off numbers yourself; the preview shows them.',
    properties: {
      goal: { type: 'string' }, player_id: { type: 'string' }, points_per_week: { type: 'integer' }, arrive_by: { type: 'integer' },
      stop: { type: 'object' }, stop_id: { type: 'string' }, mode: { type: 'string' }, until_week: { type: 'integer' },
      key: { type: 'string' }, value: { type: 'number' }
    }
  }),
  uiTool({
    name: 'warroom_draft_message',
    types: ['draft_message'],
    description: "Fill the next-move message box with a draft for Nick to copy. Words only, no digits (numbers come from " +
      'the engine). Coach never sends it: Nick copies it and sends it himself.',
    properties: { text: { type: 'string' }, tone: { type: 'string', enum: ['softer', 'firmer', 'neutral'] } }
  })
]);

/**
 * The ONE registry: every tool Coach is offered on this call, in five groups.
 *   COACH_TOOLS     always.
 *   BRAIN_TOOLS     the brain read tools (brain-tools.js), when
 *                   GRIDIRON_COACH_BRAIN_TOOLS or preview mode is on.
 *   NAV_TOOL        itinerary_edit (navigator.js, COACH-NAV), when
 *                   GRIDIRON_COACH_NAV or preview mode is on.
 *   NEG_TOOL        negotiate_reply (negotiator.js, COACH-NEGOTIATE), when
 *                   GRIDIRON_COACH_NEGOTIATE or preview mode is on.
 *   WARROOM_TOOLS   only when the question comes from the War Room, so every
 *                   other Coach surface keeps exactly today's tool list.
 * Flags are read per call, so a flag flips without a restart.
 */
export function activeTools({ warRoom = false } = {}) {
  const neg = negotiateOn();
  // The negotiator's engine modules load in the background the first time it is offered.
  if (neg) warmNegotiator();
  return [
    ...COACH_TOOLS,
    ...(brainToolsOn() ? BRAIN_TOOLS : []),
    ...(navOn() ? [NAV_TOOL] : []),
    ...(neg ? [NEG_TOOL] : []),
    ...(warRoom ? WARROOM_TOOLS : [])
  ];
}

/** The tool blocks handed to Claude: no functions, no internals. */
export function toolDefinitions({ warRoom = false } = {}) {
  return activeTools({ warRoom }).map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Run one tool and record what it returned.
 *
 * @returns {{entry: object|null, summary: object}} `entry` is the ledger entry a
 *   claim can cite, or null for metadata. `summary` is what goes back to the
 *   model: small, and enough to write the next cite. A War Room tool also
 *   returns `action`, the validated UI action for the client dispatcher.
 * @throws {CoachToolError} unknown tool, bad arguments, or a refused UI action
 * @throws refusals and SQL errors from the guarded query layer, unchanged
 */
export function runCoachTool(name, input, { ledger } = {}) {
  // A War Room action is runnable whenever the model names one (as before
  // this registry); the brain tools and the navigator stay behind their flags.
  const tools = activeTools({ warRoom: true });
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new CoachToolError(
      `There is no tool called ${name}. Coach has: ${tools.map(t => t.name).join(', ')}.`);
  }
  if (tool.kind === 'ui_action') {
    const { action } = tool.run(input);
    // RULES-EVERYWHERE: a drafted message that names a player Nick's hard rules keep out of a trade is dropped.
    const blocked = action.type === 'draft_message' ? draftNamesBlocked({ row: dbRow, rows: dbRows }, action.text) : [];
    if (blocked.length) {
      // Logged with the blocked ids (never the draft text), so a name-match false positive can be found.
      console.warn(`[rules-everywhere] coach draft dropped: names blocked player id(s) ${blocked.join(',')}`);
      return { entry: null, dropped_by_rule: 1, blocked_ids: blocked,
        summary: { refused: "That draft names a player Nick's hard rules keep out of any trade, so it was not put in the message box.",
          dropped_by_rule: 1, blocked_ids: blocked } };
    }
    return { entry: null, action,
      summary: { action, note: PLAN_CHANGING.includes(action.type)
        ? 'Sent to the dashboard as a preview. Nothing changes until Nick taps Confirm.'
        : 'Sent to the dashboard. Nick can undo it with one tap.' } };
  }
  if (!ledger) throw new CoachToolError('A tool call needs the turn\'s ledger.');

  if (tool.kind === 'meta') {
    return { entry: null, summary: tool.run(input).meta };
  }

  if (tool.kind === 'navigate') {
    // COACH-NAV: reads the plan into the ledger, proposes edits, writes nothing.
    // The dashboard dispatcher holds ONE pending plan change, so navigate()
    // serves at most one action; the other edits come back as `queued` and are
    // named in the answer's refusals, never dropped silently.
    let out;
    try {
      out = tool.run(input, { ledger });
    } catch (e) {
      if (e instanceof NavigatorError || e instanceof BrainToolInputError) throw new CoachToolError(e.message);
      throw e;
    }
    const entry = ledger.queries.at(-1) ?? null;
    return { entry, ...(out.actions.length ? { action: out.actions[0] } : {}),
      summary: { proposal: out.proposal, claims: out.answer.claims, refusals: out.answer.refusals,
        as_of: out.answer.as_of, grounded: out.verification.ok, on_screen: out.actions[0] ?? null, queued: out.queued,
        note: 'Put these claims and refusals in your answer as they are, footer last. Only on_screen waits for ' +
          'Nick\'s Confirm; queued changes are not on screen and are not recorded until he asks for them again. ' +
          'Do not call itinerary_edit again this turn: a second call replaces the preview on screen.' } };
  }

  if (tool.kind === 'negotiate') {
    // COACH-NEGOTIATE: reads the plan and the engine's prices into the ledger,
    // drafts, sends nothing. The one action is a draft for the dock's message box.
    let out;
    try {
      out = tool.run(input, { ledger });
    } catch (e) {
      if (e instanceof NegotiatorError || e instanceof BrainToolInputError) throw new CoachToolError(e.message);
      throw e;
    }
    const entry = ledger.queries.at(-1) ?? null;
    return { entry, ...(out.actions.length ? { action: out.actions[0] } : {}), dropped_by_rule: out.dropped_by_rule ?? 0,
      summary: { kind: out.kind, recommendation: out.recommendation, reprice: out.reprice, draft: out.draft,
        claims: out.answer.claims, refusals: out.answer.refusals, as_of: out.answer.as_of,
        grounded: out.verification.ok, sends: out.sends, dropped_by_rule: out.dropped_by_rule ?? 0,
        note: 'Put these claims and refusals in your answer as they are. The draft is in the message box for Nick to ' +
          'copy; nothing was sent and nothing was logged. Never state a price that is not in these claims.' } };
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
