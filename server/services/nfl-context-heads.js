/**
 * Structurally different signals for prop stats — opponent matchup strength,
 * weather, rest, home/away — as multiplicative adjustments on the structural
 * prediction, not another blend of the player's own outcome history.
 *
 * The player-head registry (`player-head-registry.js`) already proved that
 * class of candidate is near its ceiling: 24 heads, zero survivors across all
 * four prop stats. Every one of those heads only reweights the SAME time
 * series. These candidates bring in different information instead — how good
 * is the opponent's defense at this position, is it cold/windy, is the player
 * on short rest, home or away — matching what `MODEL_ROADMAP.md` Phase D
 * already called for ("new feature families: participation, weather, ...").
 *
 * Testing many weight/shrinkage variants of a few real signal families
 * produces a genuinely large candidate grid (~200 here) without inventing
 * fake signals: the grid is swept, not hand-picked, and the exact same
 * discovery -> redundancy pruning -> paired significance -> Holm correction
 * -> sealed validation pipeline this codebase already built absorbs however
 * many candidates are thrown at it. More candidates means a STRICTER bar
 * under Holm, not a looser one — that is what keeps "test hundreds of these"
 * honest instead of a p-hacking exercise.
 *
 * Opponent defense-vs-position reuses `matchups.js`'s leave-one-out +
 * shrinkage design (it is good, proven logic), but `matchups.js`'s own
 * `dvpFor` aggregates the WHOLE current season with no per-week cutoff, which
 * is correct for live use ("what do we know right now") and wrong for a
 * backtest ("what did we know before this game happened"). Rebuilt here as
 * prior-SEASONS-only (a simpler, unambiguously leak-free cutoff than a
 * within-season week boundary), kept as its own function rather than editing
 * `matchups.js`, which the live Matchups/My Team pages depend on.
 */
import { playerWeeks } from './nfl-pbp.js';
import { gameContext } from './nfl-features.js';
import { buildPlayerWeekEngine, playerWeekProjection, playerWeekEventExpectation } from './player-week-engine.js';
import { gameScriptFor } from './gamescript.js';
import { PROP_METRIC_CONFIG } from './nfl-prop-head-validation.js';
import { metrics, correlation, signFlipP, holmDecisions } from './player-head-validation.js';

const shrink = (observed, prior, weight, k) => (weight + k > 0 ? (observed * weight + prior * k) / (weight + k) : prior);

/* --------------------------------------------------------- cutoff-safe DVP */

const dvpCache = new Map();

/** Defense-vs-position for one metric, built ONLY from seasons strictly before `throughSeason`. */
function cutoffDvp(metricKey, throughSeason) {
  const key = `${metricKey}|${throughSeason}`;
  if (dvpCache.has(key)) return dvpCache.get(key);
  const cfg = PROP_METRIC_CONFIG[metricKey];
  const weightOf = s => ({ [throughSeason - 1]: 1, [throughSeason - 2]: 0.6, [throughSeason - 3]: 0.35 })[s] ?? 0;
  const log = [];
  for (const s of [throughSeason - 1, throughSeason - 2, throughSeason - 3]) {
    const w = weightOf(s);
    if (!w) continue;
    for (const r of playerWeeks(s)) {
      const val = r.features[cfg.actualField];
      if (val == null || !r.opponent || !r.position) continue;
      log.push({ player_id: r.player_id, opponent: r.opponent, position: r.position, val, w });
    }
  }
  const player = new Map();
  for (const g of log) {
    const p = player.get(g.player_id) ?? { w: 0, wval: 0 };
    p.w += g.w; p.wval += g.w * g.val;
    player.set(g.player_id, p);
  }
  const bucket = new Map();
  for (const g of log) {
    const p = player.get(g.player_id);
    const remW = p.w - g.w, remVal = p.wval - g.w * g.val;
    const baseline = remW > 0 ? remVal / remW : null;
    const ratio = baseline != null && baseline > 0 ? g.val / baseline : null;
    if (ratio == null) continue;
    const k = `${g.opponent}|${g.position}`;
    const b = bucket.get(k) ?? { ratioW: 0, ratioSum: 0, games: 0 };
    b.games++; b.ratioW += g.w; b.ratioSum += g.w * ratio;
    bucket.set(k, b);
  }
  const table = new Map();
  for (const [k, b] of bucket) table.set(k, { observed: b.ratioSum / b.ratioW, weight: b.ratioW, games: b.games });
  dvpCache.set(key, table);
  return table;
}

