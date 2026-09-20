/**
 * Chance to play must never fail open to a confident-looking number.
 *
 * review-fixes-2 finding 1 closed the bare catch in `fittedAvailability()`: a missing
 * fit table is now a NAMED basis ('role' | 'pooled' | 'constants'), warned once and
 * carried on `assetUniverse().context` and `lineupCall()`. Two holes of the same shape
 * were left open, and both are live on the Start/Sit screen:
 *
 *   1. `liveEspnStatuses()` still reads the `leagues` table inside a bare
 *      `catch { return null; }`. `leagues` is created by the legacy schema migration at
 *      import of server/db/index.js, so it always exists — which means that catch can
 *      only ever fire on a REAL fault (schema drift, a locked database), and when it
 *      does the whole ESPN designation layer disappears with no log, no throw and no
 *      change to `availabilityBasis()`. Measured on the fixture below: an ESPN
 *      INJURY_RESERVE starter goes from 0.006 to 0.953 and is started.
 *
 *   2. `lineupCall()` carries `availability_basis`, but nothing says it out loud. With
 *      the role layer inert the page prints "about 57% likely to suit up and see the
 *      ball this week" under
 *      "Check before kickoff" for a player with no injury at all — a pooled
 *      injury-report rate presented exactly like the validated one. The house rule is
 *      honest degradation with the reason attached (counterparty-pricing.js reports an
 *      inert source as { source, reason }), so the note names the layer, why it is
 *      inert, what the shown numbers therefore are, and how to fix it.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-honest-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const C = await import('../server/services/contingency.js');
const realTradeEngine = await import('../server/services/trade-engine.js');

let mockedAssets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => mockedAssets,
    tradeWeekContext: () => ({ season: 2026, week: 2 }),
    lineupDiff: () => ({ error: 'not under test' })
  }
});
const { lineupCall } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const warnings = () => {
  const spy = mock.method(console, 'warn', () => {});
  return {
    about: text => spy.mock.calls.filter(c => String(c.arguments.join(' ')).includes(text)).length,
    restore: () => spy.mock.restore()
  };
};

/* ----------------------------------------------- fixture: one healthy, one ESPN IR */

const player = (id, name, gsis, espn) =>
  run('INSERT INTO players (id, name, position, gsis_id, espn_id) VALUES (?,?,?,?,?)', id, name, 'WR', gsis, espn);
