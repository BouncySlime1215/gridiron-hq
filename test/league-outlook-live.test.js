/**
 * Scoring one of Nick's own leagues against the STORED Team Outlook fit (2026-09-20).
 *
 * This is the consumer #42 deliberately did not write. Its commit said why: the model
 * could not run on the deployed app at all, because `history-corpus.js` opens the crawled
 * corpus from `process.cwd()/data/derived/` and the Dockerfile's runtime stage never copies
 * `data/`. The 065 fit store closed that -- the fit is now a row in the app's own database
 * -- so the consumer becomes writable. It reads the store; it never fits.
 *
 * THREE THINGS CAN GO WRONG HERE AND PRODUCE A NUMBER ANYWAY. Each has a test below,
 * because none of them errors:
 *
 *   1. `weeks_left`. `weeklyPanel` computes it as `totalWeeks - (i + 1)` over the rows the
 *      team HAS. For a corpus row from a finished season that is the weeks remaining. For a
 *      live league three weeks into a fourteen-week season it is ZERO -- the model is told
 *      the regular season is over. `weeks_left` is one of the six fitted features, so this
 *      is not cosmetic: a team is priced as though its record were final, which makes a bad
 *      start look fatal and a good one look safe, at exactly the weeks where the whole point
 *      of the model is that little is decided yet. The season length has to come from the
 *      payload, and if the payload does not carry it there is no honest number to serve.
 *   2. `playoff_teams` and `num_teams`. `featureRow` defaults `playoff_share` to 0.5 when
 *      they are missing, and `weeklyPanel` falls back to the whole field for the playoff
 *      cut that `games_back` measures distance to. Six of twelve and two of four are
 *      different worlds; a default here is an invented league format, scored silently.
 *   3. A week the fit does not cover. The fit is per-week (`OUTLOOK_GATE.weeks` is 2..8).
 *      `predictOutlook` returns null for a week with no model, `verdictFor(null, …)` returns
 *      null, and a surface handed nulls prints blanks with no reason beside them.
 *
 * And the state that matters most in production: no fit stored at all. That must be a
 * sentence, not an empty shape -- see the store's header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-outlook-live-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

// THIS WHOLE FILE RUNS AS THE DEPLOYED APP RUNS: with no corpus on disk. The Docker runtime
// stage copies `client/dist`, `server` and `scripts`, so `data/derived/sleeper_history.sqlite`
// is never in the image, and the container this was written in DOES have it -- which is
// exactly how a consumer that secretly depends on the corpus passes its tests here and
// renders nothing on Fly. Pointing the corpus at a path that does not exist makes every
// assertion below a statement about the deployed app rather than about this machine.
process.env.GRIDIRON_LEAGUE_HISTORY_PATH = path.join(temp, 'no-corpus-in-the-image.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { fitOutlook, fitThresholds, predictOutlook, predictFrom,
  verdictFor, OUTLOOK_FEATURES, OUTLOOK_GATE, VERDICTS } = await import('../server/services/team-outlook.js');
const { espnWeeklyRows } = await import('../server/services/espn-weekly-scores.js');
const { leagueOutlook } = await import('../server/services/league-outlook.js');
const { weeklyPanel, historyStatus } = await import('../server/services/history-corpus.js');
const { saveOutlookFit, activeOutlookFit } = await import('../server/services/outlook-fit-store.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ the fixtures */

const FIT_WEEKS = [2, 3];
const REGULAR_PERIODS = 14;
const K = 4.75;

/**
 * A fit-set panel whose outcome really depends on the features, so the coefficients mean
 * something.
 *
 * SEASON LENGTH VARIES ACROSS THE FIT LEAGUES, and it has to. The first version gave every
 * league fourteen regular-season weeks, so within a fitted week `weeks_left` was the same
 * number for every row -- a constant column. `fitOutlook` standardises each feature on the
 * fit set, a constant column standardises to all zeros, and L2 then drives its coefficient
 * to nothing. `weeks_left` was in the model and had no effect, so the test for the
 * `weeks_left` correction could not tell a corrected panel from an uncorrected one and said
 * so. Real leagues run thirteen to seventeen weeks; these do too.
 */
