/**
 * Does an insider tweet actually move the line, and if so, why?
 *
 * Two honest limits, stated before any numbers appear:
 *
 * 1. This is FORWARD-ONLY. Multi-book line snapshots only exist from
 *    2026-08-05 in this database — there is no historical intraday movement
 *    archive to backtest against, the same constraint the prop-CLV work
 *    already documented. Every stat here accumulates from now, like that
 *    archive, and should be read as "N observations so far," never as a
 *    settled finding until N is large enough to mean something.
 * 2. A line moving after a tweet is not proof the tweet caused it — books
 *    move for many reasons at once (sharp money, other news, weather). The
 *    AI explanation step is asked to say so explicitly when the connection
 *    is not clean, not to manufacture a causal story because one was asked
 *    for.
 *
 * The mechanism: when a tweet resolving to a tracked team is stored, snapshot
 * that team's CURRENT spread/total as a baseline. On later snapshot captures,
 * check whether it moved beyond normal week-to-week noise. If it did, ask
 * Claude to write a short, falsifiable explanation grounded only in the
 * tweet text and the measured move — never invited to guess beyond what it
 * was given.
 *
 * Output has NO numeric authority over the model, same as every other news
 * signal in this codebase. It becomes a reportable correlation; whether it
 * becomes a real feature goes through the same discovery -> validation gate
 * as everything else once enough observations exist.
 */
import { db, rows, run } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from './claude.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_tweet_line_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL, team TEXT NOT NULL, event_id TEXT NOT NULL,
  market TEXT NOT NULL, side TEXT NOT NULL,
  baseline_line REAL, baseline_captured_at TEXT NOT NULL,
  tweet_text TEXT, tweet_published_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_line REAL, resolved_captured_at TEXT,
  moved_points REAL, ai_explanation TEXT, ai_confidence REAL,
  created_at TEXT NOT NULL,
  UNIQUE(news_id, event_id, market, side)
)`);

/** Noise floor: a spread needs to move at least this much to count as a real move, not vig wobble. */
const NOISE_FLOOR = { spreads: 0.5, totals: 0.5 };
const CHECK_WINDOW_HOURS = 48;

/** Full team name -> abbr, for matching nfl_line_snapshots' home_team/away_team strings. */
function teamNameIndex() {
  return new Map(rows(`SELECT id, name, abbr FROM nfl_teams`).map(t => [t.name, t.abbr]));
}

/**
 * Call right after a tweet-sourced news item is stored. Finds that team's
 * nearest upcoming line snapshot and records it as the pre-tweet baseline.
 * No-ops quietly if no snapshot exists yet for that team — the multi-book
 * capture job may not have run recently, which is reportable, not an error.
 */
export function watchTweetForLineMove(newsItem) {
  if (!newsItem?.team_abbr) return { skipped: true, reason: 'no resolved team' };
  const names = teamNameIndex();
  const latest = rows(`SELECT * FROM nfl_line_snapshots
    WHERE captured_at = (SELECT MAX(captured_at) FROM nfl_line_snapshots)
      AND market IN ('spreads','totals') ORDER BY event_id, market, side`);
  const relevant = latest.filter(l => names.get(l.home_team) === newsItem.team_abbr || names.get(l.away_team) === newsItem.team_abbr);
  if (!relevant.length) return { skipped: true, reason: 'no current line snapshot for this team — multi-book capture may not have run recently' };

  let watched = 0;
  const now = new Date().toISOString();
  for (const l of relevant) {
    run(`INSERT INTO nfl_tweet_line_watch
      (news_id,team,event_id,market,side,baseline_line,baseline_captured_at,tweet_text,tweet_published_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(news_id,event_id,market,side) DO NOTHING`,
      newsItem.id, newsItem.team_abbr, l.event_id, l.market, l.side, l.line, l.captured_at,
      newsItem.headline, newsItem.published_at, now);
    watched++;
  }
  return { watched };
}

/**
 * Check every open watch against the latest snapshot. Resolves (marks
 * settled either way) once CHECK_WINDOW_HOURS has passed since the tweet, so
 * an unresolved watch doesn't sit open forever waiting for a move that isn't
 * coming — a non-move is itself the honest result, not a pending state.
 */
export async function checkTweetLineMovement({ explainMoves = true } = {}) {
  const open = rows(`SELECT * FROM nfl_tweet_line_watch WHERE resolved = 0`);
  let checked = 0, moved = 0, explained = 0;
  for (const w of open) {
    const latest = rows(`SELECT line, captured_at FROM nfl_line_snapshots
      WHERE event_id = ? AND market = ? AND side = ? ORDER BY captured_at DESC LIMIT 1`,
    w.event_id, w.market, w.side)[0];
    if (!latest || latest.captured_at === w.baseline_captured_at) continue;
    const ageHours = (Date.now() - new Date(w.tweet_published_at).getTime()) / 3600e3;
    const delta = w.baseline_line != null && latest.line != null ? latest.line - w.baseline_line : null;
    const floor = NOISE_FLOOR[w.market] ?? 0.5;
    const realMove = delta != null && Math.abs(delta) >= floor;
    checked++;
    if (!realMove && ageHours < CHECK_WINDOW_HOURS) continue;   // keep watching a while longer

    let explanation = null, confidence = null;
    if (realMove) {
      moved++;
      if (explainMoves && getApiKey()) {
        const out = await explainLineMove(w, delta);
        explanation = out?.explanation ?? null; confidence = out?.confidence ?? null;
        if (explanation) explained++;
      }
    }
    run(`UPDATE nfl_tweet_line_watch SET resolved=1, resolved_line=?, resolved_captured_at=?,
         moved_points=?, ai_explanation=?, ai_confidence=? WHERE id=?`,
    latest.line, latest.captured_at, delta, explanation, confidence, w.id);
  }
  return { open_at_start: open.length, checked, moved, explained };
}

/**
 * A single, cheap, bounded Claude call: given ONLY the tweet text and the
 * measured line move, explain whether they plausibly connect. Explicitly
 * allowed — expected, even — to say "not clearly related" rather than invent
 * a story, since the whole point is not manufacturing false causality.
 */
async function explainLineMove(watch, delta) {
  const msg = await callClaude({
    feature: 'nfl-tweet-line-explain', maxTokens: 300,
    prompt: `An NFL insider tweet was published, and the ${watch.market} line for ${watch.team} moved ${delta > 0 ? '+' : ''}${delta} points afterward.

TWEET: "${watch.tweet_text}"
MARKET: ${watch.market}, side: ${watch.side}
MOVE: ${watch.baseline_line} -> ${watch.resolved_line ?? '?'} (${delta > 0 ? '+' : ''}${delta})
TIME FROM TWEET TO THIS SNAPSHOT: line snapshots are captured roughly twice daily.

Respond with ONLY JSON: {"plausibly_related": true/false, "explanation": "one sentence, grounded only in the tweet content and the move direction", "confidence": 0-1}.
If the tweet content doesn't obviously explain the direction of the move (e.g. a positive-news tweet but the line moved against expectation, or the move is small enough to be normal week-to-week drift), set plausibly_related to false and say so — do not invent a connection.`
  });
  const out = parseJson(msg);
  return out && typeof out === 'object' ? { explanation: out.explanation ?? null,
    confidence: out.plausibly_related ? Number(out.confidence) || 0.5 : 0 } : null;
}

