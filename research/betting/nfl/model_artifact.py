"""Model artifact creation, versioning and reload for NFL spread models.

This is the master plan's **WP12** ("Weekly nested training and OOF lineage")
and **WP04**'s "Model artifact" logical-record contract
(`docs/CLAUDE-NEXT-STEPS.md` section 4.1's "Forecast" contract row; the
master plan's WP04 table row: "Model artifact | Algorithm/settings,
preprocessing, feature contract, fitted state, train-through instant,
upstream model IDs, calibrator/combiner IDs and content hash").

Stage 3 (`stage3_team_strength.py`, committed `c72206f`) ran a ONE-OFF
comparison report: fit-and-score inside a single Python process, print a
verdict, never save the fitted model. Neither ridge nor LightGBM beat the
market baseline there -- that finding is NOT re-litigated here. This module
does not re-run that comparison, does not add features, and does not decide
whether a model is "good enough" to bet with. It builds the missing
plumbing underneath any future answer to that question: given a predeclared
candidate and a declared training cutoff, FIT it once, SAVE it in a
versioned, inspectable, reloadable form with full provenance, and reload it
later with integrity/contract checks that refuse to silently misload it.

WHAT THIS DOES NOT DO (read before assuming more than this delivers):

  * NO live decision-serving connection. This produces artifacts on disk
    under `research/betting/nfl/artifacts/`; nothing in the live app (the
    Node server, `nfl-ensemble.js`, the T-60 packet/decision pipeline) reads
    them. Wiring a served prediction into the app is WP15, explicitly future
    work, not this module.
  * Ridge only, by default. Stage 3's LightGBM path exists in
    `stage3_team_strength.py` and could be given the same
    save/reload/verify treatment, but was not attempted here -- ridge
    working correctly and saved reproducibly was the stated priority.
    `fit_and_save(..., algorithm='lightgbm')` raises `NotImplementedError`.
  * No calibrator, no combiner, no upstream learned-feature model. This is a
    single first-stage regressor on `stage3_team_strength.FEATURE_NAMES`.
    The metadata sidecar carries `calibrator_id`/`combiner_id`/
    `upstream_model_ids` fields (per the WP04 contract row) all set to
    null/empty, honestly, rather than omitted.
  * No hyperparameter search beyond Stage 3's own already-frozen 3-alpha
    grid, selected via the SAME inner-chronological-validation method Stage
    3 already implements (`stage3_team_strength._inner_split`). This module
    does not invent a new search.

FEATURE REUSE. `row_features`, `feature_matrix`, `_ridge_pipeline`,
`_inner_split`, `FEATURE_NAMES`, `RIDGE_ALPHAS` and `SEED` are imported
directly from `stage3_team_strength.py`, not reimplemented -- this module
owns saving/versioning/reloading/scheduling, not feature engineering.

TRAINING-ROW ELIGIBILITY -- A NOTE ON WHAT WAS ACTUALLY REUSED. The task
that produced this module asked for `dataset.eligible_training_rows`
reused directly. Reading it (`dataset.py` lines ~255-279) shows it filters
on `r['market']` and `r.get('label_at')` -- fields that exist on
`build_betting_dataset`/`paired_quotes`-shaped rows (as consumed by
`market_lab.py`/`tree_lab.py`), confirmed absent from
`build_football_dataset`'s row shape (which carries `decision_at`, the
game's own kickoff, and no `label_at`/`market` at all -- confirmed by
reading `build_football_dataset`'s row-construction block). Calling
`eligible_training_rows` directly against football-dataset rows would
silently return an empty list every time (`stamp(r.get('label_at'))` is
always `None` for these rows), which is exactly the kind of silent
mismatch this project's own conventions warn against creating.

So `eligible_football_rows` below is new glue code, but the two numbers
that actually matter -- the settlement lag and the timestamp parser -- are
`dataset.RESULT_PUBLICATION_LAG` and `dataset.stamp`, imported and used
verbatim, not reinvented. It mirrors `eligible_training_rows`'s own
two-condition contract (season strictly earlier; label settled strictly
before the cutoff), adapted to the field this dataset actually has.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import mean_absolute_error

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dataset as shared_dataset  # noqa: E402
import stage3_team_strength as stage3  # noqa: E402

SCHEMA = 'nfl-model-artifact-v1'
DEFAULT_ARTIFACT_ROOT = Path(__file__).resolve().parent / 'artifacts'


class ArtifactError(Exception):
    """Base class for artifact load/verify failures."""


class ArtifactIntegrityError(ArtifactError):
    """The saved model file's bytes do not match its recorded content hash."""


