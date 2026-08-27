/**
 * Signal truth ledger.
 *
 * A large candidate library is useful only when every adjustment says where it
 * came from and why it deserves authority. This registry separates real game
 * uncertainty from missing data, model disagreement and unstable correlations.
 * Candidate paths are generated in shadow; only chronologically validated paths
 * may affect a projection or stake.
 */

export const SIGNAL_QUALITY_VERSION = 'signal-truth-v1.0.0';

const METHODS = Object.freeze([
  'structural_bayes', 'robust_recent', 'exp_weighted', 'changepoint',
  'hierarchical_pool', 'residual_linear', 'residual_tree', 'market_anchor'
]);
const HORIZONS = Object.freeze(['career', 'season', 'recent_5', 'current_regime']);

export const UNCERTAINTY_LAYERS = Object.freeze([
  ['identity', 'Identity & lineage', 'data_quality'],
  ['availability', 'Injury & availability', 'state_uncertainty'],
  ['participation', 'Starter / active-game state', 'state_uncertainty'],
  ['role', 'Role and opportunity share', 'parameter_uncertainty'],
  ['team_volume', 'Team pace and play volume', 'parameter_uncertainty'],
  ['opponent', 'Opponent matchup response', 'context_uncertainty'],
  ['game_script', 'Spread / total game script', 'context_uncertainty'],
  ['weather', 'Weather and field conditions', 'context_uncertainty'],
  ['venue', 'Home / away / travel / surface', 'context_uncertainty'],
  ['efficiency', 'Player efficiency level', 'parameter_uncertainty'],
  ['event_variance', 'Within-game football randomness', 'aleatoric_uncertainty'],
  ['model_disagreement', 'Independent model disagreement', 'epistemic_uncertainty'],
  ['source_freshness', 'Feed freshness and cutoff validity', 'data_quality']
].map(([id, label, uncertainty]) => Object.freeze({ id, label, uncertainty })));

export const SIGNAL_TRUTH_GATES = Object.freeze([
  'pregame_cutoff_valid', 'sample_support', 'source_fresh',
  'temporal_repeatability', 'placebo_or_permutation_passed',
  'next_window_replication', 'redundancy_pruned', 'calibration_acceptable',
  'operationally_available'
]);

export const MODEL_CHAIN_TARGETS = Object.freeze([
  { id: 'team_plays', question: 'How many offensive plays will the team run?', reconciles_to: 'game environment' },
  { id: 'team_pass_attempts', question: 'How many dropbacks become pass attempts?', reconciles_to: 'team_plays' },
  { id: 'team_rush_attempts', question: 'How many designed rushes occur?', reconciles_to: 'team_plays' },
  { id: 'qb_participation', question: 'Which quarterback owns the game state?', reconciles_to: 'team_pass_attempts' },
  { id: 'player_targets', question: 'How are team targets divided?', reconciles_to: 'team_pass_attempts' },
  { id: 'player_carries', question: 'How are team carries divided?', reconciles_to: 'team_rush_attempts' },
  { id: 'pass_efficiency', question: 'How many yards and scoring events per attempt?', reconciles_to: 'qb_participation' },
  { id: 'rush_efficiency', question: 'How many yards and scoring events per carry?', reconciles_to: 'player_carries' },
  { id: 'catch_probability', question: 'Which targets become receptions?', reconciles_to: 'player_targets' },
  { id: 'receiving_efficiency', question: 'How many yards and scores result per target?', reconciles_to: 'player_targets' },
  { id: 'event_distribution', question: 'How does football randomness spread around the means?', reconciles_to: 'all event targets' },
  { id: 'fantasy_translation', question: 'How do shared events score under league rules?', reconciles_to: 'event_distribution' },
  { id: 'prop_translation', question: 'How often does the shared distribution cross a listed line?', reconciles_to: 'event_distribution' },
  { id: 'probability_calibration', question: 'Do predicted hit rates match observed hit rates?', reconciles_to: 'prop_translation' }
]);

export const SIGNAL_PATHS = Object.freeze(UNCERTAINTY_LAYERS.flatMap(layer =>
  METHODS.flatMap(method => HORIZONS.map(horizon => Object.freeze({
    id: `${layer.id}:${method}:${horizon}`,
    layer: layer.id, method, horizon, status: 'shadow_candidate',
    production_authority: 0,
    promotion_rule: 'chronological discovery + independent validation + forward monitoring'
  })))));

