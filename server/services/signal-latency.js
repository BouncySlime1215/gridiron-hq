/**
 * Do we learn things before the market does?
 *
 * This is the only question left that matters, and it took a long time to get
 * here. Five seasons and twenty-two models say the closing line cannot be
 * out-forecast with public data: the play simulator lands 48.55% against the
 * spread, the ensemble is 0.44 points worse on margin, and the blend sweep in
 * nfl-cover-calibration.js shows every unit of weight on our model strictly
 * degrading the forecast. Modelling harder is a settled dead end.
 *
 * What is NOT settled is latency. A closing line is efficient because it has
 * absorbed all available information; an OPENING line has not, and neither has
 * a line ten minutes after a beat reporter tweets that a starting left tackle
 * is out. Edge in that world is not "we predict better", it is "we knew at
 * 14:02 and the number did not move until 14:40".
 *
 * That reframe changes what needs measuring. Instead of grading picks against
 * outcomes — which needs a season and thousands of bets to say anything — this
 * grades SIGNALS against subsequent line movement, which is observable within
 * hours and needs no bet to be placed. If our signals systematically precede
 * moves in the direction they imply, there is a real edge and its size can be
 * priced. If they follow moves, we are downstream of the market and no amount
 * of modelling will help.
 *
 * Deliberately built on the FREE ESPN reference line rather than the metered
 * odds feed. Measuring latency is exactly the kind of thing that should not
 * require spending credits, and the account has one left.
 */
import { rows, row } from '../db/index.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Map a team name or abbreviation to the abbreviation used in the move log. */
function teamKey(name) {
  if (!name) return null;
  const s = String(name).trim().toUpperCase();
  if (s.length <= 4) return s;
  // ESPN move rows store abbreviations; news signals store them too, but the
  // odds feed stores full names. Take the last word as a weak fallback and let
  // the caller decide whether a weak match is good enough.
  return s.split(/\s+/).pop();
}

/**
 * For one signal, find the next reference-line move on that team's game.
 *
 * "Next" is strictly after the signal was published — a move that happened
 * before we knew is not evidence that we knew first, and conflating the two is
 * the easiest way to manufacture a fake edge here.
 */
function nextMoveAfter(team, publishedAt, { windowHours = 48 } = {}) {
  if (!team || !publishedAt) return null;
  const t = teamKey(team);
  const until = new Date(new Date(publishedAt).getTime() + windowHours * 3600000).toISOString();
  return row(
    `SELECT observed_at, home_team, away_team, home_spread, prev_home_spread,
            spread_delta, total, prev_total, total_delta
     FROM espn_line_moves
     WHERE (home_team = ? OR away_team = ?)
       AND observed_at > ? AND observed_at <= ?
     ORDER BY observed_at ASC LIMIT 1`, t, t, publishedAt, until);
}

/** Was there already a move in the hours BEFORE the signal? */
function priorMoveBefore(team, publishedAt, { windowHours = 12 } = {}) {
  if (!team || !publishedAt) return null;
  const t = teamKey(team);
  const since = new Date(new Date(publishedAt).getTime() - windowHours * 3600000).toISOString();
  return row(
    `SELECT observed_at, spread_delta FROM espn_line_moves
     WHERE (home_team = ? OR away_team = ?)
       AND observed_at >= ? AND observed_at < ?
     ORDER BY observed_at DESC LIMIT 1`, t, t, since, publishedAt);
}

/**
 * Which way should the line move if a signal is true?
 *
 * A player becoming unavailable should move the number AGAINST his team; a
 * player returning should move it toward them. `role_delta` and
 * `unavailable_probability` carry the direction and the magnitude the signal
 * itself claimed, so the test is not merely "did the line move" but "did it
 * move the way we said".
 */
function impliedDirection(signal) {
  const unavail = signal.unavailable_probability;
  const role = signal.role_delta;
  if (Number.isFinite(unavail) && unavail >= 0.5) return -1;   // team gets worse
  if (Number.isFinite(unavail) && unavail <= 0.15) return +1;  // available / returning
  if (Number.isFinite(role) && Math.abs(role) > 0.05) return role > 0 ? +1 : -1;
  return 0;                                                    // no directional claim
}

/**
 * The headline measurement: do our signals lead the reference line?
 *
 * Returns per-signal detail plus the aggregate, and is explicit about sample
 * size because at the time of writing there is almost none. The movement log
 * only began accumulating properly once the scheduler was fixed — before that
 * the free line watch had run three times in the life of the database — so this
 * is infrastructure that will become informative, not a finished result.
 */