class ArtifactFeatureMismatchError(ArtifactError):
    """The artifact's feature list/order does not match what the caller expects."""


# --------------------------------------------------------------------------
# Code / config hashing
# --------------------------------------------------------------------------

def compute_code_hash(files):
    """sha256 over the given files' names and bytes, sorted by name.

    Same pattern `stage3_team_strength.py` already uses for its own `run_id`
    (hash itself), extended here to cover both files that actually determine
    a fit's behavior: the feature/pipeline code it imports from, and this
    module's own saving/eligibility/CLI code.
    """
    h = hashlib.sha256()
    for f in sorted((Path(p) for p in files), key=lambda p: p.name):
        h.update(f.name.encode('utf-8'))
        h.update(b'\0')
        h.update(f.read_bytes())
    return h.hexdigest()


def _default_code_files():
    here = Path(__file__).resolve().parent
    return [Path(stage3.__file__), Path(shared_dataset.__file__), Path(__file__),
            here / 'unified_model.py', here.parents[1] / 'expert_selector_lab.py']


def compute_config_hash(meta):
    """A deterministic hash of the fields that define WHAT was fit, excluding
    wall-clock/run identity fields (`run_id`, `created_at`) and the model's
    own serialized-byte hash (that is a separate, independently-checked
    integrity field, not part of "what configuration produced this fit").

    Two fits with identical code, cutoff, dataset and hyperparameter
    selection produce the same `config_content_hash` even if their
    `run_id`/`created_at`/directory differ -- this is the field the
    idempotency tests actually compare.
    """
    training_row_ids_hash = hashlib.sha256(
        json.dumps(meta['training_row_ids'], sort_keys=True).encode('utf-8')).hexdigest()
    payload = {
        'code_hash': meta['code_hash'],
        'feature_names': meta['feature_names'],
        'algorithm': meta['algorithm'],
        'hyperparameters': meta['hyperparameters'],
        'training_cutoff': meta['training_cutoff'],
        'dataset_version': meta['dataset_version'],
        'seed': meta.get('seed'),
        'min_season': meta['min_season'],
        'through_season_query_cap': meta['through_season_query_cap'],
        'n_training_rows': meta['n_training_rows'],
        'training_row_ids_hash': training_row_ids_hash,
        'training_data_hash': meta.get('training_data_hash'),
        'packages': meta.get('packages'),
        'target': meta.get('target'),
        'preprocessing_steps': meta.get('preprocessing_steps'),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode('utf-8')).hexdigest()


# --------------------------------------------------------------------------
# Cutoff resolution and eligibility (see module docstring's note on why this
# is new glue rather than a direct call to dataset.eligible_training_rows)
# --------------------------------------------------------------------------

