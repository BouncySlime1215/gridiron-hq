import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/*
 * FINAL ORDER #2 (2026-09-16, RUNBOOK §10.2) — the drive simulator's clock
 * and end-of-game rules. Three separate defects, each with the recipe's own
 * exit test:
 *
 *   (b) `kneelDecision`'s victory-formation window used the OPPONENT's
 *       timeout count with the wrong sign: `40 + timeouts * 40` made kneeling
 *       look SAFER the more timeouts the opponent held, when each opponent
 *       timeout is exactly what stops the clock and denies the kneel-out.
 *       Also, one kneel decision consumed the entire remaining clock.
 *   (c) `simulateRemainder` ran a single undifferentiated `while (clock > 0)`
 *       loop: no halftime (timeouts never reset, possession never changed at
 *       the break), `isHalfEnd` computed off the GAME clock, timeouts
 *       hardcoded 3/3 on every drive, and no overtime — so a trial that
 *       reached 0:00 level was reported as a final tie.
 *
 * Item (a) of that recipe (the `urgency = 1 - secondsLeft/3600` denominator)
 * was found ALREADY FIXED on inspection: both production call sites
 * (`nfl-drive-sim.js` `varianceProfile`/`gameScriptPassRate`) pass
 * `gameSecondsLeft`, which is full-game scoped, so the 3600 divisor is
 * correct there. The `urgencyReceivesGameClock` test below pins that, so a
 * future edit cannot silently reintroduce the half-scoped version.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-drive-sim-clock-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { kneelDecision, varianceProfile, gameScriptPassRate } = await import('../server/services/nfl-sim-policy.js');

// Two league-average teams: every rate falls back to RATE_SPEC/DEF_SPEC's own
// defaults when a feature key is absent, so an empty blob is a deliberate
// "perfectly average team" rather than a missing one. Identical teams is what
// makes the overtime fix visible — a level game is the common case here.
const { run } = await import('../server/db/index.js');
for (const team of ['AAA', 'BBB']) {
  for (let week = 1; week <= 12; week++) {
    run(`INSERT INTO nfl_team_week_features (season, week, team, opponent, home, features)
         VALUES (?, ?, ?, ?, ?, ?)`,
      2024, week, team, team === 'AAA' ? 'BBB' : 'AAA', team === 'AAA' ? 1 : 0, '{}');
  }
}
const { simulateRemainder } = await import('../server/services/nfl-drive-sim.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/* ------------------------------------------------ (b) the kneel-down rule */

test('leading by 3 with 1:30 left: kneel when the opponent has NO timeouts, do not when they have three', () => {
  const secondsLeft = 90;
  const withThree = kneelDecision({ lead: 3, secondsLeft, timeouts: 3, yard: 50, isHalfEnd: false });
  const withNone = kneelDecision({ lead: 3, secondsLeft, timeouts: 0, yard: 50, isHalfEnd: false });
  assert.equal(withThree.call, 'play',
    'three opponent timeouts stop the clock after every kneel — the offence cannot run it out');
  assert.equal(withNone.call, 'kneel',
    'with no opponent timeouts three kneel-downs burn roughly two minutes — victory formation');
});

test('the kneel window shrinks monotonically as the opponent keeps timeouts (the sign of the old bug)', () => {
  // Measure the actual window per opponent-timeout count: the largest clock
  // at which victory formation is still called. The OLD formula
  // (40 + timeouts*40) produced exactly the reverse ordering — 160s of window
  // when the opponent had THREE timeouts and 40s when they had none — which
  // is the defect this pins.
  const windowFor = (t) => {
    let largest = 0;
    for (let s = 1; s <= 400; s++) {
      if (kneelDecision({ lead: 7, secondsLeft: s, timeouts: t, yard: 50, isHalfEnd: false }).call === 'kneel') {
        largest = s;
      }
    }
    return largest;
  };
  const windows = [0, 1, 2, 3].map(windowFor);
  assert.deepEqual(windows, [160, 120, 80, 40],
    'one 40-second play clock per kneel-down the opponent CANNOT stop, plus the clock already running');
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i] < windows[i - 1],
      `window must shrink as opponent timeouts grow, got ${JSON.stringify(windows)}`);
  }
});

test('a trailing or tied team never kneels the game away, whatever the opponent holds', () => {
  for (const timeouts of [0, 1, 2, 3]) {
    assert.equal(kneelDecision({ lead: -3, secondsLeft: 40, timeouts, yard: 50, isHalfEnd: false }).call, 'play');
    assert.equal(kneelDecision({ lead: 0, secondsLeft: 40, timeouts, yard: 50, isHalfEnd: false }).call, 'play');
  }
});

test('the end-of-half branch is unchanged: backed up, level or better, under 40 seconds', () => {
  assert.equal(kneelDecision({ lead: 0, secondsLeft: 30, timeouts: 3, yard: 20, isHalfEnd: true }).call, 'kneel');
  // Not backed up: a real drive is worth attempting.
  assert.equal(kneelDecision({ lead: 0, secondsLeft: 30, timeouts: 3, yard: 60, isHalfEnd: true }).call, 'play');
});

/* ------------------------------ (a) regression pin: urgency gets game clock */

