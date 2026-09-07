import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The untried cross-wire: feed the career / preseason / offseason player
// engines into the TD PROP calibration head, rather than into game-level
// spread and total lines (that angle was tried and failed — see
// docs/BETTING_PLAYER_ENGINES.md and nfl-team-strength.js, untouched here).
//
// The measured answer was a decline on both TD markets (docs/PROPS_PLAYER_ENGINES.md).
// What this file protects is the harness that produced that answer, because a
// negative result is only worth anything if the thing that produced it was
// actually capable of finding a positive one and actually walked forward:
//
//  1. the season features are strictly pre-season-T — a monster season T does
//     not leak backwards into the feature attached to season T's own weeks;
//  2. the no-feature control reproduces the shipped head, so a challenger loss
//     is a statement about the FEATURES and not about the fitter's shape;
//  3. training is strictly chronological and a season with no prior data is
//     skipped rather than quietly graded;
//  4. "wins" requires a significant improvement, in the right direction —
//     a favourable point estimate inside a CI that straddles zero is not a win.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-prop-player-heads-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
db.exec(`CREATE TABLE IF NOT EXISTS nfl_player_week_features (
  season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
  player_name TEXT, team TEXT, opponent TEXT, position TEXT, features TEXT NOT NULL,
  PRIMARY KEY (season, week, player_id)
)`);

const GSIS = n => `00-00${String(10000 + n).slice(-5)}`;
const PLAYERS = Array.from({ length: 40 }, (_, i) => GSIS(i));
const SEASONS = [2019, 2020, 2021, 2022, 2023];

// A synthetic league: player 0 is the leakage probe — nothing at all before
// 2023, then a 15-TD 2023.
const insert = db.prepare(`INSERT OR REPLACE INTO nfl_player_week_features
  (season,week,player_id,player_name,team,opponent,position,features) VALUES (?,?,?,?,?,?,?,?)`);
for (const season of SEASONS) {
  for (let i = 0; i < PLAYERS.length; i++) {
    if (i === 0 && season < 2023) continue;
    for (let week = 1; week <= 15; week++) {
      const scores = i === 0 ? (week <= 15 ? 1 : 0) : ((i + week + season) % 4 === 0 ? 1 : 0);
      insert.run(season, week, PLAYERS[i], `Player ${i}`, i % 2 ? 'BUF' : 'MIA',
        i % 2 ? 'MIA' : 'BUF', ['RB', 'WR', 'TE', 'WR'][i % 4], JSON.stringify({
          carries: 8 + (i % 5), targets: 4 + (i % 6), pass_attempts: 0,
          rushing_yards: 30 + i, receiving_yards: 25 + i, passing_yards: 0,
          receptions: 3, rushing_tds: scores, receiving_tds: 0, passing_tds: 0, interceptions: 0
        }));
    }
  }
}

const { propPlayerFeatures, clearPropPlayerFeatureCache } =
  await import('../server/services/nfl-props-player-features.js');
const { challengerRows, walkForwardChallengerTd, ablateChallengerTd, CHALLENGER_HEADS } =
  await import('../server/services/nfl-prop-player-heads.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Replay-shaped rows: probability p, outcome y, one synthetic game per week. */
function replayRows({ seasons = [2021, 2022, 2023], leak = false } = {}) {
  const out = [];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const season of seasons) {
    for (let week = 1; week <= 15; week++) {
      for (let i = 0; i < PLAYERS.length; i++) {
        const p = 0.1 + 0.5 * rand();
        const y = rand() < p ? 1 : 0;
        const p2 = p * 0.3;
        out.push({
          season, week, player_id: PLAYERS[i], position: ['RB', 'WR', 'TE', 'WR'][i % 4],
          team: i % 2 ? 'BUF' : 'MIA', opponent: i % 2 ? 'MIA' : 'BUF',
          eligibility: { markets: { player_anytime_td: true } },
          market: { anytime_td: p, multi_td: p2 },
          actual: { anytime_td: leak ? y : y, multi_td: rand() < p2 ? 1 : 0 }
        });
      }
    }
  }
  return out;
}

test('a season-T explosion never reaches the feature attached to season T', () => {
  clearPropPlayerFeatureCache();
  const f2023 = propPlayerFeatures(2023).get(PLAYERS[0]);
  // Player 0 played only in 2023, and scored in every week of it. The career
  // block for 2023 must therefore see NOTHING: any non-zero TD rate here would
  // be season 2023 predicting season 2023.
  assert.equal(f2023.career_missing, 1);
  assert.equal(f2023.career_td_per_game, 0);
  assert.equal(f2023.career_seasons, 0);

  // A player who really does have prior seasons gets a real, non-leaked rate,
  // so the zero above is the leak guard firing and not the block being broken.
  const other = propPlayerFeatures(2023).get(PLAYERS[4]);
  assert.equal(other.career_missing, 0);
  assert.ok(other.career_seasons >= 2, 'prior seasons should be visible');
  assert.ok(other.career_td_per_game > 0);
});