function fitPanel() {
  let s = 20260920;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [];
  const LENGTHS = [13, 14, 15, 17];
  for (const week of FIT_WEEKS) {
    for (let i = 0; i < 80; i++) {
      const strength = rand();
      const periods = LENGTHS[i % LENGTHS.length];
      out.push({
        season: 2023, league_id: 100 + (i % 8), roster_id: i, week,
        num_teams: 12, playoff_teams: i % 2 ? 6 : 4,
        all_play_pct: 0.15 + 0.7 * strength + 0.1 * (rand() - 0.5),
        mean_points_z: (strength - 0.5) * 2,
        games: week,
        win_pct: 0.1 + 0.8 * strength,
        games_back: (1 - strength) * 3,
        weeks_left: periods - week,
        made_playoffs: strength + 0.15 * (rand() - 0.5) > 0.45 ? 1 : 0,
        champion: 0, outcome_known: true
      });
    }
  }
  return out;
}

/**
 * Weekly scores for a four-team league, one row per week, in team order 1..4.
 *
 * WHY THEY ARE MIXED. The first version of this fixture had team 1 outscoring team 4 by
 * twelve points every single week. Every team then pinned against `clamp01` -- the two good
 * ones at 1 - 1e-6 and the two bad ones at 1e-6 -- and at those bounds NO input changes the
 * output, so the test for the `weeks_left` correction could not show a difference and the
 * test for it said so. A fixture that saturates the model measures the clamp, not the model.
 * These results give every team a mid-range all-play record instead.
 */
const SCORES = [
  [120, 110, 100, 90],
  [90, 100, 110, 120],
  [115, 95, 105, 85]
];

/** Deliberately saturating, for the one test that needs a probability that rounds to 1. */
const BLOWOUT = [[160, 70, 150, 60], [158, 72, 151, 64], [162, 68, 149, 61]];

/**
 * One ESPN league payload, in the shape `routes/leagues.js:160` stores. Four teams, two
 * playoff places, `weeksPlayed` weeks actually played out of `regularPeriods`, and the
 * remaining periods present and UNDECIDED exactly as ESPN returns them.
 */
function league({ weeksPlayed = 3, regularPeriods = REGULAR_PERIODS,
  playoffTeamCount = 2, scores = SCORES, teams = [1, 2, 3, 4] } = {}) {
  const schedule = [];
  for (let w = 1; w <= regularPeriods; w++) {
    const played = w <= weeksPlayed;
    const wk = scores[(w - 1) % scores.length];
    const pts = t => (played ? wk[t - 1] : 0);
    const pair = (a, b) => schedule.push({
      matchupPeriodId: w,
      winner: played ? (pts(a) >= pts(b) ? 'HOME' : 'AWAY') : 'UNDECIDED',
      home: { teamId: a, totalPoints: pts(a) }, away: { teamId: b, totalPoints: pts(b) }
    });
    pair(1, 2); pair(3, 4);
  }
  // Two playoff periods, which are not part of a regular-season panel.
  for (const w of [regularPeriods + 1, regularPeriods + 2]) {
    schedule.push({ matchupPeriodId: w, winner: 'UNDECIDED',
      home: { teamId: 1, totalPoints: 0 }, away: { teamId: 3, totalPoints: 0 } });
  }
  const scheduleSettings = { matchupPeriodCount: regularPeriods };
  if (playoffTeamCount != null) scheduleSettings.playoffTeamCount = playoffTeamCount;
  return {
    id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({
      teams: teams.map(id => ({ id, name: `Team ${id}` })),
      schedule, settings: { scheduleSettings }
    })
  };
}

const PANEL = fitPanel();
const FIT = fitOutlook({ panel: PANEL, k: K, weeks: FIT_WEEKS });
const THRESHOLDS = fitThresholds({ fit: FIT, panel: PANEL });

