/**
 * NFL weekly auto-picks: the 5 most confident spread edges each week, each one
 * its own straight bet at 1 unit — no parlays, no moneyline/total mixed in.
 * Picks are locked in once made (idempotent per season/week) so they don't
 * silently change if the model or lines move later; grading reads the real
 * final score straight out of game_lines once ESPN reports the game final.
 */
import { rows, run } from '../db/index.js';
import { ensembleWeek, ensembleLine } from './nfl-ensemble.js';
import { NFL_PRODUCTION_POLICY, applyNflPolicy } from './nfl-policy.js';
import { calibratedCoverProbability } from './nfl-cover-calibration.js';
import { promotedFindingVeto } from './nfl-candidate-findings.js';
import { pregameSnapshotFor } from './nfl-pregame.js';
import { onlineNeuralPrediction } from './nfl-online-neural.js';
import { shinNoVig } from './nfl-devig.js';
import { spreadForecastIdentity } from './nfl-forecast-identity.js';
import { resolvePacketMarketQuote, PACKET_BOARD_INPUT_COVERAGE, t60PacketHash } from './nfl-t60-packet.js';

const COORDINATED_DECISION_VERSION = 'coordinated-market-residual-v2-graph-bound';

// nfl_auto_picks and nfl_pick_decisions come from
// server/migrations/000_legacy_schema.js, along with the policy/quote/void
// columns that were once appended here. A locked pick is a ledger entry and
// must never silently vanish, but a pick locked under a policy that no longer
// exists is not a live position either — that is what voided_at/void_reason
// are for: the row and its history stay, the standing drops it.

/** Locks in this week's top-5 spread picks, if they don't already exist. */
export function ensurePicksFor(season, week, board, count = 5) {
  const existing = rows('SELECT * FROM nfl_auto_picks WHERE season = ? AND week = ? ORDER BY rank', season, week);
  if (existing.length) return existing;

  const candidates = board.filter(b => b.market === 'spread').slice(0, count);
  if (!candidates.length) return [];

  const now = new Date().toISOString();
  // Model-derived stake is zero until a market clears the forward gates
  // (PROFITABILITY_PLAN §8). The row is still a frozen, gradeable decision; it
  // simply carries no units, so the standing it feeds cannot pretend to be P&L.
  const units = Number(process.env.NFL_MODEL_STAKE_UNITS) || 0;
  candidates.forEach((b, i) => {
    run(`INSERT INTO nfl_auto_picks
        (season, week, rank, home_team, away_team, matchup, selection, side, line, american_price,
         model_probability, implied_probability, probability_difference, detail, units_staked, selected_at,
         policy_id, policy_version, book, quote_at, quote_source, feature_snapshot_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(season, week, rank) DO NOTHING`,
      season, week, i + 1, b.home_team, b.away_team, b.matchup, b.selection, b.side, b.line, b.american_price,
      b.model_probability, b.implied_probability, b.probability_difference, b.detail, units, now,
      NFL_PRODUCTION_POLICY.id, NFL_PRODUCTION_POLICY.version, b.book ?? null, b.quote_at ?? null,
      b.quote_source ?? null, JSON.stringify(b.feature_snapshot ?? {}));
  });
  return rows('SELECT * FROM nfl_auto_picks WHERE season = ? AND week = ? ORDER BY rank', season, week);
}

/**
 * The production auto-pick slate uses the same frozen policy as the blind
 * replay. This closes the old gap where the Training page graded the ensemble
 * but the Auto Picks button silently used a separate single-ratings board.
 */
/**
 * The decision board is deterministic given the week's lines and the fitted
 * models, but computing it walks the whole ensemble per game and takes 15-30
 * seconds. Node is single-threaded, so that is not merely a slow page — it
 * blocks the event loop and every other request on the server queues behind it.
 * Opening the hub while it ran froze the entire app, including endpoints that
 * answer in milliseconds on their own.
 *
 * Keyed on a fingerprint of the underlying rows rather than a TTL, so it is
 * correct by construction: any line sync changes `fetched_at`, the key misses,
 * and the board recomputes. A TTL would have had to choose between serving a
 * stale board and recomputing needlessly.
 */
