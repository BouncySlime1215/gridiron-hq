/**
 * Each league's exact rules, read from the stored platform payload
 * (`leagues.payload`, ESPN `mSettings` + `mTeam` + schedule). The one producer
 * of league rules (CE-05, plan items A1/B9).
 *
 * Before this module the rules were read in six places, three with silent
 * defaults: season-sim.js used `playoffTeamCount ?? 6` and
 * `matchupPeriodCount ?? 14`, played every bracket on NFL weeks 15-17 one week
 * per round, re-seeded every round and ignored divisions. Of the five synced
 * leagues, two play two-week playoff rounds, one has a 13-week regular season,
 * one has two divisions, and all five play a fixed (not re-seeded) bracket.
 *
 * Contract:
 *   - A field the payload does not carry is `null` and its payload path is in
 *     `missing`. Nothing here substitutes a default. Callers decide whether a
 *     missing field blocks them (`simRulesProblem` is the season simulator's).
 *   - A field the payload carries but this module cannot honour (an unknown
 *     tiebreaker, multi-week regular-season matchups, variable round lengths)
 *     is listed in `unsupported`.
 *   - A rule the platform does not publish (ESPN has no median-game field) is
 *     inferred where the data allows it and otherwise listed in `unknown`.
 *
 * Scope: only the rules a route reaches (the season simulator,
 * trade-horizon.js#leagueSchedule, and the waiver board's claim priority,
 * waiver-wire.js#claimPriority). Other rules keep their existing producers
 * until a consumer is moved here, so no field ships without a reader:
 *   - scoring: scoring.js#scoringFor;
 *   - lineup slots: trade-engine.js#lineupSlots <- leagues.roster_positions,
 *     written by routes/leagues.js#syncEspnLeague via ESPN_SLOT_NAME, which
 *     drops slot 7 (OP/superflex) that espn-draft.js#SLOT_NAME keeps (follow-up:
 *     one slot map, owned with trade-engine.js);
 *   - trade settings: trade-tactics.js reads vetoVotesRequired itself; the trade
 *     deadline (DEADLINE-01) is read here, `trade_deadline`, for title-chess.js
 *     (CHESS-01a caps its trade steps at it; findTradeSequences reaches it);
 *   - waiver clock (waiverProcessDays/Hour): waiver-wire.js#nextWaiverRun reads
 *     acquisitionSettings itself (follow-up: move it here beside `waivers`);
 *   - Sleeper: no reader yet, so a Sleeper league gets a named error, never a
 *     default (follow-up: read payload.league.settings, which
 *     sleeper-history.js already reads for playoff_teams).
 */

const SS = 'settings.scheduleSettings';
const ACQ = 'settings.acquisitionSettings';
const TRADE = 'settings.tradeSettings';

/** Tiebreakers seedStandings() implements, by ESPN `playoffSeedingRule` value. */
export const SUPPORTED_TIEBREAKERS = new Set(['TOTAL_POINTS_SCORED']);

/** The fields simulateSeason cannot run without. */
export const SIM_REQUIRED = [
  `${SS}.matchupPeriodCount`, `${SS}.matchupPeriodLength`, `${SS}.playoffTeamCount`,
  `${SS}.playoffMatchupPeriodLength`, `${SS}.playoffReseed`, `${SS}.playoffSeedingRule`, `${SS}.divisions`,
  'teams[].divisionId',
];

function emptyRules(source, platform, missing) {
  return {
    source, platform,
    schedule: { regular_season_weeks: null, regular_matchup_length: null, playoff_teams: null,
      playoff_round_length: null, playoff_rounds: null, playoff_weeks: null, reseed: null },
    seeding: { tiebreaker: null, divisions: null, division_winners_first: null, team_division: null },
    median_game: null,
    waivers: { acquisition_type: null, uses_budget: null, order_resets_weekly: null },
    trade_deadline: null,
    missing, unsupported: [], unknown: [],
  };
}

const isPosInt = v => Number.isInteger(v) && v > 0;

/**
 * @param lg a `leagues` row (needs `platform`, `payload`).
 *           Never pass or select `espn_s2` / `swid`; this reads the payload only.
 */