/* -------------------------------------------- 0. the deployment this has to work on */

test('the corpus really is absent, so everything below is a claim about the deployed app', () => {
  const status = historyStatus();
  assert.equal(status.available, false,
    'if the corpus is readable here, the rest of this file proves nothing about Fly');
  assert.equal(fs.existsSync(process.env.GRIDIRON_LEAGUE_HISTORY_PATH), false);
});

/* -------------------------------------------- 1. no fit stored is a sentence, not a shape */

test('with no fit stored, the panel says so in words and carries no probability at all', () => {
  assert.equal(activeOutlookFit(), null, 'nothing stored yet, or this test is checking the wrong thing');
  const out = leagueOutlook(league());
  assert.equal(out.ready, false);
  assert.match(out.reason, /fit/i, 'the reason has to be printable beside the empty space');
  assert.ok(!('teams' in out) || out.teams.length === 0,
    'a fit-shaped object with empty innards is what the store exists to prevent');
  assert.equal(JSON.stringify(out).includes('probability'), false,
    'no probability may appear when there is nothing to compute one from');
});

/* -------------------------------------------- store the fit; everything below reads it */

test('the stored fit is the one the rest of this file scores against', () => {
  const id = saveOutlookFit({ fit: FIT, thresholds: THRESHOLDS, through_season: 2023,
    l2: OUTLOOK_GATE.l2, provenance: { seasons: [2023], rows: PANEL.length } });
  assert.ok(id > 0);
  assert.deepEqual(activeOutlookFit().weeks, FIT_WEEKS);
});

/* -------------------------------------------- 2. the weeks_left correction */

test('weeks_left comes from the season length in the payload, not from the weeks played', () => {
  const lg = league({ weeksPlayed: 3 });
  const raw = espnWeeklyRows(lg);
  assert.ok(raw.ok);

  // The defect, demonstrated on the untouched producer: the panel a live league builds says
  // the season is over at its last played week.
  const plain = weeklyPanel({ rows: raw.rows });
  const atLast = plain.filter(r => r.week === 3);
  assert.equal(atLast.length, 4);
  for (const r of atLast) {
    assert.equal(r.weeks_left, 0,
      'weeklyPanel counts the rows it was given, so a live league reads as finished');
  }

  const out = leagueOutlook(lg);
  assert.equal(out.ready, true, out.reason);
  assert.equal(out.week, 3);
  assert.equal(out.weeks_left, REGULAR_PERIODS - 3);
  for (const team of out.teams) {
    assert.equal(team.features.weeks_left, REGULAR_PERIODS - 3,
      'the feature the model was fitted on has to carry the real number of weeks remaining');
  }
});

test('the correction changes the answer, which is why it is not cosmetic', () => {
  // The first version of this test compared the served probability (rounded to four places)
  // against an unrounded prediction and asserted they differed. They always differ, so it
  // survived the mutation that deletes the correction entirely. It proved nothing. Both
  // sides are now scored the same way, and the assertion is that the SERVED number follows
  // the corrected side, on a team where the two are far enough apart to round differently.
  const lg = league({ weeksPlayed: 3 });
  const fit = activeOutlookFit();
  const out = leagueOutlook(lg);
  const plain = weeklyPanel({ rows: espnWeeklyRows(lg).rows }).filter(r => r.week === 3);

  const compared = plain.map(row => {
    const uncorrected = predictOutlook(fit, row);
    const corrected = predictOutlook(fit, { ...row, weeks_left: REGULAR_PERIODS - 3 });
    return { roster_id: row.roster_id, uncorrected, corrected,
      served: out.teams.find(t => t.roster_id === row.roster_id).probability };
  });

  // Not every team can show the difference: `clamp01` caps at 1 - 1e-6, so a team the fit
  // saturates reads the same either way. That is the clamp doing its job, not the correction
  // failing, so the assertion is on the teams where the difference survives rounding.
  // At least one team where the difference survives rounding, asserted on the served value:
  // this is the assertion the deleted-correction mutation has to fail.
  const visible = compared.filter(c => +c.corrected.toFixed(4) !== +c.uncorrected.toFixed(4));
  assert.ok(visible.length, 'no team where the correction is visible at four places');
  for (const c of visible) {
    assert.equal(c.served, Math.min(0.9999, Math.max(0.0001, +c.corrected.toFixed(4))),
      `team ${c.roster_id} is served the uncorrected number`);
  }
});