def resolve_cutoff(rows, *, through_date=None, through_season=None, through_week=None):
    """Resolve a declared fit-through cutoff into (instant, before_season_cap).

    Exactly one of `through_date` or `through_season` must be supplied.

    * `through_date`: parsed directly via `dataset.stamp` as the cutoff
      instant. No season cap -- `eligible_football_rows`'s per-row
      settlement check does the entire job.
    * `through_season` (+ optional `through_week`): the cutoff instant is
      one second AFTER the LATEST `(decision_at + dataset.RESULT_PUBLICATION_LAG)`
      among rows at or before that season/week, read back off the
      already-built `rows` -- the exact "ready" formula
      `dataset.build_chronology` applies to every game, just reused rather
      than recomputed against a second database read. The `+1 second` is
      necessary, not cosmetic: `eligible_football_rows` requires a row's own
      settlement to be STRICTLY before the cutoff, so without the buffer the
      single latest-settling game in the requested window would coincide
      exactly with the cutoff and be excluded from its own "through this
      season" request -- confirmed against the real database (1999-2025):
      without this buffer, `--through-season 2025` silently dropped exactly
      one row, the actual final game of the 2025 season (`2025 wk22 NE@SEA`),
      from its own declared training window. `before_season` is set to
      `through_season + 1` as a whole-season belt-and-braces cap that holds
      alongside the instant-level cap, not instead of it.
    """
    if (through_date is None) == (through_season is None):
        raise ValueError('pass exactly one of through_date or through_season')
    if through_date is not None:
        instant = shared_dataset.stamp(through_date)
        if instant is None:
            raise ValueError(f'unparseable through_date: {through_date!r}')
        return instant, None

    candidates = []
    for r in rows:
        if r['season'] > through_season:
            continue
        if r['season'] == through_season and through_week is not None and r['week'] > through_week:
            continue
        day = shared_dataset.stamp(r['decision_at'])
        if day is not None:
            candidates.append(day + shared_dataset.RESULT_PUBLICATION_LAG)
    if not candidates:
        raise ValueError(f'no rows found at or before season={through_season} week={through_week}')
    instant = max(candidates) + timedelta(seconds=1)
    before_season = through_season + 1
    return instant, before_season


def eligible_football_rows(rows, cutoff_instant, before_season=None):
    """Rows from `build_football_dataset()` legal to fit on at `cutoff_instant`.

    Two conditions, mirroring `dataset.eligible_training_rows`'s own
    contract: the row's season is strictly earlier than `before_season`
    (when given), and the row's own OUTCOME must have settled --
    `decision_at + dataset.RESULT_PUBLICATION_LAG` -- strictly before the
    cutoff instant. `RESULT_PUBLICATION_LAG` is imported from `dataset.py`
    unmodified, not reinvented.
    """
    out = []
    for r in rows:
        if before_season is not None and r['season'] >= before_season:
            continue
        day = shared_dataset.stamp(r['decision_at'])
        if day is None:
            continue
        settled = day + shared_dataset.RESULT_PUBLICATION_LAG
        if settled >= cutoff_instant:
            continue
        out.append(r)
    return out


# --------------------------------------------------------------------------
# Fitting (reuses stage3_team_strength's feature/pipeline code directly)
# --------------------------------------------------------------------------