const appear = (id, season, week, team, pct) => {
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,?,'WR',5,0,0)`, id, season, week, team);
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)',
    id, season, week, Math.round(pct * 65), pct);
};

const ROSTER = [[921, 'Honest Healthy', 'hon-h', 7001, 'ACTIVE'], [922, 'Honest EspnIR', 'hon-r', 7002, 'INJURY_RESERVE']];
for (const [id, name, gsis, espn] of ROSTER) {
  player(id, name, gsis, espn);
  for (let w = 1; w <= 5; w++) appear(id, 2025, w, 'AAA', 0.9);
}
run(`INSERT INTO leagues (platform, league_id, season, name, my_team_id, payload, fetched_at)
     VALUES ('espn', 'honest-1', 2025, 'Honest', '1', ?, datetime('now'))`,
JSON.stringify({ seasonId: 2025, scoringPeriodId: 6,
  teams: [{ id: 1, roster: { entries: ROSTER.map(([, name, , espn, status]) => ({
    lineupSlotId: 20, playerPoolEntry: { player: { id: espn, fullName: name, injuryStatus: status, proTeamId: 1 } }
  })) } }] }));

db.exec(C.AVAILABILITY_RATES_DDL);
db.exec(C.AVAILABILITY_ROLE_RATES_DDL);
const fittedAt = '2026-09-19T00:00:00Z';
for (const [rs, p, n] of [['none', 0.8314, 3564], ['out', 0.004, 900]]) {
  run(`INSERT INTO nfl_availability_rates (scope,team,report_status,practice_status,p_active,n,raw_rate,shrunk,fitted_at)
       VALUES ('league','',?,'any',?,?,?,0,?)`, rs, p, n, p, fittedAt);
}
const config = JSON.stringify({ k: 5, byPosition: false, durabilityCap: false });
for (const [rs, ps, tier, gap, p] of [
  ['noreport', '*', '*', '*', 0.70], ['noreport', 'none', '*', '*', 0.70],
  ['noreport', 'none', 'starter', '*', 0.90], ['noreport', 'none', 'starter', 'g0', 0.953],
  ['out', '*', '*', '*', 0.006]
]) {
  run(`INSERT INTO nfl_availability_role_rates
       (report_status,practice_status,position,tier,gap,p_active,n,raw_rate,config,fitted_at)
       VALUES (?,?,'*',?,?,?,100,?,?,?)`, rs, ps, tier, gap, p, p, config, fittedAt);
}
C.resetAvailabilityCache();

/* ------------------------------------- 1. the ESPN designation layer cannot vanish */

test('the fixture prices the ESPN INJURY_RESERVE starter as out while the leagues table reads', () => {
  C.resetAvailabilityCache();
  const a = C.weeklyAvailability(2025, 6);
  assert.equal(a.get(921).active_probability, 0.953, 'healthy starter on his role cell');
  assert.equal(a.get(922).active_probability, 0.006, 'ESPN IR priced on the out designation');
  assert.equal(a.get(922).espn_status, 'INJURY_RESERVE');
});

test('a leagues read fault throws instead of silently dropping every ESPN designation', () => {
  db.exec('ALTER TABLE leagues RENAME COLUMN fetched_at TO fetched_at_v2');
  C.resetAvailabilityCache();
  try {
    // Before this test: the bare catch swallowed it, `espn_status` went null and the
    // ESPN IR starter read 0.953 — startable, with nothing anywhere saying why.
    assert.throws(() => C.weeklyAvailability(2025, 6), /fetched_at/,
      'a real read fault on the ESPN source is a fault, not "no ESPN designations"');
  } finally {
    db.exec('ALTER TABLE leagues RENAME COLUMN fetched_at_v2 TO fetched_at');
    C.resetAvailabilityCache();
  }
});

test('no leagues table at all is a named state: null, said once, with its reason', () => {
  const saved = db.prepare('SELECT * FROM leagues').all();
  db.exec('ALTER TABLE leagues RENAME TO leagues_parked');
  C.resetAvailabilityCache();
  const warn = warnings();
  try {
    assert.equal(C.liveEspnStatuses(2025, 6), null, 'no leagues table: no ESPN statuses');
    assert.equal(C.liveEspnStatuses(2025, 6), null);
    assert.equal(warn.about('ESPN'), 1, 'said exactly once, not per call and not never');
    assert.equal(warn.about('leagues'), 1, 'the warning names the table it could not read');
  } finally {
    warn.restore();
    db.exec('ALTER TABLE leagues_parked RENAME TO leagues');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n, saved.length);
    C.resetAvailabilityCache();
  }
});

/* --------------------------- 2. Start/Sit says when the role layer is not the one pricing */

const POOLED = { basis: 'pooled', missing: ['nfl_availability_role_rates'], stamp: '139:x|0:' };
const ROLE = { basis: 'role', missing: [], stamp: '139:x|871:y' };

let leagueSeq = 80;
const callWith = (availability_basis, active_probability) => {
  mockedAssets = new Map([[1, {
    id: 1, name: 'Jayden Placeholder', position: 'QB', team_abbr: 'MID', espn_id: 9101, available: true,
    current_week_ppg: 18, adj_ppg: 18, ppg: 18, ros_ppg: 18, ceiling: 27, floor: 9, active_probability, bye: 9
  }]]);
  mockedAssets.context = { season: 2026, week: 2, availability_basis };
  const id = ++leagueSeq;
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: [{ lineupSlotId: 0,
    playerPoolEntry: { player: { id: 9101, fullName: 'Jayden Placeholder', defaultPositionId: 1, injuryStatus: 'ACTIVE' } } }] } }],
  schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Honest lineup', '1', 10, 1, ?, ?)`,
  id, `honest-lg-${id}`, JSON.stringify(['QB']), JSON.stringify(payload));
  const call = lineupCall(id);
  assert.ok(!call.error, call.error);
  return call;
};

