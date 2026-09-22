/**
 * "The model pulls and verifies ALL league settings itself... if any setting can't be
 * confirmed, it says so loudly instead of guessing." (Nick, PART 5 plan, 2026-09-21)
 *
 * Read-only reporting over what leagues.js/scoring.js/format.js already store on a
 * `leagues` row: `payload`, `ppr`, `roster_positions`, `league_type`. This adds no
 * ingest, changes no stored column, and calls no external API — it is a consumer of
 * what those three already produce, nothing more.
 *
 * ESPN's API is undocumented and several of Nick's eight settings have no known field
 * mapping on it at all (waiver type, FAAB, trade deadline) — those are reported
 * 'unavailable' rather than guessed. Sleeper's public, documented settings object DOES
 * carry waiver_type/waiver_budget/trade_deadline, so those are read when present — but
 * reported 'best_effort', never 'confirmed', because the field names come from
 * Sleeper's own API docs and have not been cross-checked against a real payload in this
 * container: `leagues` in server/data.sqlite has zero rows for any of the 5 real
 * leagues (checked directly, 2026-09-22). Every OTHER field path this file reads is
 * already used by shipped code elsewhere in this repo — cited per function below —
 * which is the bar for calling something 'confirmed'.
 */
import { scoringConfirmationFor } from './scoring.js';
import { leagueTypeFromPayload } from './format.js';

// The same slot-id map routes/leagues.js uses to build roster_positions. Duplicated
// rather than imported: that map lives in a route file, and a service importing from
// routes would invert this codebase's layering. Kept in sync by the test file's own
// fixture builder, which constructs roster_positions the same way leagues.js does.
const ESPN_LINEUP_SLOT_NAMES = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DEF', 17: 'K', 23: 'FLEX' };

export const CONFIG_VERIFICATION_KEYS = Object.freeze([
  'scoring', 'lineup_slots', 'bench_ir', 'waiver_type', 'faab_budget', 'trade_deadline',
  'playoff_structure', 'keeper_dynasty'
]);

function parsedPayload(lg) {
  if (!lg?.payload) return null;
  try { return JSON.parse(lg.payload); } catch { return null; }
}

function verifyLineupSlotsAndBenchIr(lg, payload) {
  const stored = lg.roster_positions ? JSON.parse(lg.roster_positions) : [];
  if (!payload) {
    return {
      lineup_slots: { status: 'unavailable', reason: 'league has no synced payload yet' },
      bench_ir: { status: 'unavailable', reason: 'league has no synced payload yet' }
    };
  }
  if (lg.platform === 'espn') {
    // Verified path: routes/leagues.js:153 reads this exact field to build
    // roster_positions in the first place.
    const counts = payload.settings?.rosterSettings?.lineupSlotCounts ?? {};
    const totalSlots = Object.values(counts).reduce((s, n) => s + Number(n || 0), 0);
    const namedSlots = Object.entries(counts)
      .filter(([slot]) => ESPN_LINEUP_SLOT_NAMES[slot])
      .reduce((s, [, n]) => s + Number(n || 0), 0);
    const dropped = totalSlots - namedSlots;
    if (!totalSlots) {
      return {
        lineup_slots: { status: 'unavailable', reason: 'payload has no rosterSettings.lineupSlotCounts' },
        bench_ir: { status: 'unavailable', reason: 'payload has no rosterSettings.lineupSlotCounts' }
      };
    }
    return {
      lineup_slots: {
        status: dropped > 0 ? 'defaulted' : 'confirmed',
        total_slots: totalSlots, named_slots: namedSlots, stored_count: stored.length,
        reason: dropped > 0
          ? `${dropped} of ${totalSlots} lineup slots have no name mapping in this codebase (bench/IR/other) `
            + 'and were silently dropped before roster_positions was stored'
          : `all ${totalSlots} lineup slots matched a known name`
      },
      bench_ir: dropped > 0
        ? { status: 'unavailable', dropped_slot_count: dropped,
            reason: 'ESPN bench/IR slot ids have no name mapping in this codebase, so the count of dropped '
              + 'slots is known but which ones are bench vs IR vs something else is not' }
        : { status: 'confirmed',
            reason: 'no lineup slots were dropped, which means none is an unnamed bench/IR slot -- it does '
              + 'not by itself prove bench/IR is being read correctly, only that nothing was silently lost' }
    };
  }
  // Sleeper: roster_positions is the raw API list, unfiltered (routes/leagues.js:180
  // takes league.roster_positions directly), so BN/IR are checked for by name.
  const hasBench = stored.includes('BN');
  const hasIr = stored.includes('IR');
  return {
    lineup_slots: stored.length
      ? { status: 'confirmed', count: stored.length,
          reason: 'Sleeper roster_positions is read directly from the API, unfiltered' }
      : { status: 'unavailable', reason: 'payload has no roster_positions' },
    bench_ir: !stored.length
      ? { status: 'unavailable', reason: 'payload has no roster_positions' }
      : (hasBench || hasIr)
        ? { status: 'confirmed', bench_present: hasBench, ir_present: hasIr,
            reason: 'BN/IR found by name in Sleeper roster_positions' }
        : { status: 'unavailable', bench_present: false, ir_present: false,
            reason: 'no BN or IR entry in Sleeper roster_positions -- this league may genuinely carry none, '
              + 'or Sleeper may label it differently; not cross-checked against a real payload' }
  };
}