def fit_ridge_artifact(rows, *, feature_names=None, alpha_grid=None, seed=None):
    """Fit ridge on `rows` (already eligible/cutoff-filtered), selecting alpha
    via Stage 3's own inner-chronological-validation split
    (`stage3_team_strength._inner_split`) over Stage 3's own predeclared
    3-alpha grid (`stage3_team_strength.RIDGE_ALPHAS`) unless overridden.

    Returns `(fitted_pipeline, model_meta)`. `model_meta` carries the
    alpha-selection trial record (every grid point, not just the winner --
    matching Stage 3's own reporting discipline) plus the fields needed to
    fill in the metadata sidecar's `algorithm`/`hyperparameters`/
    `preprocessing_steps`/`seed`.
    """
    alpha_grid = list(alpha_grid) if alpha_grid is not None else list(stage3.RIDGE_ALPHAS)
    seed = stage3.SEED if seed is None else seed
    names = list(feature_names) if feature_names is not None else list(stage3.FEATURE_NAMES)

    for r in rows:
        r['_features'] = stage3.row_features(r, feature_names=names)

    inner_train, inner_val = stage3._inner_split(rows)
    if inner_val:
        first_validation = min(shared_dataset.stamp(r['decision_at']) for r in inner_val)
        inner_train = eligible_football_rows(inner_train, first_validation)
    train_ids = {(r['season'], r['week'], r['home'], r['away']) for r in inner_train}
    if train_ids.intersection((r['season'], r['week'], r['home'], r['away']) for r in inner_val):
        raise ValueError('same game appears in inner training and validation')
    trials = []
    if inner_train and inner_val:
        Xtr = stage3.feature_matrix(inner_train, feature_names=names)
        ytr = np.array([r['actual_margin'] for r in inner_train], dtype=float)
        Xval = stage3.feature_matrix(inner_val, feature_names=names)
        yval = np.array([r['actual_margin'] for r in inner_val], dtype=float)
        for alpha in alpha_grid:
            model = stage3._ridge_pipeline(alpha).fit(Xtr, ytr)
            inner_mae = float(mean_absolute_error(yval, model.predict(Xval)))
            trials.append({'alpha': alpha, 'inner_mae': inner_mae})
        best = min(trials, key=lambda t: t['inner_mae'])
        selection_method = 'inner_chronological_validation'
    else:
        # Too little history for an 80/20 chronological inner split (only
        # possible with a very small/synthetic training set). Fall back to
        # the middle of the predeclared grid and say so explicitly rather
        # than silently fitting on an empty inner split.
        trials = [{'alpha': a, 'inner_mae': None} for a in alpha_grid]
        best = trials[len(trials) // 2]
        selection_method = 'insufficient_history_for_inner_split_used_grid_midpoint'

    Xfull = stage3.feature_matrix(rows, feature_names=names)
    yfull = np.array([r['actual_margin'] for r in rows], dtype=float)
    final_model = stage3._ridge_pipeline(best['alpha'])
    final_model.fit(Xfull, yfull)

    model_meta = {
        'algorithm': 'ridge',
        'feature_names': names,
        'hyperparameters': {'alpha': best['alpha']},
        'alpha_grid': alpha_grid,
        'alpha_selection_method': selection_method,
        'alpha_trials': trials,
        'inner_train_weeks': len({(r['season'], r['week']) for r in inner_train}),
        'inner_val_weeks': len({(r['season'], r['week']) for r in inner_val}),
        'inner_training_row_ids': [f"{r['season']}-w{r['week']:02d}-{r['home']}@{r['away']}" for r in inner_train],
        'inner_validation_row_ids': [f"{r['season']}-w{r['week']:02d}-{r['home']}@{r['away']}" for r in inner_val],
        'preprocessing_steps': [name for name, _ in final_model.steps[:-1]],
        'seed': seed,
        # IDs alone cannot distinguish corrected labels/features for the same
        # games. Hash the effective training values, including explicit nulls.
        'training_data_hash': hashlib.sha256(json.dumps([
            {'game': [r['season'], r['week'], r['home'], r['away']],
             'features': r['_features'], 'target': r['actual_margin']}
            for r in rows
        ], sort_keys=True, allow_nan=False).encode('utf-8')).hexdigest(),
    }
    return final_model, model_meta


def fit_unified_artifact(rows, *, feature_names=None):
    from unified_model import fit_unified
    return fit_unified(rows, feature_names=feature_names)


ALGORITHM_FITTERS = {
    'ridge': fit_ridge_artifact,
    'unified_margin': fit_unified_artifact,
}


# --------------------------------------------------------------------------
# Save / load / verify
# --------------------------------------------------------------------------

def _atomic_write_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_bytes(data)
    tmp.replace(path)


def _atomic_write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False, default=str))
    tmp.replace(path)


def _cutoff_tag(training_cutoff):
    """A short, human-scannable fragment for the run_id, e.g. `s2025` for a
    whole-season cutoff or a date fragment for a date-based one. Purely
    cosmetic -- uniqueness/idempotency comes from the content hash appended
    to it in `save_artifact`, not from this tag."""
    season = training_cutoff.get('through_season_arg')
    week = training_cutoff.get('through_week_arg')
    if season is not None:
        return f's{season}' + (f'w{week}' if week is not None else '')
    date_arg = training_cutoff.get('through_date_arg') or training_cutoff.get('fit_through_instant')
    if date_arg:
        return str(date_arg)[:10].replace('-', '').replace(':', '')
    return 'cutoff'