const _boardCache = new Map();
export function clearAutoPickBoardCache() { _boardCache.clear(); }

function boardFingerprint(season, week) {
  const g = rows(`SELECT COUNT(*) n, COALESCE(MAX(fetched_at),'') fetched, COALESCE(SUM(spread),0) s
                  FROM game_lines WHERE season = ? AND week = ?`, season, week)[0];
  return `${g.n}:${g.fetched}:${g.s}`;
}

export function autoPickDecisionBoard(season, week, policy = NFL_PRODUCTION_POLICY, modelOptions = {}) {
  modelOptions = { blendMode: 'market_residual', ...modelOptions };
  const engineMode = modelOptions.includeChallengers ? 'candidate' : 'champion';
  const modelKey = JSON.stringify(Object.fromEntries(Object.entries(modelOptions).sort(([a], [b]) => a.localeCompare(b))));
  const key = `${season}:${week}:${policy.id}:${policy.version}:${engineMode}:${modelKey}:${boardFingerprint(season, week)}`;
  if (_boardCache.has(key)) return _boardCache.get(key);
  const computed = computeDecisionBoard(season, week, policy, modelOptions);
  // One week at a time is all that is ever asked for; keeping the map small
  // matters more than keeping history nobody reads.
  if (_boardCache.size > 8) _boardCache.clear();
  _boardCache.set(key, computed);
  return computed;
}

function computeDecisionBoard(season, week, policy = NFL_PRODUCTION_POLICY, modelOptions = {}) {
  const prices = new Map(rows(`SELECT team, opponent, spread, spread_odds, source, fetched_at
                               FROM game_lines WHERE season=? AND week=?`, season, week)
    .map(x => [x.team, { ...x, provenance: 'game_lines' }]));
  const quoteFor = team => prices.get(team);
  const out = ensembleWeek(season, week, modelOptions).map(game => buildCandidate(game, quoteFor, modelOptions));
  return { ...applyNflPolicy(out, policy),
    engine_mode: modelOptions.includeChallengers ? 'candidate' : 'champion',
    // Explicit at the board level, not just inferable per-game: every
    // audit/replay/production run of this board declares which blend it used.
    blend_mode: modelOptions.blendMode,
    // How many of this week's games actually got a market-identity forecast
    // out of that blend. See coordinated_decision_head.is_market_identity.
    market_identity_games: out.filter(d => d.is_market_identity).length,
    total_games: out.length };
}

/**
 * One game's decision candidate, from an already-computed ensemble `game`
 * (nfl-ensemble.js's ensembleLine/ensembleWeek shape) and a `quoteFor(team)`
 * lookup for that team's spread/price. Shared by the live weekly board
 * (computeDecisionBoard, quoteFor reading game_lines) and the packet-sourced
 * single-game board (autoPickDecisionBoardForPacket, quoteFor reading a frozen
 * T-60 packet's resolved quote) so the two paths run the exact same math and
 * can never quietly drift apart -- the only thing that differs between them is
 * where the quote and the ensemble's own market number came from, and that
 * provenance is carried through onto the result rather than erased.
 */
