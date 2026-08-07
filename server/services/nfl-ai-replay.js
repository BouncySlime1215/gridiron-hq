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
);
CREATE TABLE IF NOT EXISTS nfl_ai_replay_candidate_cache (
  season INTEGER NOT NULL, cache_version TEXT NOT NULL, created_at TEXT NOT NULL,
  candidates_json TEXT NOT NULL, PRIMARY KEY(season, cache_version)
);`);

const parse = v => { try { return JSON.parse(v); } catch { return null; } };
const r3 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(3);
const MODEL = 'claude-haiku-4-5-20251001';
const INPUT_TOKENS = 1800, OUTPUT_TOKENS = 180;
const CACHE_VERSION = 'nfl-ai-candidates-v1';
const REVIEW_CONCURRENCY = 3;
const GATE_VERSION = 'nfl-ai-gate-v2';
const REVIEW_TOOL = {
  name: 'submit_pregame_review',
  description: 'Submit the single bounded pregame risk decision for the locked NFL selection.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['approve', 'reduce', 'abstain'] },
      risk_score: { type: 'integer', minimum: 0, maximum: 100 },
      stake_multiplier: { type: 'number', enum: [0, 0.5, 1] },
      flags: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', enum: [
        'availability_uncertain', 'quarterback_uncertain', 'weather_variance', 'model_disagreement',
        'price_unverified', 'feature_gap', 'late_season_volatility', 'explicit_contradiction'
      ] } },
      reasons: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 160 } }
    },
    required: ['action', 'risk_score', 'stake_multiplier', 'flags', 'reasons']
  }
};
const perReviewCost = () => costOf(MODEL, INPUT_TOKENS, OUTPUT_TOKENS);
const reviewMultiplier = review => review?.stake_multiplier
  ?? (review?.action === 'reduce' ? 0.5 : review?.action === 'abstain' ? 0 : 1);

function packetFor(bet) {
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
  const homeFeatures = slim(bet.home), awayFeatures = slim(bet.away);
  const contextValues = [game.open_spread, game.spread, game.total, game.temp, game.wind, game.roof, game.rest_days, game.div_game];
  const selectedTeam = String(bet.side ?? '').split(' ')[0];
  const selectedIsHome = selectedTeam === bet.home;
  const selectedRole = `${selectedIsHome ? 'home' : 'away'}_${Number(bet.line) > 0 ? 'underdog' : Number(bet.line) < 0 ? 'favorite' : 'pickem'}`;
  return {
    protocol: GATE_VERSION, mode: 'retrospective_reconstruction_research_only',
    cutoff_rule: 'team features are strictly prior to target week; final score/result excluded from prompt',
    game: { season: bet.season, week: bet.week, phase: bet.week <= 6 ? 'early' : bet.week >= 14 ? 'late' : 'mid',
      away: bet.away, home: bet.home },
    market: { selection: bet.selection ?? bet.side, spread: bet.line, american_price: bet.american_price,
      selected_team: selectedTeam, selected_role: selectedRole, source: bet.quote_source ?? null,
      quote_timestamp_status: 'historical quote timestamp not preserved' },
    pregame_context: { opening_spread: game.open_spread ?? null, current_spread: game.spread ?? null,
      total: game.total ?? null, temperature_f: game.temp ?? null, wind_mph: game.wind ?? null,
      roof: game.roof ?? null, home_rest_days: game.rest_days ?? null, divisional_game: game.div_game ?? null },
    availability: { injuries, quarterback_reports: qbs },
    model: { edge_points: bet.edge_points, disagreement: bet.disagreement,
      // These values were locked by the deterministic replay before the AI
      // packet is built. Re-running the ensemble here is redundant, slow, and
      // can needlessly contend with candidate construction.
      projected_margin: bet.model_margin ?? null, market_spread: bet.market_margin ?? null,
      models_contributing: bet.feature_snapshot?.margin_models_active ?? null,
      edge_to_disagreement: bet.disagreement > 0 ? r3(bet.edge_points / bet.disagreement) : null },
    prior_features: { [bet.home]: homeFeatures, [bet.away]: awayFeatures },
    evidence_coverage: { home_feature_fields: Object.keys(homeFeatures).length, away_feature_fields: Object.keys(awayFeatures).length,
      injury_rows: injuryRows.length, quarterback_reports: qbs[bet.home].length + qbs[bet.away].length,
      context_fields_present: contextValues.filter(x => x != null).length, context_fields_total: contextValues.length,
      preserved_quote_timestamp: false },
    source_notes: sourceNotes,
    admissibility: 'research_only — source timestamps are incomplete; never eligible for production promotion'
  };
}

const promptFor = packet => `You are a bounded NFL pregame risk reviewer. Use ONLY this JSON packet.\nDo not infer missing injuries, news, weather, or outcomes. Do not change the selection or estimate a win probability.\nSubmit exactly one submit_pregame_review tool call. The action and stake multiplier MUST agree:\n- approve = 1 unit and risk_score 0-35\n- reduce = 0.5 units and risk_score 36-69\n- abstain = 0 units and risk_score 70-100\nMissing historical quote timestamps are a research limitation, not by themselves an abstention. Use abstain for an explicit packet contradiction, severe feature gap, or unresolved QB/availability uncertainty.\nLate-season timing is not automatically bad; flag late_season_volatility only when the packet also lacks availability evidence or shows a concrete availability concern.\nPACKET:\n${JSON.stringify(packet)}`;

function parseReview(msg) {
  const toolInput = msg?.content?.find?.(block => block.type === 'tool_use' && block.name === REVIEW_TOOL.name)?.input;
  if (toolInput) return normalizeReview(toolInput);
  const raw = String(msg?.content?.[0]?.text ?? '').trim().replace(/^```json?\s*|\s*```$/g, '');
  const candidate = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try { return normalizeReview(JSON.parse(candidate)); }
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
      return normalizeReview({ action, risk_score: risk === 'low' ? 25 : risk === 'medium' ? 50 : 80,
        stake_multiplier: action === 'approve' ? 1 : action === 'reduce' ? 0.5 : 0, flags: [], reasons });
    }
    // A formatting miss must never kill a paid, otherwise-valid blind replay.
    // Treat it as the conservative decision and leave an explicit audit trail.
    // This is a parser fallback, not an invented football opinion.
    return { action: 'abstain', risk: 'high', risk_score: 100, stake_multiplier: 0,
      flags: ['explicit_contradiction'], reasons: ['Structured response could not be validated; conservatively excluded.'], parser_fallback: true };
  }
}

export function normalizeReview(input) {
  const score = Math.max(0, Math.min(100, Math.round(Number(input?.risk_score))));
  const action = input?.action;
  const expected = action === 'approve' ? 1 : action === 'reduce' ? 0.5 : action === 'abstain' ? 0 : null;
  const reasons = Array.isArray(input?.reasons) ? input.reasons.map(String).filter(Boolean).slice(0, 4) : [];
  const flags = Array.isArray(input?.flags) ? [...new Set(input.flags.map(String))].slice(0, 5) : [];
  const scoreMatches = action === 'approve' ? score <= 35 : action === 'reduce' ? score >= 36 && score <= 69 : score >= 70;
  if (expected == null || !Number.isFinite(score) || reasons.length === 0 || Number(input?.stake_multiplier) !== expected || !scoreMatches) {
    return { action: 'abstain', risk: 'high', risk_score: 100, stake_multiplier: 0,
      flags: ['explicit_contradiction'], reasons: ['Structured review was internally inconsistent; conservatively excluded.'], parser_fallback: true };
  }
  return { action, risk: score <= 35 ? 'low' : score <= 69 ? 'medium' : 'high', risk_score: score,
    stake_multiplier: expected, flags, reasons };
}

function update(id, patch) {
  const prior = rows('SELECT progress_json FROM nfl_ai_replay_runs WHERE id=?', id)[0];
  const progress = { ...(parse(prior?.progress_json) ?? {}), ...patch };
  run('UPDATE nfl_ai_replay_runs SET progress_json=? WHERE id=?', JSON.stringify(progress), id);
}

function reportRun(id) {
  const r = rows('SELECT * FROM nfl_ai_replay_runs WHERE id=?', id)[0];
  if (!r) return null;
  let result = parse(r.result_json);
  if (r.status === 'complete' && result) {
    const graded = rows('SELECT season,week,review_json,outcome,units FROM nfl_ai_replay_reviews WHERE run_id=?', id);
    const kept = graded.filter(x => reviewMultiplier(parse(x.review_json)) > 0);
    const totalStaked = kept.reduce((s, x) => s + reviewMultiplier(parse(x.review_json)), 0);
    const weightedUnits = kept.reduce((s, x) => s + x.units * reviewMultiplier(parse(x.review_json)), 0);
    const weeks = new Map();
    for (const x of graded) {
      const key = `${x.season}-${x.week}`;
      weeks.set(key, (weeks.get(key) ?? 0) + (reviewMultiplier(parse(x.review_json)) > 0 ? 1 : 0));
    }
    result = { ...result, total_units_staked: r3(totalStaked), roi_per_kept: kept.length ? r3(weightedUnits / kept.length) : null,
      units: r3(weightedUnits), roi: totalStaked ? r3(weightedUnits / totalStaked) : null,
      pushes: kept.filter(x => x.outcome === 'Push').length, calculation_version: 'stake-normalized-v2',
      weekly_coverage: result.weekly_coverage ?? { weeks: weeks.size,
        average_kept: r3([...weeks.values()].reduce((s, n) => s + n, 0) / Math.max(1, weeks.size)),
        weeks_with_3_plus: [...weeks.values()].filter(n => n >= 3).length,
        zero_kept_weeks: [...weeks.values()].filter(n => n === 0).length }
    };
  }
  return { ...r, seasons: parse(r.seasons_json), progress: parse(r.progress_json), result,
    seasons_json: undefined, progress_json: undefined, result_json: undefined };
}

const yieldToServer = () => new Promise(resolve => setImmediate(resolve));

function cachedCandidates(season) {
  const hit = rows(`SELECT candidates_json FROM nfl_ai_replay_candidate_cache WHERE season=? AND cache_version=?`, season, CACHE_VERSION)[0];
  if (hit) return { bets: parse(hit.candidates_json), cache: 'hit' };
  const replay = replaySeason(season);
  if (replay.error) throw new Error(replay.error);
  run(`INSERT INTO nfl_ai_replay_candidate_cache (season,cache_version,created_at,candidates_json)
       VALUES (?,?,datetime('now'),?)`, season, CACHE_VERSION, JSON.stringify(replay.bets));
  return { bets: replay.bets, cache: 'miss' };
}

async function execute(id, seasons, maxReviews) {
  try {
    const candidates = [];
    for (const season of seasons) {
      update(id, { current: 0, total: 0, season, week: null, game: null,
        state: `building cutoff-safe ${season} candidates` });
      // Let requests such as Dev Hub key saves and progress polls run between
      // seasons instead of holding the event loop through a five-year replay.
      await yieldToServer();
      const built = cachedCandidates(season);
      candidates.push(...built.bets);
      update(id, { current: 0, total: 0, season, week: null, game: null,
        state: built.cache === 'hit' ? `reused cached ${season} candidates` : `built and cached ${season} candidates` });
      await yieldToServer();
    }
    const bets = candidates.slice(0, maxReviews);
    update(id, { current: 0, total: bets.length, state: 'pregame packets locked; starting AI review' });
    for (let start = 0; start < bets.length; start += REVIEW_CONCURRENCY) {
      const batch = bets.slice(start, start + REVIEW_CONCURRENCY);
      update(id, { current: start + 1, total: bets.length, season: batch[0].season, week: batch[0].week,
        game: `${batch[0].away} at ${batch[0].home}`, state: `asking AI pregame risk gate (${batch.length} parallel reviews)` });
      const prepared = batch.map((bet, offset) => ({ bet, ordinal: start + offset + 1, packet: packetFor(bet) }));
      for (const x of prepared) run(`INSERT INTO nfl_ai_replay_reviews (run_id,ordinal,season,week,home,away,selection,packet_json)
        VALUES (?,?,?,?,?,?,?,?)`, id, x.ordinal, x.bet.season, x.bet.week, x.bet.home, x.bet.away, x.bet.side, JSON.stringify(x.packet));
      const completed = await Promise.all(prepared.map(async x => {
        const msg = await callClaude({ feature: 'nfl_blind_replay_gate', model: MODEL, maxTokens: OUTPUT_TOKENS,
          prompt: promptFor(x.packet), tools: [REVIEW_TOOL], toolChoice: { type: 'tool', name: REVIEW_TOOL.name,
            disable_parallel_tool_use: true } });
        return { ...x, review: parseReview(msg) };
      }));
      for (const x of completed) {
        if (!['approve', 'reduce', 'abstain'].includes(x.review.action) || !['low', 'medium', 'high'].includes(x.review.risk)) throw new Error('AI returned an invalid structured review');
        run(`UPDATE nfl_ai_replay_reviews SET review_json=?,outcome=?,units=? WHERE run_id=? AND ordinal=?`, JSON.stringify(x.review), x.bet.result, x.bet.units, id, x.ordinal);
      }
      update(id, { current: start + completed.length, total: bets.length, season: batch.at(-1).season, week: batch.at(-1).week,
        game: `${batch.at(-1).away} at ${batch.at(-1).home}`, state: 'AI reviews saved' });
    }
    const graded = rows('SELECT review_json,outcome,units FROM nfl_ai_replay_reviews WHERE run_id=?', id);
    const kept = graded.filter(x => reviewMultiplier(parse(x.review_json)) > 0);
    const totalStaked = kept.reduce((s, x) => s + reviewMultiplier(parse(x.review_json)), 0);
    const units = kept.reduce((s, x) => s + x.units * reviewMultiplier(parse(x.review_json)), 0);
    const wins = kept.filter(x => x.outcome === 'Won').length, losses = kept.filter(x => x.outcome === 'Lost').length;
    const weekly = rows(`SELECT season,week,COUNT(*) reviewed,
      SUM(CASE WHEN COALESCE(json_extract(review_json,'$.stake_multiplier'),CASE json_extract(review_json,'$.action') WHEN 'reduce' THEN .5 WHEN 'abstain' THEN 0 ELSE 1 END)>0 THEN 1 ELSE 0 END) kept
      FROM nfl_ai_replay_reviews WHERE run_id=? GROUP BY season,week`, id);
    const result = { gate_version: GATE_VERSION, candidates: graded.length, reviewed: graded.length, kept: kept.length, abstained: graded.length - kept.length,
      wins, losses, pushes: kept.filter(x => x.outcome === 'Push').length,
      win_rate: wins + losses ? r3(wins / (wins + losses)) : null, total_units_staked: r3(totalStaked),
      units: r3(units), roi: totalStaked ? r3(units / totalStaked) : null, calculation_version: 'stake-normalized-v2',
      weekly_coverage: { weeks: weekly.length, average_kept: r3(weekly.reduce((s, x) => s + x.kept, 0) / Math.max(1, weekly.length)),
        weeks_with_3_plus: weekly.filter(x => x.kept >= 3).length, zero_kept_weeks: weekly.filter(x => x.kept === 0).length },
      evidence_status: 'research_only — historical quote/snapshot timestamps were not preserved; no promotion decision may use this report' };
    run(`UPDATE nfl_ai_replay_runs SET status='complete',progress_json=?,result_json=? WHERE id=?`,
      JSON.stringify({ current: bets.length, total: bets.length, state: 'complete' }), JSON.stringify(result), id);
  } catch (e) {
    run(`UPDATE nfl_ai_replay_runs SET status='failed',error=? WHERE id=?`, String(e.message ?? e), id);
  }
}

export function startAiBlindReplay({ seasons = [2021, 2022, 2023, 2024, 2025], budgetUsd = 1 } = {}) {
  const active = rows(`SELECT id FROM nfl_ai_replay_runs WHERE status='running' ORDER BY id DESC LIMIT 1`)[0];
  if (active) {
    const error = new Error(`AI replay #${active.id} is already running. Reattach to its live trace instead of starting another charged run.`);
    error.status = 409;
    throw error;
  }
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
  // Do not inherit `node --watch` from the interactive dev server. A detached,
  // plain-node worker owns its own durable SQLite status and remains alive
  // through UI reloads or a server hot restart.
  const child = fork(new URL('../scripts/run-nfl-ai-replay.js', import.meta.url), [String(id)], {
    detached: true,
    stdio: 'ignore',
    execArgv: []
  });
  child.unref();
  return reportRun(id);
}

export function aiReplayRun(id) { return reportRun(Number(id)); }
export function latestAiReplayRun() {
  const r = rows(`SELECT id FROM nfl_ai_replay_runs ORDER BY id DESC LIMIT 1`)[0];
  return r ? reportRun(r.id) : null;
}
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