function dvpMult(metricKey, throughSeason, opponent, position, k) {
  const table = cutoffDvp(metricKey, throughSeason);
  const b = table.get(`${opponent}|${position}`);
  if (!b) return 1;
  return shrink(b.observed, 1, b.weight, k);
}

/* ----------------------------------------------------------- candidate grid */

const DVP_WEIGHTS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const DVP_K = [1, 2, 4, 6, 8, 12, 16, 24];
const CONTEXT_WEIGHTS = [0.25, 0.5, 0.75, 1.0];
const HOME_MAGNITUDES = [0.01, 0.02, 0.03, 0.04, 0.06, 0.08];
const REST_MAGNITUDES = [0.02, 0.04, 0.06, 0.08];
const WEATHER_MAGNITUDES = [0.02, 0.04, 0.06, 0.08, 0.1];

/** One entry per candidate: {id, adjust(signals, dvpM) -> multiplier}. Family groups related variants for reporting. */
function candidateSpecs() {
  const specs = [{ id: 'structural', family: 'baseline', adjust: () => 1 }];
  for (const w of DVP_WEIGHTS) for (const k of DVP_K) {
    specs.push({ id: `dvp_w${w}_k${k}`, family: 'opponent_dvp', dvpK: k,
      adjust: (s, m) => 1 + w * (m - 1) });
  }
  for (const w of CONTEXT_WEIGHTS) for (const mag of HOME_MAGNITUDES) {
    specs.push({ id: `home_w${w}_m${mag}`, family: 'home_away',
      adjust: s => 1 + w * (s.is_home === 1 ? mag : s.is_home === 0 ? -mag : 0) });
  }
  for (const w of CONTEXT_WEIGHTS) for (const mag of REST_MAGNITUDES) {
    specs.push({ id: `rest_w${w}_m${mag}`, family: 'rest',
      adjust: s => 1 + w * ((s.is_short_week === 1 ? -mag : 0) + (s.is_off_bye === 1 ? mag : 0)) });
  }
  for (const w of CONTEXT_WEIGHTS) for (const mag of WEATHER_MAGNITUDES) {
    specs.push({ id: `weather_w${w}_m${mag}`, family: 'weather',
      adjust: s => 1 + w * ((s.is_cold === 1 ? -mag : 0) + (s.is_windy === 1 ? -mag : 0)) });
  }
  return specs;
}

const contextCache = new Map();
function contextFor(season, week, team) {
  const key = `${season}|${week}|${team}`;
  if (contextCache.has(key)) return contextCache.get(key);
  const c = gameContext(season, week, team) ?? {};
  contextCache.set(key, c);
  return c;
}

