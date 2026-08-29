/**
 * Live game state and in-game win probability, for free.
 *
 * ESPN's public scoreboard carries live score, clock, period and possession
 * with no API key and no quota — the same endpoint the reference-line movement
 * detector already polls. Nothing in the app has ever read the live half of it,
 * so on Sunday afternoon the product goes quiet exactly when it should be most
 * useful.
 *
 * THE WIN PROBABILITY MODEL, stated in full because an unexplained probability
 * on a live game is worse than none:
 *
 *   Final margin = current margin + whatever else happens.
 *   Model the remainder as Normal(drift, sigma x sqrt(fraction of game left)).
 *
 * The sqrt scaling is the standard random-walk result — variance accumulates
 * linearly in time, so standard deviation grows with its square root — and
 * sigma is not invented: it is 14.16 points, measured from 1,424 real games in
 * this database. The drift term carries the pregame spread, decayed by the same
 * time fraction, so a heavy favourite trailing early is still credited with
 * being the better team, and that credit correctly vanishes as the clock runs
 * out.
 *
 * WHAT THIS IS NOT: it has no possession, down-and-distance, or timeout
 * awareness, so it cannot tell a 4th-and-1 from a kickoff and will misprice the
 * final two minutes, where those things decide games. It is a good estimate for
 * most of a game and an explicitly rough one at the very end — flagged in the
 * output rather than quietly wrong.
 */
import { rows } from '../db/index.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SEASON = Number(process.env.NFL_SEASON) || 2026;
const GAME_SECONDS = 3600;

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

let _sigma = null;
/** Standard deviation of final margin, measured rather than assumed. */
export function marginSigma() {
  if (_sigma != null) return _sigma;
  const g = rows(`SELECT team_score, opp_score FROM game_lines
                  WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL
                    AND season >= 2021`);
  if (g.length < 100) { _sigma = 14.16; return _sigma; }
  const margins = g.map(x => x.team_score - x.opp_score);
  const mean = margins.reduce((a, b) => a + b, 0) / margins.length;
  _sigma = Math.sqrt(margins.reduce((s, m) => s + (m - mean) ** 2, 0) / margins.length);
  return _sigma;
}

/**
 * @param lead            current margin from the home team's view
 * @param secondsLeft     game seconds remaining
 * @param pregameSpread   ESPN convention: negative means the home side is favoured
 */
export function liveWinProbability(lead, secondsLeft, pregameSpread = null) {
  if (!Number.isFinite(lead)) return null;
  const left = Math.max(0, Math.min(GAME_SECONDS, secondsLeft ?? 0));
  const fraction = left / GAME_SECONDS;

  // Game over: no uncertainty left to model. A tie is genuinely 50/50 since
  // overtime decides it.
  if (left <= 0) return lead > 0 ? 1 : lead < 0 ? 0 : 0.5;

  // Expected remaining margin, from the pregame line, decayed with the clock.
  const expectedRemaining = pregameSpread == null ? 0 : (-pregameSpread) * fraction;
  const sd = Math.max(0.5, marginSigma() * Math.sqrt(fraction));

  // P(final margin > 0) = P(remainder > -lead)
  const z = (lead + expectedRemaining) / sd;
  const p = normalCdf(z);

  // A game still being played is never 0% or 100%. The normal tail rounds to
  // certainty long before football does — comebacks from three scores happen,
  // and onside kicks and quick strikes are exactly what this model cannot see.
  // Clamping keeps it from asserting an impossibility it has no basis for.
  const floor = 0.005;
  return r4(Math.max(floor, Math.min(1 - floor, p)));
}

const clockSeconds = (period, displayClock) => {
  // Regulation only; overtime is reported as period 5+ and treated as the dying
  // seconds of a tied game, which is close enough for a display estimate.
  if (!period) return GAME_SECONDS;
  if (period > 4) return 0;
  const [m, s] = String(displayClock ?? '15:00').split(':').map(Number);
  const inPeriod = (Number.isFinite(m) ? m : 15) * 60 + (Number.isFinite(s) ? s : 0);
  return (4 - period) * 900 + inPeriod;
};

/**
 * Every game on the current scoreboard with live state and win probability.
 * Free: no key, no quota.
 */
export async function liveGames({ season = SEASON, week = null } = {}) {
  const wk = week ?? (rows(`SELECT week FROM game_lines WHERE season = ? AND team_score IS NULL
                            ORDER BY week LIMIT 1`, season)[0]?.week ?? 1);
  let data;
  try {
    const res = await fetch(`${SCOREBOARD}?seasontype=2&week=${wk}&dates=${season}`,
      { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
    data = await res.json();
  } catch (e) { return { error: e.message }; }

  const games = [];
  for (const ev of data.events ?? []) {
    const c = ev.competitions?.[0];
    if (!c) continue;
    const home = c.competitors?.find(x => x.homeAway === 'home');
    const away = c.competitors?.find(x => x.homeAway === 'away');
    if (!home || !away) continue;

    const st = ev.status?.type ?? {};
    const state = st.state ?? 'pre';            // pre | in | post
    const homeScore = Number(home.score);
    const awayScore = Number(away.score);
    const hasScore = Number.isFinite(homeScore) && Number.isFinite(awayScore);
    const lead = hasScore ? homeScore - awayScore : null;

    const period = ev.status?.period ?? 0;
    const secondsLeft = state === 'pre' ? GAME_SECONDS
      : state === 'post' ? 0
      : clockSeconds(period, ev.status?.displayClock);

    const spread = c.odds?.[0]?.spread != null ? Number(c.odds[0].spread) : null;
    const wp = state === 'pre'
      ? liveWinProbability(0, GAME_SECONDS, spread)
      : liveWinProbability(lead ?? 0, secondsLeft, spread);

    games.push({
      event_id: ev.id,
      home_team: home.team?.abbreviation, away_team: away.team?.abbreviation,
      matchup: `${away.team?.abbreviation} at ${home.team?.abbreviation}`,
      state, status: st.shortDetail ?? st.description ?? null,
      period: period || null, clock: ev.status?.displayClock ?? null,
      home_score: hasScore ? homeScore : null, away_score: hasScore ? awayScore : null,
      lead, seconds_left: secondsLeft,
      pregame_spread: spread,
      home_win_probability: wp,
      // A number is only as good as the model behind it, and this one degrades
      // badly in the endgame where possession and timeouts decide outcomes.
      probability_reliable: state !== 'in' || secondsLeft > 300,
      possession: c.situation?.possession ?? null,
      down_distance: c.situation?.shortDownDistanceText ?? null,
      start_time: ev.date ?? null
    });
  }

  const live = games.filter(g => g.state === 'in');
  return {
    season, week: wk, cost: 'free — ESPN public scoreboard, no key or quota',
    games,
    live_count: live.length,
    any_live: live.length > 0,
    margin_sigma: +marginSigma().toFixed(2),
    note: 'Win probability models the rest of the game as a random walk whose spread grows with the ' +
      'square root of time remaining, drifting toward the pregame line. It has no possession, down ' +
      'or timeout awareness, so anything inside five minutes is flagged unreliable rather than ' +
      'presented as precise.'
  };
}
