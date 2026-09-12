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
  // Giant Plan 8.14: coverage below used to derive "expected weeks" from the
  // min/max of weeks actually opened, which cannot tell "the preregistered
  // span finished clean" apart from "the run stopped partway through it" --
  // both look like a hole-free range if the only evidence is what happened to
  // get opened. The preregistered spec's own schedule is the real target.
  let expectedWeeksBySeason = null;
  try {
    const spec = JSON.parse(runRow.spec_json);
    if (Array.isArray(spec?.schedule)) {
      expectedWeeksBySeason = new Map();
      for (const item of spec.schedule) {
        const set = expectedWeeksBySeason.get(item.season) ?? new Set();
        set.add(item.week);
        expectedWeeksBySeason.set(item.season, set);
      }
    }
  } catch { expectedWeeksBySeason = null; }

  const bySeason = new Map();
  const byMarket = {};
  const allBets = [];
  // NOT error weeks: nfl-blind-audit.js writes a `fault_json` "outcome-visible
  // fault pass" diagnostic (biggest player/betting misses) for essentially
  // every normal week, by design (see its own 'no model mutation authorized'
  // classification) -- a nonzero count here describes routine miss logging,
  // never a failure of the run itself.
  let weeksWithFaultLog = 0;

  // Codex correction C09. Four separate counting defects, all here:
  //
  //   1. `pushes` was initialised and never added to, so every market reported
  //      zero pushes however many actually occurred.
  //   2. A week whose result JSON failed to parse was skipped SILENTLY, so a
  //      corrupt week shrank the denominator invisibly.
  //   3. A week with a betting section but zero bets never entered `bySeason`,
  //      so zero-bet weeks vanished from coverage entirely -- and they are
  //      exactly the weeks a weekly economic average must include.
  //   4. Coverage was reported as min-max, which cannot distinguish "weeks 5
  //      through 18" from "weeks 5 through 18 with 9 and 12 missing".
  //
  // Outcomes are aggregated from the PICKS, which are the authoritative
  // pick-level record, rather than from the per-week `by_market` summary. The
  // summary is a claim; the picks are the fact, and the two are reconciled
  // below so a disagreement is reported instead of silently preferred.
  const corruptWeeks = [];
  const presentWeeks = new Map();

  for (const w of weeks) {
    if (w.fault_json) weeksWithFaultLog++;
    let parsed;
    try {
      parsed = JSON.parse(w.result_json);
    } catch (error) {
      corruptWeeks.push({ season: w.season, week: w.week, ordinal: w.ordinal, reason: error.message });
      continue;
    }
    const betting = parsed?.betting;

    // Recorded BEFORE the betting check: a week that ran and bet nothing is a
    // real, complete week with a zero result, not a gap.
    const seasonWeeks = presentWeeks.get(w.season) ?? new Set();
    seasonWeeks.add(w.week);
    presentWeeks.set(w.season, seasonWeeks);

    const coverage = bySeason.get(w.season) ?? { min_week: w.week, max_week: w.week, weeks: new Set() };
    coverage.min_week = Math.min(coverage.min_week, w.week);
    coverage.max_week = Math.max(coverage.max_week, w.week);
    coverage.weeks.add(w.week);
    bySeason.set(w.season, coverage);

    if (!betting) continue;

    for (const [market, m] of Object.entries(betting.metrics?.by_market ?? {})) {
      const t = byMarket[market] ??= { bets: 0, wins: 0, losses: 0, pushes: 0, units: 0,
        summary_bets: 0, summary_units: 0 };
      // The per-week summary, kept only to reconcile against the picks.
      t.summary_bets += m.bets ?? 0;
      t.summary_units += m.units ?? 0;
    }
    for (const pick of betting.picks ?? []) {
      const market = pick.market;
      const t = byMarket[market] ??= { bets: 0, wins: 0, losses: 0, pushes: 0, units: 0,
        summary_bets: 0, summary_units: 0 };
      t.bets += 1;
      // Explicit unknown/void states. A missing result is NOT a loss and a
      // missing unit figure is NOT zero: both are unknowns, and folding them
      // into a real outcome is how a denominator quietly improves.
      //
      // Case-normalized because the stored runs actually write 'Won'/'Lost'
      // while newer code writes 'won'/'lost'. A case-sensitive comparison
      // silently classified every historical pick as an unknown result, which
      // is precisely the failure mode this correction is about: it did not
      // throw, it produced a confident report with a null win rate.
      const result = typeof pick.result === 'string' ? pick.result.trim().toLowerCase() : null;
      if (result === 'won' || result === 'win') t.wins += 1;
      else if (result === 'lost' || result === 'loss') t.losses += 1;
      else if (result === 'push') t.pushes += 1;
      else if (result === 'void') t.voids = (t.voids ?? 0) + 1;
      else t.unknown_results = (t.unknown_results ?? 0) + 1;
      if (pick.units == null) t.missing_units = (t.missing_units ?? 0) + 1;
      else t.units += pick.units;

      allBets.push({ season: w.season, week: w.week, market, result,
        units: pick.units ?? 0, units_known: pick.units != null });
    }
  }

  for (const market of Object.keys(byMarket)) {
    const t = byMarket[market];
    // Win rate excludes pushes and voids from its denominator, which is what
    // "win rate" means for a bet that can return the stake.
    t.win_rate = t.wins + t.losses ? r2(t.wins / (t.wins + t.losses)) : null;
    // Giant Plan 8.14: ROI's denominator used to be `t.bets`, which includes
    // voided picks -- a void never actually risked a stake (it is cancelled,
    // not settled), so counting it as a bet drags ROI toward zero for every
    // void the run recorded, exactly like counting a scratched horse as a
    // loss would.
    const riskedBets = t.bets - (t.voids ?? 0);
    t.roi = riskedBets ? r2(t.units / riskedBets) : null;
    // Reconciliation between the authoritative pick-level count and the
    // per-week summary the run also wrote. A mismatch is reported, never
    // resolved silently in favour of whichever number is nearer to hand.
    //
    // The unit tolerance is not cosmetic. Each week's stored summary rounds its
    // own total before this sums them, so a sum-of-rounded and a rounded-sum
    // differ by a fraction of a unit across a season -- run 27's spread book
    // reconciles to -11.855 from the picks and -11.854 from the summaries.
    // That is display rounding, not disagreement. A tolerance of half a unit
    // is far below any real bookkeeping error (one bet is one unit) and far
    // above accumulated rounding, and the exact delta is reported either way
    // so nobody has to take the boolean's word for it.
    t.summary_units_delta = r2(t.summary_units - t.units);
    t.summary_reconciles = t.summary_bets === t.bets
      && Math.abs(t.summary_units - t.units) < 0.5;
    t.summary_units = r2(t.summary_units);
    t.units = r2(t.units);
  }

  // Coverage names the exact weeks present and the exact weeks missing.
  // `5-18` cannot distinguish a complete cohort from one with holes in it,
  // and a hole is precisely what a weekly economic average needs to know
  // about. "Expected" comes from the run's own preregistered spec.schedule
  // when it's available -- min/max of the OBSERVED weeks (the fallback below)
  // cannot tell "this span finished clean" apart from "the run stopped
  // partway through it": both look hole-free if the only evidence used is
  // what happened to get opened.
  const seasonCoverage = [...bySeason.entries()].sort((a, b) => a[0] - b[0])
    .map(([season, c]) => {
      const fromSpec = expectedWeeksBySeason?.get(season);
      const expected = fromSpec
        ? [...fromSpec].sort((a, b) => a - b)
        : Array.from({ length: c.max_week - c.min_week + 1 }, (_, i) => c.min_week + i);
      const missing = expected.filter(week => !c.weeks.has(week));
      return { season,
        weeks: `${c.min_week}-${c.max_week}`,
        weeks_present: c.weeks.size,
        weeks_expected_in_span: expected.length,
        missing_weeks: missing,
        complete: missing.length === 0,
        coverage_source: fromSpec ? 'spec_schedule' : 'observed_min_max_fallback' };
    });
  const earlySeasonTested = seasonCoverage.some(c => Number(c.weeks.split('-')[0]) <= 4);

  const spreadBets = allBets.filter(b => b.market === 'spread');
  // `allBets` now carries the case-normalized result, so these read the same
  // vocabulary the market aggregation above uses. They previously compared
  // against 'Won'/'Lost'/'Push' directly, which happened to match the stored
  // runs but would have silently returned zeros for anything written in the
  // newer lower-case spelling -- two vocabularies for one fact.
  // Codex correction C09, second pass. These read the same vocabulary
  // `by_market` accepts, which is wider than 'won'/'lost': the stored runs also
  // write 'win'/'loss'. A review demonstrated the gap on four picks -- by_market
  // reported 2-1-1 with a 66.7% win rate while spread_only reported 0-0-1 with
  // a NULL win rate, from one call, without throwing. That is the identical
  // shape of the defect this correction exists to close, reached through a
  // spelling `by_market` itself declares valid, in the block the file says
  // exists "so a reader never has to reconstruct the spread-only picture".
  const isWin = r => r === 'won' || r === 'win';
  const isLoss = r => r === 'lost' || r === 'loss';
  const spreadWins = spreadBets.filter(b => isWin(b.result)).length;
  const spreadLosses = spreadBets.filter(b => isLoss(b.result)).length;
  const spreadPushes = spreadBets.filter(b => b.result === 'push').length;
  // Anything the vocabulary does not recognise is neither a win nor a loss, and
  // must be visible rather than silently absent from the denominator.
  const spreadUnknown = spreadBets.filter(b =>
    !isWin(b.result) && !isLoss(b.result) && b.result !== 'push' && b.result !== 'void').length;
  const spreadVoids = spreadBets.filter(b => b.result === 'void').length;
  const spreadUnits = spreadBets.reduce((s, b) => s + (b.units ?? 0), 0);
  const spreadRiskedBets = spreadBets.length - spreadVoids;
  // uncertainty() (nfl-replay.js) matches `result` against the exact strings
  // 'Won'/'Lost' -- the title case every replaySeason() bet actually carries.
  // `result` here was normalized to lower case above (Codex C09, second
  // pass) so by_market/spread_only recognize both historical ('Won') and
  // newer ('won') spellings; passed straight through, that normalization
  // made uncertainty()'s case-sensitive check match nothing, so win_rate_95
  // was always [0,0] regardless of how many bets were actually graded.
  // Restoring the case uncertainty() expects here -- rather than loosening
  // its own matching, which every other real caller already satisfies --
  // fixes this without widening what that shared function accepts.
  const forUncertainty = spreadBets.map(b => ({ ...b,
    result: isWin(b.result) ? 'Won' : isLoss(b.result) ? 'Lost' : b.result }));

  return {
    run_id: runId, status: runRow.status, label: runRow.label, created_at: runRow.created_at,
    weeks_sealed: weeks.length, weeks_with_fault_log: weeksWithFaultLog,
    season_coverage: seasonCoverage,
    // Codex correction C09: a week whose result JSON will not parse used to be
    // skipped in silence, shrinking the denominator invisibly. It is now named.
    corrupt_weeks: corruptWeeks,
    coverage_complete: seasonCoverage.every(s => s.complete) && corruptWeeks.length === 0,
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
      unknown_results: spreadUnknown || undefined,
      win_rate: spreadWins + spreadLosses ? r2(spreadWins / (spreadWins + spreadLosses)) : null,
      units: r2(spreadUnits), roi: spreadRiskedBets ? r2(spreadUnits / spreadRiskedBets) : null,
      uncertainty: spreadBets.length ? uncertainty(forUncertainty) : null
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
