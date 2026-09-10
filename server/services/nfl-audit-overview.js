/**
 * Work package 0 of Codex's CLAUDE-NEXT-STEPS.md implementation brief
 * (2026-09-10): "one truthful evidence record," generated from saved audit
 * data rather than hand-assembled by SQL each time someone needs a number.
 *
 * Two concrete, previously-missing capabilities:
 *
 *   - `auditOverview(runId)` — the corrected scoreboard. Splits results by
 *     market (spread/total/moneyline never get pooled into one misleading
 *     win rate again — see finding M07/the evidence doc's own correction of
 *     the "37.5%" headline), reports which season/week ranges the run
 *     actually covers (explicitly flagging when weeks 1-4 were never
 *     tested, since the early-season Bayesian blend is untested by any run
 *     that skips them), and computes the same weekly-cluster bootstrap
 *     uncertainty `nfl-replay.js` already trusts, scoped to spreads alone.
 *
 *   - `compareAuditRuns(runIdA, runIdB)` — "did anything actually change,"
 *     answered from each week's already-stored `result_hash`
 *     (nfl_blind_audit_weeks) instead of an expensive fresh replay. Two runs
 *     of the identical frozen code/data produce byte-identical weekly
 *     hashes; this says so plainly instead of implying a re-run taught the
 *     model something new (exactly the run-27-vs-run-31 confusion this
 *     project hit directly on 2026-09-09).
 */
import { rows, row } from '../db/index.js';
import { uncertainty } from './nfl-replay.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * Every market this run recorded, aggregated honestly: never a single
 * pooled win rate across markets with different payout structures (a
 * moneyline win rate and a spread win rate are not comparable numbers).
 */
export function auditOverview(runId) {
  const runRow = row(`SELECT * FROM nfl_blind_audit_runs WHERE id=?`, runId);
  if (!runRow) return { error: `no blind audit run ${runId}` };
  const weeks = rows(`SELECT ordinal, season, week, result_json, result_hash, fault_json
    FROM nfl_blind_audit_weeks WHERE run_id=? ORDER BY ordinal`, runId);

  const bySeason = new Map();
  const byMarket = {};
  const allBets = [];
  // NOT error weeks: nfl-blind-audit.js writes a `fault_json` "outcome-visible
  // fault pass" diagnostic (biggest player/betting misses) for essentially
  // every normal week, by design (see its own 'no model mutation authorized'
  // classification) -- a nonzero count here describes routine miss logging,
  // never a failure of the run itself.
  let weeksWithFaultLog = 0;

  for (const w of weeks) {
    if (w.fault_json) weeksWithFaultLog++;
    let parsed;
    try { parsed = JSON.parse(w.result_json); } catch { continue; }
    const betting = parsed?.betting;
    if (!betting) continue;

    const coverage = bySeason.get(w.season) ?? { min_week: w.week, max_week: w.week };
    coverage.min_week = Math.min(coverage.min_week, w.week);
    coverage.max_week = Math.max(coverage.max_week, w.week);
    bySeason.set(w.season, coverage);

    for (const [market, m] of Object.entries(betting.metrics?.by_market ?? {})) {
      const t = byMarket[market] ??= { bets: 0, wins: 0, losses: 0, pushes: 0, units: 0 };
      t.bets += m.bets ?? 0; t.wins += m.wins ?? 0; t.losses += m.losses ?? 0; t.units += m.units ?? 0;
    }
    for (const pick of betting.picks ?? []) {
      allBets.push({ season: w.season, week: w.week, market: pick.market, result: pick.result, units: pick.units ?? 0 });
    }
  }

  for (const market of Object.keys(byMarket)) {
    const t = byMarket[market];
    t.win_rate = t.wins + t.losses ? r2(t.wins / (t.wins + t.losses)) : null;
    t.roi = t.bets ? r2(t.units / t.bets) : null;
    t.units = r2(t.units);
  }

  const seasonCoverage = [...bySeason.entries()].sort((a, b) => a[0] - b[0])
    .map(([season, c]) => ({ season, weeks: `${c.min_week}-${c.max_week}` }));
  const earlySeasonTested = seasonCoverage.some(c => Number(c.weeks.split('-')[0]) <= 4);

  const spreadBets = allBets.filter(b => b.market === 'spread');
  const spreadWins = spreadBets.filter(b => b.result === 'Won').length;
  const spreadLosses = spreadBets.filter(b => b.result === 'Lost').length;
  const spreadPushes = spreadBets.filter(b => b.result === 'Push').length;
  const spreadUnits = spreadBets.reduce((s, b) => s + (b.units ?? 0), 0);

  return {
    run_id: runId, status: runRow.status, label: runRow.label, created_at: runRow.created_at,
    weeks_sealed: weeks.length, weeks_with_fault_log: weeksWithFaultLog,
    season_coverage: seasonCoverage,
    early_season_note: earlySeasonTested
      ? 'This run includes at least one season starting at week 4 or earlier.'
      : 'This run does NOT test weeks 1-4 of any season. The early-season preseason/in-season Bayesian blend ' +
        '(nfl-preseason-blend.js) is entirely UNTESTED by this record -- do not cite this run as evidence for or ' +
        'against that module.',
    by_market: byMarket,
    // Deliberately separate from by_market.spread: this block exists so a
    // reader never has to reconstruct the spread-only picture from a pooled
    // headline the way run 27's "37.5%" figure was originally, incorrectly,
    // read as a spread accuracy number.
    spread_only: {
      bets: spreadBets.length, wins: spreadWins, losses: spreadLosses, pushes: spreadPushes,
      win_rate: spreadWins + spreadLosses ? r2(spreadWins / (spreadWins + spreadLosses)) : null,
      units: r2(spreadUnits), roi: spreadBets.length ? r2(spreadUnits / spreadBets.length) : null,
      uncertainty: spreadBets.length ? uncertainty(spreadBets) : null
    },
    warning: 'A combined win rate pooling spread, total and moneyline bets together is NOT a spread win rate and ' +
      'must never be benchmarked against a spread break-even threshold -- moneyline payouts and base rates differ ' +
      'fundamentally. Use by_market or spread_only for any market-specific claim.'
  };
}

