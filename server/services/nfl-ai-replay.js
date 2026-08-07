/**
 * Bounded, outcome-blind Claude review for historical NFL candidates.
 *
 * Claude is a risk gate, not a source of invented probabilities.  It sees a
 * compact pregame packet after the deterministic policy has selected a side;
 * scores and results are withheld until every response is immutable.  A run is
 * deliberately capped by an estimated dollar budget before any API call.
 */
import { db, rows, run } from '../db/index.js';
import { fork } from 'node:child_process';
import { replaySeason } from './nfl-replay.js';
import { ensembleLine } from './nfl-ensemble.js';
import { teamFeatureVector } from './nfl-features.js';
import { getApiKey, callClaude, costOf } from './claude.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_ai_replay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL,
  seasons_json TEXT NOT NULL, budget_usd REAL NOT NULL, estimated_cost_usd REAL NOT NULL,
  progress_json TEXT NOT NULL, result_json TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS nfl_ai_replay_reviews (
  run_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  home TEXT NOT NULL, away TEXT NOT NULL, selection TEXT NOT NULL, packet_json TEXT NOT NULL,
  review_json TEXT, outcome TEXT, units REAL, PRIMARY KEY(run_id, ordinal)
);`);

const parse = v => { try { return JSON.parse(v); } catch { return null; } };
const r3 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(3);
const MODEL = 'claude-haiku-4-5-20251001';
const INPUT_TOKENS = 850, OUTPUT_TOKENS = 120;
const perReviewCost = () => costOf(MODEL, INPUT_TOKENS, OUTPUT_TOKENS);

function packetFor(bet) {
  const line = ensembleLine(bet.season, bet.week, bet.home, bet.away);
  const slim = team => {
    const f = teamFeatureVector(bet.season, bet.week, team) ?? {};
    return Object.fromEntries(['off_epa_neutral_wp', 'def_epa_neutral_wp', 'opp_adj_net_epa',
      'off_success_rate_neutral_wp', 'off_pressure_epa_delta', 'off_epa_volatility', 'sos_played']
      .filter(k => f[k] != null).map(k => [k, f[k]]));
  };
  const game = rows(`SELECT open_spread,spread,total,temp,wind,roof,rest_days,div_game,fetched_at
                     FROM game_lines WHERE season=? AND week=? AND team=? AND home=1`,
    bet.season, bet.week, bet.home)[0] ?? {};
  const injuryRows = rows(`SELECT team,full_name,position,report_status,practice_status,injury
                            FROM nfl_injuries WHERE season=? AND week=? AND team IN (?,?)
                            ORDER BY team,position,full_name`, bet.season, bet.week, bet.home, bet.away);
  const injuries = Object.fromEntries([bet.home, bet.away].map(team => [team, injuryRows.filter(x => x.team === team)
    .map(x => ({ player: x.full_name, position: x.position, status: x.report_status,
      practice: x.practice_status, injury: x.injury }))]));
  const qbs = Object.fromEntries([bet.home, bet.away].map(team => [team, injuries[team].filter(x => x.position === 'QB')]));
  const sourceNotes = {
    prior_team_features: 'walk-forward: strictly before target week',
    historical_injury_report: injuryRows.length ? 'season/week record present; original publication timestamp unavailable' : 'not preserved',
    quarterback_status: qbs[bet.home].length || qbs[bet.away].length ? 'derived from archived injury report only' : 'not preserved',
    weather_rest_venue: 'historical game record present; source capture timestamp unavailable',
    price: 'historical line present; quote capture timestamp unavailable'
  };
  return {
    protocol: 'nfl-ai-gate-v1', mode: 'retrospective_reconstruction_research_only',
    cutoff_rule: 'team features are strictly prior to target week; final score/result excluded from prompt',
    game: { season: bet.season, week: bet.week, away: bet.away, home: bet.home },
    market: { selection: bet.selection ?? bet.side, spread: bet.line, american_price: bet.american_price,
      source: bet.quote_source ?? null, quote_timestamp_status: 'historical quote timestamp not preserved' },
    pregame_context: { opening_spread: game.open_spread ?? null, current_spread: game.spread ?? null,
      total: game.total ?? null, temperature_f: game.temp ?? null, wind_mph: game.wind ?? null,
      roof: game.roof ?? null, home_rest_days: game.rest_days ?? null, divisional_game: game.div_game ?? null },
    availability: { injuries, quarterback_reports: qbs },
    model: { edge_points: bet.edge_points, disagreement: bet.disagreement,
      projected_margin: line.ensemble?.projected_margin ?? null, market_spread: line.ensemble?.market_spread ?? null,
      models_contributing: line.ensemble?.models_contributing_margin ?? null },
    prior_features: { [bet.home]: slim(bet.home), [bet.away]: slim(bet.away) },
    source_notes: sourceNotes,
    admissibility: 'research_only — source timestamps are incomplete; never eligible for production promotion'
  };
}

const promptFor = packet => `You are a bounded NFL pregame risk reviewer. Use ONLY this JSON packet.\nDo not infer missing injuries, news, weather, or outcomes. Do not change the selection.\nReturn EXACTLY one line of valid JSON, with no Markdown and no extra text: {"action":"approve"|"reduce"|"abstain","risk":"low"|"medium"|"high","adjustment":number,"reasons":[string]}.\nRules: adjustment must be -0.15, -0.05, or 0. Reasons must be 120 characters or fewer, contain no quotation marks, and contain no line breaks. Choose abstain if material evidence is missing or the model/market conflict is not well supported.\nPACKET:\n${JSON.stringify(packet)}`;

function parseReview(msg) {
  const raw = String(msg?.content?.[0]?.text ?? '').trim().replace(/^```json?\s*|\s*```$/g, '');
  const candidate = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try { return JSON.parse(candidate); }
  catch {
    // A model occasionally emits an unescaped character inside an otherwise
    // valid reason. Recover only the constrained fields we asked for; never
    // infer a side, probability, or unavailable fact from malformed prose.
    const action = candidate.match(/"action"\s*:\s*"(approve|reduce|abstain)"/)?.[1];
    const risk = candidate.match(/"risk"\s*:\s*"(low|medium|high)"/)?.[1];
    const adjustment = Number(candidate.match(/"adjustment"\s*:\s*(-?0(?:\.\d+)?)/)?.[1]);
    const reasonBlock = candidate.match(/"reasons"\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const reasons = [...reasonBlock.matchAll(/"([^"\n]{1,160})"/g)].map(x => x[1]);
    if (action && risk && [-0.15, -0.05, 0].includes(adjustment) && reasons.length) {
      return { action, risk, adjustment, reasons };
    }
    throw new Error('AI returned malformed structured review');
  }
}

function update(id, patch) {
  const prior = rows('SELECT progress_json FROM nfl_ai_replay_runs WHERE id=?', id)[0];
  const progress = { ...(parse(prior?.progress_json) ?? {}), ...patch };
  run('UPDATE nfl_ai_replay_runs SET progress_json=? WHERE id=?', JSON.stringify(progress), id);
}

function reportRun(id) {
  const r = rows('SELECT * FROM nfl_ai_replay_runs WHERE id=?', id)[0];
  if (!r) return null;
  return { ...r, seasons: parse(r.seasons_json), progress: parse(r.progress_json), result: parse(r.result_json),
    seasons_json: undefined, progress_json: undefined, result_json: undefined };
}

const yieldToServer = () => new Promise(resolve => setImmediate(resolve));

async function execute(id, seasons, maxReviews) {
  try {
    const candidates = [];
    for (const season of seasons) {
      update(id, { current: 0, total: 0, season, week: null, game: null,
        state: `building cutoff-safe ${season} candidates` });
      // Let requests such as Dev Hub key saves and progress polls run between
      // seasons instead of holding the event loop through a five-year replay.
      await yieldToServer();
      const replay = replaySeason(season);
      if (replay.error) throw new Error(replay.error);
      candidates.push(...replay.bets);
      await yieldToServer();
    }
    const bets = candidates.slice(0, maxReviews);
    update(id, { current: 0, total: bets.length, state: 'pregame packets locked; starting AI review' });
    for (let i = 0; i < bets.length; i++) {
      const bet = bets[i], packet = packetFor(bet);
      run(`INSERT INTO nfl_ai_replay_reviews (run_id,ordinal,season,week,home,away,selection,packet_json)
        VALUES (?,?,?,?,?,?,?,?)`, id, i + 1, bet.season, bet.week, bet.home, bet.away, bet.side, JSON.stringify(packet));
      update(id, { current: i + 1, total: bets.length, season: bet.season, week: bet.week,
        game: `${bet.away} at ${bet.home}`, state: 'asking AI pregame risk gate' });
      const msg = await callClaude({ feature: 'nfl_blind_replay_gate', model: MODEL, maxTokens: OUTPUT_TOKENS, prompt: promptFor(packet) });
      const review = parseReview(msg);
      if (!['approve', 'reduce', 'abstain'].includes(review.action) || !['low', 'medium', 'high'].includes(review.risk)) {
        throw new Error('AI returned an invalid structured review');
      }
      run(`UPDATE nfl_ai_replay_reviews SET review_json=?,outcome=?,units=? WHERE run_id=? AND ordinal=?`,
        JSON.stringify(review), bet.result, bet.units, id, i + 1);
    }
    const graded = rows('SELECT review_json,outcome,units FROM nfl_ai_replay_reviews WHERE run_id=?', id);
    const kept = graded.filter(x => parse(x.review_json)?.action !== 'abstain');
    const units = kept.reduce((s, x) => s + x.units * (parse(x.review_json)?.action === 'reduce' ? 0.5 : 1), 0);
    const wins = kept.filter(x => x.outcome === 'Won').length, losses = kept.filter(x => x.outcome === 'Lost').length;
    const result = { candidates: graded.length, reviewed: graded.length, kept: kept.length, abstained: graded.length - kept.length,
      wins, losses, win_rate: wins + losses ? r3(wins / (wins + losses)) : null, units: r3(units), roi: kept.length ? r3(units / kept.length) : null,
      evidence_status: 'research_only — historical quote/snapshot timestamps were not preserved; no promotion decision may use this report' };
    run(`UPDATE nfl_ai_replay_runs SET status='complete',progress_json=?,result_json=? WHERE id=?`,
      JSON.stringify({ current: bets.length, total: bets.length, state: 'complete' }), JSON.stringify(result), id);
  } catch (e) {
    run(`UPDATE nfl_ai_replay_runs SET status='failed',error=? WHERE id=?`, String(e.message ?? e), id);
  }
}

export function startAiBlindReplay({ seasons = [2021, 2022, 2023, 2024, 2025], budgetUsd = 1 } = {}) {
  if (!getApiKey()) {
    const error = new Error('No Claude API key configured. Add one in Dev Hub before starting an AI replay.');
    error.status = 400;
    throw error;
  }
  const cap = Math.min(Math.max(Number(budgetUsd) || 1, 0.05), 1);
  const allowed = Math.floor(cap / perReviewCost());
  if (!allowed) throw new Error('Budget is too small for one bounded AI review.');
  run(`INSERT INTO nfl_ai_replay_runs (created_at,status,seasons_json,budget_usd,estimated_cost_usd,progress_json)
    VALUES (datetime('now'),'running',?,?,?,?)`, JSON.stringify(seasons), cap, r3(allowed * perReviewCost()),
    JSON.stringify({ current: 0, total: 0, state: 'queued', max_cost_usd: cap, model: MODEL }));
  const id = rows('SELECT last_insert_rowid() id')[0].id;
  // Historical ensemble reconstruction is CPU-heavy.  Run it in a separate
  // Node process so the app can immediately save keys and serve live polling.
  // The worker shares only the local SQLite job record; it has no HTTP surface.
  const child = fork(new URL('../scripts/run-nfl-ai-replay.js', import.meta.url), [String(id)], {
    detached: true, stdio: 'ignore'
  });
  child.unref();
  return reportRun(id);
}

export function aiReplayRun(id) { return reportRun(Number(id)); }
export function activeAiReplayRun() {
  const r = rows(`SELECT id FROM nfl_ai_replay_runs WHERE status='running' ORDER BY id DESC LIMIT 1`)[0];
  return r ? reportRun(r.id) : null;
}

/** Compact audit feed for the UI; final outcomes stay hidden while running. */
export function aiReplayLogs(id) {
  const job = rows('SELECT status FROM nfl_ai_replay_runs WHERE id=?', Number(id))[0];
  if (!job) return null;
  return rows(`SELECT ordinal,season,week,home,away,selection,review_json,outcome,units
               FROM nfl_ai_replay_reviews WHERE run_id=? ORDER BY ordinal DESC LIMIT 80`, Number(id))
    .map(x => ({ ...x, review: parse(x.review_json), review_json: undefined,
      outcome: job.status === 'complete' ? x.outcome : null,
      units: job.status === 'complete' ? x.units : null }));
}

/** Entry point used only by the detached local worker. */
export async function runAiReplayWorker(id) {
  const job = rows('SELECT seasons_json,budget_usd FROM nfl_ai_replay_runs WHERE id=?', Number(id))[0];
  if (!job) throw new Error(`AI replay run ${id} not found`);
  await execute(Number(id), parse(job.seasons_json), Math.floor(job.budget_usd / perReviewCost()));
}
