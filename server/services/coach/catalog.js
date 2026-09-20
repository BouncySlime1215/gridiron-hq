/**
 * What Coach may read, and what each table means.
 *
 * The assistant this replaces was told to speak a controlled vocabulary that
 * had been deleted from the repo: nfl-page-explain.js:26 reads
 * `client/src/pages/betting/TERMINOLOGY.md`, the 09-17 UI teardown removed that
 * directory, and :32 swaps in a placeholder string while the system prompt
 * still says "use these words and these meanings exactly". A model given a
 * promise of meaning and no meaning supplies its own. This file is the meaning,
 * checked in, and a test fails if it ever describes a table that is not there.
 *
 * Every entry answers four questions, because an answer built on a row is only
 * as good as the reader's ability to judge the row:
 *
 *   grain       what one row is
 *   means       what it is, in words a person who does not read SQL can use
 *   freshness   what refreshes it
 *   collection  'auto'    a scheduler job or a league sync keeps it current
 *               'by_hand' it only changes when someone runs something
 *               'derived' computed from other tables by a fit or a build
 *               'seed'    checked into the repo
 *
 * `collection` is not decoration. Finding 7 of tonight's audit is that every
 * manager read in the app comes from rows a person collected by hand and no
 * surface said so. A Coach answer built on a `by_hand` table has to show its
 * age; one built on an `auto` table does not. The field is how the answering
 * layer knows which it is holding without asking a model to remember.
 *
 * `redact` names columns Coach may never select or filter on. `leagues` carries
 * the ESPN session cookies next to the league name; CLAUDE.md's rule is that a
 * secret never reaches a log or a message, and the enforcement lives in
 * select.js, not in a prompt.
 *
 * Adding a table here grants Coach read access to it. That is the whole access
 * model: absent means unreadable, and select.js names the absent table in its
 * refusal so the gap is visible rather than mysterious.
 */
import { rows } from '../../db/index.js';

export const COLLECTION_MODES = Object.freeze(['auto', 'by_hand', 'derived', 'seed']);

/**
 * One catalog entry.
 *
 * `createdAtRuntimeBy` is the honest half of this record. Nineteen tables of
 * the app database are created by neither `server/db/schema/` nor a migration:
 * three by the database layer itself at boot, seven when a service module is
 * imported, one on its first write, and eight only by a script somebody has to
 * run — so "Coach may read it" and "it is there" are different claims. A table
 * the declared schema creates says nothing here; a table that comes from
 * anywhere else says, in a sentence, what brings it into being. The query layer
 * reads this to explain an absent table instead of passing SQLite's wording
 * along, and a test asserts that every file named here exists and holds the
 * CREATE TABLE.
 */
const t = (grain, means, freshness, collection, redact = [], createdAtRuntimeBy = null) =>
  Object.freeze({ grain, means, freshness, collection, redact: Object.freeze(redact),
    created_at_runtime_by: createdAtRuntimeBy });

/**
 * Who creates a table that no migration creates. Written once and referenced
 * by the entries below, because the same file creates several of them and a
 * copy that drifts is exactly what this field exists to prevent.
 */
const IMPORT_MANAGER_SIGNALS =
  '`server/services/manager-signals.js` creates it when the module is imported, so it exists on '
  + 'every boot but appears in no migration';
const IMPORT_MANAGER_ARCHETYPES =
  '`server/services/manager-archetypes.js` creates it when the module is imported, so it exists on '
  + 'every boot but appears in no migration';
const IMPORT_MANAGER_IDENTITY =
  '`server/services/manager-identity.js` creates it when the module is imported, so it exists on '
  + 'every boot but appears in no migration';
const IMPORT_COACH_AUDIT =
  '`server/services/coach/audit.js` creates it when the module is imported, so it exists on every '
  + 'boot but appears in no migration';
const IMPORT_COACH_CONTEXT =
  '`server/services/coach/people/context.js` creates it when the module is imported, so it exists '
  + 'on every boot but appears in no migration';
const SCRIPT_PERSON_PROFILES =
  '`scripts/build-person-profiles.mjs` creates it, and nothing else does, so it has not been built '
  + 'on any machine where that script has not been run';
const SCRIPT_LEAGUE_TRANSACTIONS =
  '`scripts/collect-league-transactions.mjs` creates it, and nothing else does, so it has '
  + 'not been built on any machine where that script has not been run';
const SCRIPT_LEAGUE_HISTORY =
  '`scripts/backfill-league-history.mjs` creates it, and nothing else does, so it has not '
  + 'been built on any machine where that script has not been run';