/**
 * Reportable summary. Explicitly framed as accumulating evidence, and
 * refuses to claim a rate is meaningful below a stated minimum sample.
 */
export function tweetLineCorrelationSummary({ minSample = 30 } = {}) {
  const resolved = rows(`SELECT * FROM nfl_tweet_line_watch WHERE resolved = 1`);
  const moved = resolved.filter(w => w.moved_points != null && Math.abs(w.moved_points) >= (NOISE_FLOOR[w.market] ?? 0.5));
  const withExplanation = moved.filter(w => w.ai_explanation);
  return {
    total_watched: rows(`SELECT COUNT(*) n FROM nfl_tweet_line_watch`)[0].n,
    resolved: resolved.length, moved: moved.length,
    move_rate: resolved.length ? +(moved.length / resolved.length).toFixed(3) : null,
    explained: withExplanation.length,
    sample_sufficient: resolved.length >= minSample,
    recent_explanations: withExplanation.slice(-10).map(w => ({
      team: w.team, market: w.market, moved_points: w.moved_points,
      tweet: w.tweet_text?.slice(0, 140), explanation: w.ai_explanation, confidence: w.ai_confidence
    })),
    note: resolved.length < minSample
      ? `Only ${resolved.length} resolved observations — below ${minSample}, do not treat the move rate as meaningful yet. Accumulates as long as the app runs and captures line snapshots.`
      : `${resolved.length} observations. Still correlational, not causal — see file header.`
  };
}