export function signalLeadTimes({ windowHours = 48, sinceDays = 60 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const signals = rows(
    `SELECT news_id, player_name, team, signal_type, status, unavailable_probability,
            role_delta, confidence, published_at, source
     FROM nfl_news_signals
     WHERE published_at >= ? ORDER BY published_at DESC`, since);

  const moveCount = row(`SELECT COUNT(*) AS n FROM espn_line_moves`)?.n ?? 0;

  const detail = [];
  for (const s of signals) {
    const dir = impliedDirection(s);
    const next = nextMoveAfter(s.team, s.published_at, { windowHours });
    const prior = priorMoveBefore(s.team, s.published_at);
    if (!next) {
      detail.push({ player: s.player_name, team: s.team, signal: s.signal_type,
        published_at: s.published_at, implied_direction: dir,
        outcome: 'no line move observed in window' });
      continue;
    }
    const lagHours = (new Date(next.observed_at) - new Date(s.published_at)) / 3600000;
    // A move on the team's own spread: positive delta means the number moved
    // toward the home team. Normalise so "toward this team" is always positive.
    const isHome = teamKey(s.team) === next.home_team;
    const towardTeam = isHome ? (next.spread_delta ?? 0) * -1 : (next.spread_delta ?? 0);
    const agreed = dir === 0 ? null : (Math.sign(towardTeam) === Math.sign(dir) && towardTeam !== 0);
    detail.push({
      player: s.player_name, team: s.team, signal: s.signal_type, status: s.status,
      published_at: s.published_at, moved_at: next.observed_at,
      lead_hours: r2(lagHours),
      implied_direction: dir, line_moved_toward_team: r2(towardTeam),
      agreed_with_signal: agreed,
      // A move in the twelve hours BEFORE the signal means the market was
      // already repricing and we are describing it, not anticipating it.
      market_already_moving: Boolean(prior && Math.abs(prior.spread_delta ?? 0) > 0)
    });
  }

  const withMove = detail.filter(d => d.lead_hours != null);
  const directional = withMove.filter(d => d.agreed_with_signal != null);
  const agreed = directional.filter(d => d.agreed_with_signal);
  const leading = withMove.filter(d => !d.market_already_moving);

  return {
    window_hours: windowHours, since_days: sinceDays,
    signals_examined: signals.length,
    line_moves_in_log: moveCount,
    signals_followed_by_a_move: withMove.length,
    median_lead_hours: withMove.length
      ? r2([...withMove.map(d => d.lead_hours)].sort((a, b) => a - b)[Math.floor(withMove.length / 2)])
      : null,
    mean_lead_hours: r2(mean(withMove.map(d => d.lead_hours))),
    directional_signals: directional.length,
    agreed_with_signal: agreed.length,
    agreement_rate: directional.length ? r4(agreed.length / directional.length) : null,
    signals_ahead_of_market: leading.length,
    detail: detail.slice(0, 40),
    sufficient_evidence: directional.length >= 30,
    verdict: directional.length < 30
      ? `Not enough yet — ${directional.length} directional signals matched to a line move, against ` +
        `${moveCount} moves in the log. This is infrastructure, not a result. The movement log only ` +
        `began filling properly once the scheduler was fixed; before that the free line watch had run ` +
        `three times in the life of the database.`
      : agreed.length / directional.length > 0.6
        ? `Signals lead the reference line ${(agreed.length / directional.length * 100).toFixed(1)}% ` +
          `of the time, median ${r2(mean(withMove.map(d => d.lead_hours)))}h ahead. That is a real ` +
          `latency edge and worth pricing.`
        : `Signals agree with subsequent movement only ` +
          `${(agreed.length / directional.length * 100).toFixed(1)}% of the time — no better than ` +
          `chance. We are downstream of the market, and modelling will not fix that.`,
    note: 'Measured against the FREE ESPN reference line, not the metered odds feed. Latency is ' +
      'exactly the thing that should not cost credits to measure. A signal only counts as leading ' +
      'when no move occurred in the twelve hours before it — otherwise we are describing a reprice ' +
      'already underway rather than anticipating one.'
  };
}

/**
 * The same latency question, separated by sportsbook once triggered multi-book
 * snapshots exist. A book only gets an observation when we preserved a quote
 * immediately before the signal and its first different quote afterward.
 */
export function bookLagDistribution({ sinceDays = 60, windowHours = 48 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const signals = rows(`SELECT news_id,team,published_at FROM nfl_news_signals
    WHERE published_at>=? AND team IS NOT NULL ORDER BY published_at`, since);
  const names = new Map(rows('SELECT abbr,name FROM nfl_teams').map(team => [team.abbr, team.name]));
  const snapshots = rows(`SELECT captured_at,event_id,home_team,away_team,book,side,line
    FROM nfl_line_snapshots WHERE market='spreads' AND captured_at>=datetime(?,'-24 hours')
    ORDER BY captured_at`, since);
  const observations = [];
  for (const signal of signals) {
    const teamName = names.get(signal.team) ?? signal.team;
    const cutoff = new Date(new Date(signal.published_at).getTime() + windowHours * 3600000).toISOString();
    const relevant = snapshots.filter(s => (s.home_team === teamName || s.away_team === teamName
      || s.home_team === signal.team || s.away_team === signal.team) && s.captured_at <= cutoff);
    const groups = new Map();
    for (const snap of relevant) {
      const key = `${snap.event_id}|${snap.book}|${snap.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(snap);
    }
    for (const list of groups.values()) {
      const baseline = [...list].reverse().find(s => s.captured_at <= signal.published_at && s.line != null);
      if (!baseline) continue;
      const moved = list.find(s => s.captured_at > signal.published_at && s.line != null && s.line !== baseline.line);
      if (!moved) continue;
      observations.push({ book: moved.book, event_id: moved.event_id, news_id: signal.news_id,
        lag_minutes: Math.round((new Date(moved.captured_at) - new Date(signal.published_at)) / 60000),
        from: baseline.line, to: moved.line });
    }
  }
  const byBook = new Map();
  for (const item of observations) {
    if (!byBook.has(item.book)) byBook.set(item.book, []);
    byBook.get(item.book).push(item.lag_minutes);
  }
  const books = [...byBook].map(([book, lags]) => {
    const sorted = [...lags].sort((a, b) => a - b);
    return { book, observations: lags.length,
      median_lag_minutes: sorted[Math.floor(sorted.length / 2)],
      mean_lag_minutes: Math.round(lags.reduce((sum, lag) => sum + lag, 0) / lags.length),
      sufficient_evidence: lags.length >= 10 };
  }).sort((a, b) => a.median_lag_minutes - b.median_lag_minutes);
  return { books, observations: observations.length, target_per_book: 10,
    note: books.length ? 'Lower lag means the book repriced sooner after a typed signal. Correlation is not causation.'
      : 'No book has a preserved before/after quote around a typed signal yet. Event-triggered captures now accumulate this.' };
}

/**
 * What the pipeline is currently capable of noticing.
 *
 * Freshness per source, and — more usefully — whether anything downstream
 * actually reads it. A feed that refreshes every ninety seconds into a table
 * nothing consumes is not a data pipeline, it is a log.
 */
export function pipelineHealth() {
  const jobs = rows(`SELECT job, last_run_at, last_status, runs FROM sync_log`);
  const now = Date.now();
  const age = j => (j.last_run_at ? (now - new Date(j.last_run_at).getTime()) / 60000 : null);

  const counts = {};
  // news_items is where the transaction wire lands — there is no
  // nfl_transactions table, the job normalises straight into the news store.
  for (const t of ['nfl_news_signals', 'nfl_injuries', 'espn_line_moves', 'nfl_play_by_play',
    'nfl_line_snapshots', 'news_items']) {
    try { counts[t] = row(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0; } catch { counts[t] = null; }
  }

  return {
    checked_at: new Date().toISOString(),
    jobs: jobs.map(j => ({ job: j.job, runs: j.runs, status: j.last_status,
      age_minutes: age(j) == null ? null : Math.round(age(j)) }))
      .sort((a, b) => (a.age_minutes ?? 1e9) - (b.age_minutes ?? 1e9)),
    row_counts: counts,
    never_run: jobs.filter(j => !j.runs).map(j => j.job),
    note: 'Row counts matter more than run counts: a job that runs on time into a table nothing ' +
      'reads is not feeding the model. See signalLeadTimes() for whether the data that does arrive ' +
      'arrives early enough to be worth anything.'
  };
}
