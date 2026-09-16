# Saved margin-model scoring

The Node app can now call the saved Stage 3 ridge pipeline through
`trainedMarginFamilyForecast(request, options)` or the standalone command below.
It uses Python's original imputation, scaling and prediction, with no second
implementation of the fitted model.

This is **reconstructed research scoring**. It does not yet score prospective
T-60 observations, create bets, join the production ensemble, or supply cover
probabilities. The `tree_lab.py` cover classifier is a different artifact and
still has no serving bridge. A margin prediction is not a cover probability.

## Interpreter

Set `GRIDIRON_RESEARCH_PYTHON` to the full path of the research Python executable,
or create `research/.venv`. An explicit `--python` argument takes precedence.
The worker refuses a saved model if its recorded scikit-learn, numpy or joblib
versions differ from the actual interpreter. A successful import alone does
not establish that a saved model is compatible.

The existing `ridge-s2025-2896e94d5302` artifact records scikit-learn 1.7.2,
numpy 2.5.3 and joblib 1.6.0. The original research environment matched all three
when checked on September 15. Keep that artifact unchanged; use a new artifact
identity for refits or changed dependencies.

## Freeze and replay

Use `score_artifact.make_score_request(dataset_row, artifact_dir)` in Python to
retain the existing Stage 3 transformation's ordered feature names, actual
values, explicit missing values, game/cutoff, transformation hash, model hash
and metadata hash. Save the returned JSON. No labels enter this request.
The builder refuses to re-date an already computed row to a different cutoff.
The current football dataset uses historical game-date cutoffs; these are not
prospective T-60 receipt evidence.

```sh
node scripts/score-nfl-artifact.mjs \
  --request /absolute/path/to/frozen-request.json \
  --python /absolute/path/to/research/python
```

The default artifact root is `research/betting/nfl/artifacts`. Supply
`--artifact-root` for a different trusted local collection. The request names
one artifact ID, never an arbitrary path or a mutable `latest` pointer.
Joblib files must be trusted local training outputs.

Results retain the request hash, exact artifact references, runtime versions
and unrounded margin. Missing artifacts, metadata/model mutations, invalid
features, reordered columns, same/later training cutoffs, incompatible runtimes,
timeouts and worker failures produce explicit unavailable results. The result
is always unqualified research evidence. No database is opened by the scorer.

## Verification

```sh
export GRIDIRON_RESEARCH_PYTHON=/absolute/path/to/research/python
"$GRIDIRON_RESEARCH_PYTHON" -m unittest discover -s research/betting/nfl -p 'test_*.py'
npm test
```

The JavaScript integration test uses a real fitted fixture and the real Python
worker, with temporary artifacts and the suite's isolated database. Without a
configured research interpreter it reports an explicit skip. Configure the
interpreter in CI before treating that check as passing there; the existing
Node-only CI environment has not been extended in this slice.

The September 15 saved-model check replayed all 16 completed 2026 Week 1 games
through Node and direct Python: maximum absolute prediction difference **0**.
That checks implementation parity. It is not a registered model comparison,
prospective observation, or profitability result.

## Next integration work

1. Build and freeze the same features for upcoming games, with immutable source
   values and receipt lineage. The aggregate map in the incumbent T-60 packet
   is not automatically the Stage 3 feature contract.
2. Add earlier-only weekly fit/artifact selection and retain every scoring or
   abstention result. Do not use a later artifact for an earlier game.
3. Fit and identify a probability calibrator on earlier out-of-fold predictions;
   evaluate it before connecting a margin model to priced decisions.
4. Connect this path to the scheduled shadow decision tape and error reports,
   then demonstrate replay after underlying tables and model pointers change.
5. Adapt the separate cover classifier with its feature order, fitted
   preprocessing, conditional/no-push target and calibration preserved.