export function leagueRules(lg) {
  const platform = lg?.platform ?? null;
  if (!lg?.payload) return emptyRules('no_payload', platform, ['leagues.payload']);
  if (platform !== 'espn') {
    return emptyRules('unsupported_platform', platform,
      [`settings (no rules reader for platform ${platform ?? 'unknown'})`]);
  }
  let payload;
  try {
    payload = JSON.parse(lg.payload);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return emptyRules('unparseable_payload', platform, [`leagues.payload (not JSON: ${e.message})`]);
  }

  const out = emptyRules('espn_settings', platform, []);
  const { missing, unsupported, unknown } = out;
  const s = payload?.settings ?? {};
  const need = (obj, key, path, ok) => {
    const v = obj?.[key];
    if (v == null || (ok && !ok(v))) { missing.push(`${path}.${key}`); return null; }
    return v;
  };

  /* --- schedule ----------------------------------------------------------- */
  const ss = s.scheduleSettings;
  const sch = out.schedule;
  sch.regular_season_weeks = need(ss, 'matchupPeriodCount', SS, isPosInt);
  sch.regular_matchup_length = need(ss, 'matchupPeriodLength', SS, isPosInt);
  sch.playoff_teams = need(ss, 'playoffTeamCount', SS, v => Number.isInteger(v) && v >= 2);
  sch.playoff_round_length = need(ss, 'playoffMatchupPeriodLength', SS, isPosInt);
  sch.reseed = need(ss, 'playoffReseed', SS, v => typeof v === 'boolean');
  if (sch.regular_matchup_length != null && sch.regular_matchup_length !== 1) {
    unsupported.push(`${SS}.matchupPeriodLength = ${sch.regular_matchup_length} (multi-week regular-season matchups: a matchup period is not an NFL week)`);
  }
  if (ss?.variablePlayoffMatchupPeriodLength === true) {
    unsupported.push(`${SS}.variablePlayoffMatchupPeriodLength = true (rounds of different lengths)`);
  }
  if (sch.playoff_teams != null) sch.playoff_rounds = Math.ceil(Math.log2(sch.playoff_teams));
  if (sch.regular_season_weeks != null && sch.playoff_rounds != null && sch.playoff_round_length != null
      && sch.regular_matchup_length === 1 && ss?.variablePlayoffMatchupPeriodLength !== true) {
    const len = sch.playoff_round_length;
    sch.playoff_weeks = Array.from({ length: sch.playoff_rounds }, (_, r) =>
      Array.from({ length: len }, (_, i) => sch.regular_season_weeks + 1 + r * len + i));
  }

  /* --- seeding ------------------------------------------------------------ */
  const seed = out.seeding;
  seed.tiebreaker = need(ss, 'playoffSeedingRule', SS, v => typeof v === 'string' && v.length > 0);
  if (seed.tiebreaker && !SUPPORTED_TIEBREAKERS.has(seed.tiebreaker)) {
    unsupported.push(`${SS}.playoffSeedingRule = ${seed.tiebreaker} (only ${[...SUPPORTED_TIEBREAKERS].join(', ')} is implemented)`);
  }
  const divs = need(ss, 'divisions', SS, Array.isArray);
  if (divs) {
    seed.divisions = divs.map(d => ({ id: d.id, size: d.size ?? null }));
    seed.division_winners_first = divs.length > 1;
    // Division membership only matters when there is more than one division.
    if (seed.division_winners_first) {
      const teams = Array.isArray(payload.teams) ? payload.teams : [];
      if (!teams.length || teams.some(t => t.divisionId == null)) missing.push('teams[].divisionId');
      else seed.team_division = Object.fromEntries(teams.map(t => [String(t.id), t.divisionId]));
    }
  }

  /* --- median game -------------------------------------------------------- */
  out.median_game = inferMedian(payload, sch.regular_season_weeks, unknown);

  /* --- waivers (RL-13-2) --------------------------------------------------- */
  // Read by waiver-wire.js#claimPriority. waiverOrderReset true: the order resets
  // every week, so a claim costs only this week's place in line. false: rolling
  // order, a successful claim sends the team to the back until others claim.
  const acq = s.acquisitionSettings;
  const wv = out.waivers;
  wv.acquisition_type = need(acq, 'acquisitionType', ACQ, v => typeof v === 'string' && v.length > 0);
  wv.uses_budget = need(acq, 'isUsingAcquisitionBudget', ACQ, v => typeof v === 'boolean');
  wv.order_resets_weekly = need(acq, 'waiverOrderReset', ACQ, v => typeof v === 'boolean');

  /* --- trade deadline (DEADLINE-01, C29) ------------------------------------ */
  const deadlineMs = need(s.tradeSettings, 'deadlineDate', TRADE, v => Number.isFinite(v) && v > 0);
  if (deadlineMs != null) {
    const season = Number.isInteger(payload.seasonId) ? payload.seasonId : new Date(deadlineMs).getUTCFullYear();
    const week = nflWeekOf(deadlineMs, season);
    out.trade_deadline = { epoch_ms: deadlineMs, date: new Date(deadlineMs).toISOString(), week, basis: NFL_WEEK_BASIS };
    if (week == null) unknown.push(`${TRADE}.deadlineDate: ${out.trade_deadline.date} falls outside NFL weeks 1-18 of ${season}`);
  }

  return out;
}

/**
 * The NFL week a moment falls in: week 1 starts the Tuesday after Labor Day (the first
 * Monday of September; the opener is that Thursday, true of every season 2020-2026), and
 * each week runs Tuesday to Tuesday, 08:00 UTC (3-4 AM Eastern, after Monday night). A
 * trade made before a deadline in week N still counts toward week N's games, so N is the
 * last scoring period before the deadline. Null outside weeks 1-18. ESPN's payload carries
 * no dates per scoring period, so the calendar is the rule, declared here.
 */