def save_artifact(output_root, *, model, model_meta, feature_names, dataset_version,
                   training_cutoff, training_row_ids, min_season, through_season_query_cap,
                   code_files=None, target='actual_margin (home score - away score)',
                   extra_meta=None):
    """Serialize `model` (joblib) plus a JSON metadata sidecar to
    `<output_root>/<run_id>/`. Returns `(artifact_dir, meta)`.

    Metadata carries every field WP04's "Model artifact" contract row
    requires: algorithm/settings, preprocessing, feature contract, fitted
    state (the model file itself), train-through instant, upstream model
    IDs, calibrator/combiner IDs (null -- none exist yet, stated honestly)
    and a content hash -- plus the code hash and dataset version this task
    additionally specified.

    IDENTITY / IDEMPOTENCY. `run_id` (and therefore the artifact directory)
    is CONTENT-ADDRESSED: `<algorithm>-<cutoff-tag>-<config_content_hash
    prefix>`, not a wall-clock timestamp. Fitting again with the exact same
    code, cutoff and eligible training rows reproduces the exact same
    `config_content_hash` and therefore the exact same `run_id` -- calling
    this function again with that identical content is a NO-OP that returns
    the already-saved artifact rather than erroring or creating a duplicate.
    An attempt to write a DIFFERENT artifact to an already-occupied run_id
    (a real hash collision, or a corrupted existing directory) still raises
    `FileExistsError` rather than silently overwriting evidence. An earlier
    version of this function used a timestamp-based run_id and that
    ONLY failed to collide by accident (two genuinely identical back-to-back
    fits landing in different clock-seconds); content-addressing makes the
    idempotency guarantee actually hold by construction instead of by luck.
    """
    output_root = Path(output_root)
    code_files = code_files if code_files is not None else _default_code_files()
    created_at = datetime.now(timezone.utc)

    buf = io.BytesIO()
    joblib.dump(model, buf)
    model_bytes = buf.getvalue()
    model_hash = hashlib.sha256(model_bytes).hexdigest()
    code_hash = compute_code_hash(code_files)

    packages = {}
    required_packages = ['scikit-learn', 'numpy', 'joblib']
    if model_meta.get('algorithm') == 'unified_margin':
        required_packages += ['lightgbm', 'scipy']
    for pkg in required_packages:
        try:
            packages[pkg] = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            packages[pkg] = None

    meta = {
        'schema': SCHEMA,
        'created_at': created_at.isoformat(),
        'target': target,
        'feature_names': list(feature_names),
        'feature_contract_source': 'stage3_team_strength.FEATURE_NAMES'
            if list(feature_names) == list(stage3.FEATURE_NAMES) else 'caller-supplied feature_names',
        'dataset_version': dataset_version,
        'training_cutoff': training_cutoff,
        'n_training_rows': len(training_row_ids),
        'training_row_ids': training_row_ids,
        'min_season': min_season,
        'through_season_query_cap': through_season_query_cap,
        'code_hash': code_hash,
        'code_files_hashed': sorted(Path(p).name for p in code_files),
        'model_content_hash': model_hash,
        'upstream_model_ids': [],
        'calibrator_id': None,
        'combiner_id': None,
        'authority': 'research_only',
        'production_changed': False,
        'serves_live_decisions': False,
        'packages': packages,
        **model_meta,
    }
    if extra_meta:
        meta.update(extra_meta)
    config_hash = compute_config_hash(meta)
    meta['config_content_hash'] = config_hash

    run_id = f"{meta.get('algorithm', 'model')}-{_cutoff_tag(training_cutoff)}-{config_hash[:12]}"
    meta['run_id'] = run_id
    artifact_dir = output_root / run_id

    if artifact_dir.exists():
        existing_meta_path = artifact_dir / 'metadata.json'
        existing_model_path = artifact_dir / 'model.joblib'
        if existing_meta_path.exists() and existing_model_path.exists():
            existing_meta = json.loads(existing_meta_path.read_text())
            existing_model_hash = hashlib.sha256(existing_model_path.read_bytes()).hexdigest()
            if existing_model_hash == model_hash and existing_meta.get('config_content_hash') == config_hash:
                return artifact_dir, existing_meta  # idempotent no-op: identical content already saved
        raise FileExistsError(
            f'artifact directory {artifact_dir} already exists with DIFFERENT content than this fit '
            'produced -- refusing to overwrite. This should only happen from a genuine content-hash '
            'collision or a corrupted prior save; it is not expected in normal operation.')

    artifact_dir.mkdir(parents=True, exist_ok=False)
    _atomic_write_bytes(artifact_dir / 'model.joblib', model_bytes)
    _atomic_write_json(artifact_dir / 'metadata.json', meta)
    return artifact_dir, meta


