import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/*
 * Giant Plan section 6, item 1: `lead` inside nfl-sim-policy.js is flipped to
 * the offence's OWN perspective, but the pregame `spread` it was compared
 * against stayed in ESPN's home-favoured convention regardless of who
 * actually had the ball — so an away possession's win-probability math was
 * silently reading the wrong team's line. This is a synthetic, DB-free-ish
 * regression for the fix: for a state where the AWAY team is on offence, the
 * offence's own win probability (computed with isHome:false) and the home
 * team's win probability (computed independently and directly from
 * nfl-live.js's own home-perspective liveWinProbability) must sum to 1 — the
 * two must be describing the same coin, just from opposite sides of it.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-policy-spread-flip-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { varianceProfile } = await import('../server/services/nfl-sim-policy.js');
const { liveWinProbability } = await import('../server/services/nfl-live.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('an away possession\'s own win probability and the home team\'s sum to 1', () => {
  const homeSpread = -7;      // ESPN convention: the home team favoured by 7
  const secondsLeft = 1800;   // midway through the game
  const awayLead = 3;         // the possessing (away) team is currently up by 3
  const homeLead = -awayLead; // same game, from the home side

  // The offence is away: isHome:false must flip `spread` to the away team's
  // own side (nflfastR's posteam_spread convention) before it means anything
  // next to `awayLead`.
  const awayWp = varianceProfile({ lead: awayLead, secondsLeft, spread: homeSpread, isHome: false })
    .win_probability;
  // Computed independently, straight from nfl-live.js's own home-perspective
  // convention (lead and spread both already home-side, no flip needed).
  const homeWp = liveWinProbability(homeLead, secondsLeft, homeSpread);

  assert.ok(Number.isFinite(awayWp) && Number.isFinite(homeWp),
    'both win probabilities must be finite numbers');
  assert.ok(Math.abs((homeWp + awayWp) - 1) < 0.001,
    `home_wp (${homeWp}) + away_wp (${awayWp}) should sum to 1, got ${homeWp + awayWp}`);
});

test('a home possession is unaffected by the flip (isHome:true is a no-op on spread)', () => {
  const homeSpread = -7;
  const secondsLeft = 1800;
  const homeLead = 3;

  const viaPolicy = varianceProfile({ lead: homeLead, secondsLeft, spread: homeSpread, isHome: true })
    .win_probability;
  const direct = liveWinProbability(homeLead, secondsLeft, homeSpread);
  assert.equal(viaPolicy, direct);
});