export const NFL_WEEK_BASIS = 'NFL calendar: week 1 starts the Tuesday after Labor Day, weeks run Tuesday to Tuesday (08:00 UTC)';
export function nflWeekOf(ms, season) {
  const sept1 = new Date(Date.UTC(season, 8, 1)).getUTCDay(); // 0 Sunday .. 6 Saturday
  const laborDay = 1 + ((8 - sept1) % 7);                       // first Monday of September
  const start = Date.UTC(season, 8, laborDay + 1, 8);           // the Tuesday after, 08:00 UTC
  const week = Math.floor((ms - start) / (7 * 86400000)) + 1;
  return week >= 1 && week <= 18 ? week : null;
}

/**
 * ESPN publishes no median-game setting in mSettings (none of the five local
 * payloads carries one). A league that plays the median records two results per
 * matchup period, so wins + losses + ties over decided regular-season periods
 * is 1 without it and 2 with it.
 */
function inferMedian(payload, regularWeeks, unknown) {
  const teams = Array.isArray(payload.teams) ? payload.teams : [];
  const decided = new Map();
  for (const m of payload.schedule ?? []) {
    if (!m.matchupPeriodId || (regularWeeks != null && m.matchupPeriodId > regularWeeks)) continue;
    if (!m.winner || m.winner === 'UNDECIDED') continue;
    for (const side of [m.home, m.away]) {
      if (side?.teamId == null) continue;
      decided.set(String(side.teamId), (decided.get(String(side.teamId)) ?? 0) + 1);
    }
  }
  const ratios = new Set();
  for (const t of teams) {
    const o = t.record?.overall;
    const n = decided.get(String(t.id)) ?? 0;
    if (!o || !n) continue;
    ratios.add(((o.wins ?? 0) + (o.losses ?? 0) + (o.ties ?? 0)) / n);
  }
  if (!ratios.size) {
    unknown.push('median_game: ESPN publishes no median-game field and no regular-season week is decided yet');
    return null;
  }
  if (ratios.size === 1 && ratios.has(1)) return false;
  if (ratios.size === 1 && ratios.has(2)) return true;
  unknown.push(`median_game: records per decided week are ${[...ratios].join(', ')}, neither 1 nor 2`);
  return null;
}

/**
 * Seed order for every team (index 0 = seed 1), by the league's own rule.
 * `standings`: [{ id, w, pf }] where `w` counts a tie as half a win.
 * Division winners take the top seeds when the league has more than one
 * division (replayed on league 2's 2023-2025 seeds; docs/evidence/2026-09-23/
 * league-rules-replay.md). The sort is stable: complete ties keep input order.
 * Throws on a tiebreaker it does not implement rather than seeding on points.
 */
export function seedStandings(standings, rules) {
  const tb = rules?.seeding?.tiebreaker;
  if (!tb) throw new Error('league rules: playoffSeedingRule is missing, cannot seed');
  if (!SUPPORTED_TIEBREAKERS.has(tb)) throw new Error(`league rules: tiebreaker ${tb} is not implemented`);
  const cmp = (a, b) => b.w - a.w || b.pf - a.pf;
  const sorted = [...standings].sort(cmp);
  if (!rules.seeding.division_winners_first) return sorted.map(s => s.id);
  const divOf = rules.seeding.team_division;
  if (!divOf) throw new Error('league rules: teams[].divisionId is missing, cannot seed divisions');
  const winners = new Map();
  for (const s of sorted) {
    const d = divOf[String(s.id)];
    if (d == null) throw new Error(`league rules: team ${s.id} has no division`);
    if (!winners.has(d)) winners.set(d, s);
  }
  const top = [...winners.values()].sort(cmp);
  const topIds = new Set(top.map(s => s.id));
  return [...top, ...sorted.filter(s => !topIds.has(s.id))].map(s => s.id);
}

/**
 * What stops the season simulator, or null. It never runs on a default: a
 * missing field returns a named error with the payload paths.
 */
export function simRulesProblem(rules) {
  // SIM_REQUIRED fields, plus the whole-payload absences (no payload, not JSON,
  // no reader for the platform), which leave every field missing.
  const blocking = rules.missing.filter(p => SIM_REQUIRED.includes(p) || p.startsWith('leagues.') || p.startsWith('settings ('));
  const unsupported = rules.unsupported.filter(u => u.startsWith(`${SS}.`));
  if (!blocking.length && !unsupported.length) return null;
  return {
    error: `league rules incomplete: ${[...blocking, ...unsupported].join('; ')}`,
    rules_source: rules.source,
    rules_missing: blocking,
    rules_unsupported: unsupported,
  };
}
