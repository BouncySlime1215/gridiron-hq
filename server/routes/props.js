/**
 * MLB prop research board — a thin proxy in front of a separate private repo
 * (glederer04/Baseball-Props, "Diamond Signal"), not a rebuild of it.
 *
 * All modeling — pitcher strikeout / batter total bases / NRFI projections, live
 * FanDuel line ingestion, no-vig market probability — lives in that repo's R
 * pipeline and stays there. This route only fetches the small CSVs it already
 * publishes under `site-data/` and hands them to the client as JSON, so the React
 * pages here are genuinely just a UI on top of someone else's numbers.
 *
 * The repo is private, so a plain client-side fetch can't reach it (and a token
 * has no business living in browser JS anyway). `gh auth token` reads the same
 * GitHub CLI credential already used elsewhere in this project — nothing new to
 * configure — and every request goes through here instead.
 */
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCsv } from '../services/nflverse.js';
import { db, rows as dbRows, run } from '../db/index.js';

const execFileAsync = promisify(execFile);
const r = Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS props_auto_picks (
    pick_date TEXT NOT NULL,
    rank INTEGER NOT NULL,
    market TEXT, selection TEXT, matchup TEXT, game_time TEXT, side TEXT, line REAL,
    american_price INTEGER, model_probability REAL, implied_probability REAL,
    probability_difference REAL, recommendation TEXT, signal TEXT,
    selected_at TEXT NOT NULL,
    PRIMARY KEY (pick_date, rank)
  );
`);

const OWNER = 'glederer04';
const REPO = 'Baseball-Props';
const CACHE_MS = 5 * 60 * 1000; // site-data refreshes at most daily; five minutes keeps navigation snappy without ever going stale in practice.

let cachedToken = null;
async function ghToken() {
  if (cachedToken) return cachedToken;
  const { stdout } = await execFileAsync('gh', ['auth', 'token']);
  cachedToken = stdout.trim();
  if (!cachedToken) throw new Error('gh auth token returned nothing — run `gh auth login` once');
  return cachedToken;
}

const cache = new Map(); // path -> { at, rows }

/** One file from site-data/, as an array of row objects. */
async function fetchCsv(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;

  const token = await ghToken();
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' }
  });
  if (res.status === 404) return []; // a fresh run may not have produced every file yet — an honest empty board, same as the site itself does
  if (!res.ok) throw new Error(`GitHub ${res.status} fetching ${path} — check \`gh auth status\` and that this account still has access to ${OWNER}/${REPO}`);

  const { header, records } = parseCsv(await res.text());
  const rows = records.map(rec => Object.fromEntries(header.map((h, i) => [h, rec[i] ?? ''])));
  cache.set(path, { at: Date.now(), rows });
  return rows;
}

const num = v => { const n = Number(v); return v !== '' && Number.isFinite(n) ? n : null; };

/* ------------------------------------------------------------------ board */

/** Shared by the /board route and the auto-pick selector below. */
async function buildBoard() {
  const [board, projections, status] = await Promise.all([
    fetchCsv('site-data/latest_board.csv'),
    fetchCsv('site-data/today_projections.csv'),
    fetchCsv('site-data/pipeline_status.csv')
  ]);

  // Same join the R site does: attach the live FanDuel price to a projection row
  // when one exists, so "model-only" rows aren't actually priceless when a line
  // happens to already be captured for them.
  const normMarket = m => (m === 'totals_1st_1_innings' ? 'nrfi' : m);
  const priceByKey = new Map();
  for (const b of board) {
    const joinMarket = normMarket(b.market);
    const joinSide = joinMarket === 'nrfi' ? b.selection : b.side;
    const key = [b.selection, b.matchup, joinMarket, joinSide].join('||');
    if (!priceByKey.has(key)) priceByKey.set(key, b.american_price);
  }

  return {
    board: board
      .map(b => ({
        selection: b.selection, matchup: b.matchup, game_time: b.game_time,
        market: normMarket(b.market), side: b.side, line: num(b.line),
        american_price: num(b.american_price),
        model_probability: num(b.model_probability),
        implied_probability: num(b.implied_probability),
        probability_difference: num(b.probability_difference),
        signal: b.signal, captured_at: b.captured_at,
        slate_date: b.captured_at?.slice(0, 10) ?? null
      }))
      .sort((a, b) => (b.probability_difference ?? -1) - (a.probability_difference ?? -1)),
    projections: projections.map(p => {
      const key = [p.selection, p.matchup, p.market, p.recommended_side].join('||');
      return {
        slate_date: p.slate_date, slate_label: p.slate_label,
        selection: p.selection, matchup: p.matchup, game_time: p.game_time,
        market: p.market, recommended_side: p.recommended_side, recommendation: p.recommendation,
        expected_count: num(p.expected_count), reference_line: num(p.reference_line),
        line_gap: num(p.line_gap), model_probability: num(p.model_probability),
        confidence: num(p.confidence), projection_note: p.projection_note, status: p.status,
        american_price: num(priceByKey.get(key))
      };
    }),
    status: status[0] ?? null
  };
}

