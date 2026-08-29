/**
 * Live play-by-play from ESPN, and what the simulator does with it.
 *
 * ESPN's public summary endpoint carries the entire play log of a game — every
 * down, distance, yards to the end zone, yardage gained, clock, and turnover
 * flag — with no key, no quota and no cost. That is unusual enough to be worth
 * saying plainly: the most detailed data this project has access to is also the
 * only completely free source in it.
 *
 * It closes two gaps that mattered.
 *
 *   1. VALIDATION. Until now the play simulator could only be checked against
 *      season aggregates: does it score about 45 points a game, does its margin
 *      spread about 14. Those are weak tests — many wrong engines pass them.
 *      With real plays we can compare the engine's yardage distribution against
 *      the actual one, play type by play type, which is a test a plausible-but-
 *      wrong model fails. See `playDistributionAudit()`.
 *
 *   2. LIVE STATE. A pregame simulation starts from a kickoff. During a game
 *      the interesting question is different: given THIS score, THIS field
 *      position, THIS down and THIS much clock, what happens from here? The
 *      engine already simulates from arbitrary state, so feeding it the live
 *      state turns a pregame model into an in-game one for free.
 *
 * The polling discipline matters and is deliberate: ESPN is free but it is
 * someone else's server, so `pollLiveGames()` only touches games that are
 * actually in progress, and the ingest is idempotent on (event_id, play_id).
 */
import { rows, row, run } from '../db/index.js';
import { withRandomSeed } from './stats-util.js';
import { liveWinProbability } from './nfl-live.js';

const SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=';
const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

run(`CREATE TABLE IF NOT EXISTS nfl_play_by_play (
  event_id     TEXT NOT NULL,
  play_id      TEXT NOT NULL,
  season       INTEGER,
  week         INTEGER,
  sequence     INTEGER,
  period       INTEGER,
  clock_seconds INTEGER,
  offense      TEXT,
  defense      TEXT,
  down         INTEGER,
  distance     INTEGER,
  yards_to_endzone INTEGER,
  play_type    TEXT,
  yards_gained INTEGER,
  is_turnover  INTEGER,
  is_scoring   INTEGER,
  is_penalty   INTEGER,
  home_score   INTEGER,
  away_score   INTEGER,
  shotgun      INTEGER,
  no_huddle    INTEGER,
  pass_depth   TEXT,
  pass_direction TEXT,
  text         TEXT,
  fetched_at   TEXT,
  PRIMARY KEY (event_id, play_id)
)`);
run(`CREATE INDEX IF NOT EXISTS idx_pbp_season_week ON nfl_play_by_play(season, week)`);

// The formation columns were added after the table shipped, and CREATE TABLE IF
// NOT EXISTS silently does nothing on an existing table — so an install that
// ingested even one play before this change would keep a schema without them and
// fail every insert. Adding them idempotently is the fix; SQLite has no
// ADD COLUMN IF NOT EXISTS, so a duplicate-column error is the expected no-op.
for (const col of ['shotgun INTEGER', 'no_huddle INTEGER', 'pass_depth TEXT',
  'pass_direction TEXT']) {
  try { run(`ALTER TABLE nfl_play_by_play ADD COLUMN ${col}`); }
  catch { /* already present */ }
}

/* ------------------------------------------------------------- normalising */

/** ESPN clock strings are "12:34"; the engine wants seconds remaining in game. */
function clockSeconds(display, period) {
  if (!display || !period) return null;
  const [m, s] = String(display).split(':').map(Number);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
  const inQuarter = m * 60 + s;
  // Periods 1-4 are quarters; 5+ is overtime.
  if (period >= 5) return inQuarter;
  return (4 - period) * 900 + inQuarter;
}

/**
 * Classify a play into the engine's own vocabulary.
 *
 * ESPN's `type.text` is a long free-text taxonomy ("Pass Reception", "Rush",
 * "Sack", "Pass Incompletion", ...). The engine only distinguishes the handful
 * of outcomes it actually simulates, so anything it does not model — kickoffs,
 * extra points, timeouts, penalties — is mapped to null and excluded rather
 * than silently counted as a rush for zero yards.
 */
