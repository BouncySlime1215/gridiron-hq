/**
 * Codex correction C09: "Audit overview miscounts pushes and coverage."
 *
 * Four defects, each with a distinct symptom:
 *
 *   1. `by_market` initialised `pushes: 0` and never added to it, so every
 *      market reported zero pushes however many actually occurred.
 *   2. A week whose `result_json` failed to parse was skipped silently, so a
 *      corrupt week shrank the denominator invisibly.
 *   3. A week with zero bets never entered the season coverage map at all —
 *      and a zero-bet week is exactly what a weekly economic average must
 *      include, since dropping it inflates the per-week average.
 *   4. Coverage was reported as min–max, which cannot tell "weeks 5 through
 *      18" apart from "weeks 5 through 18 with 9 and 12 missing".
 *
 * These run on SYNTHETIC saved packets rather than on the developer's stored
 * audit runs. That is deliberate and is Codex correction C06's requirement in
 * its own words — "economic overview checks execute on synthetic saved
 * packets" — so the checks run on a clean checkout with no history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-audit-counting-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { auditOverview } = await import('../server/services/nfl-audit-overview.js');

let runSeq = 0;
/** A synthetic sealed run: `weeks` is [{ season, week, picks, corrupt }]. */
function syntheticRun(weeks, label = `synthetic-${++runSeq}`) {
  run(`INSERT INTO nfl_blind_audit_runs (created_at,label,spec_hash,spec_json,code_hash,data_hash,status,next_ordinal)
       VALUES (?,?,?,?,?,?,?,?)`,
  '2026-09-10T00:00:00Z', label, `spec-${label}`, '{}', 'code', 'data', 'sealed', weeks.length);
  const runId = db.prepare(`SELECT id FROM nfl_blind_audit_runs WHERE label=?`).get(label).id;

  weeks.forEach((w, ordinal) => {
    const payload = w.corrupt ? '{not valid json' : JSON.stringify({
      betting: {
        metrics: { by_market: summarize(w.picks ?? []) },
        picks: w.picks ?? []
      }
    });
    run(`INSERT INTO nfl_blind_audit_weeks
         (run_id,ordinal,season,week,opened_at,prior_chain_hash,result_hash,chain_hash,result_json,fault_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
    runId, ordinal, w.season, w.week, '2026-09-10T00:00:00Z', 'prior', `hash-${ordinal}`,
    `chain-${ordinal}`, payload, '{}');
  });
  return runId;
}

/** The per-week summary a real run writes alongside its picks. */
function summarize(picks) {
  const out = {};
  for (const p of picks) {
    const m = out[p.market] ??= { bets: 0, wins: 0, losses: 0, pushes: 0, units: 0 };
    m.bets += 1;
    if (p.result === 'won') m.wins += 1;
    else if (p.result === 'lost') m.losses += 1;
    else if (p.result === 'push') m.pushes += 1;
    m.units += p.units ?? 0;
  }
  return out;
}

const pick = (over = {}) => ({ market: 'spread', result: 'won', units: 0.909, ...over });

test('C09: pushes are counted, not initialised and forgotten', () => {
  const runId = syntheticRun([
    { season: 2026, week: 1, picks: [pick(), pick({ result: 'lost', units: -1 }), pick({ result: 'push', units: 0 })] },
    { season: 2026, week: 2, picks: [pick({ result: 'push', units: 0 }), pick({ result: 'push', units: 0 })] }
  ]);
  const overview = auditOverview(runId);
  assert.equal(overview.by_market.spread.pushes, 3,
    'three real pushes must appear as three, not as zero');
  assert.equal(overview.by_market.spread.bets, 5);
  assert.equal(overview.by_market.spread.wins, 1);
  assert.equal(overview.by_market.spread.losses, 1);
  // Win rate excludes pushes from its denominator, which is what the phrase means.
  assert.equal(overview.by_market.spread.win_rate, 0.5);
});

test('C09: a zero-bet week stays in coverage instead of disappearing', () => {
  const runId = syntheticRun([
    { season: 2026, week: 1, picks: [pick()] },
    { season: 2026, week: 2, picks: [] },
    { season: 2026, week: 3, picks: [pick({ result: 'lost', units: -1 })] }
  ]);
  const overview = auditOverview(runId);
  const season = overview.season_coverage.find(s => s.season === 2026);
  assert.equal(season.weeks_present, 3, 'a week that ran and bet nothing is a complete week');
  assert.deepEqual(season.missing_weeks, []);
  assert.equal(season.complete, true);
});

test('C09: a genuine GAP is reported, not hidden inside a min-max span', () => {
  const runId = syntheticRun([
    { season: 2026, week: 5, picks: [pick()] },
    { season: 2026, week: 6, picks: [pick()] },
    // weeks 7 and 8 never ran
    { season: 2026, week: 9, picks: [pick()] }
  ]);
  const overview = auditOverview(runId);
  const season = overview.season_coverage.find(s => s.season === 2026);
  assert.equal(season.weeks, '5-9', 'the span is still reported');
  assert.deepEqual(season.missing_weeks, [7, 8], 'and so are the holes in it');
  assert.equal(season.complete, false);
  assert.equal(overview.coverage_complete, false);
});

test('C09: a corrupt week is NAMED rather than silently dropped', () => {
  const runId = syntheticRun([
    { season: 2026, week: 1, picks: [pick()] },
    { season: 2026, week: 2, corrupt: true },
    { season: 2026, week: 3, picks: [pick()] }
  ]);
  const overview = auditOverview(runId);
  assert.equal(overview.corrupt_weeks.length, 1);
  assert.equal(overview.corrupt_weeks[0].week, 2);
  assert.equal(overview.coverage_complete, false,
    'a run that could not read one of its own weeks is not complete coverage');
  assert.equal(overview.by_market.spread.bets, 2, 'only the readable weeks contribute bets');
});

test('C09: missing units become an explicit unknown, never zero', () => {
  const runId = syntheticRun([
    { season: 2026, week: 1, picks: [pick(), pick({ units: null }), pick({ units: null })] }
  ]);
  const overview = auditOverview(runId);
  assert.equal(overview.by_market.spread.missing_units, 2,
    'two picks have no recorded stake result, and that is a fact about the record');
  assert.equal(overview.by_market.spread.bets, 3);
  // The known unit total is not silently topped up with zeros.
  assert.equal(overview.by_market.spread.units, 0.909);
});

test('C09: an unknown or void result is neither a win nor a loss', () => {
  const runId = syntheticRun([
    { season: 2026, week: 1, picks: [
      pick(), pick({ result: 'void', units: 0 }), pick({ result: null, units: null }) ] }
  ]);
  const overview = auditOverview(runId);
  const spread = overview.by_market.spread;
  assert.equal(spread.wins, 1);
  assert.equal(spread.losses, 0);
  assert.equal(spread.voids, 1);
  assert.equal(spread.unknown_results, 1);
  assert.equal(spread.win_rate, 1, 'the win rate is over decided bets only');
});

test('C09: the pick-level count is reconciled against the per-week summary', () => {
  const runId = syntheticRun([
    { season: 2026, week: 1, picks: [pick(), pick({ result: 'lost', units: -1 })] }
  ]);
  assert.equal(auditOverview(runId).by_market.spread.summary_reconciles, true);

  // Now a run whose summary disagrees with its own picks. The overview must
  // SAY SO rather than prefer whichever number was easier to query.
  const label = 'summary-mismatch';
  run(`INSERT INTO nfl_blind_audit_runs (created_at,label,spec_hash,spec_json,code_hash,data_hash,status,next_ordinal)
       VALUES (?,?,?,?,?,?,?,?)`, '2026-09-10T00:00:00Z', label, 'spec-mismatch', '{}', 'c', 'd', 'sealed', 1);
  const mismatchId = db.prepare(`SELECT id FROM nfl_blind_audit_runs WHERE label=?`).get(label).id;
  run(`INSERT INTO nfl_blind_audit_weeks
       (run_id,ordinal,season,week,opened_at,prior_chain_hash,result_hash,chain_hash,result_json,fault_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
  mismatchId, 0, 2026, 1, '2026-09-10T00:00:00Z', 'p', 'h', 'c',
  JSON.stringify({ betting: {
    metrics: { by_market: { spread: { bets: 99, wins: 99, losses: 0, pushes: 0, units: 90 } } },
    picks: [pick()]
  } }), '{}');

  const overview = auditOverview(mismatchId);
  assert.equal(overview.by_market.spread.bets, 1, 'the picks are the authoritative record');
  assert.equal(overview.by_market.spread.summary_reconciles, false,
    'and the disagreement with the stored summary is reported');
});

test('C09: a metadata-only difference is not an economic difference', () => {
  // Same picks, same economics, different labels. The economic aggregates must
  // be identical; nothing about the label may leak into them.
  const a = syntheticRun([{ season: 2026, week: 1, picks: [pick(), pick({ result: 'push', units: 0 })] }], 'meta-a');
  const b = syntheticRun([{ season: 2026, week: 1, picks: [pick(), pick({ result: 'push', units: 0 })] }], 'meta-b');
  const oa = auditOverview(a), ob = auditOverview(b);
  assert.deepEqual(oa.by_market, ob.by_market);
  assert.deepEqual(oa.season_coverage, ob.season_coverage);
  assert.notEqual(oa.label, ob.label);
});