test('a payload with no season length is refused rather than priced as a finished season', () => {
  const lg = league({ weeksPlayed: 3, regularPeriods: 14 });
  const payload = JSON.parse(lg.payload);
  delete payload.settings.scheduleSettings.matchupPeriodCount;
  const out = leagueOutlook({ ...lg, payload: JSON.stringify(payload) });
  assert.equal(out.ready, false);
  assert.match(out.reason, /how many weeks|season length|regular season/i);
});

/* -------------------------------------------- 3. the league's own format */

test('a payload with no playoff places is refused rather than scored as half the field', () => {
  const out = leagueOutlook(league({ weeksPlayed: 3, playoffTeamCount: null }));
  assert.equal(out.ready, false);
  assert.match(out.reason, /playoff/i, 'the reason must name what is missing');
});

/* -------------------------------------------- 4. a week the fit does not cover */

test('a week outside the fit is refused, naming the week and the weeks the fit covers', () => {
  const out = leagueOutlook(league({ weeksPlayed: 9 }));
  assert.equal(out.ready, false);
  assert.match(out.reason, /week 9/i);
  assert.match(out.reason, /2.*3|3/, 'the covered weeks belong in the reason');
});

/* -------------------------------------------- 5. what a ready panel actually carries */

test('a ready panel is one row per team, each with a probability, a verdict and the split', () => {
  const out = leagueOutlook(league({ weeksPlayed: 3 }));
  assert.equal(out.ready, true, out.reason);
  assert.equal(out.teams.length, 4);
  assert.equal(new Set(out.teams.map(t => t.roster_id)).size, 4, 'one row per team, not per team-week');

  assert.equal(out.fit.id, activeOutlookFit().id);
  assert.equal(out.fit.k, K);
  assert.equal(out.num_teams, 4);
  assert.equal(out.playoff_teams, 2);
  assert.equal(out.weeks_played, 3);

  for (const team of out.teams) {
    assert.ok(team.probability > 0 && team.probability < 1, `probability out of range: ${team.probability}`);
    assert.ok(VERDICTS.includes(team.verdict), `not a verdict: ${team.verdict}`);
    assert.notEqual(team.verdict, 'act', 'act needs a move that helps, which this cannot see');
    for (const name of OUTLOOK_FEATURES) {
      assert.ok(Number.isFinite(team.features[name]), `${name} is not a number: ${team.features[name]}`);
    }
    const d = team.decomposition;
    assert.ok(Math.abs(d.luck + d.noise + d.real - d.total) < 5e-4,
      'the three parts have to sum to the whole or they are three unrelated numbers');
  }
  // THE FEATURES MUST BE THE ONES THAT PRODUCED THE NUMBER. A surface prints both, and a
  // `points_shrunk` computed with a different k than the fit's reads as an explanation of a
  // probability it did not produce -- plausible, chartable and wrong. Fed back through the
  // same week's model, the published features have to reproduce the published probability.
  const fit = activeOutlookFit();
  for (const team of out.teams) {
    assert.equal(
      Math.min(0.9999, Math.max(0.0001, +predictFrom(fit.byWeek[out.week], team.features).toFixed(4))),
      team.probability,
      `team ${team.roster_id}'s published features do not reproduce its published probability`);
  }

  // Team 1 has the best record and the best scoring, so it cannot come out worse off.
  const best = out.teams.find(t => t.roster_id === '1'), worst = out.teams.find(t => t.roster_id === '4');
  assert.ok(best.probability > worst.probability,
    'the strongest team must not price below the weakest one');
});

