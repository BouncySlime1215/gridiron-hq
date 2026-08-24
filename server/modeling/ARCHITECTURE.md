# Modeling and intelligence consolidation map

## Confirmed repository state

- `origin/feat/model-honest-rebuild` contains `origin/agent/nfl-blind-model-hub` at commit `00bc744`; it is 32 commits ahead, not a competing divergent branch.
- Existing fantasy projections use a transparent volume × efficiency model in `server/services/projections.js` and historical usage from nflverse.
- Existing betting replay/risk-gate logic is separate from fantasy projection auditing. Its strict-prior evidence, deterministic replay, calibration gate, and failure-retention principles must remain independent gates in the consolidated system.
- `/api/model/projections` and the player projection endpoint select the first database league when no explicit context is supplied. This is a confirmed active-league defect.
- Existing news storage lacks canonical URLs, complete source timestamps, normalized entity links, dedupe groups, reliability metadata, and classification provenance. Manual AI analysis can be represented as a source, which violates attribution requirements.
- Existing `FormationView` is a static roster/depth-chart diagram rather than a play explorer.
- This worktree has no installed frontend dependencies; production build verification currently stops at `vite: command not found`.

## Target boundary

`server/modeling` is the versioned orchestration boundary:

1. Timestamped observations enter through schema/leakage validation.
2. Walk-forward folds train only on periods strictly before each evaluation period.
3. All eligible prediction attempts persist, including failures, inactive players, and zero-point busts.
4. The latest complete season stays sealed until an explicitly authorized one-time holdout evaluation.
5. The registry stores immutable configuration hashes and lifecycle state.
6. Promotion is atomic and requires schema, leakage, data quality, baseline improvement, and test gates.
7. Existing honest-model evidence and blind risk-gate validation remain separate inputs to these gates; neither can overwrite the other.

`server/news` normalizes source attribution and identity before hub personalization. `client/src/features/news` renders only attributed stories with original links. `client/src/features/xo` labels concepts as observed only when a source says so; otherwise they are explicitly modeled.

## Integration and rollback

The new modules are additive and currently unmounted. Integration should occur after protected router/database reconciliation:

- mount Model Lab routes against `SqliteModelStore`;
- require explicit league context in both projection endpoints using `requireLeagueId`;
- migrate legacy news rows without inventing source URLs (mark them unavailable/degraded);
- mount the feature modules through the reconciled application shell;
- keep old routes available behind a feature flag for rollback;
- rollback production models by atomically moving `model_production_pointer` to the previous completed version.

No historical audit results can be reported until trustworthy five-season input snapshots are present. The pipeline correctly reports missing data rather than manufacturing metrics.

