import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * GET /api/leagues/:id/outlook — the League Hub's way in to leagueOutlook().
 *
 * The route is deliberately thin, and thin is the thing worth testing. It
 * answers with whatever leagueOutlook() returns, unchanged, in both of that
 * function's two shapes. A route that "helpfully" filled in a missing field,
 * dropped `reason`, or flattened `ready: false` into an empty panel would put
 * a second opinion about this league on the page beside the model's, and the
 * page would have no way to tell them apart.
 *
 * So the assertions are deep equality against a direct call on the same row,
 * not a spot-check of fields. A spot-check passes for a route that quietly
 * drops whatever the spot-check forgot to name.
 *
 * The corpus is pointed at a path that does not exist, because the Docker
 * runtime stage never copies `data/`. A consumer that secretly depends on the
 * corpus passes on this machine and renders nothing on Fly.
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-outlook-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_LEAGUE_HISTORY_PATH = path.join(temp, 'no-corpus-in-the-image.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { leagueOutlook } = await import('../server/services/league-outlook.js');
const { fitOutlook, fitThresholds } = await import('../server/services/team-outlook.js');
const { saveOutlookFit } = await import('../server/services/outlook-fit-store.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
// The same handler server/index.js installs: AuthorizationError carries 403.
app.use((err, _req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500)
  .json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ fixtures */

function account(subject, token) {
  run(`INSERT INTO users (subject, display_name) VALUES (?,?)`, subject, subject);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now','+1 day'))`, id, hashSessionToken(token));
  return id;
}

const REGULAR_PERIODS = 14;
const FIT_WEEKS = [2, 3];
const K = 4.75;

/**
 * Season length varies across the fit leagues on purpose. Give every league the
 * same number of regular-season weeks and `weeks_left` becomes a constant column
 * within a fitted week; standardisation turns a constant column into zeros and L2
 * drives its coefficient to nothing, so the feature is in the model with no effect
 * and a test cannot tell a corrected panel from an uncorrected one.
 */
function fitPanel() {
  let s = 20260920;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const lengths = [13, 14, 15, 17];
  const out = [];
  for (const week of FIT_WEEKS) {
    for (let i = 0; i < 80; i++) {
      const strength = rand();
      out.push({
        season: 2023, league_id: 100 + (i % 8), roster_id: i, week,
        num_teams: 12, playoff_teams: i % 2 ? 6 : 4,
        all_play_pct: 0.15 + 0.7 * strength + 0.1 * (rand() - 0.5),
        mean_points_z: (strength - 0.5) * 2,
        games: week,
        win_pct: 0.1 + 0.8 * strength,
        games_back: (1 - strength) * 3,
        weeks_left: lengths[i % lengths.length] - week,
        made_playoffs: strength + 0.15 * (rand() - 0.5) > 0.45 ? 1 : 0,
        champion: 0, outcome_known: true
      });
    }
  }
  return out;
}

/**
 * Mixed weekly results, not a blowout. A fixture where the same team wins by
 * twelve every week pins every probability against team-outlook's clamp, and at
 * the clamp no input changes the output — such a fixture measures the clamp, not
 * the model, and cannot show that the route carried real numbers through.
 */
const SCORES = [
  [120, 110, 100, 90],
  [90, 100, 110, 120],
  [115, 95, 105, 85]
];

/** One ESPN payload in the shape syncEspnLeague stores: three weeks played of fourteen. */
function espnPayload({ weeksPlayed = 3, playoffTeamCount = 2 } = {}) {
  const schedule = [];
  for (let w = 1; w <= REGULAR_PERIODS; w++) {
    const played = w <= weeksPlayed;
    const wk = SCORES[(w - 1) % SCORES.length];
    const pts = t => (played ? wk[t - 1] : 0);
    const pair = (a, b) => schedule.push({
      matchupPeriodId: w,
      winner: played ? (pts(a) >= pts(b) ? 'HOME' : 'AWAY') : 'UNDECIDED',
      home: { teamId: a, totalPoints: pts(a) }, away: { teamId: b, totalPoints: pts(b) }
    });
    pair(1, 2); pair(3, 4);
  }
  return JSON.stringify({
    teams: [1, 2, 3, 4].map(id => ({ id, name: `Team ${id}` })),
    schedule,
    settings: { scheduleSettings: { matchupPeriodCount: REGULAR_PERIODS, playoffTeamCount } }
  });
}

function league(name, payload) {
  run(`INSERT INTO leagues (platform, league_id, season, payload_season, name, payload, team_count)
       VALUES ('espn', ?, 2026, 2026, ?, ?, 4)`, `id-${name}`, name, payload);
  return row('SELECT last_insert_rowid() AS id').id;
}

const member = account('outlook-member', 'member-token');
const outsider = account('outlook-outsider', 'outsider-token');
const leagueId = league('Outlook League', espnPayload());
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'commissioner')`,
  leagueId, member);

const get = (url, token) => fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } });
const currentRow = () => row('SELECT * FROM leagues WHERE id = ?', leagueId);

/* ------------------------------------------------------ 1. the not-ready shape */

test('with no fit stored the route answers the reason, word for word, not an empty panel', async () => {
  const response = await get(`/leagues/${leagueId}/outlook`, 'member-token');
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ready, false);
  assert.equal(typeof body.reason, 'string');
  assert.ok(body.reason.length > 0, 'a not-ready answer with no reason is an empty panel with extra steps');
  assert.equal('teams' in body, false, 'ready:false must not carry a half-filled panel');
  assert.deepEqual(body, leagueOutlook(currentRow()));
});

/* ---------------------------------------------------------- 2. the ready shape */

test('with a fit stored the route answers the whole panel, unchanged', async () => {
  const panel = fitPanel();
  const fit = fitOutlook({ panel, k: K, weeks: FIT_WEEKS });
  saveOutlookFit({ fit, thresholds: fitThresholds({ fit, panel }), through_season: 2025 });

  const direct = leagueOutlook(currentRow());
  assert.equal(direct.ready, true, 'the fixture must reach ready:true, or this test asserts nothing');

  const body = await (await get(`/leagues/${leagueId}/outlook`, 'member-token')).json();
  assert.deepEqual(body, direct,
    'the route returns leagueOutlook unchanged; anything else is a second opinion on the page');

  assert.equal(body.teams.length, 4);
  for (const team of body.teams) {
    assert.ok(team.probability > 0 && team.probability < 1,
      'every team priced, and strictly inside the clamp so the fixture is measuring the model');
  }
  assert.equal(body.weeks_left, REGULAR_PERIODS - body.week,
    'weeks remaining comes from the payload, never from the rows a team happens to have');
});

/* --------------------------------------------------------- 3. who may ask */

test('an account that is not in the league is refused, and told nothing about it', async () => {
  const response = await get(`/leagues/${leagueId}/outlook`, 'outsider-token');
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal('teams' in body, false);
  assert.equal('reason' in body, false, 'a refusal must not leak the league\'s state either');
});

test('an unauthenticated caller is refused', async () => {
  assert.equal((await fetch(`${base}/leagues/${leagueId}/outlook`)).status, 401);
});

/* --------------------------------------------------- 4. the row that went away */

/**
 * My first version of this case expected 404 and got 403, and the code was
 * right. league_memberships.league_id is `REFERENCES leagues(id) ON DELETE
 * CASCADE` (migration 006) and the connection runs with `PRAGMA foreign_keys =
 * ON`, so deleting a league deletes the memberships with it and the caller is
 * no longer a member of anything. Access to a league really does die with the
 * league, which is the behaviour worth pinning here.
 *
 * That leaves the route's own 404 unreachable through any ordinary sequence:
 * the membership check can only pass while a foreign key guarantees the row
 * exists. It is kept because every other :id route in this file carries the
 * same line, and because the one gap it covers is real — a delete landing
 * between the membership check and the read. It is defensive, and stated as
 * defensive rather than quietly counted as covered.
 */
test('access to a league dies with the league: the membership cascades away, so it is 403', async () => {
  const ghost = league('Deleted League', espnPayload());
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'commissioner')`,
    ghost, member);
  assert.equal((await get(`/leagues/${ghost}/outlook`, 'member-token')).status, 200,
    'the member must be able to read it first, or the delete below proves nothing');

  run('DELETE FROM leagues WHERE id = ?', ghost);
  assert.equal(row('SELECT COUNT(*) AS n FROM league_memberships WHERE league_id = ?', ghost).n, 0,
    'the cascade is the mechanism; if it stops firing this test should say so');

  const response = await get(`/leagues/${ghost}/outlook`, 'member-token');
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'league membership required');
});