export function classifyPlay(typeText, text = '') {
  const t = String(typeText ?? '').toLowerCase();
  const body = String(text ?? '').toLowerCase();
  if (t.includes('kickoff') || t.includes('extra point') || t.includes('two-point')
    || t.includes('timeout') || t.includes('end ') || t.includes('coin toss')) return null;
  if (t.includes('punt')) return 'punt';
  if (t.includes('field goal')) return t.includes('missed') || t.includes('blocked') ? 'fg_miss' : 'fg_make';
  if (t.includes('sack')) return 'sack';
  if (t.includes('interception')) return 'interception';
  if (t.includes('fumble')) return 'fumble';
  if (t.includes('incompletion') || t.includes('incomplete')) return 'incompletion';
  if (t.includes('pass') || t.includes('reception')) return 'pass';
  if (t.includes('rush') || t.includes('run')) return 'rush';
  if (body.includes('kneel')) return 'kneel';
  return null;
}

/**
 * Pull formation and pass detail out of ESPN's play text.
 *
 * The text is not structured data, but it is written by a machine to a fixed
 * template — "(Shotgun) M.Penix pass short right to B.Robinson to ATL 46" —
 * which makes the leading parenthetical and the "pass <depth> <direction>"
 * clause reliable to parse. That is worth doing: shotgun rate, no-huddle rate
 * and deep-attempt rate are all real strategic signals the engine already
 * consumes, and parsing them here means they come from actual plays rather than
 * from somebody else's weekly summary.
 *
 * Anything not matched stays null. A wrong formation label would be worse than
 * no label, because the engine would treat it as measured.
 */
export function parseFormation(text) {
  const t = String(text ?? '');
  // The leading parenthetical can carry several tags at once — "(No Huddle,
  // Shotgun)" — so look inside the whole group rather than just after the paren.
  // Only plays that HAVE a parenthetical can be scored 0; a play without one
  // carries no formation information and must stay null rather than be recorded
  // as under centre.
  const lead = t.match(/^\s*\(([^)]*)\)/);
  const shotgun = lead ? (/shotgun/i.test(lead[1]) ? 1 : 0) : null;
  const noHuddle = /no.?huddle/i.test(t) ? 1 : 0;
  const m = t.match(/pass\s+(short|deep)\s+(left|middle|right)/i);
  return {
    shotgun,
    no_huddle: noHuddle,
    pass_depth: m ? m[1].toLowerCase() : null,
    pass_direction: m ? m[2].toLowerCase() : null
  };
}

/** Pull one game's play log and normalise it. Returns plays plus live state. */
export async function fetchGamePlays(eventId, { season = null, week = null } = {}) {
  const res = await fetch(`${SUMMARY}${encodeURIComponent(eventId)}`);
  if (!res.ok) return { error: `ESPN returned ${res.status} for event ${eventId}` };
  const j = await res.json();

  const comp = j.header?.competitions?.[0];
  const status = comp?.status?.type?.name ?? null;
  const teams = comp?.competitors ?? [];
  const homeTeam = teams.find(t => t.homeAway === 'home')?.team?.abbreviation ?? null;
  const awayTeam = teams.find(t => t.homeAway === 'away')?.team?.abbreviation ?? null;

  const driveList = [...(j.drives?.previous ?? []), ...(j.drives?.current ? [j.drives.current] : [])];
  const plays = [];
  for (const d of driveList) {
    const offense = d.team?.abbreviation ?? null;
    const defense = offense === homeTeam ? awayTeam : homeTeam;
    for (const p of d.plays ?? []) {
      const kind = classifyPlay(p.type?.text, p.text);
      const form = parseFormation(p.text);
      plays.push({
        ...form,
        play_id: String(p.id ?? `${eventId}-${p.sequenceNumber}`),
        sequence: Number(p.sequenceNumber) || null,
        period: p.period?.number ?? null,
        clock_seconds: clockSeconds(p.clock?.displayValue, p.period?.number),
        offense, defense,
        down: p.start?.down ?? null,
        distance: p.start?.distance ?? null,
        yards_to_endzone: p.start?.yardsToEndzone ?? null,
        play_type: kind,
        yards_gained: Number.isFinite(p.statYardage) ? p.statYardage : null,
        is_turnover: p.isTurnover ? 1 : 0,
        is_scoring: p.scoringPlay ? 1 : 0,
        is_penalty: p.isPenalty ? 1 : 0,
        home_score: p.homeScore ?? null,
        away_score: p.awayScore ?? null,
        text: p.text ?? null
      });
    }
  }

  // Live state, when the game is actually in progress.
  const cur = j.drives?.current;
  const lastPlay = cur?.plays?.[cur.plays.length - 1];
  const live = status === 'STATUS_IN_PROGRESS' || status === 'STATUS_HALFTIME'
    ? {
      possession: cur?.team?.abbreviation ?? null,
      down: lastPlay?.end?.down ?? null,
      distance: lastPlay?.end?.distance ?? null,
      yards_to_endzone: lastPlay?.end?.yardsToEndzone ?? null,
      period: lastPlay?.period?.number ?? comp?.status?.period ?? null,
      clock_seconds: clockSeconds(comp?.status?.displayClock, comp?.status?.period),
      home_score: Number(teams.find(t => t.homeAway === 'home')?.score) || 0,
      away_score: Number(teams.find(t => t.homeAway === 'away')?.score) || 0
    }
    : null;

  return { event_id: String(eventId), season, week, status, home: homeTeam, away: awayTeam,
    plays, live, drives: driveList.length };
}