test('an inert role layer is reported on the lineup call with its reason, like counterparty-pricing', () => {
  const note = callWith(POOLED, 0.574).availability_note;
  assert.ok(note, 'the pooled basis is a degradation and must be named');
  assert.equal(note.basis, 'pooled');
  assert.match(note.inert, /role/i, 'names the layer that is not running');
  assert.match(note.reason, /nfl_availability_role_rates/, 'names why, down to the table');
  assert.match(note.effect, /pooled|injury report/i, 'says what the shown percentages actually are');
  assert.match(note.fix, /fit-availability/, 'says what makes it live again');
});

test('no note when the fitted role layer is the one pricing the page', () => {
  assert.equal(callWith(ROLE, 0.574).availability_note, null);
  // A call solved on a universe that never reported a basis is not evidence of health.
  assert.equal(callWith(null, 0.574).availability_note, null);
});

test('a chance-to-play warning never reads as a fitted number while the layer is inert', () => {
  const degraded = callWith(POOLED, 0.574).warnings.find(w => w.player === 'Jayden Placeholder');
  assert.ok(degraded, 'a 57% chance to play is still flagged');
  assert.match(degraded.issue, /57% likely to suit up and see the ball/, 'the number is still shown');
  assert.match(degraded.issue, /not the fitted|not running|pooled/i,
    'and is never shown bare: the reason travels with it');
  assert.equal(degraded.availability_basis, 'pooled');

  const fitted = callWith(ROLE, 0.574).warnings.find(w => w.player === 'Jayden Placeholder');
  assert.match(fitted.issue, /^about 57% likely to suit up and see the ball this week$/,
    'a fitted number carries no caveat');
  assert.equal(fitted.availability_basis, 'role');
});

test('the Start/Sit page renders the note instead of leaving it on the wire', () => {
  // availability_basis was added to this payload by review-fixes-2 "so the page can say
  // so" and no page ever read it. A served field nothing renders is not a disclosure.
  const src = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  assert.match(src, /availability_note/, 'the lineup page reads the degradation note');
  assert.match(src, /\.reason/, 'and renders its reason, not just its existence');
});

test('the Start/Sit page labels the fitted state too, not only the broken one', () => {
  // The asymmetry this closes: a degraded percentage got a panel and a fitted one got
  // nothing, so "74% likely to play" rendered identically whether it was measured or a
  // hand-set constant standing in for a measurement. The reader could not tell them
  // apart from the number, which is the same defect the panel exists to prevent —
  // it was simply waiting for the next time the tables went missing.
  const src = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  assert.match(src, /availability_basis\?\.basis === 'role'/,
    'the page reads the basis, not just the absence of a note');
  assert.match(src, /measured rate from the fitted availability/,
    'and says so on the fitted path instead of rendering nothing');
});

