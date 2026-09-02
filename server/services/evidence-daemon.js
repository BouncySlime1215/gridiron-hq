/**
 * Evidence daemon: makes forward evaluation an automatic operating system.
 *
 * A model cannot prove it had information unless we preserve what it saw at
 * useful moments before an event. This service plans and records those moments
 * (opening, T-24h, T-6h, T-60m, T-15m and close) for both sports. It captures
 * context even when the paid odds feed is absent, reports that gap explicitly,
 * and never creates a retrospective snapshot.
 */
import { db, rows, run } from '../db/index.js';
import { hasKey, reserveStatus } from './odds-api.js';
import { snapshotLines } from './line-shopping.js';
import { capturePregameSnapshots } from './nfl-pregame.js';
import { captureMlbPregame } from './mlb-pregame.js';
import { appDate, nflKickoffDate } from './date-util.js';
import { recordNflShadowBoard } from './shadow-ledger.js';
import { captureOnlineNeuralWeek } from './nfl-online-neural.js';
import { captureRiskLabWeek } from './nfl-risk-lab.js';
import { captureForwardExpertWeek } from './nfl-expert-council.js';
import { hasKey as hasSgoKey, captureSportsGameOddsSnapshot } from './sportsgameodds.js';
import { captureBookFeeds } from './book-feeds.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS evidence_capture_windows (
    sport TEXT NOT NULL, event_key TEXT NOT NULL, event_at TEXT NOT NULL,
    horizon TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, captured_at TEXT,
    detail_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (sport,event_key,horizon)
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_windows_due
    ON evidence_capture_windows(status,due_at);
  CREATE TABLE IF NOT EXISTS evidence_daemon_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL, detail_json TEXT
  );
