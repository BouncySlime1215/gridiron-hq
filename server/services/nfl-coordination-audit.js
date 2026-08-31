/** Machine-readable audit of what actually reaches the NFL betting decision. */
import { latestCoverCalibration } from './nfl-cover-calibration.js';
import { nflOnlineNeuralStatus } from './nfl-online-neural.js';
import { nflRiskLabStatus } from './nfl-risk-lab.js';
import { signalReliabilityStatus } from './nfl-signal-reliability.js';

const DECISION_VERSION = 'coordinated-market-residual-v1';

export function nflCoordinationAudit() {
  const neural = nflOnlineNeuralStatus();
  const calibration = latestCoverCalibration(9999, DECISION_VERSION);
  const risk = nflRiskLabStatus();
  const reliability = signalReliabilityStatus();
  const components = [
    { id: 'raw_ensemble', target: 'final margin', connection: 'evidence_only',
      influence: 'Supplies component residuals and disagreement; raw consensus cannot directly create a pick.' },
    { id: 'market_residual_base', target: 'actual margin minus market margin', connection: 'production_connected',
      influence: 'Canonical production baseline. It equals the market unless prior residual skill passes.' },
    { id: 'pattern_reliability', target: 'per-signal residual harm', connection: 'research_path_only',
      influence: `${reliability.adjusted?.length ?? 0} signals currently shrunk in raw candidate replays; it does not alter the canonical residual answer yet.` },
    { id: 'online_neural', target: 'market residual', connection: 'candidate_connected_production_gated',
      influence: `${neural.trained ?? 0} trained examples; candidate forecasts consume it now, production requires its forward interval gate.` },
    { id: 'risk_lab', target: 'market residual and uncertainty', connection: 'shadow_disconnected',
      influence: 'Predictions are captured and trained but do not enter the coordinated decision until one model passes its own gate.',
      detail: risk },
    { id: 'roster_availability', target: 'position-group availability', connection: 'indirect_connected',
      influence: 'Feeds component evidence and the neural vector; aggregate roster value has no direct betting authority.' },
    { id: 'verified_news', target: 'typed availability and role context', connection: 'indirect_connected',
      influence: 'Feeds the neural vector only after source verification; quarantined prose has zero numeric authority.' },
    { id: 'cover_calibration', target: 'price-aware cover probability',
      connection: calibration?.metrics?.forward_gate_passed ? 'production_connected' : 'missing_for_decision_version',
      influence: calibration ? 'Version-matched calibration exists.'
        : 'The old raw-ensemble calibration is intentionally rejected because it does not match the coordinated residual head.' },
    { id: 'reasoning_ai', target: 'human explanation', connection: 'post_decision_only',
      influence: 'Translates the frozen arithmetic packet after selection and cannot change a number or side.' }
  ];
  const blockers = components.filter(item => ['shadow_disconnected', 'missing_for_decision_version', 'research_path_only']
    .includes(item.connection));
  return {
    version: DECISION_VERSION,
    verdict: 'The system is now routed through one market-residual decision head, but it does not yet have a version-matched profitable probability calibration or a promoted adaptive learner.',
    hard_truths: [
      'The prior engine registry coordinated version labels, not inference. Several registered heads never reached the betting decision.',
      'The raw ensemble optimized final-score margin while the bankroll question is incremental cover value versus the posted spread.',
      'The auto-pick board and play-by-play projection previously used different blend modes.',
      'Historical cover calibration belonged to the raw ensemble and cannot authorize a newly coordinated residual head.',
      'More working subsystems do not create edge unless their outputs meet at one target, one cutoff and one decision policy.'
    ],
    components, blockers,
    canonical_flow: ['verified pregame evidence', 'component forecasts', 'market-residual base',
      'gated adaptive residual', 'version-matched cover probability', 'frozen policy',
      'immutable shadow/forward ledger', 'post-decision explanation'],
    production_state: calibration?.metrics?.forward_gate_passed && neural.production_eligible
      ? 'review_eligible' : 'abstain_no_proven_edge'
  };
}