function buildCandidate(game, quoteFor, modelOptions) {
  const e = game.ensemble;
  const neural = onlineNeuralPrediction(game);
  const neuralUsed = Boolean((modelOptions.includeChallengers || neural.production_eligible === true)
    && Number.isFinite(neural.predicted_margin));
  const marketMargin = e.market_spread == null ? null : -e.market_spread;
  const projectedMargin = neuralUsed && neural.predicted_margin != null
    ? neural.predicted_margin : e.projected_margin;
  const edge = projectedMargin == null || marketMargin == null ? null : projectedMargin - marketMargin;
  const home = (edge ?? 0) > 0;
  const selection = home ? game.home : game.away;
  const quote = quoteFor(selection);
  const opposite = quoteFor(home ? game.away : game.home);
  const implied = noVigProbability(quote?.spread_odds, opposite?.spread_odds);
  const forecastIdentity = spreadForecastIdentity({ modelOptions,
    informationRegime: 'live_weekly_unfrozen',
    neuralVersion: neuralUsed ? (neural.version ?? 'unknown-neural-version') : null,
    reliabilityVersion: game.reliability_controller?.version ?? null });
  const calibrated = calibratedCoverProbability({ season: game.season, marketProbability: implied,
    edgePoints: edge == null ? null : Math.abs(edge), forecastIdentity });
  const modelProbability = calibrated.probability;
  const incremental = modelProbability == null || implied == null ? null : modelProbability - implied;
  // Do not let an uncalibrated forecast masquerade as a betting signal. A
  // null probability is intentional: the walk-forward calibration audit has
  // not proven that the ensemble improves on the market, so this game is an
  // auditable abstention rather than a lower-confidence recommendation.
  // Shrink-only, never boost: a promoted candidate-finding (nfl-candidate-
  // findings.js) can only ever push an otherwise-eligible pick to abstain,
  // never make an ineligible one eligible. Checked with the exact same
  // segmentsFor (nfl-replay.js) that discovered and validated the finding,
  // so there is no drift between "what was proven" and "what gets applied
  // live." As of tonight zero findings have ever been promoted, so this is
  // a guaranteed no-op — verified by its own test — until one actually is.
  const veto = promotedFindingVeto({
    season: game.season, week: game.week, home: game.home, away: game.away, market: 'spread',
    side: home ? game.home : game.away, line: quote?.spread ?? 0,
    edge: edge ?? 0, disagreement: e.model_disagreement_margin
  });
  const calibrationEligible = !veto.vetoed && modelProbability != null && incremental != null && incremental > 0;
  const audibleModels = game.models.filter(m => (modelOptions.includeChallengers || !m.challenger_only) && m.margin != null);
  const weightedModels = audibleModels.filter(m => e.blend_mode === 'market_residual'
    ? m.residual_weight > 0 && m.residual_slope != null : m.margin_weight > 0);
  const activeModels = e.blend_mode === 'raw' && !weightedModels.length ? audibleModels : weightedModels;
  const activeModelIds = new Set(activeModels.map(m => m.id));
  const pregame = pregameSnapshotFor(game.season, game.week, selection);
  return {
    market: 'spread', home_team: game.home, away_team: game.away,
    matchup: `${game.away} at ${game.home}`, selection,
    side: quote?.spread == null ? null : `${quote.spread > 0 ? '+' : ''}${quote.spread}`, line: quote?.spread ?? null,
    american_price: quote?.spread_odds ?? null,
    // The no-vig market probability is the prior. Historical cover outcomes
    // calibrate how much incremental probability a model edge has earned.
    model_probability: modelProbability,
    implied_probability: implied,
    probability_difference: incremental,
    calibration_eligible: calibrationEligible,
    calibration_status: calibrated.reason,
    // Hoisted to the top level (also nested under feature_snapshot's
    // coordinated_decision_head) so the decision tape and any direct reader
    // of the board can see it without parsing JSON. See the sweep note at
    // coordinated_decision_head.is_market_identity for what this means and
    // how it was validated against real history.
    is_market_identity: e.is_market_identity === true,
    promoted_finding_veto: veto.vetoed ? { segment_key: veto.segment_key, reason: veto.reason } : null,
    detail: `Ensemble edge ${edge > 0 ? '+' : ''}${edge} · disagreement ${e.model_disagreement_margin}`,
    edge_points: edge == null ? null : Math.abs(edge), disagreement: e.model_disagreement_margin,
    book: quote?.source ?? null, quote_source: quote?.source ?? null, quote_at: quote?.fetched_at ?? null,
    feature_snapshot: {
      forecast_identity: forecastIdentity,
      calibration_status: calibrated.reason,
      raw_forecast: { base_projected_margin: e.projected_margin, projected_margin: projectedMargin,
        market_margin: marketMargin, signed_edge_points: edge },
      margin_models_active: activeModels.length,
      margin_models_available: game.models.length,
      active_model_ids: activeModels.map(m => m.id),
      unavailable_model_ids: game.models.filter(m => !activeModelIds.has(m.id)).map(m => m.id),
      cover_calibration: calibrated.calibration
        ? `${calibrated.calibration.model_version}:${calibrated.calibration.trained_from}-${calibrated.calibration.trained_through}` : null,
      predictive_distribution: e.distribution ?? null,
      predictive_distribution_scope: 'base_ensemble_research_only',
      coordinated_decision_head: {
        version: COORDINATED_DECISION_VERSION,
        target: 'actual margin minus pregame market margin', base_blend: e.blend_mode,
        // SWEEP STEP 0 ITEM 3: whether the base blend above actually produced
        // an independent model opinion for this game, or fell through to the
        // market line by arithmetic because zero components passed the
        // residual promotion gate. Checked read-only against real production
        // history (2026-09-12): 0 of 848 stored ensemble fit artifacts ever
        // passed that gate, so this has been true of every base_blend this
        // board has ever served. A neural override does not change this flag
        // -- it describes the base blend's own honesty, independent of
        // whatever sits on top of it.
        is_market_identity: e.is_market_identity === true,
        neural: { version: neural.version ?? null, residual: neural.residual ?? null,
          authority: neural.authority ?? 'unavailable', used: Boolean(neuralUsed) },
        production_rule: 'market-residual base; neural output only after its forward gate passes'
      },
      input_mode: game.input_mode,
      reliability_controller: game.reliability_controller,
      model_trace: game.models.map(model => ({ id: model.id, family: model.family,
        challenger_only: model.challenger_only, margin: model.margin, total: model.total,
        base_margin_weight: model.base_margin_weight,
        reliability_multiplier: model.reliability_multiplier,
        margin_weight: model.margin_weight, total_weight: model.total_weight,
        residual_weight: model.residual_weight, residual_slope: model.residual_slope,
        contributes_to_base_margin: activeModelIds.has(model.id) })),
      player_availability_shadow: e.player_availability ?? null,
      pregame_snapshot_at: pregame?.captured_at ?? null,
      pregame_context: pregame?.feature_coverage ?? null,
      // Integration stage 1 (2026-09-12): where this decision's inputs
      // actually came from, field by field -- see nfl-t60-packet.js's
      // PACKET_BOARD_INPUT_COVERAGE for why game_context/team_features/
      // total_market are 'game_lines'/'nfl_team_week_features' even on a
      // packet-sourced decision (they are genuinely not in that packet's
      // schema today, and this records that honestly instead of implying a
      // fuller reproduction than actually happened).
      data_provenance: {
        market_quote: quote?.provenance ?? 'game_lines',
        market_spread_and_total: e.market_data_source ?? { home_spread: 'game_lines', total: 'game_lines' },
        game_context: 'game_lines', team_features: 'nfl_team_week_features',
        model_state: 'live (fit artifacts / calibration / candidate findings -- versioned via forecast_identity, not this packet)'
      }
    }
  };
}

