import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLeagueConfig, summarizeConfigReport, CONFIG_VERIFICATION_KEYS } from '../server/services/league-config-verification.js';
import { REAL_1PPR_ITEMS } from './fixtures/espn-scoring-items.js';

/**
 * "The model pulls and verifies ALL league settings itself... If any setting can't be
 * confirmed, it says so loudly instead of guessing." (Nick, PART 5 plan, 2026-09-21)
 *
 * These fixtures are payload shapes, not live reads -- this container's own `leagues`
 * table has zero rows for any of the 5 real leagues (checked directly: sqlite3
 * server/data.sqlite "select count(*) from leagues" returns 0), so nothing here is
 * "confirmed against a real synced league" the way test/scoring.test.js's fixture is.
 * The ESPN scoring shape is borrowed from that file's own confirmed fixture. Every
 * other shape is built from field paths already read by shipped code in this repo
 * (cited per test) rather than invented.
 */

function espnLeague({ ppr = 1, scoringItems = null, lineupSlotCounts = null, playoffTeamCount, keeperCount } = {}) {
  const settings = {};
  if (scoringItems) settings.scoringSettings = { scoringItems };
  if (lineupSlotCounts) settings.rosterSettings = { lineupSlotCounts };
  if (playoffTeamCount != null) settings.scheduleSettings = { playoffTeamCount };
  if (keeperCount != null) settings.draftSettings = { keeperCount };
  return {
    platform: 'espn', ppr,
    roster_positions: lineupSlotCounts
      ? JSON.stringify(Object.entries(lineupSlotCounts)
          .flatMap(([slot, n]) => Array(Number(n)).fill({ 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DEF', 17: 'K', 23: 'FLEX' }[slot]).filter(Boolean)))
      : null,
    payload: JSON.stringify({ settings })
  };
}

function sleeperLeague({ type, playoffTeams, playoffWeekStart, waiverType, waiverBudget, tradeDeadline, rosterPositions } = {}) {
  const s = {};
  if (type != null) s.type = type;
  if (playoffTeams != null) s.playoff_teams = playoffTeams;
  if (playoffWeekStart != null) s.playoff_week_start = playoffWeekStart;
  if (waiverType != null) s.waiver_type = waiverType;
  if (waiverBudget != null) s.waiver_budget = waiverBudget;
  if (tradeDeadline != null) s.trade_deadline = tradeDeadline;
  return {
    platform: 'sleeper', ppr: 1,
    roster_positions: rosterPositions ? JSON.stringify(rosterPositions) : null,
    payload: JSON.stringify({ league: { settings: s } })
  };
}

/* ------------------------------------------------------------------ the report shape */

test('every key CONFIG_VERIFICATION_KEYS names is always present in the report', () => {
  const report = verifyLeagueConfig({ platform: 'espn', ppr: 1, payload: null });
  for (const k of CONFIG_VERIFICATION_KEYS) {
    assert.ok(report[k], `${k} must be present even when nothing can be confirmed`);
    assert.ok(report[k].status, `${k} must carry a status`);
  }
});

test('a league with no synced payload reports every setting unavailable, not silently missing', () => {
  const report = verifyLeagueConfig({ platform: 'espn', ppr: 1, payload: null, roster_positions: null });
  for (const k of CONFIG_VERIFICATION_KEYS) {
    assert.equal(report[k].status, 'unavailable', `${k} should be unavailable, not defaulted or confirmed`);
  }
  assert.equal(report.confirmed_count, 0);
  assert.ok(report.loud_warning, 'a fully-unconfirmed league must produce a loud warning, not silence');
});

/* ---------------------------------------------------------------------------- scoring */

test('ESPN scoring is confirmed when 4+ real stat ids match', () => {
  const report = verifyLeagueConfig(espnLeague({ scoringItems: REAL_1PPR_ITEMS }));
  assert.equal(report.scoring.status, 'confirmed');
});

test('ESPN scoring defaults when fewer than 4 stat ids match', () => {
  const report = verifyLeagueConfig(espnLeague({ scoringItems: [{ statId: 4, points: 4 }] }));
  assert.equal(report.scoring.status, 'defaulted');
});

test('Sleeper scoring is always reported defaulted -- scoringFor never reads Sleeper per-stat detail', () => {
  const report = verifyLeagueConfig(sleeperLeague({ type: 0 }));
  assert.equal(report.scoring.status, 'defaulted');
  assert.match(report.scoring.reason, /sleeper/i);
});

/* ------------------------------------------------------------------- lineup slots / bench-IR */

test('ESPN: every lineup slot named -> lineup_slots and bench_ir both confirmed', () => {
  const report = verifyLeagueConfig(espnLeague({
    scoringItems: REAL_1PPR_ITEMS,
    lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1 } // QB,RB,RB,WR,WR,TE,FLEX,DEF,K = 9, all named
  }));
  assert.equal(report.lineup_slots.status, 'confirmed');
  assert.equal(report.lineup_slots.total_slots, 9);
  assert.equal(report.bench_ir.status, 'confirmed');
});

test('ESPN: bench/IR slot ids (unmapped) are counted as dropped, not silently absorbed', () => {
  // 20 = bench (a real ESPN slot id, not in this codebase's name map), 21 = IR.
  const report = verifyLeagueConfig(espnLeague({
    scoringItems: REAL_1PPR_ITEMS,
    lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 20: 6, 21: 2 } // 7 named + 8 unnamed = 15 total
  }));
  assert.equal(report.lineup_slots.status, 'defaulted', 'a dropped slot means the setting is not fully confirmed');
  assert.equal(report.lineup_slots.total_slots, 15);
  assert.equal(report.lineup_slots.named_slots, 7);
  assert.equal(report.bench_ir.status, 'unavailable');
  assert.equal(report.bench_ir.dropped_slot_count, 8);
});

test('Sleeper: roster_positions is read unfiltered, so BN/IR presence is checked by name', () => {
  const withBenchIr = verifyLeagueConfig(sleeperLeague({ type: 0, rosterPositions: ['QB', 'RB', 'WR', 'BN', 'BN', 'IR'] }));
  assert.equal(withBenchIr.lineup_slots.status, 'confirmed');
  assert.equal(withBenchIr.bench_ir.status, 'confirmed');
  assert.equal(withBenchIr.bench_ir.bench_present, true);
  assert.equal(withBenchIr.bench_ir.ir_present, true);

  const withoutBenchIr = verifyLeagueConfig(sleeperLeague({ type: 0, rosterPositions: ['QB', 'RB', 'WR'] }));
  assert.equal(withoutBenchIr.bench_ir.status, 'unavailable');
});

/* --------------------------------------------------------------------- playoff structure */

test('ESPN playoff structure is confirmed when scheduleSettings.playoffTeamCount is present', () => {
  const report = verifyLeagueConfig(espnLeague({ scoringItems: REAL_1PPR_ITEMS, playoffTeamCount: 6 }));
  assert.equal(report.playoff_structure.status, 'confirmed');
  assert.equal(report.playoff_structure.playoff_teams, 6);
});

test('ESPN playoff structure is unavailable when the field is absent -- the ??6 default elsewhere is a guess', () => {
  const report = verifyLeagueConfig(espnLeague({ scoringItems: REAL_1PPR_ITEMS }));
  assert.equal(report.playoff_structure.status, 'unavailable');
});

test('Sleeper playoff structure reads the same field sleeper-history.js already reads', () => {
  const report = verifyLeagueConfig(sleeperLeague({ type: 0, playoffTeams: 4, playoffWeekStart: 15 }));
  assert.equal(report.playoff_structure.status, 'confirmed');
  assert.equal(report.playoff_structure.playoff_teams, 4);
  assert.equal(report.playoff_structure.playoff_week_start, 15);
});

/* ----------------------------------------------------------------------- keeper/dynasty */

test('Sleeper dynasty (type 2) is confirmed -- a direct documented flag', () => {
  const report = verifyLeagueConfig(sleeperLeague({ type: 2 }));
  assert.equal(report.keeper_dynasty.status, 'confirmed');
  assert.equal(report.keeper_dynasty.league_type, 'dynasty');
});

test('Sleeper keeper (type 1) is confirmed', () => {
  const report = verifyLeagueConfig(sleeperLeague({ type: 1 }));
  assert.equal(report.keeper_dynasty.status, 'confirmed');
  assert.equal(report.keeper_dynasty.league_type, 'keeper');
});

test('ESPN keeper detection is best_effort, not confirmed -- it is a heuristic on keeperCount', () => {
  const report = verifyLeagueConfig(espnLeague({ scoringItems: REAL_1PPR_ITEMS, keeperCount: 3 }));
  assert.equal(report.keeper_dynasty.status, 'best_effort');
  assert.equal(report.keeper_dynasty.league_type, 'keeper');
});

test('ESPN redraft (keeperCount 0) is defaulted, not confirmed -- absence of the signal is not proof of redraft', () => {
  const report = verifyLeagueConfig(espnLeague({ scoringItems: REAL_1PPR_ITEMS, keeperCount: 0 }));
  assert.equal(report.keeper_dynasty.status, 'defaulted');
  assert.equal(report.keeper_dynasty.league_type, 'redraft');
});

/* ------------------------------------------------------- waiver type / FAAB / trade deadline */

test('ESPN never confirms waiver type, FAAB or trade deadline -- no known field mapping exists', () => {
  const report = verifyLeagueConfig(espnLeague({ scoringItems: REAL_1PPR_ITEMS }));
  assert.equal(report.waiver_type.status, 'unavailable');
  assert.equal(report.faab_budget.status, 'unavailable');
  assert.equal(report.trade_deadline.status, 'unavailable');
});

test('Sleeper waiver/FAAB/trade-deadline are read when present, but only ever best_effort', () => {
  const report = verifyLeagueConfig(sleeperLeague({ type: 0, waiverType: 'faab', waiverBudget: 200, tradeDeadline: 11 }));
  assert.equal(report.waiver_type.status, 'best_effort');
  assert.equal(report.waiver_type.value, 'faab');
  assert.equal(report.faab_budget.status, 'best_effort');
  assert.equal(report.faab_budget.value, 200);
  assert.equal(report.trade_deadline.status, 'best_effort');
  assert.equal(report.trade_deadline.value, 11);
});

test('Sleeper waiver/FAAB/trade-deadline are unavailable, never guessed, when the field is absent', () => {
  const report = verifyLeagueConfig(sleeperLeague({ type: 0 }));
  assert.equal(report.waiver_type.status, 'unavailable');
  assert.equal(report.faab_budget.status, 'unavailable');
  assert.equal(report.trade_deadline.status, 'unavailable');
});

/* --------------------------------------------------------------------- loud, not silent */

test('a league with mixed confirmation produces a loud_warning naming exactly the unconfirmed settings', () => {
  const report = verifyLeagueConfig(sleeperLeague({ type: 2, playoffTeams: 6, playoffWeekStart: 15, rosterPositions: ['QB', 'BN', 'IR'] }));
  assert.ok(Array.isArray(report.unconfirmed_settings));
  assert.ok(report.unconfirmed_settings.includes('scoring'), 'Sleeper scoring is never confirmed by this codebase today');
  assert.ok(!report.unconfirmed_settings.includes('keeper_dynasty'), 'dynasty was confirmed here and must not be listed as unconfirmed');
  assert.equal(report.confirmed_count, CONFIG_VERIFICATION_KEYS.length - report.unconfirmed_settings.length);
  assert.match(report.loud_warning, /scoring/);
});

test('ESPN never gets a waiver_type value even if a payload coincidentally carries a league.settings shape -- the platform gate blocks it, not a lucky field-path miss', () => {
  const lg = {
    platform: 'espn', ppr: 1, roster_positions: null,
    payload: JSON.stringify({ settings: {}, league: { settings: { waiver_type: 'faab' } } })
  };
  const report = verifyLeagueConfig(lg);
  assert.equal(report.waiver_type.status, 'unavailable',
    'ESPN must never report a confirmed or best_effort waiver type, regardless of payload shape -- there is '
    + 'no verified field mapping for it on ESPN at all');
});

test('summarizeConfigReport: loud_warning is null only when every setting is confirmed', () => {
  const allConfirmed = Object.fromEntries(CONFIG_VERIFICATION_KEYS.map(k => [k, { status: 'confirmed' }]));
  const summary = summarizeConfigReport(allConfirmed);
  assert.equal(summary.unconfirmed_settings.length, 0);
  assert.equal(summary.confirmed_count, CONFIG_VERIFICATION_KEYS.length);
  assert.equal(summary.loud_warning, null, 'a fully-confirmed report must not carry a warning');
});

test('summarizeConfigReport: one unconfirmed setting is enough to produce a loud_warning', () => {
  const mostlyConfirmed = Object.fromEntries(CONFIG_VERIFICATION_KEYS.map(k => [k, { status: 'confirmed' }]));
  mostlyConfirmed.faab_budget = { status: 'unavailable' };
  const summary = summarizeConfigReport(mostlyConfirmed);
  assert.equal(summary.unconfirmed_settings.length, 1);
  assert.equal(summary.confirmed_count, CONFIG_VERIFICATION_KEYS.length - 1);
  assert.match(summary.loud_warning, /faab_budget/);
});

test('a malformed payload JSON string does not throw, and everything reads unavailable', () => {
  assert.doesNotThrow(() => verifyLeagueConfig({ platform: 'espn', ppr: 1, payload: '{not json', roster_positions: null }));
  const report = verifyLeagueConfig({ platform: 'espn', ppr: 1, payload: '{not json', roster_positions: null });
  assert.equal(report.scoring.status, 'unavailable');
  assert.equal(report.playoff_structure.status, 'unavailable');
});