/** Store a game's plays. Idempotent on (event_id, play_id) so re-polling is safe. */
export function storePlays(game) {
  if (game?.error || !game?.plays?.length) return { stored: 0 };
  const now = new Date().toISOString();
  let stored = 0;
  for (const p of game.plays) {
    run(`INSERT INTO nfl_play_by_play
         (event_id, play_id, season, week, sequence, period, clock_seconds, offense, defense,
          down, distance, yards_to_endzone, play_type, yards_gained, is_turnover, is_scoring,
          is_penalty, shotgun, no_huddle, pass_depth, pass_direction, home_score, away_score,
          text, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(event_id, play_id) DO UPDATE SET
           yards_gained = excluded.yards_gained, is_scoring = excluded.is_scoring,
           home_score = excluded.home_score, away_score = excluded.away_score,
           fetched_at = excluded.fetched_at`,
    game.event_id, p.play_id, game.season, game.week, p.sequence, p.period, p.clock_seconds,
    p.offense, p.defense, p.down, p.distance, p.yards_to_endzone, p.play_type, p.yards_gained,
    p.is_turnover, p.is_scoring, p.is_penalty, p.shotgun, p.no_huddle, p.pass_depth,
    p.pass_direction, p.home_score, p.away_score, p.text, now);
    stored++;
  }
  return { stored, event_id: game.event_id };
}

/* ---------------------------------------------------------------- polling */

/**
 * Poll every game currently in progress and store its plays.
 *
 * Only in-progress games are fetched. ESPN charges nothing, but hammering a
 * free public endpoint for games that finished on Sunday is both rude and
 * pointless — completed games are ingested once by `ingestCompleted()`.
 */
export async function pollLiveGames({ date = null } = {}) {
  const url = date ? `${SCOREBOARD}?dates=${date}` : SCOREBOARD;
  const res = await fetch(url);
  if (!res.ok) return { error: `ESPN scoreboard returned ${res.status}` };
  const j = await res.json();
  const events = j.events ?? [];
  const season = j.season?.year ?? null;
  const week = j.week?.number ?? null;

  const live = events.filter(e => {
    const s = e.status?.type?.name;
    return s === 'STATUS_IN_PROGRESS' || s === 'STATUS_HALFTIME' || s === 'STATUS_END_PERIOD';
  });

  const results = [];
  for (const e of live) {
    const g = await fetchGamePlays(e.id, { season, week });
    if (g.error) { results.push({ event_id: e.id, error: g.error }); continue; }
    const s = storePlays(g);
    results.push({ event_id: e.id, name: e.name, status: g.status, plays: s.stored, live: g.live });
  }
  return { polled_at: new Date().toISOString(), season, week,
    games_on_slate: events.length, games_live: live.length, results,
    note: live.length ? undefined : 'No games in progress; nothing fetched.' };
}