test('features are missing-flagged rather than imputed as an average player', () => {
  clearPropPlayerFeatureCache();
  const f = propPlayerFeatures(2022).get(PLAYERS[4]);
  // No preseason board and no offseason panel exist in this synthetic league,
  // so both blocks must announce themselves as absent instead of contributing
  // a fabricated zero that reads as "league average".
  assert.equal(f.pre_missing, 1);
  assert.equal(f.off_missing, 1);
  assert.equal(f.pre_ppg, 0);
});

test('both TD markets are built, including the 2+ market the shipped tdRows skips', () => {
  clearPropPlayerFeatureCache();
  const rows = replayRows();
  const any = challengerRows(rows, 'anytime_td');
  const multi = challengerRows(rows, 'multi_td');
  assert.ok(any.length > 500);
  assert.equal(any.length, multi.length, 'identical player-weeks in both markets');
  assert.ok(multi.every(r => r.y === 0 || r.y === 1));
  // The 2+ probability is strictly below the anytime probability by construction,
  // so a mixed-up market mapping would show up here.
  assert.ok(multi.every((r, i) => r.p < any[i].p));
  assert.throws(() => challengerRows(rows, 'rec_yds'), /unknown TD prop market/);
});

test('training is strictly chronological and a season with no prior data is skipped', () => {
  clearPropPlayerFeatureCache();
  const rows = replayRows();
  const res = walkForwardChallengerTd(rows, {
    testSeasons: [2021, 2022, 2023], bootstrapIterations: 200
  });
  const by = Object.fromEntries(res.per_season.map(s => [s.season, s]));
  // 2021 has nothing before it in this dataset. Skipped, with a reason —
  // never silently graded against a head fit on its own season.
  assert.equal(by[2021].skipped, true);
  assert.match(by[2021].why, /prior-season rows/);

  const built = challengerRows(rows, 'anytime_td');
  const count = pred => built.filter(pred).length;
  assert.equal(by[2022].train_n, count(r => r.season < 2022), '2022 trains on 2021 only');
  assert.equal(by[2023].train_n, count(r => r.season < 2023), '2023 trains on 2021+2022 only');
  assert.equal(by[2023].test_n, count(r => r.season === 2023));
  assert.ok(by[2023].train_n > by[2022].train_n);
  // The challenger's own inner selection split is chronological too.
  assert.equal(by[2023].challenger_inner_season, 2022);
  assert.ok(by[2023].challenger_inner_ranking.length === CHALLENGER_HEADS.length);
});

test('the no-feature control tracks the shipped head, so a loss indicts the features', () => {
  clearPropPlayerFeatureCache();
  const rows = replayRows();
  const res = walkForwardChallengerTd(rows, { testSeasons: [2023], bootstrapIterations: 200 });
  const s = res.per_season[0];
  assert.equal(s.stacked, true, 'the fair form stacks on the shipped head');
  // Stacked on the shipped head with a slope shrunk toward 1, the challenger
  // cannot be wildly different from the baseline it starts from. If it were,
  // any verdict would be about head shape rather than about the engines.
  assert.ok(Math.abs(s.challenger.brier - s.shipped.brier) < 0.01,
    `challenger ${s.challenger.brier} vs shipped ${s.shipped.brier} diverged too far to be a feature test`);
});

test('a win needs significance in the right direction, not a favourable point estimate', () => {
  clearPropPlayerFeatureCache();
  const res = walkForwardChallengerTd(replayRows(), {
    testSeasons: [2022, 2023], bootstrapIterations: 400
  });
  for (const s of res.per_season.filter(x => !x.skipped)) {
    const [lo, hi] = s.bootstrap.ci90;
    const straddles = lo <= 0 && hi >= 0;
    if (straddles || s.bootstrap.mean_diff >= 0) assert.equal(s.wins, false);
    else assert.equal(s.wins, true);
  }
  // On pure noise features the pre-stated bar must not be cleared, and the
  // verdict must say so in words rather than leaving it to the reader.
  assert.ok(res.seasons_won < 2);
  assert.match(res.verdict, /does NOT clear the pre-stated bar/);
  assert.match(res.bar, /at least 2 of 3 held-out seasons/);
});

test('the ablation grades every block against an identical control on identical rows', () => {
  clearPropPlayerFeatureCache();
  const ab = ablateChallengerTd(replayRows(), { testSeasons: [2023], bootstrapIterations: 200 });
  const s = ab.per_season[0];
  assert.equal(s.skipped, undefined);
  assert.equal(s.blocks.length, CHALLENGER_HEADS.filter(h => h.blocks.length).length);
  for (const b of s.blocks) {
    assert.ok(Number.isFinite(b.brier));
    assert.equal(b.helps, b.significant === true && b.mean_diff < 0);
  }
});

test('nothing here is wired into the shipped calibration path', async () => {
  // The challenger is research-only. It must not have quietly become the thing
  // production calls, and it must not have written a calibration fit.
  const src = fs.readFileSync(new URL('../server/services/nfl-props.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('nfl-prop-player-heads'));
  assert.ok(!src.includes('nfl-props-player-features'));
  const fits = db.prepare(`SELECT COUNT(*) n FROM nfl_prop_calibration_fits`).get();
  assert.equal(fits.n, 0, 'the challenger evaluation must persist no calibration fit');
});
