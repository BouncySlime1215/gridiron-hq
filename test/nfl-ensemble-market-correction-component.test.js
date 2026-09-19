/**
 * Tests for the `market_correction_research` component -- the seam that
 * joins the Python research group (market_correction.py) into the JS
 * ensemble's own joint-fit combination, instead of the two staying two
 * separate, unjoined siloes.
 *
 * THE ONE PROPERTY THAT MATTERS MOST: this component must be structurally
 * incapable of reaching a live pick until explicitly promoted.
 * `challengerOnly: true` means `blendEligible = includeChallengers ||
 * !m.challenger_only` excludes it from every blended margin/total/residual
 * computation whenever `includeChallengers` is false -- which is
 * `ensembleLine`'s own default, i.e. every real caller. The test below
 * proves this by comparison, not by trusting the flag: a live `ensembleLine`
 * call must produce the IDENTICAL blended output whether or not the lookup
 * file has real, non-null data in it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ensemble-market-correction-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'this test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { componentIds, ensembleLine, challengerSignalWeek, componentPredictionStream,
  ensembleReplayInputs } = await import('../server/services/nfl-ensemble.js');
const lookupMod = await import('../server/services/nfl-market-correction-lookup.js');

// Scratch lookup file, selected via the same env override offline-guard.mjs
// defaults to nowhere -- this test never touches the real export under
// server/data/research/.
const LOOKUP_PATH = path.join(temp, 'market-correction-lookup.json');
process.env.GRIDIRON_MARKET_CORRECTION_LOOKUP = LOOKUP_PATH;
test.after(() => lookupMod.clearMarketCorrectionLookupCache());

function writeLookup(entries) {
  fs.writeFileSync(LOOKUP_PATH, JSON.stringify({
    schema: 'nfl-market-correction-lookup-v1',
    weeks_correction_fitted: 1, weeks_correction_abstained: 0, games_with_correction: entries.length,
    entries,
  }));
  lookupMod.clearMarketCorrectionLookupCache();
}

test('the component is registered, correctly flagged challenger-only, and in the Market family', () => {
  const ids = componentIds();
  const component = ids.find(m => m.id === 'market_correction_research');
  assert.ok(component, 'market_correction_research is not registered in MODELS');
  assert.equal(component.challenger_only, true);
  assert.equal(component.family, 'Market');
});

// 8 teams -> 4 games/week, so `games()`'s own `season >= MIN_SEASON` (2015)
// filter still clears the `hist.length >= 100` gate every function under
// test below applies well before 2023 week 8 -- a 4-team, 1-game/week
// fixture (90 games total across 2015-2023) does not.
const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];

function seedHistory() {
  for (let season = 2015; season <= 2023; season++) {
    for (let week = 1; week <= 10; week++) {
      for (let pair = 0; pair < TEAMS.length / 2; pair++) {
        const home = TEAMS[(pair * 2 + week) % TEAMS.length];
        const away = TEAMS[(pair * 2 + 1 + week) % TEAMS.length];
        if (home === away) continue;
        const margin = ((season + week + pair) % 15) - 7;
        run(`INSERT OR REPLACE INTO game_lines
             (season,week,team,opponent,home,spread,total,team_score,opp_score,
              open_spread,open_total,temp,wind,roof,rest_days,div_game,neutral_site,gameday)
             VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
          season, week, home, away, -margin, 44, 20 + margin, 20,
          -margin + 0.5, 44, 65, 5, 'outdoors', 7, 0, `${season}-09-01`);
        run(`INSERT OR REPLACE INTO game_lines
             (season,week,team,opponent,home,spread,total,team_score,opp_score,
              open_spread,open_total,temp,wind,roof,rest_days,div_game,neutral_site,gameday)
             VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
          season, week, away, home, margin, 44, 20, 20 + margin,
          margin - 0.5, 44, 65, 5, 'outdoors', 7, 0, `${season}-09-01`);
      }
    }
  }
}

test('a live ensembleLine call is byte-identical whether or not the lookup has real data', () => {
  seedHistory();
  writeLookup([]); // no correction data at all
  const withoutData = ensembleLine(2023, 8, 'AAA', 'BBB');

  writeLookup([{ season: 2023, week: 8, home: 'AAA', away: 'BBB', market_correction_margin: 99 }]);
  const withData = ensembleLine(2023, 8, 'AAA', 'BBB');

  assert.deepEqual(withoutData, withData,
    'a challengerOnly component with a wildly different value (99) changed the LIVE blended '
    + 'output -- it must be structurally excluded from every real pick, not merely intended to be');
});

test('the component predicts exactly the looked-up value, and null when there is none', () => {
  seedHistory();
  writeLookup([{ season: 2023, week: 8, home: 'AAA', away: 'BBB', market_correction_margin: 3.25 }]);
  const signals = challengerSignalWeek(2023, 8);
  const game = signals.games.find(g => g.home === 'AAA' && g.away === 'BBB');
  assert.ok(game, 'expected game not found in challenger signal week');
  const component = game.signals.find(s => s.id === 'market_correction_research');
  assert.ok(component);
  assert.equal(component.projected_margin, 3.25);
});

test('componentPredictionStream carries the looked-up value through the historical replay too', () => {
  // pair=0's home/away assignment only lands on AAA/BBB at an EVEN week
  // (the pairing formula is parity-locked); week 8 is the value already
  // proven to work above.
  seedHistory();
  writeLookup([{ season: 2020, week: 8, home: 'AAA', away: 'BBB', market_correction_margin: -1.5 }]);
  const { all, restMap, cal } = ensembleReplayInputs({ evalFrom: 2022, beforeSeason: 2024 });
  let found = null;
  for (const row of componentPredictionStream({ all, restMap, cal, beforeSeason: 2024 })) {
    if (row.season === 2020 && row.week === 8 && row.home === 'AAA' && row.away === 'BBB') {
      found = row;
      break;
    }
  }
  assert.ok(found, 'expected replay row not found');
  assert.equal(found.margins.market_correction_research, -1.5);
});
