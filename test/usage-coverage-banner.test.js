/**
 * The setup banner could not tell "never run" from "ran and wrote nothing".
 *
 * `GET /api/model/setup-status` (routes/model.js:685) builds `missing` from
 * sources whose `last_status === 'never run'`. A source that ran, reported
 * `ok`, and inserted zero rows is therefore counted as healthy: `needs_setup`
 * comes back false, the banner never renders, and every page that needs this
 * season's usage quietly serves last season's instead.
 *
 * That is this install's actual state — the weekly usage source is stamped
 * `ok` while `player_week_usage` holds 2021–2025 and nothing for the season
 * being played. Nothing failed. Nothing said anything.
 *
 * Four states, one test each, named for the state it covers. The decision
 * logic lives in plain `.js` because node:test has no build step and cannot
 * import a `.tsx`; the last test is what keeps the component and these tests
 * pointed at the same module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { coverageState, canRetry, coverageHeadline, coverageDetail } from '../client/src/lib/usage-coverage.js';

const banner = fs.readFileSync(new URL('../client/src/components/DataSetupBanner.tsx', import.meta.url), 'utf8');

test('S1 healthy: rows for the season being played renders nothing at all', () => {
  const c = { state: 'healthy', season: 2026, rows: 4820, latest_week: 2, league_week: 2 };
  assert.equal(coverageState(c), 'healthy');
  assert.equal(coverageHeadline('healthy', c), null, 'a healthy install is being told it has a problem');
  assert.equal(coverageDetail('healthy', c), null);
  // And the component asks the same question before rendering.
  assert.match(banner, /coverage != null && coverage !== 'healthy'/,
    'the banner no longer treats healthy as the state that renders nothing');
});

test('S2 never run: a fresh clone is told what is missing, and offered the fix', () => {
  const c = { state: 'never_run', season: 2026, rows: 0, latest_week: null, league_week: 2 };
  assert.equal(coverageState(c), 'never_run');
  assert.equal(canRetry('never_run'), true, 'the one state a retry actually fixes stopped offering one');
  assert.match(coverageHeadline('never_run', c), /missing historical model data/);
  assert.match(coverageDetail('never_run', c), /only exists once the one-time backfill has run/,
    'the banner stopped saying why a fresh clone has no data');
});

test('S3 stale: it names the week it stops at and the week the league is on', () => {
  const c = { state: 'stale', season: 2026, rows: 2400, latest_week: 1, league_week: 4 };
  assert.equal(coverageState(c), 'stale');
  assert.equal(canRetry('stale'), true);
  const h = coverageHeadline('stale', c);
  assert.match(h, /week 1/, 'the headline no longer says where the data stops');
  assert.match(h, /week 4/, 'the headline no longer says where the league is');
  // Both numbers, or neither — a sentence with one of them invites the reader
  // to assume the other.
  assert.match(coverageHeadline('stale', { state: 'stale', season: 2026 }),
    /has not caught up to the current week/,
    'a stale state with no week numbers is inventing one');
});

test('S4 reports ok with no rows: its own headline, and no Update button', () => {
  // The state this whole file exists for.
  const c = { state: 'ok_no_rows', season: 2026, rows: 0, latest_week: null,
    league_week: 2, seasons_with_rows: [2023, 2024, 2025], source_status: 'ok' };
  assert.equal(coverageState(c), 'ok_no_rows');
  // A retry cannot help: the pull already believes it succeeded.
  assert.equal(canRetry('ok_no_rows'), false, 'the empty-table state is offering a retry that cannot work');
  const h = coverageHeadline('ok_no_rows', c);
  assert.match(h, /reports that it updated/, 'the headline stopped naming the contradiction');
  assert.match(h, /no 2026 rows/, 'the headline stopped naming the season it has nothing for');
  assert.notEqual(h, coverageHeadline('never_run', c), 'this state wears the missing-data headline again');
  const d = coverageDetail('ok_no_rows', c);
  assert.match(d, /the same nothing/, 'the detail stopped saying a retry changes nothing');
  assert.match(d, /2023, 2024, 2025/, 'the detail stopped saying where the numbers are coming from instead');
  // The component honours it: the button is behind the retry check, not always on.
  assert.match(banner, /\{retryable && \(\s*<button onClick=\{runSync\}/,
    'the Update now button renders in every state again');
  assert.match(banner, /const retryable = coverage == null \? true : canRetry\(coverage\)/,
    'the banner decides retryability somewhere other than the shared helper');
});

test('an unplanned fifth state is shown, never silently treated as healthy', () => {
  // The availability vocabulary's rule, one surface over: a value this build
  // does not know is its own visible tier, because "unrecognised" and "fine"
  // are the two things that must never look alike.
  assert.equal(coverageState({ state: 'partial_backfill' }), 'unrecognised');
  assert.equal(canRetry('unrecognised'), false, 'an unknown state is offering a retry nobody can justify');
  assert.match(coverageHeadline('unrecognised', {}), /does not recognise/);
  // Absent is different from unknown: no field served means no claim to make.
  assert.equal(coverageState(undefined), null, 'an absent field is being read as a state');
  assert.equal(coverageState(null), null);
});

test('the banner and this test are calling the same module', () => {
  // Without this, every assertion above could pass against a helper the
  // component does not use — the failure mode the odds gate hit one step back.
  // The VALUE import specifically. /from '..\/lib\/usage-coverage'/ alone is
  // satisfied by the `import type { UsageCoverage }` line one row below it, so
  // the component could replace all four functions with local shims and keep
  // this green — which a mutation did.
  assert.match(banner, /import \{ coverageState, canRetry, coverageHeadline, coverageDetail \} from '\.\.\/lib\/usage-coverage'/,
    'the banner has its own copy of the coverage logic again');
  assert.doesNotMatch(banner, /^const (coverageState|canRetry|coverageHeadline|coverageDetail) =/m,
    'the banner is shadowing an imported decision with a local one');
  // And the key is declared, so a served field cannot be silently dropped by
  // the type rather than rendered.
  const iface = banner.slice(banner.indexOf('interface SetupStatus'), banner.indexOf('/**', banner.indexOf('interface SetupStatus')) + 400);
  assert.match(iface, /usage_coverage\?: UsageCoverage \| null;/,
    'usage_coverage is not declared on SetupStatus');
});