test('urgency is computed from a FULL-GAME clock, so 30 seconds left reads ~0.98 not ~0.49', () => {
  // Both modules take `secondsLeft` already game-scoped (nfl-drive-sim.js
  // passes `gameSecondsLeft`). 30 seconds left in the GAME must read as
  // maximal urgency; the half-scoped bug would have halved it.
  const late = varianceProfile({ lead: -7, secondsLeft: 30, spread: null, isHome: true });
  const early = varianceProfile({ lead: -7, secondsLeft: 3000, spread: null, isHome: true });
  // A trailing team late must seek MORE variance than the same team early.
  assert.ok(late.variance_multiplier > early.variance_multiplier,
    `late ${late.variance_multiplier} should exceed early ${early.variance_multiplier}`);

  const rates = { off_neutral_pass_rate: 0.56, off_leading_pass_rate: 0.52, off_trailing_pass_rate: 0.63 };
  const scriptLate = gameScriptPassRate({ lead: -7, secondsLeft: 30, rates });
  const scriptEarly = gameScriptPassRate({ lead: -7, secondsLeft: 3000, rates });
  assert.ok(scriptLate.pass_rate > scriptEarly.pass_rate,
    'a trailing team passes more as the game clock runs out, not less');
  // With 30s left of a 3600s game, urgency ~= 0.99, so the trailing lean is
  // essentially fully applied: 0.56 + (0.63-0.56)*(0.4+0.6*0.99) ~= 0.6288.
  assert.ok(scriptLate.pass_rate > 0.62,
    `expected near-full trailing lean, got ${scriptLate.pass_rate} (half-scoped urgency would give ~0.605)`);
});

/* --------------------------- (c) simulateRemainder: halftime and overtime */

const remainder = (state, extra = {}) => simulateRemainder({
  home: 'AAA', away: 'BBB', season: 2024, week: 13, trials: 200, seed: 99, state, ...extra
});

test('a game tied with seconds left is decided by overtime, not reported as a final tie', () => {
  // Before FINAL ORDER #2c, `simulateRemainder` had no overtime at all: every
  // trial that reached 0:00 level returned a tie, so this state reported
  // ~100% ties and every live win probability derived from it was computed
  // off finishes real football would have played on.
  const out = remainder({ possession: 'home', yard: 25, down: 1, toGo: 10,
    secondsLeft: 8, homeScore: 20, awayScore: 20 });
  assert.ok(!out.error, JSON.stringify(out));
  assert.ok(out.live_moneyline.tie < 0.25,
    `tied with 8 seconds left must usually be settled in overtime, got tie=${out.live_moneyline.tie}`);
  assert.ok(out.live_moneyline.home_win > 0.3 && out.live_moneyline.away_win > 0.3,
    'two identical teams going to overtime should be close to a coin flip, not one-sided');
});

test('overtime can still end level — the fix models NFL rules, it does not forbid ties', () => {
  // Regular-season overtime genuinely can end tied. The claim being pinned is
  // "regulation ties get played on", not "ties are impossible" — asserting
  // zero ties would encode the wrong rule and fail honestly-correct code.
  const out = remainder({ possession: 'home', yard: 25, down: 1, toGo: 10,
    secondsLeft: 8, homeScore: 20, awayScore: 20 });
  assert.ok(out.live_moneyline.tie >= 0, 'tie probability is reported, not suppressed');
  const summed = out.live_moneyline.home_win + out.live_moneyline.away_win + out.live_moneyline.tie;
  assert.ok(Math.abs(summed - 1) < 0.01, `outcome probabilities must sum to 1, got ${summed}`);
});

test('a first-half start plays through halftime and produces a plausible full game', () => {
  // HONEST SCOPE: this is a path/sanity guard, not proof of the halftime fix.
  // The old single-loop version burned the same total clock budget, so it
  // would likely have passed this too. What it does guard is that the new
  // two-half control flow actually terminates, crosses the break, and yields
  // a sane full-game score rather than crashing or double-counting — the
  // failure modes a restructured loop most plausibly introduces.
  // The halftime specifics that are NOT black-box observable here (timeouts
  // resetting to 3/3, possession passing to the team that did not have it,
  // `isHalfEnd` now measured against the HALF clock rather than the game
  // clock) are verified by inspection against `simulateGame`'s own halftime
  // block, which this path was rewritten to mirror.
  const firstHalf = remainder({ possession: 'home', yard: 25, down: 1, toGo: 10,
    secondsLeft: 3400, homeScore: 0, awayScore: 0 });
  const secondHalfOnly = remainder({ possession: 'home', yard: 25, down: 1, toGo: 10,
    secondsLeft: 1700, homeScore: 0, awayScore: 0 });
  assert.ok(!firstHalf.error && !secondHalfOnly.error);
  assert.ok(firstHalf.projection.total > secondHalfOnly.projection.total * 1.4,
    `a full game (${firstHalf.projection.total}) should score far more than one half `
    + `(${secondHalfOnly.projection.total})`);
  // Sanity: a full game from 0-0 between two league-average teams lands in a
  // plausible NFL range rather than an absurd one.
  assert.ok(firstHalf.projection.total > 25 && firstHalf.projection.total < 75,
    `implausible full-game total ${firstHalf.projection.total}`);
});

test('a kneel no longer swallows the whole clock: leading late still leaves the opponent time', () => {
  // With a big lead and 300 seconds left the offence may kneel, but a victory
  // formation burns at most three play clocks (~120s) — the opponent must
  // still get the ball back. Before the fix the drive returned
  // `seconds: secondsLeft`, ending the game from a single decision.
  const out = remainder({ possession: 'home', yard: 50, down: 1, toGo: 10,
    secondsLeft: 300, homeScore: 27, awayScore: 10 });
  assert.ok(!out.error, JSON.stringify(out));
  // The trailing team still scores sometimes in those remaining minutes.
  assert.ok(out.projection.away_score > 10,
    `the trailing team must still get possessions, got away_score=${out.projection.away_score}`);
});