function verifyPlayoffStructure(lg, payload) {
  if (!payload) return { status: 'unavailable', reason: 'league has no synced payload yet' };
  if (lg.platform === 'espn') {
    // Verified path: season-sim.js:198 and trade-horizon.js:59 already read this
    // field, defaulting to 6 when absent -- a guess this function refuses to repeat.
    const n = payload.settings?.scheduleSettings?.playoffTeamCount;
    return Number.isFinite(n)
      ? { status: 'confirmed', playoff_teams: n, reason: 'read from settings.scheduleSettings.playoffTeamCount' }
      : { status: 'unavailable',
          reason: 'no scheduleSettings.playoffTeamCount in the payload -- callers that default this to 6 '
            + '(season-sim.js, trade-horizon.js) are guessing for this league' };
  }
  // Verified path: sleeper-history.js:36-38 already reads these two fields.
  const n = payload.league?.settings?.playoff_teams;
  const start = payload.league?.settings?.playoff_week_start;
  return Number.isFinite(n)
    ? { status: 'confirmed', playoff_teams: n, playoff_week_start: Number.isFinite(start) ? start : null,
        reason: 'read from league.settings.playoff_teams, the same field sleeper-history.js already reads' }
    : { status: 'unavailable', reason: 'no league.settings.playoff_teams in the payload' };
}

function verifyKeeperDynasty(lg, payload) {
  if (!payload) return { status: 'unavailable', reason: 'league has no synced payload yet' };
  const type = leagueTypeFromPayload(lg.platform, payload);
  if (!type) return { status: 'unavailable', reason: 'leagueTypeFromPayload could not determine a type' };
  return lg.platform === 'sleeper'
    ? { status: 'confirmed', league_type: type, reason: 'Sleeper settings.type is a direct, documented flag' }
    : {
        status: type === 'keeper' ? 'best_effort' : 'defaulted', league_type: type,
        reason: type === 'keeper'
          ? 'ESPN has no dynasty flag; a non-zero keeperCount is the closest available signal, not a confirmation'
          : 'ESPN has no dynasty flag; keeperCount is 0, so redraft is assumed rather than confirmed'
      };
}

/**
 * Sleeper-only, and never more than best_effort: these three field names come from
 * Sleeper's public API documentation, not from anything already read by shipped code in
 * this repo, and have not been cross-checked against a real payload in this container.
 */
function sleeperBestEffortField(payload, pick) {
  if (!payload) return { status: 'unavailable', reason: 'league has no synced payload yet' };
  const value = pick(payload.league?.settings ?? {});
  return value != null
    ? { status: 'best_effort', value,
        reason: "found at league.settings under a Sleeper-documented field name, not cross-checked against "
          + 'a real payload in this container' }
    : { status: 'unavailable', reason: 'no matching field in league.settings' };
}

function verifyWaiverType(lg, payload) {
  if (lg?.platform !== 'sleeper') {
    return { status: 'unavailable', reason: "no known field mapping for waiver type on ESPN's undocumented API" };
  }
  return sleeperBestEffortField(payload, s => s.waiver_type);
}

function verifyFaabBudget(lg, payload) {
  if (lg?.platform !== 'sleeper') {
    return { status: 'unavailable', reason: "no known field mapping for FAAB budget on ESPN's undocumented API" };
  }
  return sleeperBestEffortField(payload, s => s.waiver_budget);
}

function verifyTradeDeadline(lg, payload) {
  if (lg?.platform !== 'sleeper') {
    return { status: 'unavailable', reason: "no known field mapping for trade deadline on ESPN's undocumented API" };
  }
  return sleeperBestEffortField(payload, s => s.trade_deadline);
}

/**
 * Pure aggregation, separated from the eight domain checks above so it is testable on
 * its own -- including the all-confirmed case, which no real fixture can reach today
 * (see the note in verifyLeagueConfig's doc comment) but which the logic must still get
 * right on its own terms.
 */
export function summarizeConfigReport(report) {
  const unconfirmed = CONFIG_VERIFICATION_KEYS.filter(k => report[k].status !== 'confirmed');
  return {
    confirmed_count: CONFIG_VERIFICATION_KEYS.length - unconfirmed.length,
    total_count: CONFIG_VERIFICATION_KEYS.length,
    unconfirmed_settings: unconfirmed,
    loud_warning: unconfirmed.length
      ? `${unconfirmed.length} of ${CONFIG_VERIFICATION_KEYS.length} league settings are not confirmed for `
        + `this league (${unconfirmed.join(', ')}) -- projections and trade values built from them may be `
        + "wrong for this league's actual rules"
      : null
  };
}

/**
 * One confidence report for a synced league, covering every setting Nick named:
 * scoring, lineup slots, bench/IR, waiver type, FAAB budget, trade deadline, playoff
 * structure, keeper/dynasty. Every key in CONFIG_VERIFICATION_KEYS is always present —
 * a setting this can't check is reported 'unavailable', never silently missing.
 *
 * NOTE ON loud_warning: as this file's checks stand today, no real league can reach an
 * all-confirmed report. Sleeper scoring is always 'defaulted' (scoringFor never reads
 * Sleeper per-stat detail); ESPN's waiver_type/faab_budget/trade_deadline are always
 * 'unavailable' (no known field mapping on ESPN's undocumented API). So loud_warning is
 * never null in practice yet -- which is itself the honest state of this ingest, not a
 * bug in this function.
 */
export function verifyLeagueConfig(lg) {
  const payload = parsedPayload(lg);
  const { lineup_slots, bench_ir } = verifyLineupSlotsAndBenchIr(lg, payload);
  const report = {
    scoring: scoringConfirmationFor(lg),
    lineup_slots,
    bench_ir,
    waiver_type: verifyWaiverType(lg, payload),
    faab_budget: verifyFaabBudget(lg, payload),
    trade_deadline: verifyTradeDeadline(lg, payload),
    playoff_structure: verifyPlayoffStructure(lg, payload),
    keeper_dynasty: verifyKeeperDynasty(lg, payload)
  };
  return { ...report, ...summarizeConfigReport(report) };
}