/** One-off ingest of completed games, for building the validation corpus. */
export async function ingestCompleted({ date = null, limit = 20 } = {}) {
  const url = date ? `${SCOREBOARD}?dates=${date}` : SCOREBOARD;
  const res = await fetch(url);
  if (!res.ok) return { error: `ESPN scoreboard returned ${res.status}` };
  const j = await res.json();
  const season = j.season?.year ?? null, week = j.week?.number ?? null;
  const done = (j.events ?? []).filter(e => e.status?.type?.name === 'STATUS_FINAL').slice(0, limit);

  let total = 0; const games = [];
  for (const e of done) {
    const g = await fetchGamePlays(e.id, { season, week });
    if (g.error) continue;
    const s = storePlays(g);
    total += s.stored;
    games.push({ event_id: e.id, name: e.name, plays: s.stored });
  }
  return { season, week, games: games.length, plays_stored: total, detail: games };
}

/* -------------------------------------------------------- live simulation */

/**
 * Finish a live game from its actual current state, thousands of times.
 *
 * This is what the play-by-play feed is really for. A pregame model has to
 * assume a kickoff; here the simulator is handed the score, the field position,
 * the down and the clock that actually exist right now, and plays out only what
 * remains. The output is a live win probability, live spread cover and live
 * total — all read off the same simulated finishes.
 */
export async function simulateLiveGame(eventId, { trials = 4000, spread = null, total = null } = {}) {
  const { simulateRemainder } = await import('./nfl-drive-sim.js');
  const g = await fetchGamePlays(eventId);
  if (g.error) return g;
  if (!g.live) {
    return { event_id: g.event_id, status: g.status, home: g.home, away: g.away,
      error: 'Game is not in progress — nothing left to simulate.' };
  }
  const out = simulateRemainder({
    home: g.home, away: g.away, trials, spread, total,
    state: {
      possession: g.live.possession === g.home ? 'home' : 'away',
      yard: g.live.yards_to_endzone == null ? 25 : 100 - g.live.yards_to_endzone,
      down: g.live.down ?? 1,
      toGo: g.live.distance ?? 10,
      secondsLeft: g.live.clock_seconds ?? 900,
      homeScore: g.live.home_score, awayScore: g.live.away_score
    }
  });
  return { event_id: g.event_id, status: g.status, live_state: g.live, ...out };
}

/* ----------------------------------------------------- validation against real plays */

/**
 * The strong test: does the engine's play distribution match the real one?
 *
 * Season aggregates are a weak check — plenty of wrong engines produce 45
 * points a game. This compares the actual distribution of yardage by play type
 * against what the simulator generates, including the tails, which is where a
 * plausible-looking model usually falls apart.
 *
 * Reports the comparison whether or not it flatters the engine.
 */
export async function playDistributionAudit({ season = null, sampleTrials = 20000 } = {}) {
  const where = season ? `WHERE season = ${Number(season)}` : '';
  const real = rows(`SELECT play_type, yards_gained FROM nfl_play_by_play
                     ${where} ${where ? 'AND' : 'WHERE'} play_type IN ('pass','rush','incompletion','sack')
                       AND yards_gained IS NOT NULL`);
  if (real.length < 200) {
    return { error: `only ${real.length} stored plays — run ingestCompleted() first to build the corpus`,
      hint: 'POST /api/nfl-betting/pbp/ingest' };
  }

  const { simulatePlaySample } = await import('./nfl-drive-sim.js');
  const sim = simulatePlaySample({ trials: sampleTrials });

  const summarise = (list, label) => {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { source: label, n: list.length, mean: r2(mean(list)),
      p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99),
      explosive_share: r4(list.filter(y => y >= 15).length / list.length),
      loss_share: r4(list.filter(y => y < 0).length / list.length) };
  };

  const byType = {};
  for (const type of ['pass', 'rush']) {
    const realY = real.filter(r => r.play_type === type).map(r => r.yards_gained);
    const simY = sim[type] ?? [];
    const R = summarise(realY, 'real'), S = summarise(simY, 'simulated');
    if (!R || !S) continue;
    byType[type] = {
      real: R, simulated: S,
      mean_gap: r2(S.mean - R.mean),
      p90_gap: S.p90 - R.p90,
      explosive_gap: r4(S.explosive_share - R.explosive_share),
      // A mean can match while the shape is completely wrong, which is exactly
      // the failure mode this audit exists to catch.
      shape_ok: Math.abs(S.p90 - R.p90) <= 4 && Math.abs(S.explosive_share - R.explosive_share) <= 0.05
    };
  }

  const realIncompletionRate = real.filter(r => r.play_type === 'incompletion').length
    / real.filter(r => ['pass', 'incompletion', 'sack'].includes(r.play_type)).length;

  return {
    real_plays: real.length, simulated_plays: sampleTrials, season: season ?? 'all stored',
    by_type: byType,
    real_incompletion_rate: r4(realIncompletionRate),
    passing: Object.values(byType).every(t => t.shape_ok),
    note: 'Compares the SHAPE of the yardage distribution, not just its mean. A simulator can match ' +
      'yards per play exactly and still be wrong everywhere that matters — this checks the 90th ' +
      'percentile and the explosive-play share, which is where scoring actually comes from.'
  };
}