`);

const HORIZONS = [
  ['open', null], ['T-24h', 24 * 60], ['T-6h', 6 * 60],
  ['T-60m', 60], ['T-15m', 15], ['close', 5]
];
const iso = value => new Date(value).toISOString();
const eventDate = (date, time = '12:00', sport = null) => {
  if (sport === 'NFL') return nflKickoffDate(date, time) ?? new Date(NaN);
  if (/T/.test(String(time))) return new Date(time);
  const normalized = /^\d{2}:\d{2}$/.test(String(time)) ? time : '12:00';
  return new Date(`${date}T${normalized}:00Z`);
};
const addWindow = (sport, eventKey, at) => {
  for (const [horizon, minutes] of HORIZONS) {
    const due = minutes == null ? new Date() : new Date(at.getTime() - minutes * 60000);
    run(`INSERT INTO evidence_capture_windows (sport,event_key,event_at,horizon,due_at)
         VALUES (?,?,?,?,?) ON CONFLICT(sport,event_key,horizon) DO UPDATE SET
           event_at=excluded.event_at,
           due_at=CASE WHEN evidence_capture_windows.horizon='open'
             THEN evidence_capture_windows.due_at ELSE excluded.due_at END
         WHERE evidence_capture_windows.status IN ('queued','partial')`,
    sport, eventKey, iso(at), horizon, iso(due));
  }
};

/** Seed upcoming events. Completed captures stay immutable; unrun schedule corrections are safe. */
export function planEvidenceWindows() {
  const now = Date.now();
  const nfl = rows(`SELECT season,week,team,opponent,gameday,gametime FROM game_lines
    WHERE home=1 AND team_score IS NULL AND gameday IS NOT NULL ORDER BY gameday LIMIT 300`)
    .filter(g => eventDate(g.gameday, g.gametime, 'NFL').getTime() > now - 6 * 3600e3);
  for (const g of nfl) addWindow('NFL', `${g.season}:${g.week}:${g.team}:${g.opponent}`, eventDate(g.gameday, g.gametime, 'NFL'));

  const mlb = rows(`SELECT game_pk,date,game_time FROM mlb_games WHERE date >= ? ORDER BY date LIMIT 120`, appDate())
    .filter(g => eventDate(g.date, g.game_time).getTime() > now - 6 * 3600e3);
  for (const g of mlb) addWindow('MLB', String(g.game_pk), eventDate(g.date, g.game_time));
  return { nfl_events: nfl.length, mlb_events: mlb.length };
}

// A partial window (context captured, paid quotes unavailable) is retried a
// bounded number of times. Unbounded retries were the mechanism that turned an
// exhausted quota into a 30-minute loop of 401s for the rest of the season.
const MAX_PARTIAL_ATTEMPTS = 3;
const OPEN_HORIZON_DAYS = 10;

function dueWindows(force = false) {
  const now = new Date().toISOString();
  const retryBefore = new Date(Date.now() - 30 * 60000).toISOString();
  const openHorizon = new Date(Date.now() + OPEN_HORIZON_DAYS * 86400000).toISOString();
  return rows(`SELECT * FROM evidence_capture_windows
    WHERE due_at <= ? AND event_at >= ? AND (
      status='queued' OR (status='partial' AND COALESCE(last_attempt_at,'') < ? AND attempts < ?)
    ) AND (horizon <> 'open' OR event_at <= ?) ORDER BY event_at,horizon`, now,
  new Date(Date.now() - 5 * 60000).toISOString(), retryBefore, MAX_PARTIAL_ATTEMPTS, openHorizon)
    .filter(x => force || x.status === 'queued' || x.last_attempt_at == null || x.last_attempt_at < retryBefore);
}

function mark(windows, status, detail) {
  const at = new Date().toISOString();
  for (const w of windows) run(`UPDATE evidence_capture_windows
    SET status=?, attempts=attempts+1, last_attempt_at=?, captured_at=?, detail_json=?
    WHERE sport=? AND event_key=? AND horizon=?`, status, at,
  status === 'captured' ? at : null, JSON.stringify(detail), w.sport, w.event_key, w.horizon);
}

/** Runs all due windows. One capture per NFL week / MLB date prevents API waste. */
export async function runEvidenceDaemon({ force = false } = {}) {
  const planned = planEvidenceWindows();
  const due = dueWindows(force);
  const started = new Date().toISOString();
  const inserted = run(`INSERT INTO evidence_daemon_runs (started_at,status,detail_json) VALUES (?, 'running', '{}')`, started);
  const detail = { planned, due: due.length, nfl: [], mlb: [], odds_feed: hasKey() };
  try {
    const nflGroups = new Map();
    const mlbGroups = new Map();
    for (const w of due) {
      if (w.sport === 'NFL') {
        const [season, week] = w.event_key.split(':').map(Number);
        const key = `${season}:${week}`; const a = nflGroups.get(key) ?? []; a.push(w); nflGroups.set(key, a);
      } else {
        const game = rows('SELECT date FROM mlb_games WHERE game_pk=?', Number(w.event_key))[0];
        if (game) { const a = mlbGroups.get(game.date) ?? []; a.push(w); mlbGroups.set(game.date, a); }
      }
    }
    for (const [key, windows] of nflGroups) {
      const [season, week] = key.split(':').map(Number);
      try {
        const context = capturePregameSnapshots(season, week);
        // Two markets, not three: h2h is worth a credit on demand, never at
        // every horizon. The reserve itself is enforced inside odds-api.js.
        const reserve = reserveStatus();
        const odds = !hasKey() ? { error: 'no ODDS_API_KEY configured' }
          : reserve.exhausted ? { error: `odds quota at reserve (${reserve.requests_remaining} left, reserve ${reserve.reserve}); free ESPN reference line only` }
            : await snapshotLines({ markets: 'spreads,totals' });
        // A second, independent quote provider — opt-in, and on its own
        // 2,500-object monthly budget, so it never competes with the Odds API
        // reserve above. Its own failure never blocks this capture window;
        // the Odds API result above is still the primary source when present.
        const sgo = hasSgoKey() ? await captureSportsGameOddsSnapshot().catch(error => ({ error: error.message })) : null;
        // The free book feeds cost nothing, so every window gets a real
        // multi-book quote set (Pinnacle included) whether or not the Odds
        // API reserve is being held.
        const free = await captureBookFeeds().catch(error => ({ error: error.message }));
        const shadow = recordNflShadowBoard(season, week);
        const neural = captureOnlineNeuralWeek(season, week, {
          horizons: windows.map(window => window.horizon)
        });
        const riskLab = captureRiskLabWeek(season, week, {
          horizons: windows.map(window => window.horizon)
        });
        const expertCouncil = [...new Set(windows.map(window => window.horizon))]
          .map(horizon => captureForwardExpertWeek(season, week, { horizon }));
        // Complete if EITHER provider produced real quotes — the Odds API
        // reserve being held is not a partial capture if SportsGameOdds just
        // supplied the multi-book evidence instead.
        const complete = !odds.error || (sgo && !sgo.error && sgo.quotes > 0) || (free && !free.error && free.quotes > 0);
        mark(windows, complete ? 'captured' : 'partial', { context, odds, sgo, free_feeds: free, shadow, neural, risk_lab: riskLab,
          expert_council: expertCouncil, mode: 'forward_shadow' });
        detail.nfl.push({ season, week, windows: windows.length, context, odds, sgo, free_feeds: free, shadow, neural,
          risk_lab: riskLab, expert_council: expertCouncil });
      } catch (error) {
        mark(windows, 'partial', { error: error.message, mode: 'source_quarantined' });
        detail.nfl.push({ season, week, windows: windows.length, error: error.message });
      }
    }
    for (const [date, windows] of mlbGroups) {
      try {
        const result = await captureMlbPregame(date);
        // When MLB quotes are deliberately disabled the context capture IS the
        // complete capture; marking it partial would retry it forever.
        const complete = !result.odds_capture_enabled || (result.odds_available && result.quotes > 0);
        mark(windows, complete ? 'captured' : 'partial', { ...result, mode: 'forward_shadow' });
        detail.mlb.push({ date, windows: windows.length, result });
      } catch (error) {
        mark(windows, 'partial', { error: error.message, mode: 'source_quarantined' });
        detail.mlb.push({ date, windows: windows.length, error: error.message });
      }
    }
    const status = due.length ? 'ok' : 'idle';
    run('UPDATE evidence_daemon_runs SET finished_at=?,status=?,detail_json=? WHERE id=?', new Date().toISOString(), status, JSON.stringify(detail), inserted.lastInsertRowid);
    return { status, ...detail };
  } catch (error) {
    run('UPDATE evidence_daemon_runs SET finished_at=?,status=?,detail_json=? WHERE id=?', new Date().toISOString(), 'error', JSON.stringify({ ...detail, error: error.message }), inserted.lastInsertRowid);
    throw error;
  }
}

export function evidenceDaemonStatus() {
  const byStatus = rows(`SELECT status,COUNT(*) count FROM evidence_capture_windows GROUP BY status`);
  const byHorizon = rows(`SELECT horizon,status,COUNT(*) count FROM evidence_capture_windows GROUP BY horizon,status ORDER BY horizon`);
  const next = rows(`SELECT sport,event_key,event_at,horizon,due_at,status FROM evidence_capture_windows
    WHERE event_at >= ? AND status IN ('queued','partial') ORDER BY due_at LIMIT 12`, new Date().toISOString());
  const latest = rows('SELECT * FROM evidence_daemon_runs ORDER BY id DESC LIMIT 1')[0] ?? null;
  const partial = rows(`SELECT COUNT(*) count FROM evidence_capture_windows WHERE status='partial'`)[0]?.count ?? 0;
  // A window whose due time AND kickoff have both passed while it is still
  // queued was missed: the process was not running (or the daemon was stuck)
  // when it came due. The plan asks for this to be an alert, not a backfill.
  const missed = rows(`SELECT sport, horizon, COUNT(*) count FROM evidence_capture_windows
    WHERE status='queued' AND due_at < ? AND event_at < ? AND horizon <> 'open'
    GROUP BY sport, horizon ORDER BY sport, horizon`, new Date().toISOString(), new Date().toISOString());
  const missedNfl = missed.filter(m => m.sport === 'NFL').reduce((n, m) => n + m.count, 0);
  const reserve = reserveStatus();
  return {
    running: false, odds_feed: hasKey(), odds_reserve: reserve, sgo_feed: hasSgoKey(),
    by_status: byStatus, by_horizon: byHorizon, next, missed_windows: missed,
    latest_run: latest && { ...latest, detail: latest.detail_json ? JSON.parse(latest.detail_json) : null, detail_json: undefined },
    alerts: [
      ...(hasKey() ? [] : [{ severity: 'warn', code: 'odds_feed_missing', message: 'No ODDS_API_KEY: context is captured but real-price, line-movement and CLV evidence remain blocked.' }]),
      ...(hasKey() && reserve.exhausted ? [{ severity: hasSgoKey() ? 'warn' : 'error', code: 'odds_quota_exhausted',
        message: `Odds API has ${reserve.requests_remaining} credits left against a ${reserve.reserve}-credit reserve; paid multi-book capture is paused until the monthly reset.`
          + (hasSgoKey() ? ' SportsGameOdds is filling in as the second provider.' : ' Free ESPN reference lines continue; set SPORTSGAMEODDS_API_KEY for a free second source.') }] : []),
      ...(partial ? [{ severity: 'warn', code: 'partial_windows', message: `${partial} due capture windows have context only; each retries at most ${MAX_PARTIAL_ATTEMPTS} times.` }] : []),
      ...(missedNfl ? [{ severity: 'error', code: 'missed_windows',
        message: `${missedNfl} NFL capture window${missedNfl === 1 ? ' was' : 's were'} missed (kickoff passed while still queued: ${missed.filter(m => m.sport === 'NFL').map(m => `${m.horizon}×${m.count}`).join(', ')}). The app was not running when they came due; they are not backfilled.` }] : [])
    ]
  };
}