def load_artifact(artifact_dir, *, expected_feature_names=None, verify_hash=True):
    """Reload a saved artifact: `(model, meta)`.

    Refuses (raises) rather than silently loading:
      * `ArtifactIntegrityError` if the model file's bytes do not hash to
        the value recorded in `metadata.json` at save time -- catches
        truncation, disk corruption or tampering.
      * `ArtifactFeatureMismatchError` if `expected_feature_names` is given
        and does not match the artifact's own recorded feature list AND
        ORDER exactly -- catches the "silently-wrong feature ordering"
        failure mode named in the task (a caller assembling a feature
        vector in the wrong order against a model that expects a specific
        order would otherwise get a confidently wrong prediction).
    """
    artifact_dir = Path(artifact_dir)
    meta_path = artifact_dir / 'metadata.json'
    model_path = artifact_dir / 'model.joblib'
    if not meta_path.exists() or not model_path.exists():
        raise ArtifactError(f'incomplete artifact directory (missing metadata.json or model.joblib): {artifact_dir}')

    meta = json.loads(meta_path.read_text())
    model_bytes = model_path.read_bytes()

    if verify_hash:
        actual_hash = hashlib.sha256(model_bytes).hexdigest()
        expected_hash = meta.get('model_content_hash')
        if actual_hash != expected_hash:
            raise ArtifactIntegrityError(
                f'model content hash mismatch for {artifact_dir}: metadata.json records '
                f'{expected_hash!r}, the saved model.joblib actually hashes to {actual_hash!r}. '
                'Refusing to load a corrupted or tampered artifact.')

    if expected_feature_names is not None:
        actual_features = meta.get('feature_names')
        if list(expected_feature_names) != actual_features:
            raise ArtifactFeatureMismatchError(
                f'feature list/order mismatch for {artifact_dir}: this artifact was fit on '
                f'{actual_features!r}, caller expects {list(expected_feature_names)!r}. Refusing '
                'to load with a silently misaligned feature contract.')

    model = joblib.load(io.BytesIO(model_bytes))
    return model, meta


# --------------------------------------------------------------------------
# Weekly-fit entry point
# --------------------------------------------------------------------------