/**
 * Backfill whole seasons of play-by-play.
 *
 * ESPN's scoreboard takes `dates=<year>&seasontype=<n>&week=<n>`, so a season
 * is 18 regular-season weeks plus five playoff rounds — about 285 games and
 * 51,000 plays. Five years is roughly a quarter of a million plays, which is
 * enough to fit the engine's distributions directly rather than inferring them
 * from weekly summaries.
 *
 * Throttled deliberately. This is a free public endpoint with no quota, which
 * is exactly why it deserves to be treated politely rather than hammered with
 * 1,400 parallel requests.
 */
export async function backfillSeasons({
  seasons = [2021, 2022, 2023, 2024, 2025], throttleMs = 120, onProgress = null
} = {}) {
  const started = Date.now();
  const summary = [];
  for (const season of seasons) {
    let seasonPlays = 0, seasonGames = 0, skipped = 0;
    // seasontype 2 = regular season (18 weeks), 3 = postseason (5 rounds).
    const schedule = [...Array(18).keys()].map(i => ({ seasontype: 2, week: i + 1 }))
      .concat([...Array(5).keys()].map(i => ({ seasontype: 3, week: i + 1 })));

    for (const { seasontype, week } of schedule) {
      let events = [];
      try {
        const res = await fetch(`${SCOREBOARD}?dates=${season}&seasontype=${seasontype}&week=${week}`);
        if (!res.ok) continue;
        const j = await res.json();
        events = (j.events ?? []).filter(e => e.status?.type?.name === 'STATUS_FINAL');
      } catch { continue; }

      for (const e of events) {
        // Idempotent: a game already stored is skipped without a network call,
        // so re-running the backfill costs almost nothing and resumes cleanly
        // after an interruption.
        const have = row(`SELECT COUNT(*) AS n FROM nfl_play_by_play WHERE event_id = ?`, String(e.id))?.n ?? 0;
        if (have > 20) { skipped++; continue; }
        try {
          const g = await fetchGamePlays(e.id, { season, week });
          if (g.error) continue;
          seasonPlays += storePlays(g).stored;
          seasonGames++;
        } catch { /* one bad game must not end a five-year backfill */ }
        if (throttleMs) await new Promise(r => setTimeout(r, throttleMs));
      }
      if (onProgress) onProgress({ season, seasontype, week, seasonGames, seasonPlays });
    }
    summary.push({ season, games: seasonGames, plays: seasonPlays, already_had: skipped });
  }
  return { seasons: summary,
    total_plays: summary.reduce((a, b) => a + b.plays, 0),
    total_games: summary.reduce((a, b) => a + b.games, 0),
    elapsed_seconds: Math.round((Date.now() - started) / 1000),
    corpus: pbpStatus() };
}

/**
 * What the play corpus says about formations.
 *
 * Parsed from real play text rather than taken from a weekly summary, so these
 * are first-hand measurements — and they are directly comparable to the rates
 * the simulator consumes, which is the point.
 */