const SCRIPT_FIT_AVAILABILITY =
  '`scripts/fit-availability.mjs` creates it from the DDL in `server/services/contingency.js`, and '
  + 'nothing else does, so it has not been built on any machine where that script has not been run';

/**
 * The fantasy core. Deliberately not "every table": 215 exist, most of them
 * betting-side machinery, model artefacts and audit ledgers that cannot inform
 * a fantasy answer and would only widen what a generated query can touch.
 * catalogCoverage() reports what is left out so the gap is a number.
 */
export const COACH_TABLES = Object.freeze({
  // --- who exists, and where ---
  players: t('one NFL player',
    'the player identity table the whole app joins on: name, position, current team, depth rank and the external ids (ESPN, Sleeper, nflverse gsis)',
    'ESPN roster sync and the nflverse crosswalk job', 'auto'),
  nfl_teams: t('one of the 32 NFL teams',
    'team identity plus the current coaching staff and scheme write-ups: head coach, coordinators, offensive and defensive scheme and their detail paragraphs, and the per-unit scouting text',
    'seeded, with the staff and scheme columns refreshed by the team_analyses and nfl_coaches jobs', 'seed'),
  nfl_team_coaches: t('one team in one season',
    'which head coach actually coached a team in a season and for how many games — the history nfl_teams cannot hold because it only has today',
    'nfl_coaches job, daily', 'auto'),
  roster_players: t('one player on one NFL team roster',
    "the synced ESPN roster: jersey, age, experience, height, weight, status and which unit he is on (offense, defense, special teams, IR, practice squad)",
    'league and roster sync jobs', 'auto'),
  nfl_depth: t('one player at one position on one team in one week',
    'the depth chart as captured that week: position, rank within it and the slot label. This is the answer to "who is the depth"',
    'espn_depth_chart job', 'auto'),
  leagues: t('one fantasy league Nick is in',
    'the league itself: platform, season, name, team count, scoring (PPR), superflex, roster slots and which team is his',
    'written when a league is connected; settings refreshed on sync', 'auto',
    ['espn_s2', 'swid', 'payload']),

  // --- what happened ---
  schedule_games: t('one team in one week of one season',
    'the NFL schedule: opponent, date and whether the team is home',
    'schedule sync', 'auto'),
  player_gamelog: t('one player in one week',
    'fantasy points actually scored, and against whom',
    'ESPN game log sync', 'auto'),
  player_season_stats: t('one player in one season, projected or actual',
    'season fantasy points and games, in two kinds — the preseason projection and what actually happened — with the underlying stat map kept as JSON',
    'espn_season_stats job', 'auto'),
  player_week_usage: t('one player in one week',
    'the opportunity behind the points rather than the points: attempts, carries, targets, receptions, target share, air-yards share and WOPR. The table the projection foundation is built on',
    'nflverse_weekly_usage job', 'auto'),
  player_week_snaps: t('one player in one week',
    'offensive snaps and snap share, joined to the app player id',
    'nflverse_snap_counts job', 'auto'),
  nfl_snaps: t('one player on one team in one week, by name',
    'the raw nflverse snap counts: offence, defence and special-teams snaps and percentages, keyed by player name rather than by app id',
    'nfl advanced-stats sync', 'auto'),
  nfl_ngs: t('one player in one week for one Next Gen Stats family',
    'the Next Gen Stats block (passing, rushing or receiving) as a JSON stat map',
    'nfl advanced-stats sync', 'auto'),
  nfl_ffopportunity_weekly: t('one player in one week',
    'expected fantasy points from opportunity versus what he actually scored, split by pass, rush and receive. A player far above his expected line is the classic sell-high profile',
    'sync:ffopportunity', 'by_hand'),
  nfl_team_week_features: t('one team in one week',
    'the team-level feature vector computed from play-by-play, stored as JSON — pace, pass rate, situational splits',
    'play-by-play ingest and the feature build', 'derived'),

  // --- what is about to happen ---
  game_lines: t('one team in one game',
    'the market view of a game from that team\'s side: spread, total, implied points, moneyline, the open and closing numbers, plus kickoff, roof, surface, rest days and the recorded temperature and wind. This is what "what does the game script look like" is read from',
    'nfl_lines job, hourly', 'auto'),
  gamescript_model: t('one target, pass attempts or rush attempts',
    'the fitted relationship between the spread, the total and how often a team throws or runs — the coefficients, the r² and the sample it was fitted on. The modelled half of game script',
    'refitted by the gamescript build', 'derived'),
  nfl_game_weather: t('one game',
    'forecast and observed conditions at kickoff: temperature, wind, gusts and precipitation, with the source',
    'nfl_qbr_weather job, daily', 'auto'),
  nfl_injuries: t('one player in one week',
    'the official injury report: report status, practice status and the body part',
    'nfl_injuries job', 'auto'),
  news_items: t('one story',
    'headline, body, source and date, plus the AI analysis and fantasy-impact columns when a story has been explained',
    'rss_news and espn_news jobs', 'auto'),
  nfl_news_signals: t('one typed signal extracted from one story about one player',
    'what a story actually asserts, as structured fields rather than prose: signal type, status, body part, probability the player is unavailable, role change, confidence, and the span of text it came from',
    'nfl_news_signals job', 'auto'),

  // --- season-long advanced stats, from nflverse's own release files ---
  // These five are the tables stat-names.js already names columns of, which
  // meant Coach could label a number it was not allowed to read. They refresh
  // ONCE after a season ends (nfl-offseason-cycle.js:47, fired by the
  // nfl_offseason_cycle job), not weekly — an answer standing on them is
  // talking about a completed season, and the freshness line says so.
  off_ngs_season: t('one player in one season, for one kind of usage (receiving, rushing or passing)',
    "Next Gen Stats' own season aggregates from the tracking data: separation and cushion at the catch point, air-yards share, YAC over expected, catch rate, rush efficiency and rush yards over expected, time to throw, aggressiveness and completion percentage over expected",
    'the offseason cycle, once after a season ends', 'auto'),
  off_pfr_adv_season: t('one player in one season, for one kind of usage',
    "Pro Football Reference's advanced season table: average depth of target, yards before and after the catch per reception and per attempt, broken tackles, drop rate, pressure rate, on-target rate, pocket time and play-action attempts",
    'the offseason cycle, once after a season ends', 'auto'),
  off_qbr_season: t('one quarterback in one season',
    "ESPN's Total QBR and its parts: total QBR, points added, qualifying plays, total EPA and the raw score, with whether he met the attempt threshold to qualify",
    'the offseason cycle, once after a season ends', 'auto'),
  off_depth_chart: t('one player at one position on one team, in one season',
    'the depth chart as it was published: position group, rank within it, the slot label, and the week the listing was taken from. A LISTING, not a measurement — it can be stale or wrong, and snap share is what settles a disagreement between them',
    'the offseason cycle, once after a season ends', 'auto'),
  off_team_season_stats: t('one team in one season',
    'the season totals a team posted on offence: attempts, carries, completions, passing and rushing yards and touchdowns, sacks suffered, passing and rushing EPA, air yards, targets and first downs. The denominator behind any share',
    'the offseason cycle, once after a season ends', 'auto'),

  // --- what the app itself concluded ---
  weekly_prediction_snapshots: t('one player in one week, at one cutoff',
    'the weekly projection as it stood at a stated cutoff, with its components (structural, season-to-date, last three, last one) and the engine version that produced it. The record that makes a projection gradeable after the fact',
    'written by the weekly projection run', 'derived'),
  shrinkage_fits: t('one fit',
    'a fitted shrinkage model with the held-out season it was tested on and its CRPS and MAE against the hardcoded constants it replaces, and whether it is the active fit',
    'scripts/fit-*.mjs', 'by_hand'),
  trend_findings: t('one measured trend for one team or player',
    'a metric moving: the baseline, the recent value, the direction, the lookback and the week it was measured through',
    'trend build', 'derived'),
  player_analysis: t('one player',
    'the BUY / SELL / HOLD verdict and its reasoning, written on demand',
    'generated when someone asks for it on the player page', 'by_hand'),
  scout_reports: t('one player',
    'the draft-style scouting report and its confidence, written on demand',
    'generated when someone asks for it', 'by_hand'),
  slot_weakness: t('one player on a roster',
    'whether a lineup slot is weak or fine, with the reasoning and the stats that were looked at',
    'generated on demand from the accolades route', 'by_hand'),
  nfl_team_cards: t('one team in one week at one horizon',
    'a frozen team context card with the evidence hash and cutoff it was built under, kept so a past read can be reproduced exactly',
    'team-card build', 'derived'),

  // --- value and drafts ---
  dynasty_values: t('one player in one scoring format',
    'external market value: dynasty value, redraft value, 30-day trend, age and positional rank',
    'value sync', 'auto'),
  pick_values: t('one draft pick in one scoring format',
    'what a future pick is worth on the same scale as a player',
    'value sync', 'auto'),
  ranking_sets: t('one ranking list',
    'a named set of rankings and its scoring',
    'created by hand in the app', 'by_hand'),
  ranking_entries: t('one player in one ranking list',
    "the rank, tier and note Nick gave a player in that list",
    'edited by hand in the app', 'by_hand'),
  drafts: t('one draft',
    'a mock, live or recap draft: team count, rounds, slot and the ranking set it used',
    'created in the app', 'by_hand'),
  draft_picks: t('one pick in one draft',
    'who went where, to which slot, and the reason recorded at the time',
    'written as a draft runs', 'by_hand'),
  trending_players: t('one player',
    'how often a player is being added or dropped across the platform, with when it was fetched',
    'trade-lab refresh', 'by_hand'),

  // --- the people on the other side of a trade ---
  //
  // None of these four is created by a migration; each is created when its
  // module is first imported. They are the only place the app holds who a
  // manager is rather than what a roster is, which is what Nick asked Coach to
  // be able to answer.
  manager_signals: t('one manager in one league, one metric',
    'a measured habit of a manager — how he drafts, how he trades, how he reacts — with the number of observations behind it and where it came from',
    'recomputed from the chat and draft corpora when the signal job is run by hand', 'by_hand', [],
    IMPORT_MANAGER_SIGNALS),
  manager_player_view: t('one manager and one player he has talked about',
    'how warmly a manager speaks about a particular player, on a 0 to 4 scale where 2 is neutral, with how many mentions it rests on and when he last mentioned him',
    'recomputed with manager_signals, by hand', 'by_hand', [],
    IMPORT_MANAGER_SIGNALS),
  manager_archetypes: t('one manager in one league and season, one metric',
    'the archetype numbers behind "what kind of manager is he": league 0 and season 0 are the career roll-up across everything, and every row carries the observations behind it rather than implying them',
    'recomputed by the archetype job, run by hand', 'by_hand', [],
    IMPORT_MANAGER_ARCHETYPES),
  manager_archetype_jev: t('one manager and one question he was scored on',
    'a probability for how a manager answers a question, with a basis column that is the honest half of it: "draft" means the state read contains evidence bearing on the question, "inference_only" means it does not and the number is a prior dressed as a probability',
    'written by the archetype evaluation, run by hand', 'by_hand', [],
    IMPORT_MANAGER_ARCHETYPES),
  league_member_identity: t('one team in one league',
    'the join between an ESPN member and the person who sends the messages: ESPN name, team name, chat name, how the match was made and how confident it is, from confirmed down to unmatched',
    'written when a league is synced and when Nick confirms a match by hand', 'by_hand', [],
    IMPORT_MANAGER_IDENTITY),

  // --- what Coach itself has said, and what it knows about a person ---
  coach_answers: t('one question Coach was asked',
    'the audit of Coach\'s own answers: whether the grounding check passed, whether a retry saved it, how many numbers were checked, what it cost and which route asked. This is what turns "Coach does not hallucinate" into a rate somebody can read',
    'written on every answer', 'auto',
    ['answer_json', 'ledger_json', 'plan_json'],
    IMPORT_COACH_AUDIT),
  coach_person_context: t('one stated fact about one person',
    'the facts that change what somebody\'s words mean — Nick\'s "when Josh says we, that is the flag football team" is a row here — each with its author, when it was stated and when it stopped being believed',
    'written when a rule is added; retiring one keeps the row', 'by_hand', [],
    IMPORT_COACH_CONTEXT),
  coach_person_variables: t('one person and one measured variable',
    'the counted half of a person profile: forty variables per person with the sample size behind each, and a priceable flag that is 0 until the grading harness has shown the variable measures the person rather than the fortnight',
    'built by hand from the chat corpus, which lives only on Nick\'s machine', 'derived', [],
    SCRIPT_PERSON_PROFILES),

  // --- whether somebody actually plays ---
  nfl_availability_rates: t('one combination of injury report and practice status',
    'the fitted probability that a player who is listed this way actually plays, with the observations behind it and whether it was shrunk toward the league rate',
    'refitted by hand when the availability fit is run', 'derived', [],
    SCRIPT_FIT_AVAILABILITY),
  nfl_availability_role_rates: t('one combination of report, practice, position, role tier and rest gap',
    'the same probability cut finer, by position and by how central the player is to the offence, shrunk toward the pooled cell above it',
    'refitted with nfl_availability_rates, by hand', 'derived', [],
    SCRIPT_FIT_AVAILABILITY),

  // --- the league's own history, which only a script ever writes ---
  //
  // Finding 7 in the round of audits this work sits in: every manager read,
  // archetype and counterparty price in this app stands on rows a person
  // collected by hand. league_transactions_raw is where they land, and it is
  // not merely refreshed by hand — it is CREATED by hand, so on a fresh clone
  // it does not exist at all and nothing on any surface says so.
  league_transactions_raw: t('one transaction in one league and season',
    'every add, drop, trade and waiver claim as ESPN returned it: who did it, when it was proposed and processed, what was bid, whether it went through, and the raw payload behind it. The only record of what a manager has actually done',
    'collected by hand; nothing refreshes it on a schedule', 'by_hand', [],
    SCRIPT_LEAGUE_TRANSACTIONS),
  league_season_teams: t('one team in one league and season',
    'the finished season for a team: record, points for and against, final rank and playoff seed, with the owner behind it',
    'backfilled by hand, one run per league', 'by_hand', [],
    SCRIPT_LEAGUE_HISTORY),
  league_week_scores: t('one team in one week of one season',
    'what a team actually scored that week, who it played and whether the week was a playoff week — the history behind "is he lucky or good"',
    'backfilled with league_season_teams, by hand', 'by_hand', [],
    SCRIPT_LEAGUE_HISTORY),

  // --- what the app has already told Nick to do ---
  decision_recommendations: t('one recommendation the app has made',
    'the Decision Inbox: what an engine told Nick to do, how urgent it was, what it expected to be worth, whether he actioned, dismissed or ignored it, and how it turned out. The one table that answers "what has the app told me and did I act on it"',
    'written by the engines that publish into the inbox; expired by the inbox itself', 'auto'),

  // --- how fresh any of this is ---
  sync_log: t('one background job',
    'when each job last ran, whether it succeeded, its last detail line and how many times it has failed in a row. The table that lets an answer state its own data age',
    'written by every scheduler tick', 'auto')
});