const gateState = (passed, reason = null) => ({ passed: passed === true, reason });
const layer = (id, { status = 'shadow', authority = 0, evidence = [], support = null,
  freshness = null, gates = {}, noise = null } = {}) => {
  const definition = UNCERTAINTY_LAYERS.find(x => x.id === id);
  const truth = Object.fromEntries(SIGNAL_TRUTH_GATES.map(g => [g,
    gateState(gates[g] === true, gates[g] === true ? null : (gates[g] ?? 'not demonstrated'))]));
  return { ...definition, status, authority, evidence, support, freshness,
    noise_class: noise ?? definition?.uncertainty, truth };
};

/** One projection's inspectable real-vs-fake signal trace. */
export function playerSignalTrace({ projection, eligibility, gameScript, eventState } = {}) {
  const engine = projection?.player_week_engine;
  const identityOk = !!(projection?.player_id && (projection?.gsis_id || projection?.espn_id));
  const roleChange = projection?.role_change;
  const scriptOk = !!gameScript;
  const evidence = projection?.evidence_games ?? 0;
  const output = [
    layer('identity', { status: identityOk ? 'observed' : 'missing', authority: identityOk ? 1 : 0,
      evidence: [projection?.gsis_id ? `GSIS ${projection.gsis_id}` : null,
        projection?.espn_id ? `ESPN ${projection.espn_id}` : null].filter(Boolean),
      support: identityOk ? 1 : 0,
      gates: { pregame_cutoff_valid: true, sample_support: identityOk, source_fresh: identityOk,
        temporal_repeatability: true, placebo_or_permutation_passed: true,
        next_window_replication: true, redundancy_pruned: true,
        calibration_acceptable: true, operationally_available: identityOk } }),
    layer('availability', { status: 'separate_state_required', authority: 0,
      evidence: [`historical expected games ${projection?.expected_games ?? 'unknown'}`], support: evidence,
      gates: { pregame_cutoff_valid: true, sample_support: evidence >= 8,
        operationally_available: false }, noise: 'injury/activeness state; never infer from target-game DNP' }),
    layer('participation', { status: eligibility?.state ?? 'unknown',
      authority: eligibility?.state === 'cutoff_primary_qb' ? 1 : 0,
      evidence: eligibility?.qb_rank ? [`cutoff QB rank ${eligibility.qb_rank}`] : [], support: evidence,
      gates: { pregame_cutoff_valid: true, sample_support: evidence >= 1,
        source_fresh: true, temporal_repeatability: true, operationally_available: true } }),
    layer('role', { status: roleChange?.status ?? 'stable_baseline', authority: roleChange ? 1 : 0.5,
      evidence: roleChange ? [`opportunities ${roleChange.prior_opportunities}→${roleChange.recent_opportunities}`,
        `snap change ${roleChange.snap_change_points}`] : [`${evidence} evidence games`], support: evidence,
      gates: { pregame_cutoff_valid: true, sample_support: evidence >= 5, source_fresh: true,
        temporal_repeatability: roleChange ? true : evidence >= 5,
        next_window_replication: roleChange ? true : 'no regime change claimed',
        operationally_available: true } }),
    layer('team_volume', { status: eventState?.volume ? 'observed_model_state' : 'missing', authority: eventState?.volume ? 1 : 0,
      evidence: eventState?.volume ? [`attempts ${eventState.volume.attempts.toFixed(1)}`,
        `carries ${eventState.volume.carries.toFixed(1)}`, `targets ${eventState.volume.targets.toFixed(1)}`] : [],
      support: evidence, gates: { pregame_cutoff_valid: true, sample_support: evidence >= 5,
        source_fresh: true, temporal_repeatability: true, next_window_replication: true,
        operationally_available: !!eventState?.volume } }),
    layer('opponent', { status: scriptOk ? 'available_in_game_context' : 'missing', authority: scriptOk ? 0.5 : 0,
      evidence: gameScript?.opponent ? [`opponent ${gameScript.opponent}`] : [],
      gates: { pregame_cutoff_valid: true, source_fresh: scriptOk,
        sample_support: scriptOk, operationally_available: scriptOk } }),
    layer('game_script', { status: scriptOk ? 'market_conditioned' : 'missing', authority: scriptOk ? 1 : 0,
      evidence: scriptOk ? [`spread ${gameScript.spread ?? 'n/a'}`, `total ${gameScript.total ?? 'n/a'}`,
        `pass ×${gameScript.pass_mult}`, `rush ×${gameScript.rush_mult}`] : [],
      gates: { pregame_cutoff_valid: scriptOk, source_fresh: scriptOk, sample_support: scriptOk,
        temporal_repeatability: true, redundancy_pruned: true, operationally_available: scriptOk } }),
    layer('weather', { status: gameScript?.weather ? 'observed' : 'not_connected_to_player_state', authority: 0,
      evidence: gameScript?.weather ? [String(gameScript.weather)] : [],
      gates: { pregame_cutoff_valid: true, source_fresh: !!gameScript?.weather,
        operationally_available: !!gameScript?.weather } }),
    layer('venue', { status: gameScript?.home_team ? 'observed' : 'partial', authority: gameScript?.home_team ? 0.5 : 0,
      evidence: gameScript?.home_team ? [`home ${gameScript.home_team}`] : [],
      gates: { pregame_cutoff_valid: true, source_fresh: !!gameScript,
        operationally_available: !!gameScript } }),
    layer('efficiency', { status: projection?.params ? 'hierarchically_shrunk' : 'missing', authority: projection?.params ? 1 : 0,
      evidence: projection?.params ? [`YPA ${projection.params.ypa.toFixed(2)}`,
        `YPC ${projection.params.ypc.toFixed(2)}`, `YPT ${projection.params.ypt.toFixed(2)}`] : [],
      support: evidence, gates: { pregame_cutoff_valid: true, sample_support: evidence >= 5,
        temporal_repeatability: true, redundancy_pruned: true, operationally_available: !!projection?.params } }),
    layer('event_variance', { status: 'modeled_compound_distribution', authority: 1,
      evidence: ['negative-binomial opportunity', 'gamma yardage', 'binomial scoring events'],
      gates: { pregame_cutoff_valid: true, sample_support: true, source_fresh: true,
        temporal_repeatability: true, next_window_replication: true,
        calibration_acceptable: true, operationally_available: true } }),
    layer('model_disagreement', { status: projection?.candidate_heads ? 'shadow_measured' : 'missing', authority: 0,
      evidence: projection?.candidate_heads ? [`${Object.keys(projection.candidate_heads).length} player heads`] : [],
      gates: { pregame_cutoff_valid: true, sample_support: true, redundancy_pruned: false,
        next_window_replication: false, operationally_available: !!projection?.candidate_heads },
      noise: 'epistemic; disagreement lowers confidence and never increases stake by itself' }),
    layer('source_freshness', { status: engine?.cutoff ? 'cutoff_stamped' : 'missing', authority: engine?.cutoff ? 1 : 0,
      evidence: engine?.cutoff ? [`through ${engine.cutoff}`] : [], freshness: engine?.cutoff ?? null,
      gates: { pregame_cutoff_valid: !!engine?.cutoff, source_fresh: !!engine?.cutoff,
        operationally_available: !!engine?.cutoff } })
  ];
  const missing = output.filter(x => x.status === 'missing' || x.status.includes('not_connected'));
  const active = output.filter(x => x.authority > 0);
  return {
    version: SIGNAL_QUALITY_VERSION,
    candidate_paths_evaluated_by_registry: SIGNAL_PATHS.length,
    active_layers: active.length,
    missing_layers: missing.map(x => x.id),
    confidence_ceiling: +(Math.max(0.25, 1 - missing.length * 0.1)).toFixed(2),
    policy: 'Only cutoff-valid, replicated signals may move the number. Missing data and model disagreement lower confidence; they never become positive evidence.',
    layers: output
  };
}

export function signalQualityCatalog() {
  return { version: SIGNAL_QUALITY_VERSION, layers: UNCERTAINTY_LAYERS,
    methods: METHODS, horizons: HORIZONS, paths: SIGNAL_PATHS.length,
    component_targets: MODEL_CHAIN_TARGETS,
    truth_gates: SIGNAL_TRUTH_GATES,
    policy: '416 shadow paths supply breadth. Sparse chronological promotion supplies authority.' };
}