/**
 * The packet-sourced counterpart to autoPickDecisionBoard(), scoped to the
 * ONE game a frozen T-60 evidence packet (nfl-t60-packet.js's freezeT60Packet)
 * describes -- Giant Plan 8.10's "strongest claim available today" gap
 * (t60-runner.js's captureDueObservations): that comment recorded a board on
 * the tape as `frozen_packet` evidence while the board itself still read live
 * mutable tables. This function is what actually closes it.
 *
 * It runs the EXACT same per-game math as the live board (buildCandidate,
 * above -- shared, not reimplemented) but supplies the market spread/price
 * from the packet's own frozen quote-tape evidence instead of a live
 * game_lines re-read, via ensembleLine's marketOverride. Every other input
 * ensembleLine needs (weather/rest/div/neutral game context, prior-week team
 * features) is genuinely NOT in this packet's schema today -- see
 * nfl-t60-packet.js's PACKET_BOARD_INPUT_COVERAGE -- and is read live, same as
 * before. That is disclosed on the result (`packet_provenance` and each
 * decision's own `feature_snapshot.data_provenance`), never silent.
 *
 * A packet with no eligible market quote does not fall back to game_lines for
 * it -- that would defeat the one input this stage actually fixed. It instead
 * produces a genuine, honest abstention (`missing_line`), the same shape the
 * live board already uses when a game has no usable quote.
 */