export function formationReport({ season = null } = {}) {
  const w = season ? `WHERE season = ${Number(season)}` : '';
  const total = row(`SELECT COUNT(*) AS n FROM nfl_play_by_play ${w}
                     ${w ? 'AND' : 'WHERE'} shotgun IS NOT NULL
                       AND play_type IN ('pass','rush','incompletion','sack')`)?.n ?? 0;
  if (!total) return { available: false, note: 'No formation-tagged plays ingested yet.' };

  const shotgun = rows(`SELECT shotgun, play_type, AVG(yards_gained) AS ypp, COUNT(*) AS n
                        FROM nfl_play_by_play ${w} ${w ? 'AND' : 'WHERE'} shotgun IS NOT NULL
                          AND play_type IN ('pass','rush') AND yards_gained IS NOT NULL
                        GROUP BY shotgun, play_type`);
  const depth = rows(`SELECT pass_depth, COUNT(*) AS n, AVG(yards_gained) AS ypp
                      FROM nfl_play_by_play ${w} ${w ? 'AND' : 'WHERE'} pass_depth IS NOT NULL
                      GROUP BY pass_depth`);
  const byTeam = rows(`SELECT offense AS team, COUNT(*) AS plays,
                              AVG(CAST(shotgun AS REAL)) AS shotgun_rate,
                              AVG(CAST(no_huddle AS REAL)) AS no_huddle_rate
                       FROM nfl_play_by_play ${w} ${w ? 'AND' : 'WHERE'} shotgun IS NOT NULL
                         AND play_type IN ('pass','rush','incompletion','sack')
                       GROUP BY offense HAVING plays > 100 ORDER BY shotgun_rate DESC`);

  return {
    available: true, season: season ?? 'all stored', formation_tagged_plays: total,
    // Scrimmage plays only. Punt and field-goal formations also carry a leading
    // parenthetical and score as not-shotgun, which drags a naive average down
    // to about 20% against a real rate near 60%.
    shotgun_rate: r4((row(`SELECT AVG(CAST(shotgun AS REAL)) AS r FROM nfl_play_by_play ${w}
                           ${w ? 'AND' : 'WHERE'} shotgun IS NOT NULL
                             AND play_type IN ('pass','rush','incompletion','sack')`)?.r) ?? null),
    by_formation: shotgun.map(x => ({ formation: x.shotgun ? 'shotgun' : 'under center',
      play_type: x.play_type, plays: x.n, yards_per_play: r2(x.ypp) })),
    by_pass_depth: depth.map(x => ({ depth: x.pass_depth, attempts: x.n, yards_per_completion: r2(x.ypp) })),
    most_shotgun: byTeam.slice(0, 5).map(t => ({ team: t.team, shotgun_rate: r4(t.shotgun_rate),
      no_huddle_rate: r4(t.no_huddle_rate) })),
    least_shotgun: byTeam.slice(-5).reverse().map(t => ({ team: t.team, shotgun_rate: r4(t.shotgun_rate),
      no_huddle_rate: r4(t.no_huddle_rate) })),
    note: 'Parsed from ESPN play text. Shotgun-vs-under-centre yards per play is a real efficiency ' +
      'split the engine does not yet condition on — it is measured here first so that adding it can ' +
      'be justified by data rather than assumed.'
  };
}

/** What is in the play corpus so far. */
export function pbpStatus() {
  const total = row(`SELECT COUNT(*) AS n FROM nfl_play_by_play`)?.n ?? 0;
  const games = row(`SELECT COUNT(DISTINCT event_id) AS n FROM nfl_play_by_play`)?.n ?? 0;
  const bySeason = rows(`SELECT season, COUNT(DISTINCT event_id) AS games, COUNT(*) AS plays
                         FROM nfl_play_by_play GROUP BY season ORDER BY season DESC`);
  const byType = rows(`SELECT play_type, COUNT(*) AS n FROM nfl_play_by_play
                       WHERE play_type IS NOT NULL GROUP BY play_type ORDER BY n DESC`);
  const last = row(`SELECT MAX(fetched_at) AS t FROM nfl_play_by_play`)?.t ?? null;
  return { plays: total, games, last_fetched: last, by_season: bySeason, by_type: byType,
    source: 'ESPN public summary endpoint — free, keyless, unmetered.',
    ready_for_audit: total >= 200 };
}

/**
 * Does the live win-probability model actually work?
 *
 * The in-game simulator has never been validated. It was built, wired to a
 * route, and trusted — which is the exact pattern that produced twenty-two
 * failed forecasting models here, and it is worse for a live model because
 * in-game prices move fast enough to lose money quickly.
 *
 * The play corpus makes a real test possible without waiting for a live game.
 * Every completed game in it is a sequence of states with a known outcome, so
 * the model can be asked "who wins from here?" at hundreds of points across
 * hundreds of games and graded against what actually happened.
 *
 * The right grading is CALIBRATION, not accuracy. A live model that says 90% at
 * some state should be right about 90% of the time — not more, not less. Being
 * right 97% of the time when you claimed 90% is not a better model, it is a
 * model that will size bets wrongly in the other direction. Buckets are
 * reported so over- and under-confidence are visible separately, along with a
 * Brier score and the base-rate baseline it has to beat.
 */