test('the row that was priced by a chance to play shows it', () => {
  // The page stated the basis for the page and never printed the number the basis
  // described. `active_probability` has been on every lineup call since the fit
  // landed, and the one multiplier behind each start was the single thing the
  // page would not say.
  const src = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  assert.match(src, /c\.player\.active_probability/, 'the slot reads the per-player number');
  assert.match(src, /% to play/, 'and renders it on the row it priced');
  // This used to assert the literal string "(assumed)". That was the wording of
  // one implementation, not the guarantee: the row must say where its number
  // came from. The suffix is now the shared BasisChip, which is strictly more
  // than the string was — it renders in the MEASURED state too, where the
  // suffix rendered nothing and a reader could not tell a checked page from an
  // unchecked one. So the assertion follows the path to the reader instead of
  // the text: the row maps the server's basis through the chip's map, and the
  // chip has a tier for the fallback.
  assert.match(src, /<BasisChip[\s\S]{0,200}AVAILABILITY_BASIS\[/,
    'the row no longer marks its number with the shared chip');
  const chip = fs.readFileSync(new URL('../client/src/components/ui/BasisChip.tsx', import.meta.url), 'utf8');
  assert.match(chip, /constants:\s*'assumed'/, "the server's hand-set basis no longer reaches a tier");
  assert.match(chip, /assumed:\s*\{[\s\S]{0,80}label:\s*'Assumed'/,
    'the assumed tier no longer says so');
});

test('every surface priced by these percentages says which model produced them', () => {
  // Three PRs added a basis field to a response and one rendered it, so the
  // waiver board and Trade Lab priced players on a hand-set fallback in exactly
  // the same words they use for a measured rate. A field no page reads is not a
  // disclosure, wherever it is served from.
  // As above: these asserted each surface's own wording, and each surface had
  // its own. They are all the shared chip now, so what must hold is that each
  // still READS the basis and still renders a chip for it — including in the
  // measured state, which two of these three used to pass over in silence.
  const waivers = fs.readFileSync(new URL('../client/src/components/lineup/WaiverWire.tsx', import.meta.url), 'utf8');
  assert.match(waivers, /availability_basis\?\.basis === 'role'/, 'the waiver board reads the basis');
  assert.match(waivers, /<BasisChip basis=\{measured \? 'fitted' : 'assumed'\}/,
    'and marks its chips when the number is not measured');

  const tradeLab = fs.readFileSync(new URL('../client/src/pages/TradeLab.tsx', import.meta.url), 'utf8');
  assert.match(tradeLab, /availability_basis/, 'Trade Lab reads the basis from model_context');
  assert.match(tradeLab, /<BasisChip basis=\{AVAILABILITY_BASIS\[/,
    'and says so where every deal is ranked');
});

test('a Start/Sit row is marked by the model that priced THAT player', () => {
  // The page-level basis is a process fact; the fitted role layer only reaches a
  // player with an in-scope role cell, so a role-basis process still prices some
  // players pooled. Marking their number measured is the same overstatement the
  // basis field exists to remove, one level up. The page reads the per-call field
  // and keeps the page-level one only as the fallback for an asset built before
  // that field existed.
  const page = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  assert.match(page, /const basis = c\.player\?\.availability_basis \?\? pageBasis;/,
    'the row reads its own basis first');
  assert.doesNotMatch(page, /basis=\{d\?\.availability_basis\?\.basis \?\? null\}/,
    'and the page-level basis is no longer what decides a row');
  // Was `/unfitted_position.*not modelled/s` against this one file. The
  // distinction it protects is real and unchanged — a position the fit does not
  // cover is not an assumption about that player, it is a thing nobody modelled
  // — but it now lives on the path rather than in one string, so it is checked
  // along the path. Lineup maps the server's value; the chip gives that value
  // its own tier, separate from 'assumed'; the tier says "Not modelled".
  assert.match(page, /AVAILABILITY_BASIS\[basis \?\? ''\]/,
    'the row no longer maps the server basis through the shared map');
  assert.match(page, /unfitted_position/, 'the row no longer distinguishes the uncovered position');
  const chip = fs.readFileSync(new URL('../client/src/components/ui/BasisChip.tsx', import.meta.url), 'utf8');
  assert.match(chip, /unfitted_position:\s*'none'/,
    "the uncovered position is being folded into a tier that isn't its own");
  assert.match(chip, /none:\s*\{[\s\S]{0,80}label:\s*'Not modelled'/,
    'the not-modelled tier no longer says so');
  assert.doesNotMatch(chip, /unfitted_position:\s*'assumed'/,
    'an uncovered position is being called an assumption about that player again');
});
