/**
 * Plan 01 / package #19 (Auditor units 11, 12, G5/G6): a graded, normalised
 * availability multiplier from the report_status a player actually carried,
 * fit from `nfl_injuries` (the designation roster -- an Out/Doubtful player
 * mostly has no `player_week_usage` row at all, so that table alone cannot
 * see them) and consumed as-of a decision time via `nfl_feature_revisions`,
 * never `nfl_injuries` directly (`nfl_injuries` UPSERTs in place and holds
 * only the final designation -- reading it for a Sunday-lock decision is a
 * look-ahead leak).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-graded-availability-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const {
  fitGradedAvailability, gradedAvailabilityMultiplier, GRADED_AVAILABILITY_ENABLED
} = await import('../server/services/nfl-player-context.js');
const { recordRevision } = await import('../server/services/nfl-bitemporal.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Every test below that grades the multiplier's REAL behaviour opts in
// explicitly: Auditor §R40 ships it default-off (GRADED_AVAILABILITY_ENABLED
// false), so without this the consumer would return the neutral 1 and these
// tests would be grading the kill switch instead of the logic under it.
const ENABLED = { enabled: true };

let nextId = 1;
const insertPlayer = (name, position, gsisId) => {
  const id = nextId++;
  run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (?,?,?,?,1)`,
    id, name, position, gsisId);
  return id;
};

const insertUsage = (playerId, season, week, targets) => run(
  `INSERT INTO player_week_usage (player_id, season, week, team, opponent, position, targets, carries, attempts)
   VALUES (?,?,?, 'AAA', 'BBB', 'WR', ?,0,0)`,
  playerId, season, week, targets);

// fitGradedAvailability (Auditor §R19.6) sources its population from the
// EARLIEST `injury_report` revision, not `nfl_injuries` -- so a fixture that
// only writes `nfl_injuries` is invisible to the fit. This inserts both: the
// final designation table (matching what serving code would see if it ever
// read it directly, which it must not) and one revision recorded early in
// the window, so a fixture with no deliberate divergence behaves the same
// under either read.
let revSeq = 0;
const insertInjury = (gsisId, season, week, reportStatus) => {
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, report_status) VALUES (?,?,?,?)`,
    season, week, gsisId, reportStatus);
  const publishedAt = new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + revSeq * 60000).toISOString();
  const observedAt = new Date(Date.UTC(2024, 0, 1, 0, 0, 5) + revSeq * 60000).toISOString();
  recordRevision({
    entity: `player:${gsisId}:${season}:${week}`, feature: 'injury_report',
    value: { report_status: reportStatus, practice_status: null, injury: null },
    publishedAt, observedAt,
    provenance: 'captured', sourceId: 'fixture', entitySeason: season, entityWeek: week
  });
  revSeq++;
};

// Fixture population for fitGradedAvailability: 40 "clean" baseline
// player-weeks (30 play, 10 sit -- rate 0.75, well above the minN floor),
// 40 Questionable weeks (20 play), 40 Out weeks (0 play), 20 Doubtful weeks
// (0 play, deliberately UNDER minN=30 to exercise the pre-registered floor).
//
// The establishing week is 21 and the measured week is 22 (the query's own
// `next_week <= 22` cap), not 1/2: a player who plays in the measured week
// becomes "active" there too and would otherwise cascade into a spillover
// candidate for week+1 in a live, full-season dataset that legitimately
// keeps rolling forward. At week 22 that spillover (week 23) is exactly
// what the production query's own cap excludes, which keeps this small,
// two-week fixture numerically self-contained without changing the query.
function seedFitPopulation() {
  // Baseline: 40 distinct players, each with a week-21 usage row (establishes
  // "active"), then week 22 is the measured week: 30 play, 10 do not, none on
  // the injury report week 22.
  for (let i = 0; i < 40; i++) {
    const id = insertPlayer(`Baseline ${i}`, 'WR', `gsis-base-${i}`);
    insertUsage(id, 2024, 21, 5);
    if (i < 30) insertUsage(id, 2024, 22, 5);
  }
  // Questionable: 40 players, active week 21, Questionable week 22, 20 play.
  for (let i = 0; i < 40; i++) {
    const id = insertPlayer(`Quest ${i}`, 'WR', `gsis-q-${i}`);
    insertUsage(id, 2024, 21, 5);
    insertInjury(`gsis-q-${i}`, 2024, 22, 'Questionable');
    if (i < 20) insertUsage(id, 2024, 22, 5);
  }
  // Out: 40 players, active week 21, Out week 22, none play.
  for (let i = 0; i < 40; i++) {
    const id = insertPlayer(`Out ${i}`, 'WR', `gsis-out-${i}`);
    insertUsage(id, 2024, 21, 5);
    insertInjury(`gsis-out-${i}`, 2024, 22, 'Out');
  }
  // Doubtful: only 20 (under minN=30) -- must collapse to 1.0.
  for (let i = 0; i < 20; i++) {
    const id = insertPlayer(`Doubtful ${i}`, 'WR', `gsis-dt-${i}`);
    insertUsage(id, 2024, 21, 5);
    insertInjury(`gsis-dt-${i}`, 2024, 22, 'Doubtful');
  }
}
seedFitPopulation();
const fit = fitGradedAvailability([2024], { minN: 30 });

test('Out and Questionable get real, different, correctly-ordered ratios', () => {
  assert.ok(fit.ratios.Out != null, 'Out must clear the minN floor in this fixture');
  assert.ok(fit.ratios.Questionable != null, 'Questionable must clear the minN floor in this fixture');
  assert.ok(fit.ratios.Out < fit.ratios.Questionable,
    `Out (rarely plays) must be a smaller ratio than Questionable (often plays): ` +
    `Out=${fit.ratios.Out}, Questionable=${fit.ratios.Questionable}`);
  // Out: 0 of 40 played -> ratio 0. Questionable: 20 of 40 played (rate 0.5)
  // against baseline rate 0.75 -> ratio 0.5/0.75 = 0.667.
  assert.equal(fit.ratios.Out, 0);
  assert.ok(Math.abs(fit.ratios.Questionable - 0.667) < 0.01,
    `expected Questionable ratio near 0.667, got ${fit.ratios.Questionable}`);
});

test('a bucket under the pre-registered minN floor (Doubtful, n=20) collapses to unretained, not a separate estimate', () => {
  assert.equal(fit.buckets.Doubtful.n, 20);
  assert.equal(fit.buckets.Doubtful.retained, false, 'n=20 < minN=30 must not be retained');
  assert.equal(fit.ratios.Doubtful, undefined, 'a collapsed bucket must not appear in the consumption vector at all');
});

test('G1 invariant: an unreported player-week gets a multiplier of EXACTLY 1, never a raw play-rate estimate', () => {
  const id = insertPlayer('No Report Player', 'WR', 'gsis-noreport-1');
  // No injury report recorded at all for this player-week.
  const decisionAt = '2024-09-25T12:00:00Z';
  // Opts in (§R40/§R51.1): the G1 invariant is a claim about what the multiplier
  // returns when it RUNS on an unreported week. Without the opt-in this would be
  // the kill switch returning 1, which would prove nothing about G1.
  const result = gradedAvailabilityMultiplier('gsis-noreport-1', 2024, 3, decisionAt, fit.ratios, ENABLED);
  assert.equal(result.multiplier, 1, 'unreported must be exactly 1, not close to 1');
  assert.equal(result.known, false);
});

test('a bucket collapsed by the minN floor (Doubtful) also resolves to exactly 1 through the consumer, not its raw rate', () => {
  recordRevision({
    entity: 'player:gsis-collapsed-1:2024:4', feature: 'injury_report',
    value: { report_status: 'Doubtful', practice_status: 'Did Not Participate', injury: 'ankle' },
    publishedAt: '2024-09-26T18:00:00Z', observedAt: '2024-09-26T18:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 4
  });
  // Opts in (§R40/§R51.1): the claim is that the minN floor's collapse survives
  // the CONSUMER, so the consumer has to actually reach its bucket lookup.
  const result = gradedAvailabilityMultiplier('gsis-collapsed-1', 2024, 4, '2024-09-27T12:00:00Z', fit.ratios, ENABLED);
  assert.equal(result.multiplier, 1,
    'Doubtful is not in fit.ratios (collapsed for n<minN), so the consumer must fall back to exactly 1, ' +
    'not silently apply some other value');
});

test('a retained bucket (Questionable) applies its fitted ratio through the consumer, as-of the decision time', () => {
  recordRevision({
    entity: 'player:gsis-live-q-1:2024:5', feature: 'injury_report',
    value: { report_status: 'Questionable', practice_status: 'Limited Participation', injury: 'hamstring' },
    publishedAt: '2024-10-03T18:00:00Z', observedAt: '2024-10-03T18:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 5
  });
  // Opts in (§R40/§R51.1): this is the one test that grades a NON-neutral return
  // value, so it is the test the kill switch would silently hollow out -- with the
  // flag off it would assert 1 and still pass. §R51.1 names this among the three
  // evidence tests that later earn default-on.
  const result = gradedAvailabilityMultiplier('gsis-live-q-1', 2024, 5, '2024-10-04T12:00:00Z', fit.ratios, ENABLED);
  assert.equal(result.bucket, 'Questionable');
  assert.equal(result.retained, true);
  assert.equal(result.multiplier, fit.ratios.Questionable);
  assert.ok(result.multiplier > 0 && result.multiplier < 1, 'a real Questionable ratio must sit strictly between 0 and 1');
});

test('LOOK-AHEAD GUARD: a decision at Wednesday sees Wednesday\'s designation, not a later Friday downgrade', () => {
  const entity = 'player:gsis-lookahead-1:2024:6';
  // Wednesday: full participation, no designation on the report yet.
  recordRevision({
    entity, feature: 'injury_report',
    value: { report_status: null, practice_status: 'Full Participation', injury: 'hamstring' },
    publishedAt: '2024-10-09T18:00:00Z', observedAt: '2024-10-09T18:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 6
  });
  // Friday: downgraded to Questionable. A Sunday-lock decision would see this,
  // but a Wednesday one must not.
  recordRevision({
    entity, feature: 'injury_report',
    value: { report_status: 'Questionable', practice_status: 'Limited Participation', injury: 'hamstring' },
    publishedAt: '2024-10-11T21:00:00Z', observedAt: '2024-10-11T21:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 6
  });

  // Opts in twice below (§R40/§R51.1): the look-ahead guard is a claim about the
  // as-of READ, which only happens on the far side of the flag check. §R51.1 names
  // this among the three evidence tests that later earn default-on.
  const wednesday = gradedAvailabilityMultiplier('gsis-lookahead-1', 2024, 6, '2024-10-09T20:00:00Z', fit.ratios, ENABLED);
  assert.equal(wednesday.bucket, null, 'Wednesday must see the pre-downgrade state (no report_status yet)');
  assert.equal(wednesday.multiplier, 1);

  const sunday = gradedAvailabilityMultiplier('gsis-lookahead-1', 2024, 6, '2024-10-13T17:00:00Z', fit.ratios, ENABLED);
  assert.equal(sunday.bucket, 'Questionable', 'Sunday must see the Friday downgrade');
  assert.equal(sunday.retained, true);
});

test('empty-source no-op: a player with zero injury-feature revisions of any kind is unaffected', () => {
  // Opts in (§R40/§R51.1): the claim is that the REVISION read reports
  // `feature_never_recorded`, a reason string only the enabled path produces --
  // with the flag off the reason would be `graded_availability_disabled`. §R51.1
  // names this among the three evidence tests that later earn default-on.
  const result = gradedAvailabilityMultiplier('gsis-never-reported', 2024, 7, '2024-10-16T12:00:00Z', fit.ratios, ENABLED);
  assert.equal(result.multiplier, 1);
  assert.equal(result.known, false);
  assert.equal(result.reason, 'feature_never_recorded');
});

// Auditor §R19.6: fitGradedAvailability must bucket a player-week by its
// EARLIEST recorded status, not `nfl_injuries`' final one -- otherwise a
// player who deteriorates during the week is fit under the bucket he ended
// on, not the one an early decision actually saw him in, biasing that
// bucket's ratio toward the (mostly-zero) outcome of players who never
// really belonged to it at decision time.
test('CONDITIONING FIX: a player who deteriorates during the week is fit under his EARLIEST status, not nfl_injuries\' final one', () => {
  // A dedicated season (2023) so this doesn't interact with seedFitPopulation's
  // 2024 buckets. 35 players: each gets an early 'Questionable' revision,
  // then a later revision downgrading to 'Out'; none play. `nfl_injuries`
  // (the UPSERT-in-place table) ends up holding only 'Out' for every one of
  // them -- a fit reading nfl_injuries directly would count these 35 under
  // Out, not Questionable, and Out already has n>=30 in this file's real
  // fixture, so this cannot be a floor artifact of some other bucket.
  const baselineIds = [];
  for (let i = 0; i < 35; i++) {
    const id = insertPlayer(`Deteriorate ${i}`, 'WR', `gsis-det-${i}`);
    baselineIds.push(id);
    insertUsage(id, 2023, 21, 5);
    const entity = `player:gsis-det-${i}:2023:22`;
    recordRevision({
      entity, feature: 'injury_report',
      value: { report_status: 'Questionable', practice_status: 'Limited Participation', injury: 'knee' },
      publishedAt: '2023-10-04T18:00:00Z', observedAt: '2023-10-04T18:05:00Z',
      provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2023, entityWeek: 22
    });
    recordRevision({
      entity, feature: 'injury_report',
      value: { report_status: 'Out', practice_status: 'Did Not Participate', injury: 'knee' },
      publishedAt: '2023-10-06T21:00:00Z', observedAt: '2023-10-06T21:05:00Z',
      provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2023, entityWeek: 22
    });
    run(`INSERT INTO nfl_injuries (season, week, gsis_id, report_status) VALUES (?,?,?,?)`,
      2023, 22, `gsis-det-${i}`, 'Out'); // nfl_injuries UPSERTs to the FINAL status only
  }
  // A 2023 baseline (35 clean weeks, all play) so this season has its own
  // minN-clearing denominator independent of the 2024 fixture above.
  for (let i = 0; i < 35; i++) {
    const id = insertPlayer(`Base23 ${i}`, 'WR', `gsis-base23-${i}`);
    insertUsage(id, 2023, 21, 5);
    insertUsage(id, 2023, 22, 5);
  }

  const rawInjuriesStatus = rows(`SELECT report_status FROM nfl_injuries WHERE gsis_id = 'gsis-det-0' AND season=2023 AND week=22`)[0];
  assert.equal(rawInjuriesStatus.report_status, 'Out', 'sanity: nfl_injuries only ever held the final status');

  const seasonFit = fitGradedAvailability([2023], { minN: 30 });
  assert.equal(seasonFit.buckets.Questionable.n, 35,
    'the 35 deteriorating players must be counted under Questionable (their earliest status), not Out');
  assert.equal(seasonFit.buckets.Questionable.played, 0);
  assert.equal(seasonFit.ratios.Questionable, 0,
    'ratio is 0 here (none played), distinct from this file\'s other fixture -- proves this bucket came from this block, not a leftover');
  assert.equal(seasonFit.buckets.Out, undefined,
    'nothing should land in Out for 2023: every one of these players\' EARLIEST status was Questionable, never Out');
});

test('Auditor §R40: GRADED_AVAILABILITY_ENABLED defaults false, and nothing in this repo sets it true', () => {
  assert.equal(GRADED_AVAILABILITY_ENABLED, false,
    'default-off until the R19.6-conditioned fit is independently regraded (Auditor §R19.5/§R19.6). ' +
    'Flipping this is a one-line, reviewable change; leaving the multiplier as unreachable dead code ' +
    'instead would let a future call site switch it on with nothing to review');
});

test('Auditor §R40: the flag is a hard kill switch, not a formality -- it overrides a real, retained bucket', () => {
  // The "retained bucket (Questionable)" test above proves fit.ratios.Questionable
  // is a real value strictly between 0 and 1 on this fixture data. With the flag
  // off, gradedAvailabilityMultiplier must STILL return the neutral 1 -- which is
  // what shows the flag check runs before the bucket lookup, rather than this
  // fixture merely falling through to one of the already-neutral branches.
  assert.ok(fit.ratios.Questionable > 0 && fit.ratios.Questionable < 1,
    'sanity: this bucket really is non-trivial in the fixture data');
  recordRevision({
    entity: 'player:gsis-flag-off-1:2024:8', feature: 'injury_report',
    value: { report_status: 'Questionable', practice_status: 'Limited Participation', injury: 'ankle' },
    publishedAt: '2024-10-17T18:00:00Z', observedAt: '2024-10-17T18:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries', entitySeason: 2024, entityWeek: 8
  });
  const result = gradedAvailabilityMultiplier('gsis-flag-off-1', 2024, 8, '2024-10-18T12:00:00Z', fit.ratios);
  assert.equal(result.multiplier, 1);
  assert.equal(result.known, false);
  assert.equal(result.reason, 'graded_availability_disabled');
});

// ---------------------------------------------------------------------------
// Auditor §R51.1 condition 1. The rule "production code never passes the
// override" is worth nothing as a convention: the failure mode it guards
// against is a caller forwarding `options` through, which reads as plumbing in
// a diff. So this is a source scan. It permits a future caller to WIRE the
// multiplier in (that is what the coupled grade's call site is for) and fails
// only if such a caller passes a 6th argument at all -- production code
// inherits GRADED_AVAILABILITY_ENABLED or it does not run.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Comments are stripped before scanning, because the flag's own docstring
// spells out `gradedAvailabilityMultiplier(..., { enabled: true })` as prose.
// A scan that read comments would report the documentation as a violation.
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++; out += ' '; continue;
    }
    out += c;
  }
  return out;
}

// Each occurrence of `name(`, with its balanced argument text and whether the
// occurrence is the declaration rather than a call.
function callSitesOf(src, name) {
  const sites = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index);
    let depth = 0, end = open;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')') { depth--; if (depth === 0) break; }
    }
    sites.push({
      args: src.slice(open + 1, end),
      declaration: /\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 40), m.index))
    });
  }
  return sites;
}

function splitTopLevelArgs(argText) {
  const parts = [];
  let depth = 0, cur = '', quote = null;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += argText[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function sourceFilesUnder(...dirs) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
  };
  for (const d of dirs) walk(path.join(repoRoot, d));
  return out;
}

test('Auditor §R51.1: no caller under server/ or scripts/ passes the enabled override', () => {
  const files = sourceFilesUnder('server', 'scripts');
  assert.ok(files.length > 50,
    `sanity: the scan must be walking the real repository, found only ${files.length} files under server/+scripts/`);
  assert.ok(files.includes(path.join(repoRoot, 'server/services/nfl-player-context.js')),
    'sanity: the scan must include the file that declares the multiplier');

  const offenders = [];
  let declarations = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('gradedAvailabilityMultiplier')) continue;
    for (const site of callSitesOf(stripComments(raw), 'gradedAvailabilityMultiplier')) {
      if (site.declaration) { declarations++; continue; }
      const args = splitTopLevelArgs(site.args);
      if (args.length > 5 || /\benabled\b/.test(site.args)) {
        offenders.push(`${path.relative(repoRoot, file)}: ${args.length} args -- ${site.args.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
  }
  assert.equal(declarations, 1,
    `expected exactly one declaration under server/+scripts/, saw ${declarations} ` +
    `(a 0 here means the comment stripper broke, not that the repository changed)`);
  assert.deepEqual(offenders, [],
    'a caller under server/ or scripts/ passes a 6th argument to gradedAvailabilityMultiplier. Production code ' +
    'inherits GRADED_AVAILABILITY_ENABLED; it never overrides it. Forwarding the override out of caller options ' +
    'is precisely how an ungraded multiplier gets switched on in a diff that reads as wiring (Auditor §R51.1). ' +
    'Turning it on belongs at the coupled grade\'s named call site, where §R19.6\'s as-of refit binds');
});

test('Auditor §R51.1: every opt-in under test/ is the literal { enabled: true }, never a computed value', () => {
  const files = sourceFilesUnder('test');
  const bad = [];
  let optIns = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('gradedAvailabilityMultiplier')) continue;
    const code = stripComments(raw);
    // A named constant is allowed only because it is bound, in this same file's
    // source, to the literal -- so reading the call site is enough to know what
    // was passed, without running anything.
    const boundToLiteral = /\bconst\s+ENABLED\s*=\s*\{\s*enabled\s*:\s*true\s*\}/.test(code);
    for (const site of callSitesOf(code, 'gradedAvailabilityMultiplier')) {
      if (site.declaration) continue;
      const args = splitTopLevelArgs(site.args);
      if (args.length <= 5) continue;
      optIns++;
      const sixth = args[5].replace(/\s+/g, '');
      if (sixth === '{enabled:true}') continue;
      if (sixth === 'ENABLED' && boundToLiteral) continue;
      bad.push(`${path.relative(repoRoot, file)}: ${args[5]}`);
    }
  }
  assert.ok(optIns >= 5,
    `sanity: this unit's evidence tests opt in explicitly at every call site, expected at least 5, saw ${optIns}`);
  assert.deepEqual(bad, [],
    'an opt-in that is not the literal { enabled: true } (or ENABLED, bound to that literal in the same file) can ' +
    'carry a value decided at run time, which is a forwarded override in a test\'s clothes');
});