export function autoPickDecisionBoardForPacket(packet, policy = NFL_PRODUCTION_POLICY, modelOptions = {}) {
  modelOptions = { blendMode: 'market_residual', ...modelOptions };
  const engineMode = modelOptions.includeChallengers ? 'candidate' : 'champion';
  const base = { policy, decisions: [], selected: [], engine_mode: engineMode };

  if (!packet || packet.error) {
    return { ...base, packet_error: packet?.error ?? 'no packet supplied' };
  }
  const { season, week } = packet;
  const home = packet.home_team, away = packet.away_team;
  if (!home || !away) {
    // Packets frozen before this stage added home_team/away_team have no
    // canonical identity to source a board from. Parsing the human-readable
    // `matchup` string back into team codes would be a guess this function
    // refuses to make silently -- the honest answer is that this specific
    // packet predates the schema this needs, not a live-table fallback.
    return { ...base, packet_error: 'packet carries no home_team/away_team (frozen before this stage) -- '
      + 'cannot identify the game without guessing; re-freeze to source a board from it' };
  }

  const marketQuote = resolvePacketMarketQuote(packet);
  // An explicit `null`, never `undefined`: ensembleLine treats the KEY's
  // presence as "do not read game_lines for this," so a packet with nothing
  // eligible still gets a real override (of nothing) rather than silently
  // falling through to whatever game_lines says right now. The `source` label
  // itself still distinguishes the two cases, so a reader of
  // market_data_source never has to also check market_quote_status to know
  // whether the packet actually had a number.
  const marketOverride = { home_spread: marketQuote.status === 'available' ? marketQuote.home_spread : null,
    source: marketQuote.status === 'available' ? 'frozen_packet' : 'frozen_packet_unavailable' };

  const line = ensembleLine(season, week, home, away, { ...modelOptions, marketOverride });
  if (line.error) return { ...base, packet_error: `ensemble could not compute this game: ${line.error}` };

  const quoteFor = team => {
    if (marketQuote.status !== 'available') return undefined;
    if (team === home) return { spread: marketQuote.home_spread, spread_odds: marketQuote.home_price,
      source: marketQuote.book, fetched_at: marketQuote.quote_at, provenance: 'frozen_packet' };
    if (team === away) return { spread: marketQuote.away_spread, spread_odds: marketQuote.away_price,
      source: marketQuote.book, fetched_at: marketQuote.quote_at, provenance: 'frozen_packet' };
    return undefined;
  };

  const candidate = buildCandidate(line, quoteFor, modelOptions);
  candidate.feature_snapshot.data_provenance.market_quote_status = marketQuote.status;
  if (marketQuote.status !== 'available') candidate.feature_snapshot.data_provenance.market_quote_reason = marketQuote.reason;

  return { ...applyNflPolicy([candidate], policy), engine_mode: engineMode,
    packet_provenance: {
      packet_hash: t60PacketHash(packet), cutoff_at: packet.cutoff_at, mode: packet.mode,
      market_quote: marketQuote, schema_coverage: PACKET_BOARD_INPUT_COVERAGE
    } };
}

