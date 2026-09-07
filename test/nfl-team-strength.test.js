import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAM_STRENGTH_KEYS, TEAM_STRENGTH_SEASONS,
  teamStrength, teamStrengthCoverage, leaguePrior, teamStrengthGbmFeatures
} from '../server/services/nfl-team-strength.js';
import { buildGbmDataset } from '../server/services/nfl-gbm.js';
import { featureContracts } from '../server/services/model-governance.js';

/*
 * These features exist only because docs/OFFSEASON_MODEL.md §6 said that IF a
 * team-level aggregate is ever fed to a market model it must go through a
 * registered contract rather than a quiet new column. The tests below guard the
 * three things that would make that promise hollow: the champion silently
 * changing shape, a market-derived column sneaking in, and a season-T fact
 * leaking into a feature that claims to be knowable in August.
 */

/* --------------------------------------------------- the champion is untouched */

// The whole safety argument for the `extraFeatures` hook is that the default
// path is unchanged. If this ever fails, the challenger has started editing the
// champion's training data, and every historical GBM number in the docs is
// describing a model that no longer exists.
test('buildGbmDataset without extraFeatures is byte-identical to the champion panel', () => {
  const a = buildGbmDataset({ fromSeason: 2018, throughSeason: 2025 });
  const b = buildGbmDataset({ fromSeason: 2018, throughSeason: 2025, extraFeatures: null });
  assert.equal(a.X.length, b.X.length);
  assert.deepEqual(a.featureNames, b.featureNames);
  assert.equal(a.featureNames.length, 36, 'champion is 29 team differentials + 7 situational');
  assert.deepEqual(a.X[0], b.X[0]);
  assert.deepEqual(a.X.at(-1), b.X.at(-1));
});

test('the challenger appends columns without dropping or reordering any game', () => {
  const champ = buildGbmDataset({ fromSeason: 2018, throughSeason: 2025 });
  const chal = buildGbmDataset({ fromSeason: 2018, throughSeason: 2025,
    extraFeatures: teamStrengthGbmFeatures() });

  // A paired comparison is only meaningful on identical games in identical order.
  assert.equal(chal.X.length, champ.X.length);
  assert.deepEqual(chal.meta.map(m => `${m.season}|${m.week}|${m.home}`),
    champ.meta.map(m => `${m.season}|${m.week}|${m.home}`));
  assert.equal(chal.featureNames.length, champ.featureNames.length + TEAM_STRENGTH_KEYS.length);
  // The champion's columns must still be the champion's columns, in place.
  for (let i = 0; i < champ.X.length; i += 137) {
    assert.deepEqual(chal.X[i].slice(0, champ.featureNames.length), champ.X[i]);
  }
});

test('a challenger hook returning a wrong-length row drops the game rather than misaligning it', () => {
  const short = buildGbmDataset({ fromSeason: 2018, throughSeason: 2025,
    extraFeatures: { names: ['a', 'b'], row: () => [1] } });
  // Every row is malformed, so every game is refused. The alternative — pushing
  // a short row — would shift every column after it by one and produce a model
  // that trains happily on nonsense.
  assert.equal(short.X.length, 0);
});

/* ------------------------------------------------------------- no look-ahead */

test('every evaluated season resolves teams from a pre-Week-1 source, not season-T usage', () => {
  for (const c of teamStrengthCoverage()) {
    assert.ok(['depth', 'roster_snapshot'].includes(c.roster_source),
      `${c.season} fell back to '${c.roster_source}', which reads where players actually played`);
  }
});

test('no market-derived column is exposed to the market model', () => {
  // The implied-total effect is the one place the offseason model touched market
  // data and it failed (0.995, CI 0.951-1.044). Re-feeding it to a model whose
  // inputs already include the spread and the total would be circular.
  for (const k of TEAM_STRENGTH_KEYS) {
    assert.doesNotMatch(k, /implied|spread|total_line|market/,
      `${k} looks market-derived; §6 excludes those`);
  }
  const row = teamStrength(2025).get('KC');
  assert.deepEqual(Object.keys(row).sort(), ['season', 'team', ...TEAM_STRENGTH_KEYS].sort());
});