function contextHeadReplay(metricKey, season, specs) {
  const cfg = PROP_METRIC_CONFIG[metricKey];
  const out = [];
  const actualWeeks = playerWeeks(season).filter(p => p.week >= 2);
  for (const week of [...new Set(actualWeeks.map(p => p.week))].sort((a, b) => a - b)) {
    const engine = buildPlayerWeekEngine({ season, week });
    for (const actual of actualWeeks.filter(p => p.week === week)) {
      const projection = playerWeekProjection(engine, actual.player_id);
      if (!projection || !actual.opponent) continue;
      const gs = gameScriptFor(actual.team, season, week);
      const mult = gs?.line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
      const p = playerWeekEventExpectation(projection, { mult });
      if (!cfg.eligible(p)) continue;
      const structural = p.events[cfg.eventKey];
      const actualValue = actual.features[cfg.actualField] ?? 0;
      const signals = contextFor(season, week, actual.team);

      const candidateHeads = { structural, active_champion: structural };
      const dvpByK = new Map(DVP_K.map(k => [k, dvpMult(metricKey, season, actual.opponent, projection.position, k)]));
      for (const spec of specs) {
        const m = spec.family === 'opponent_dvp' ? dvpByK.get(spec.dvpK) : null;
        candidateHeads[spec.id] = spec.id === 'structural' ? structural : structural * spec.adjust(signals, m);
      }
      out.push({ season, week, player_id: actual.player_id, position: projection.position,
        candidate_heads: candidateHeads, actual: actualValue });
    }
  }
  return out;
}

/**
 * Discovery-only by design (no `openValidation` flag at all, unlike the
 * player-head/prop-head audits): this is a first pass over a genuinely large
 * grid, and 2025 should stay sealed until a smaller, pre-registered survivor
 * set is decided on deliberately, not swept in the same run as ~200 candidates.
 */
export function auditContextHeads(metricKey, { developmentSeason = 2023, discoverySeason = 2024,
  redundancy = 0.985, minN = 250, alpha = 0.05 } = {}) {
  if (!PROP_METRIC_CONFIG[metricKey]) throw new Error(`unknown prop metric: ${metricKey}`);
  const specs = candidateSpecs();
  const development = contextHeadReplay(metricKey, developmentSeason, specs);
  const discovery = contextHeadReplay(metricKey, discoverySeason, specs);
  const candidates = specs.map(spec => ({ head: { id: spec.id, family: spec.family },
    development: metrics(development, spec.id), discovery: metrics(discovery, spec.id) }));
  const champion = { head: { id: 'active_champion' },
    development: metrics(development, 'active_champion'), discovery: metrics(discovery, 'active_champion') };

  const ordered = candidates.filter(x => x.head.id !== 'structural' && x.discovery.n >= minN && x.discovery.coverage >= 0.8)
    .sort((a, b) => a.discovery.mae - b.discovery.mae);
  const kept = [], redundant = [];
  for (const candidate of ordered) {
    const duplicate = kept.find(other => Math.abs(correlation(discovery, candidate.head.id, other.head.id)) >= redundancy);
    if (duplicate) redundant.push({ id: candidate.head.id, duplicate_of: duplicate.head.id,
      correlation: +correlation(discovery, candidate.head.id, duplicate.head.id).toFixed(5) });
    else kept.push(candidate);
  }

  const tested = kept.map(candidate => ({
    ...candidate,
    significance: signFlipP(discovery, candidate.head.id),
    rank_ok: candidate.discovery.spearman >= champion.discovery.spearman - 0.002,
    accuracy_ok: candidate.discovery.mae < champion.discovery.mae
  }));
  holmDecisions(tested, alpha); // corrected across the FULL tested batch — the more candidates, the stricter the bar
  const survivors = tested.filter(x => x.accuracy_ok && x.rank_ok && x.holm?.passed);

  return {
    metric: metricKey, development_season: developmentSeason, discovery_season: discoverySeason,
    grid_size: specs.length,
    baseline: { id: 'active_champion', development: champion.development, discovery: champion.discovery },
    candidates_tested: tested.length, candidates_redundant: redundant.length,
    redundant, discovery: tested, survivors: survivors.map(x => x.head.id),
    survivors_by_family: [...new Set(survivors.map(x => tested.find(t => t.head.id === x)?.head.family))],
    validation_opened: false,
    note: `Discovery only over a ${specs.length}-candidate grid (opponent DvP x weight x shrinkage, home/away, rest, weather). ` +
      '2025 stays sealed pending a deliberate, pre-registered survivor set — not swept in the same run as this large a grid.'
  };
}