def fit_and_save(db_path, *, through_season=None, through_week=None, through_date=None,
                  min_season=1999, output_root=DEFAULT_ARTIFACT_ROOT, algorithm='ridge',
                  rows=None, feature_names=None):
    """Build the eligible training set for a declared fit-through cutoff, fit
    ONE candidate (ridge by default), and save it as a versioned artifact.

    `rows` may be passed directly (already the output of
    `build_football_dataset(...)['rows']`, or an equivalent in-memory
    fixture) to avoid a real database read -- used by the test suite.
    Otherwise this opens a READ-ONLY connection to `db_path` via
    `dataset.build_football_dataset` (never writes to it) and never touches
    `output_root` for anything but this module's own artifact files.

    `feature_names` defaults to `stage3.FEATURE_NAMES` -- the frozen 14 every
    existing baseline was measured on -- so every prior caller reproduces its
    exact artifact ID. Pass `stage3.EXTENDED_FEATURE_NAMES` (or any other
    list) to fit on a different feature set; it is recorded in the artifact's
    own identity, so a model fitted on a different set cannot collide with,
    or silently be mistaken for, one fitted on another.
    """
    if algorithm not in ALGORITHM_FITTERS:
        raise NotImplementedError(
            f'algorithm={algorithm!r} is not implemented; only {sorted(ALGORITHM_FITTERS)} today. '
            'Ridge working correctly and saved reproducibly was this task\'s stated priority; '
            'LightGBM artifact support (Stage 3 already has the fitting code in `_lgb_model`) '
            'is explicitly left for a future pass.')

    if through_season is not None:
        query_cap_season = through_season
    elif through_date is not None:
        parsed = shared_dataset.stamp(through_date)
        query_cap_season = parsed.year if parsed is not None else 2025
    else:
        raise ValueError('must supply through_season or through_date')

    dataset_version = None
    if rows is None:
        dataset = shared_dataset.build_football_dataset(
            db_path, min_season=min_season, through_season=query_cap_season)
        rows = dataset['rows']
        dataset_version = dataset['dataset_version']
    else:
        dataset_version = shared_dataset.DATASET_VERSION + '-football'

    cutoff_instant, before_season = resolve_cutoff(
        rows, through_date=through_date, through_season=through_season, through_week=through_week)
    eligible = eligible_football_rows(rows, cutoff_instant, before_season=before_season)
    if not eligible:
        raise ValueError(
            f'no eligible training rows for cutoff={cutoff_instant.isoformat()} '
            f'(through_season={through_season}, through_week={through_week}, through_date={through_date})')

    names = list(feature_names) if feature_names is not None else list(stage3.FEATURE_NAMES)
    model, model_meta = ALGORITHM_FITTERS[algorithm](eligible, feature_names=names)

    training_row_ids = [f"{r['season']}-w{r['week']:02d}-{r['home']}@{r['away']}" for r in eligible]
    training_cutoff = {
        'fit_through_instant': cutoff_instant.isoformat(),
        'through_season_arg': through_season,
        'through_week_arg': through_week,
        'through_date_arg': through_date,
        'before_season_cap': before_season,
    }

    artifact_dir, meta = save_artifact(
        output_root,
        model=model, model_meta=model_meta,
        feature_names=names, dataset_version=dataset_version,
        training_cutoff=training_cutoff, training_row_ids=training_row_ids,
        min_season=min_season, through_season_query_cap=query_cap_season,
    )
    return artifact_dir, meta


def _main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True, help='path to the (read-only opened) sqlite database')
    p.add_argument('--through-season', type=int, default=None)
    p.add_argument('--through-week', type=int, default=None)
    p.add_argument('--through-date', type=str, default=None)
    p.add_argument('--min-season', type=int, default=1999)
    p.add_argument('--output', type=str, default=str(DEFAULT_ARTIFACT_ROOT))
    p.add_argument('--algorithm', type=str, default='ridge')
    args = p.parse_args(argv)

    artifact_dir, meta = fit_and_save(
        args.db, through_season=args.through_season, through_week=args.through_week,
        through_date=args.through_date, min_season=args.min_season,
        output_root=Path(args.output), algorithm=args.algorithm)

    print(json.dumps({
        'artifact_dir': str(artifact_dir),
        'run_id': meta['run_id'],
        'algorithm': meta['algorithm'],
        'hyperparameters': meta['hyperparameters'],
        'n_training_rows': meta['n_training_rows'],
        'training_cutoff': meta['training_cutoff'],
        'dataset_version': meta['dataset_version'],
        'code_hash': meta['code_hash'],
        'model_content_hash': meta['model_content_hash'],
        'config_content_hash': meta['config_content_hash'],
    }, indent=2), flush=True)
    return meta


if __name__ == '__main__':
    _main()