/**
 * Whether two completed runs' overlapping weeks are byte-identical, using
 * each week's already-stored `result_hash` -- no replay, no re-fetching of
 * outcomes, just a comparison of what was already sealed. A run that
 * reproduces its predecessor exactly is a reproducibility check, not new
 * evidence; a run that DIFFERS on some weeks says exactly which ones and
 * leaves the reader to find out why (a code change, a data change, a
 * different policy) rather than asserting it.
 */
export function compareAuditRuns(runIdA, runIdB) {
  const a = rows(`SELECT ordinal, season, week, result_hash FROM nfl_blind_audit_weeks WHERE run_id=? ORDER BY ordinal`, runIdA);
  const b = rows(`SELECT ordinal, season, week, result_hash FROM nfl_blind_audit_weeks WHERE run_id=? ORDER BY ordinal`, runIdB);
  if (!a.length) return { error: `run ${runIdA} has no sealed weeks` };
  if (!b.length) return { error: `run ${runIdB} has no sealed weeks` };
  const bByKey = new Map(b.map(w => [`${w.season}|${w.week}`, w]));

  const changedWeeks = [];
  const unchangedWeeks = [];
  const onlyInA = [];
  for (const wa of a) {
    const wb = bByKey.get(`${wa.season}|${wa.week}`);
    if (!wb) { onlyInA.push({ season: wa.season, week: wa.week }); continue; }
    (wa.result_hash === wb.result_hash ? unchangedWeeks : changedWeeks).push({ season: wa.season, week: wa.week });
  }
  const aByKey = new Set(a.map(w => `${w.season}|${w.week}`));
  const onlyInB = b.filter(w => !aByKey.has(`${w.season}|${w.week}`)).map(w => ({ season: w.season, week: w.week }));

  const overlapping = changedWeeks.length + unchangedWeeks.length;
  return {
    run_a: runIdA, run_b: runIdB,
    overlapping_weeks: overlapping,
    unchanged_weeks: unchangedWeeks.length, changed_weeks: changedWeeks.length,
    changed_week_list: changedWeeks,
    only_in_a: onlyInA.length, only_in_b: onlyInB.length,
    note: overlapping === 0
      ? 'These runs share no overlapping (season, week) pairs -- nothing to compare.'
      : changedWeeks.length === 0
        ? `All ${overlapping} overlapping weeks are byte-identical between run ${runIdA} and run ${runIdB} -- ` +
          'running the same frozen code/data again reproduced the same result. This is a reproducibility check, ' +
          'not new evidence of improved (or worsened) forecasting.'
        : `${changedWeeks.length} of ${overlapping} overlapping weeks differ between run ${runIdA} and run ${runIdB} ` +
          '-- a real forecast, selection-policy, or data change occurred between these two runs; see changed_week_list.'
  };
}