export function liveModelValidation({ season = null, maxGames = 120, sampleEvery = 12 } = {}) {
  const where = season ? `WHERE season = ${Number(season)}` : '';
  const events = rows(`SELECT DISTINCT event_id FROM nfl_play_by_play ${where} LIMIT ?`, maxGames)
    .map(r => r.event_id);
  if (!events.length) return { error: 'no play-by-play stored', hint: 'run the backfill first' };

  const samples = [];
  for (const eventId of events) {
    const plays = rows(
      `SELECT period, clock_seconds, home_score, away_score, offense, defense
       FROM nfl_play_by_play
       WHERE event_id = ? AND clock_seconds IS NOT NULL
         AND home_score IS NOT NULL AND away_score IS NOT NULL
       ORDER BY sequence`, eventId);
    if (plays.length < 40) continue;

    // The final score is the last play's, which is the outcome every earlier
    // state is graded against.
    const last = plays[plays.length - 1];
    const homeWon = last.home_score > last.away_score ? 1 : last.home_score < last.away_score ? 0 : null;
    if (homeWon == null) continue;   // ties carry no signal for a binary model

    for (let i = 0; i < plays.length; i += sampleEvery) {
      const p = plays[i];
      const lead = p.home_score - p.away_score;
      const left = p.clock_seconds;
      if (!Number.isFinite(left) || left <= 0) continue;
      samples.push({ lead, seconds_left: left, home_won: homeWon,
        predicted: liveWinProbability(lead, left, null) });
    }
  }
  if (samples.length < 100) return { error: `only ${samples.length} usable states` };

  // Calibration buckets: what we claimed against what happened.
  const buckets = Array.from({ length: 10 }, (_, i) => {
    const lo = i / 10, hi = (i + 1) / 10;
    const list = samples.filter(s => s.predicted >= lo && s.predicted < (i === 9 ? 1.01 : hi));
    const claimed = list.length ? mean(list.map(s => s.predicted)) : null;
    const actual = list.length ? mean(list.map(s => s.home_won)) : null;
    return { range: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`, n: list.length,
      claimed: r4(claimed), actual: r4(actual),
      gap: claimed == null || actual == null ? null : r4(actual - claimed) };
  });

  const brier = mean(samples.map(s => (s.predicted - s.home_won) ** 2));
  const baseRate = mean(samples.map(s => s.home_won));
  // The score a model gets by ignoring the game state entirely and always
  // predicting the base rate. Beating it is the minimum bar.
  const baselineBrier = mean(samples.map(s => (baseRate - s.home_won) ** 2));
  const ece = mean(buckets.filter(b => b.n).map(b => Math.abs(b.gap ?? 0) * b.n)) / (samples.length / 10);
  const weightedEce = buckets.filter(b => b.n)
    .reduce((acc, b) => acc + b.n * Math.abs(b.gap ?? 0), 0) / samples.length;

  return {
    season: season ?? 'all stored', games_used: events.length, states_graded: samples.length,
    brier_score: r4(brier),
    baseline_brier_always_base_rate: r4(baselineBrier),
    beats_baseline: brier < baselineBrier,
    skill_score: r4(1 - brier / baselineBrier),
    base_rate_home_wins: r4(baseRate),
    expected_calibration_error: r4(weightedEce),
    calibration: buckets,
    well_calibrated: weightedEce < 0.05,
    verdict: brier >= baselineBrier
      ? 'The live model is no better than ignoring the game entirely and always predicting the base ' +
        'rate. It should not be used.'
      : weightedEce < 0.05
        ? `Calibrated and skilful: Brier ${r4(brier)} against a ${r4(baselineBrier)} baseline, ` +
          `calibration error ${r4(weightedEce)}. Stated probabilities match observed frequencies.`
        : `Skilful but miscalibrated: it beats the baseline, but stated probabilities are off by ` +
          `${r4(weightedEce)} on average. Usable for ranking states, not for sizing bets.`,
    note: 'Graded on calibration rather than accuracy. A model claiming 90% should be right 90% of ' +
      'the time — being right 97% is not better, it is wrong in the other direction and will size ' +
      'bets incorrectly. States are sampled from real completed games, so the outcome is known.'
  };
}
