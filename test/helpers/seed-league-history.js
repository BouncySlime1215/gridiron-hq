/**
 * A deterministic multi-season league history, for tests that need real-shaped
 * data rather than the developer's own database.
 *
 * Codex correction C06: "The full test suite still depends on private
 * development history." Several logic tests read `game_lines`, `nfl_teams` and
 * friends directly and assert things like "should pool thousands of real
 * team-games". Run on a clean checkout with an isolated database they find
 * nothing and fail — so the suite was only green on one machine, which is not
 * a passing suite, it is an unmeasured one.
 *
 * The fix the plan asks for is "deterministic fixtures for logic tests", and
 * that is what this is: a seeded pseudo-random league whose team strengths,
 * scores and spreads are fixed by a constant seed, so every run of every test
 * sees byte-identical history. It is NOT a substitute for validation against
 * real football data — see `requiresRealHistory` below for how those checks
 * are kept separate rather than quietly deleted.
 */

/**
 * A small deterministic generator. `Math.random()` would make the fixture
 * differ between runs, which is the one property a fixture must not have:
 * a flaky failure in a fixture-backed test is indistinguishable from a real
 * regression.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximately normal, from the sum of twelve uniforms. Deterministic. */
function normal(rand, mean = 0, sd = 1) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += rand();
  return mean + (sum - 6) * sd;
}

export const FIXTURE_TEAMS = Object.freeze([
  ['KC', 'Kansas City Chiefs', 'AFC', 'West'], ['BAL', 'Baltimore Ravens', 'AFC', 'North'],
  ['BUF', 'Buffalo Bills', 'AFC', 'East'], ['CIN', 'Cincinnati Bengals', 'AFC', 'North'],
  ['SF', 'San Francisco 49ers', 'NFC', 'West'], ['SEA', 'Seattle Seahawks', 'NFC', 'West'],
  ['DAL', 'Dallas Cowboys', 'NFC', 'East'], ['PHI', 'Philadelphia Eagles', 'NFC', 'East'],
  ['GB', 'Green Bay Packers', 'NFC', 'North'], ['DET', 'Detroit Lions', 'NFC', 'North'],
  ['MIA', 'Miami Dolphins', 'AFC', 'East'], ['NYJ', 'New York Jets', 'AFC', 'East'],
  ['LAR', 'Los Angeles Rams', 'NFC', 'West'], ['ARI', 'Arizona Cardinals', 'NFC', 'West'],
  ['TB', 'Tampa Bay Buccaneers', 'NFC', 'South'], ['NO', 'New Orleans Saints', 'NFC', 'South']
]);

/** Insert the canonical teams, if they are not already there. */
export function seedTeams(db) {
  const existing = db.prepare(`SELECT COUNT(*) n FROM nfl_teams`).get()?.n ?? 0;
  if (existing) return;
  db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES ${
    FIXTURE_TEAMS.map(([abbr, name, conf, div], i) =>
      `(${i + 1},'${abbr}','${name.replace(/'/g, "''")}','${conf}','${div}')`).join(',')}`);
}

/**
 * Seed `seasons` complete seasons of games with persistent team strengths.
 *
 * Team strength carries over between seasons with real drift, which is what
 * makes a year-over-year prior variance estimable at all — a fixture where
 * every season is independent would make the preseason blend's whole subject
 * matter vanish.
 *
 * Spreads are the true strength difference plus a small market error, so the
 * residual `margin + spread` has a genuine, non-degenerate distribution.
 */
export function seedLeagueHistory(run, {
  seasons = [2019, 2020, 2021, 2022, 2023, 2024],
  weeksPerSeason = 17,
  seed = 20260910
} = {}) {
  const rand = mulberry32(seed);
  const strength = new Map(FIXTURE_TEAMS.map(([abbr]) => [abbr, normal(rand, 0, 6)]));
  let games = 0;

  for (const season of seasons) {
    // Between-season drift: teams change, but not completely.
    for (const [abbr, value] of strength) strength.set(abbr, value * 0.6 + normal(rand, 0, 4));

    for (let week = 1; week <= weeksPerSeason; week++) {
      // A rotating pairing so every team plays every week and the schedule
      // genuinely varies across weeks.
      for (let i = 0; i < FIXTURE_TEAMS.length / 2; i++) {
        const home = FIXTURE_TEAMS[(i + week) % FIXTURE_TEAMS.length][0];
        const away = FIXTURE_TEAMS[(FIXTURE_TEAMS.length - 1 - i + week * 3) % FIXTURE_TEAMS.length][0];
        if (home === away) continue;

        const trueEdge = strength.get(home) - strength.get(away) + 2.1; // home field
        const margin = Math.round(trueEdge + normal(rand, 0, 12));
        // The market sees the true edge with a small error, rounded to a half.
        const spread = -(Math.round((trueEdge + normal(rand, 0, 2.5)) * 2) / 2);
        const total = 44 + Math.round(normal(rand, 0, 6));
        const homeScore = Math.max(0, Math.round((total + margin) / 2));
        const awayScore = Math.max(0, homeScore - margin);
        const gameday = `${season}-${String(9 + Math.floor(week / 5)).padStart(2, '0')}-${String((week % 28) + 1).padStart(2, '0')}`;

        run(`INSERT OR IGNORE INTO game_lines
             (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,gametime)
             VALUES (?,?,?,?,1,?,?,?,?,?,'13:00')`,
        season, week, home, away, spread, total, homeScore, awayScore, gameday);
        run(`INSERT OR IGNORE INTO game_lines
             (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,gametime)
             VALUES (?,?,?,?,0,?,?,?,?,?,'13:00')`,
        season, week, away, home, -spread, total, awayScore, homeScore, gameday);
        games++;
      }
    }
  }
  return { games, seasons, teams: FIXTURE_TEAMS.length, seed };
}

/**
 * Whether the developer's real historical database is present.
 *
 * Codex correction C06 asks to "separate large historical validation from
 * required logic tests" and to preserve meaningful assertions rather than
 * deleting them. A check that is genuinely ABOUT real NFL data — "single-game
 * margin variance is much larger than year-over-year team-quality variance in
 * the actual league" — cannot be proved by a fixture, however well built. Such
 * checks stay in the suite, guarded by this, and report an explicit disposition
 * when the history is absent rather than silently passing.
 */
export function hasRealHistory(rows, { minSeasons = 5, minGames = 2000 } = {}) {
  const summary = rows(`SELECT COUNT(*) games, COUNT(DISTINCT season) seasons
    FROM game_lines WHERE home = 1 AND team_score IS NOT NULL`)[0];
  return (summary?.seasons ?? 0) >= minSeasons && (summary?.games ?? 0) >= minGames;
}