/* -------------------------------------------- 6. the bands are fitted, not chosen */

test('the verdict comes from the fitted thresholds, not from round numbers', () => {
  // The thresholds are quantiles of the fitted probabilities -- see `fitThresholds` and the
  // tdd, which fixes them BEFORE anything was fitted, because a threshold chosen after
  // seeing which threshold looked good is not a threshold. On this fit they come out at
  // watch 0.09 and act_candidate 0.0049, nowhere near the quantiles' own 0.35 and 0.15, so
  // a consumer that reached for the round numbers would put a middling team on 'watch'.
  // A mutation that did exactly that changed no test, which is why this one exists.
  const fit = activeOutlookFit();
  const out = leagueOutlook(league({ weeksPlayed: 3 }));
  assert.deepEqual(out.fit.thresholds, fit.thresholds, 'the panel must publish the bands it used');

  const ROUND = { watch: 0.35, act_candidate: 0.15 };
  const disagreeing = out.teams.filter(t =>
    verdictFor(t.probability, fit.thresholds) !== verdictFor(t.probability, ROUND));
  assert.ok(disagreeing.length,
    'this fixture no longer has a team the two threshold sets disagree about, so it cannot '
    + 'tell a fitted threshold from a round one');
  for (const team of disagreeing) {
    assert.equal(team.verdict, verdictFor(team.probability, fit.thresholds),
      `team ${team.roster_id} at ${team.probability} was given the round-number verdict`);
    assert.notEqual(team.verdict, verdictFor(team.probability, ROUND));
  }
});

/* -------------------------------------------- 6. rounding must not manufacture certainty */

test('rounding for display never turns a bounded probability into a certainty', () => {
  // `predictOutlook` clamps to (1e-6, 1 - 1e-6) because a logistic fit on a few hundred
  // league-seasons is not entitled to say a team is certain. `(0.9999996).toFixed(4)` is
  // '1.0000', so rounding alone puts the certainty straight back and the page prints a 100%
  // playoff chance at week 3. This is how that defect was found, so it needs a fixture that
  // really does saturate -- the ordinary one deliberately does not.
  const lg = league({ weeksPlayed: 3, scores: BLOWOUT });
  const out = leagueOutlook(lg);
  assert.equal(out.ready, true, out.reason);

  const fit = activeOutlookFit();
  const plain = weeklyPanel({ rows: espnWeeklyRows(lg).rows }).filter(r => r.week === 3);
  const unrounded = plain.map(r => predictOutlook(fit, { ...r, weeks_left: REGULAR_PERIODS - 3 }));
  assert.ok(unrounded.some(p => +p.toFixed(4) === 1 || +p.toFixed(4) === 0),
    `this test needs a probability that rounds to a certainty; got ${unrounded.join(', ')}`);

  for (const team of out.teams) {
    assert.ok(team.probability > 0 && team.probability < 1,
      `a displayed probability may not be a certainty: ${team.probability}`);
  }
  assert.ok(out.teams.some(t => t.probability === 0.9999 || t.probability === 0.0001),
    'the saturated team should land on the finest value inside the bound, not on 1 or 0');
});

test("an unsynced league gets the producer's own reason, not a fit reason", () => {
  const out = leagueOutlook({ id: 9, league_id: 'L9', season: 2026, payload: null });
  assert.equal(out.ready, false);
  assert.match(out.reason, /never been synced/i);
});

test('the parser has one definition, and the old path still reaches it', async () => {
  // It moved out of team-outlook.js into espn-weekly-scores.js so consumers can read weekly
  // scores without importing a fitted model, and so they do not wait on this branch merging.
  // team-outlook.js re-exports it for existing importers; two definitions is the thing to
  // avoid, and this asserts there is one function, not two that agree today.
  const model = await import('../server/services/team-outlook.js');
  const parser = await import('../server/services/espn-weekly-scores.js');
  assert.equal(model.espnWeeklyRows, parser.espnWeeklyRows,
    'the re-export must be the same function object, not a second copy');
});