test('the preseason projection column is absent exactly where no prior-trained fit exists', () => {
  const byYear = new Map(teamStrengthCoverage().map(c => [c.season, c]));
  // preseason-model.js fits on graded seasons from 2022 onward, so 2021 and 2022
  // have no projection-backed column at all. Asserting the gap rather than
  // hiding it: a future sync that extends the board back should fail here and be
  // looked at, not silently change what the feature means.
  assert.equal(byYear.get(2021).filled.proj_off_points, 0);
  assert.equal(byYear.get(2022).filled.proj_off_points, 0);
  for (const s of [2023, 2024, 2025, 2026]) {
    assert.equal(byYear.get(s).filled.proj_off_points, 32, `${s} should price all 32 teams`);
  }
});

/* ------------------------------------------------------------ the aggregates */

test('every season covers exactly the 32 canonical teams, with no alias double-count', () => {
  for (const season of TEAM_STRENGTH_SEASONS) {
    const teams = [...teamStrength(season).keys()];
    assert.equal(teams.length, 32, `${season} produced ${teams.length} teams`);
    assert.equal(new Set(teams).size, 32);
    // `off_team_season` files the Rams under `LA`; unmapped, that produced a
    // 33rd team whose only real column was a QBR delta no game row could match.
    assert.ok(!teams.includes('LA'), `${season} still carries the un-canonical 'LA'`);
    assert.ok(teams.includes('LAR'));
  }
});

test('the Rams keep their QB1 QBR delta rather than stranding it on the LA alias', () => {
  const lar = teamStrength(2023).get('LAR');
  assert.ok(Number.isFinite(lar.qb1_qbr_delta),
    'LAR lost its QBR delta to the LA alias — the team-code join regressed');
});

test('shares are real shares and projected points are on a plausible season scale', () => {
  for (const season of [2023, 2024, 2025]) {
    for (const [team, r] of teamStrength(season)) {
      for (const k of ['vacated_opportunity_share', 'returning_points_share']) {
        if (r[k] == null) continue;
        assert.ok(r[k] >= 0 && r[k] <= 1, `${season} ${team} ${k}=${r[k]} is not a share`);
      }
      if (r.proj_off_points != null) {
        // Seven starters' PPR season totals. Far outside this band means the
        // starter filter counted the wrong number of players.
        assert.ok(r.proj_off_points > 400 && r.proj_off_points < 2000,
          `${season} ${team} projected ${r.proj_off_points}`);
      }
      if (r.qb1_change != null) assert.ok(r.qb1_change === 0 || r.qb1_change === 1);
    }
  }
});

/* ------------------------------------------------ missing behaviour and gates */

test('a season outside the panel shrinks to the league prior and differences to zero', () => {
  const hook = teamStrengthGbmFeatures();
  // 2018 predates the depth-chart feed entirely. The contract says "shrink to
  // league prior", and a prior is the same for both teams, so the differential
  // is zero — the feature says "no information" instead of inventing one.
  const early = hook.row({ season: 2018, home: 'KC', away: 'DEN' });
  assert.equal(early.length, TEAM_STRENGTH_KEYS.length);
  assert.ok(early.every(v => v === 0), `expected all-zero, got ${JSON.stringify(early)}`);

  // An unknown team inside a covered season falls back the same way.
  const unknown = hook.row({ season: 2025, home: 'ZZZ', away: 'YYY' });
  assert.ok(unknown.every(v => v === 0));

  // A real matchup must actually differ, or the feature is doing nothing at all.
  const real = hook.row({ season: 2025, home: 'DET', away: 'TEN' });
  assert.ok(real.some(v => Math.abs(v) > 1e-9), 'a real matchup produced no signal');
});

test('leaguePrior returns a finite number for every key, so the fallback can never emit NaN', () => {
  for (const season of TEAM_STRENGTH_SEASONS) {
    const prior = leaguePrior(season);
    for (const k of TEAM_STRENGTH_KEYS) {
      assert.ok(Number.isFinite(prior[k]), `${season} ${k} prior is ${prior[k]}`);
    }
  }
});

test('both markets register the team-strength contract with the documented shape', () => {
  const found = featureContracts('NFL').filter(c => c.feature_key === 'team_strength_aggregate');
  assert.deepEqual(found.map(c => c.market).sort(), ['spread', 'total']);
  for (const c of found) {
    // The values OFFSEASON_MODEL.md §6 specifies, not values chosen later to fit
    // whatever the evaluation happened to produce.
    assert.equal(c.missing_behavior, 'shrink to league prior');
    assert.equal(c.leakage_risk, 'high');
    assert.match(c.availability_rule, /before Week 1 kickoff/);
    assert.match(c.availability_rule, /no season-T usage row may be read/);
  }
});