/** Live column names for a table, straight from the database. Never hand-copied. */
function liveColumns(table) {
  return rows(`SELECT name FROM pragma_table_info(?)`, table).map(c => c.name);
}

function exists(table) {
  return !!rows(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).length;
}

/** Table names Coach may read, sorted. */
export function readableTables() {
  return Object.keys(COACH_TABLES).sort();
}

/**
 * The catalog's description of one table, with its live columns, or null when
 * Coach may not read it. Null for an unknown name too: "not in the catalog" and
 * "not in the database" are the same answer to a caller asking what it may read.
 */
export function catalogEntry(table) {
  const meta = Object.hasOwn(COACH_TABLES, table) ? COACH_TABLES[table] : null;
  if (!meta) return null;
  return { table, ...meta, redact: [...meta.redact], columns: liveColumns(table),
    created_at_runtime_by: meta.created_at_runtime_by ?? null };
}

/** The whole catalog, keyed by table, ready to hand to a model or a UI. */
export function catalog() {
  return Object.fromEntries(readableTables().map(name => [name, catalogEntry(name)]));
}

/**
 * What Coach can and cannot see, as counts and lists rather than as a feeling.
 * `uncatalogued` is the honest blind spot: tables that exist and that Coach is
 * not allowed to read, so an answer can say "that lives in a table I do not
 * read" instead of guessing at its contents.
 */
export function catalogCoverage() {
  const present = rows(`SELECT name FROM sqlite_master WHERE type='table'
                        AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(r => r.name);
  const readable = new Set(readableTables());
  const absent = readableTables().filter(name => !exists(name));
  return {
    catalogued: readable.size,
    in_database: present.length,
    uncatalogued: present.filter(name => !readable.has(name)),
    ...splitAbsent(absent)
  };
}

/**
 * Why a catalogued table is not in the database, which is two different things
 * and must not be one bucket. Absent while naming a script is a machine where
 * nobody has run the script — fixable by running it, and not a defect. Absent
 * while naming nothing is a catalog that is wrong, which is a defect and the
 * only one of the two anybody should be paged about.
 *
 * Exported because it is the part worth testing with a list of its own:
 * catalogCoverage() can only ever be called against whatever this database
 * happens to hold, so a bucketing mistake would be invisible there.
 */
export function splitAbsent(absent) {
  const notBuiltYet = absent.filter(name =>
    /scripts\//.test(COACH_TABLES[name]?.created_at_runtime_by ?? ''));
  const notBuilt = new Set(notBuiltYet);
  return { not_built_yet: notBuiltYet, missing_from_database: absent.filter(name => !notBuilt.has(name)) };
}