export function autoPickCandidates(season, week, policy = NFL_PRODUCTION_POLICY) {
  return autoPickDecisionBoard(season, week, policy).selected;
}

// `persistPickDecisions` (Giant Plan 8.10 / G08's "read/cache role only" UPSERT
// straight from a caller-supplied board) was removed in the stage-2 engine
// unification: it was an independent write path to `nfl_pick_decisions` that
// could disagree with the tape, and one caller (nfl-market.js's
// `/sync-and-pick` route) used it with NO tape write at all. Every former
// caller now calls `recordDecisionRun` (nfl-decision-tape.js) instead, which
// regenerates `nfl_pick_decisions` FROM its own tape rows as a side effect --
// see that file's "ONE WRITER" note. Integration note (2026-09-12 unify): that
// side-effect rebuild (refreshPickDecisionsCache) is where u2-market-identity's
// `is_market_identity` column -- added here by the now-removed UPSERT above --
// had to be re-homed; see the fix there.

/** No-vig fair probability, via Shin's method (see nfl-devig.js). */
function noVigProbability(odds, oppositeOdds) {
  return shinNoVig(odds, oppositeOdds);
}

const americanToDecimal = odds => (odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds));

/**
 * Grades one pick against the real final score, already sitting in game_lines
 * once ESPN marks the game final. A pick's `selection` names which team the
 * spread `line` belongs to (the model may have preferred either side).
 */
function gradePick(p) {
  // Checked before the score lookup: a voided pick stays voided even once the
  // game finishes, otherwise it would quietly rejoin the record on Sunday.
  if (p.voided_at) return { status: 'Void', units: 0 };
  const result = rows(
    `SELECT team, team_score, opp_score FROM game_lines
     WHERE season = ? AND week = ? AND team = ?`,
    p.season, p.week, p.selection
  )[0];
  if (!result || result.team_score == null) return { status: 'Pending', units: 0 };

  const margin = result.team_score - result.opp_score; // positive = `selection` won by this much
  const covered = margin > -p.line;
  const pushed = margin === -p.line;
  if (pushed) return { status: 'Push', units: 0 };
  if (!covered) return { status: 'Lost', units: -p.units_staked };
  return { status: 'Won', units: p.units_staked * (americanToDecimal(p.american_price) - 1) };
}

/** Every pick for one week, graded. */
export function pickResultsFor(season, week) {
  const picks = rows('SELECT * FROM nfl_auto_picks WHERE season = ? AND week = ? ORDER BY rank', season, week);
  return picks.map(p => ({ ...p, ...gradePick(p) }));
}

/** Full history across every week tracked so far, graded. */
export function allPickResults() {
  const picks = rows('SELECT * FROM nfl_auto_picks ORDER BY season DESC, week DESC, rank ASC');
  return picks.map(p => ({ ...p, ...gradePick(p) }));
}

/** Record / units across everything settled so far — "where we stand". */
export function standing() {
  // Voided picks are excluded from the record entirely — not counted as losses,
  // not counted as pending. They are history, not positions.
  const graded = allPickResults().filter(g => g.status !== 'Void');
  const settled = graded.filter(g => g.status === 'Won' || g.status === 'Lost');
  const wins = settled.filter(g => g.status === 'Won').length;
  const losses = settled.filter(g => g.status === 'Lost').length;
  const pushes = graded.filter(g => g.status === 'Push').length;
  const units = graded.reduce((s, g) => s + g.units, 0);
  return {
    wins, losses, pushes,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    units: +units.toFixed(2),
    weeks_tracked: new Set(graded.map(g => `${g.season}-${g.week}`)).size
  };
}