r.get('/board', async (req, res, next) => {
  try { res.json(await buildBoard()); } catch (e) { next(e); }
});

/* ------------------------------------------------------------- auto-picks */

/**
 * The top 5 FanDuel-priced edges for a slate, auto-selected and locked in —
 * every pick is graded as its own straight bet, never combined into a parlay.
 * Generation is idempotent per slate date: once today's five are picked, they
 * stay fixed even if the board re-ranks later in the day.
 */
async function ensureAutoPicksFor(slateDate, board) {
  const existing = dbRows('SELECT * FROM props_auto_picks WHERE pick_date = ? ORDER BY rank', slateDate);
  if (existing.length) return existing;

  const candidates = board.filter(b => b.slate_date === slateDate && b.american_price != null)
    .sort((a, b) => (b.probability_difference ?? -1) - (a.probability_difference ?? -1))
    .slice(0, 5);
  if (!candidates.length) return [];

  const now = new Date().toISOString();
  candidates.forEach((b, i) => {
    run(`INSERT INTO props_auto_picks
        (pick_date, rank, market, selection, matchup, game_time, side, line, american_price,
         model_probability, implied_probability, probability_difference, recommendation, signal, selected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pick_date, rank) DO NOTHING`,
      slateDate, i + 1, b.market, b.selection, b.matchup, b.game_time, b.side, b.line, b.american_price,
      b.model_probability, b.implied_probability, b.probability_difference,
      `${b.side ?? b.selection} ${b.line ?? ''}`.trim(), b.signal, now);
  });
  return dbRows('SELECT * FROM props_auto_picks WHERE pick_date = ? ORDER BY rank', slateDate);
}

r.get('/auto-picks', async (req, res, next) => {
  try {
    const { board } = await buildBoard();
    const slateDate = board[0]?.slate_date ?? new Date().toISOString().slice(0, 10);
    const today = await ensureAutoPicksFor(slateDate, board);
    const history = dbRows('SELECT * FROM props_auto_picks ORDER BY pick_date DESC, rank ASC');
    res.json({ slate_date: slateDate, today, history });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- pick grading */

/** The historical settlement feed My Picks grades saved slips against, client-side. */
r.get('/results', async (req, res, next) => {
  try {
    const rows = await fetchCsv('site-data/pick_results.csv');
    res.json(rows.map(r => ({
      slate_date: r.slate_date, matchup: r.matchup, selection: r.selection, market: r.market,
      actual_count: num(r.actual_count), actual_nrfi: num(r.actual_nrfi)
    })));
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- model info */

r.get('/model', async (req, res, next) => {
  try {
    const [summary, factors, status] = await Promise.all([
      fetchCsv('site-data/model_summary.csv'),
      fetchCsv('site-data/model_factors.csv'),
      fetchCsv('site-data/pipeline_status.csv')
    ]);
    res.json({
      summary: summary.map(s => ({
        market: s.market, selected_model: s.selected_model,
        training_rows: num(s.training_rows), test_rows: num(s.test_rows),
        training_through: s.training_through, test_start: s.test_start,
        brier_score: num(s.brier_score), log_loss: num(s.log_loss),
        mae: num(s.mae), rmse: num(s.rmse), auc: num(s.auc)
      })),
      factors,
      status: status[0] ?? null
    });
  } catch (e) { next(e); }
});

export default r;
