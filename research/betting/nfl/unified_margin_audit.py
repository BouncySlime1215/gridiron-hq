"""Audit of the unified margin model against the market, refit weekly.

What this answers: over real history, refitting every week on only what had
settled before that week's production fit slot, does `unified_model`'s learned
blend predict game margin better than the market line on the *same* games?

─────────────────────────────────────────────────────────────────────────────
NOT ANOTHER WALK-FORWARD ENGINE

This repository already has four things that walk a calendar forward, and a
fifth would be exactly the "several disagreeing implementations of one idea"
failure its own GitHub catalog documents. This file is deliberately none of
them, and deliberately owns no statistics of its own:

  - `server/services/weekly-walkforward.js` refits weekly too, but it fits a
    hand-rolled JS ridge on football-first features, targets the residual
    AGAINST the spread, filters to games clearing a `minLean` threshold, and
    grades ATS hit rate against a break-even. That is a BETTING-selection
    measurement of a DIFFERENT model. This file scores every eligible game
    with no selection threshold, targets raw margin, and reports prediction
    error -- and it does it for the Python `unified_margin` recipe, which is
    what production now actually serves and which no JS engine can fit.
  - `stage3_team_strength.run_expanding_folds` refits once per SEASON and
    compares ridge and LightGBM as separate candidates. Production refits
    weekly and serves one learned combination of them; an annual study of the
    components is not evidence about the weekly pipeline.
  - `server/services/purged-walk-forward.js` is the season-level purge rule
    (López de Prado ch.7) other callers apply to their own feature windows.
    Eligibility here is already time-based and production's own
    (`eligible_football_rows`), so there is nothing for it to purge.
  - `server/modeling/walk-forward.js` requires timestamped player-level
    observations and seals the latest season as an unopened holdout; these
    rows are per-game and the whole point is to grade every week.

Uncertainty is likewise NOT reimplemented here. `predictions.json` emits the
per-game paired errors and the week cluster key, which is precisely the input
`server/services/backtest-significance.js`'s `pairedBootstrapDiff(a, b,
{ groups })` already takes -- the one tested, already-corrected block
bootstrap in the project. `scripts/unified-margin-audit-significance.mjs`
runs it. A second bootstrap living in Python would be a second thing to keep
right, and the first one has a bug fix this one would not have inherited.

Three properties this file is built around:

  1. NO LOOK-AHEAD. Each test week's training set is
     `eligible_football_rows(rows, weekly_origin(first decision of that week))`
     -- production's own slot function and production's own eligibility rule,
     not a reimplementation. A game whose result had not published by the fit
     slot is not in that week's training set, including games from the test
     week itself.
  2. EVERY GAME IS ACCOUNTED FOR. A week the recipe legitimately refuses to
     fit (too little history for its chronological blocks) records an
     abstention with the refusal reason for each of that week's games. A week
     is never silently dropped, and an abstention is never scored as a
     prediction.
  3. THE COMPARISON IS PAIRED. Headline metrics are computed on common
     support -- games where the market quote also exists -- so the candidate
     and the market are never compared across different game sets.

What this is NOT evidence for. `market_spread` here is the stored historical
spread, not a verified decision-time executable quote, so nothing in this
report is a betting result, a profit estimate, or a claim about realizable
edge. It measures margin prediction only. It is also development data by
construction: this history has been inspected repeatedly. A negative result
is a valid completion.
"""
import argparse
import copy
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import dataset as shared_dataset
import market_correction as mc
import model_artifact as ma
import stage3_team_strength as stage3
import unified_model as um
import weekly_training as weekly

SCHEMA = 'nfl-unified-margin-audit-v1'
SEED = 30717  # same fixed seed as stage3; nothing here is stochastic beyond the fitters

NOMINAL_INTERVAL_COVERAGE = 0.80  # what UnifiedMarginModel.describe()'s interval_80 claims

# The existing, tested block bootstrap that turns this audit's per-game paired
# errors into an interval. Named here so the report can point at exactly one
# implementation rather than describing a method this file does not own.
SIGNIFICANCE_TOOL = ('server/services/backtest-significance.js pairedBootstrapDiff '
                     "with groups=fit_week, via scripts/unified-margin-audit-significance.mjs")

# Predeclared before the first run against real data. Each group is derived
# ONLY from information available at the fit slot (schedule, rest, venue and
# the market's own quote) -- never from the outcome being scored.
DIAGNOSTIC_GROUPS = {
    'season_phase_early_weeks_1_6': lambda r: r['week'] <= 6,
    'season_phase_mid_weeks_7_13': lambda r: 7 <= r['week'] <= 13,
    'season_phase_late_weeks_14_18': lambda r: 14 <= r['week'] <= 18,
    'postseason_weeks_19_plus': lambda r: r['week'] >= 19,
    'divisional_game': lambda r: bool(r.get('div_game')),
    'indoor_roof': lambda r: r.get('roof') in ('dome', 'closed'),
    'rest_advantage_3plus_days': lambda r: abs((r.get('home_rest') or 0) - (r.get('away_rest') or 0)) >= 3,
    'market_near_pick_em_under_3': lambda r: r.get('market_spread') is not None and abs(r['market_spread']) < 3,
    'market_double_digit_favorite': lambda r: r.get('market_spread') is not None and abs(r['market_spread']) >= 10,
}

# A group with fewer than this many scored games is reported but explicitly
# marked inconclusive rather than read as a finding.
MIN_GROUP_GAMES = 100


def protocol(min_test_season, through_season, correction_recipe=None, availability_path=None,
             qb_quality_path=None):
    """The predeclared experiment. Written to disk BEFORE any result exists."""
    recipe = correction_recipe or mc.RECIPE_V1
    return {
        'schema': SCHEMA,
        'question': 'Does the unified_margin weekly-refit blend beat the market line on '
                    'margin MAE, on the same games, under earlier-only training?',
        'candidate': 'unified_model.fit_unified (RECIPE below), refit once per test week',
        'recipe': um.RECIPE,
        'baselines': {
            'market': 'negated stored historical spread (-market_spread)',
            'zero_information': "mean actual_margin of that week's own training set",
        },
        'scheme': {
            'granularity': 'one refit per (season, week)',
            'cutoff': 'weekly_training.weekly_origin(earliest decision_at in the test week) '
                      '-- production\'s Wednesday-noon America/New_York fit slot',
            'eligibility': 'model_artifact.eligible_football_rows (decision_at + '
                           'dataset.RESULT_PUBLICATION_LAG strictly before the cutoff)',
            'test_week_exclusion': "the test week's own games can never satisfy that rule",
        },
        'secondary_candidate': {
            'name': 'market_correction.fit_market_correction (recipe below), refit on the same '
                    'weekly training set, scored on the same test week, abstaining independently',
            'recipe': recipe,
            'availability_path': str(availability_path) if availability_path else None,
            'qb_quality_path': str(qb_quality_path) if qb_quality_path else None,
            'baselines': ['market', 'football_alone (the correction head\'s own base model)'],
            'decision_rule': 'must beat BOTH baselines on the same games to be more than a '
                             'research candidate; beating football-alone without beating the '
                             'market proves nothing about betting',
        },
        'horizons': {
            'model_weights': 'fit at the Wednesday-noon slot; only outcomes published '
                             '(gameday + RESULT_PUBLICATION_LAG) strictly before that slot',
            'row_features': "as of that game's own kickoff, under the same publication lag "
                            '(dataset.build_football_dataset: decision_at = gameday)',
            'market_baseline_and_correction_features': 'the stored CLOSING line (kickoff '
                'horizon). correction-vs-market is horizon-matched; correction-vs-football_alone '
                'is not (the correction head sees the close, football-alone does not)',
        },
        'primary_metric': 'MAE of predicted margin vs actual_margin, on common support with the market',
        'secondary_metrics': ['RMSE', 'signed bias', f'empirical coverage of the nominal '
                              f'{NOMINAL_INTERVAL_COVERAGE:.0%} interval'],
        'uncertainty': f'not computed in this module; {SIGNIFICANCE_TOOL}',
        'diagnostic_groups': sorted(DIAGNOSTIC_GROUPS),
        'min_group_games_before_reading_a_group': MIN_GROUP_GAMES,
        'decision_rule': 'Report the measured result. A result where the market wins is a '
                         'valid completion and does not license further searching for a '
                         'configuration that wins.',
        'explicitly_not_claimed': [
            'betting profitability (no verified decision-time executable quotes are used)',
            'prospective validity (this history is development data)',
        ],
        'window': {'min_test_season': min_test_season, 'through_season': through_season},
        'seed': SEED,
        'authority': 'research_only',
    }


def code_identity():
    """sha256 of every module whose code produces a number in the report.

    `market_correction` is in the list because the report carries the
    correction head's own numbers; a provenance hash that omitted the file
    producing half the results would not identify the run.
    """
    files = [Path(m.__file__) for m in (shared_dataset, ma, mc, stage3, um, weekly)] + [Path(__file__)]
    return {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(files, key=lambda p: p.name)}


def rows_in_window(rows, min_test_season=None, through_season=None):
    """The games `run_walk_forward` is obliged to account for -- same filter."""
    return [r for r in rows
            if (min_test_season is None or r['season'] >= min_test_season)
            and (through_season is None or r['season'] <= through_season)]


def check_accounting(rows, week_records, scored_rows, min_test_season=None, through_season=None):
    """Every game in the window is scored or named in an abstention -- exactly once.

    Property 2 in the module docstring, enforced at the end of a run rather
    than trusted. Returns the count of window games; raises if a game went
    missing or was counted twice between the dataset and the report.
    """
    expected = len(rows_in_window(rows, min_test_season, through_season))
    abstained = sum(len(w.get('abstained_games', ())) for w in week_records if not w['fitted'])
    if len(scored_rows) + abstained != expected:
        raise AssertionError(
            f'accounting broke: {len(scored_rows)} scored + {abstained} abstained != '
            f'{expected} games in the evaluation window')
    ids = [stage3_row_id(r) for r in scored_rows]
    if len(set(ids)) != len(ids):
        raise AssertionError('accounting broke: a game was scored more than once')
    return expected


def week_cutoff(test_rows):
    """Production's own fit slot for the week these games belong to."""
    earliest = min(shared_dataset.stamp(r['decision_at']) for r in test_rows)
    return weekly.weekly_origin(earliest.isoformat())


def fit_identity(meta):
    """Per-week model identity, without the megabyte-scale row-id lists."""
    lineage = meta['component_lineage']
    return {
        'algorithm': meta['algorithm'],
        'ridge_alpha': meta['hyperparameters']['ridge_alpha'],
        'lightgbm_params': meta['hyperparameters']['lightgbm'],
        'learned_weights': dict(zip(um.RECIPE['families'], meta['hyperparameters']['weights'])),
        'training_data_hash': meta['training_data_hash'],
        'calibrator_id': meta['calibrator_id'],
        'combiner_id': meta['combiner_id'],
        'n_base_rows': len(lineage['base_selection_row_ids']),
        'n_combination_rows': len(lineage['combination_row_ids']),
        'n_calibration_rows': len(lineage['calibration_row_ids']),
        'calibration_weeks': lineage['calibration_weeks'],
    }


def run_walk_forward(rows, min_test_season=None, through_season=None, progress=None,
                      score_market_correction=True, correction_recipe=None):
    """Refit once per week; return (week_records, scored_rows).

    `week_records` has one entry per test week -- fitted or abstained, never
    omitted. `scored_rows` is every game that received a prediction, carrying
    its own predictions for the pooled tables. Games in an abstained week
    appear in that week's record with a reason and are NOT in `scored_rows`,
    so an abstention can never be silently scored as if it were a forecast.

    `score_market_correction`: also fit `market_correction.fit_market_correction`
    on the SAME weekly training set the unified model just used, and score it
    on the same test week. This is a SEPARATE, independently-abstaining
    candidate -- the market-correction head needs market-evidenced rows the
    unified model doesn't, so a week can have `fitted=True` for one and
    `correction_fitted=False` for the other, and both are recorded honestly
    rather than one silently gating the other.

    `correction_recipe`: forwarded to `fit_market_correction` unchanged --
    `market_correction.RECIPE_V1` (default), `RECIPE_V2` (adds the two
    availability-deficit columns; RUNBOOK §4.1) or `RECIPE_V3` (adds the two
    starting-QB-quality columns on top of V2's own). Rows only carry a
    recipe's extra keys at all if the caller built the dataset with the
    matching `availability_path=...` / `qb_quality_path=...`
    (`dataset.build_football_dataset`) -- passing a richer recipe against
    rows that never got that treatment reads the missing columns as NaN on
    every row, which degenerates to the next-simpler recipe's own fit rather
    than erroring.
    """
    for r in rows:
        if '_features' not in r:
            r['_features'] = stage3.row_features(r)
        r.setdefault('_market_pred', (-r['market_spread']) if r.get('market_spread') is not None else None)

    by_week = {}
    for r in rows:
        by_week.setdefault((r['season'], r['week']), []).append(r)

    week_records, scored_rows = [], []
    for key in sorted(by_week):
        season, week = key
        if min_test_season is not None and season < min_test_season:
            continue
        if through_season is not None and season > through_season:
            continue
        test_rows = by_week[key]
        cutoff = week_cutoff(test_rows)
        train = ma.eligible_football_rows(rows, cutoff)

        record = {
            'season': season, 'week': week,
            'fit_cutoff': cutoff.isoformat(),
            'n_games_in_week': len(test_rows),
            'n_training_rows': len(train),
            'n_training_weeks': len({(r['season'], r['week']) for r in train}),
        }
        # A test-week game leaking into its own training set would invalidate
        # the whole run, so assert it structurally rather than trusting the
        # eligibility rule from a distance.
        leaked = [r for r in train if (r['season'], r['week']) == key]
        if leaked:
            raise AssertionError(
                f'{len(leaked)} game(s) from test week {key} entered its own training set '
                f'at cutoff {cutoff.isoformat()} -- eligibility is broken, refusing to continue')

        try:
            model, meta = um.fit_unified(train)
        except (ValueError, RuntimeError) as exc:
            record.update(fitted=False, abstention_reason=f'{type(exc).__name__}: {exc}',
                          abstained_games=[stage3_row_id(r) for r in test_rows])
            week_records.append(record)
            if progress:
                progress(record)
            continue

        zero_info = float(np.mean([r['actual_margin'] for r in train]))
        X = stage3.feature_matrix(test_rows)
        predicted = model.predict(X)
        for r, pred in zip(test_rows, predicted):
            described = model.describe(stage3.feature_matrix([r]))
            lo, hi = described['interval_80']
            r['_unified_pred'] = float(pred)
            r['_zero_info_pred'] = zero_info
            r['_interval_lo'], r['_interval_hi'] = float(lo), float(hi)
            r['_interval_covered'] = bool(lo <= r['actual_margin'] <= hi)
            r['_fit_week'] = f'{season}-w{week:02d}'
            scored_rows.append(r)

        record.update(fitted=True, zero_information_baseline=zero_info, model=fit_identity(meta))

        if score_market_correction:
            # Independent copy: fit_market_correction reassigns `_features`
            # on whatever rows it's given, which must not disturb the
            # unified model's own `_features` on the same objects above.
            try:
                correction_model, correction_meta = mc.fit_market_correction(
                    copy.deepcopy(train), recipe=correction_recipe)
                record['correction_fitted'] = True
                record['correction_model'] = {
                    'football_alpha': correction_meta['hyperparameters']['football_alpha'],
                    'correction_alpha': correction_meta['hyperparameters']['correction_alpha'],
                    'combination_rows_dropped_no_market_evidence':
                        correction_meta['lineage']['combination_rows_dropped_no_market_evidence'],
                    'features_used': correction_meta['lineage']['correction_features_used'],
                    'features_dropped_insufficient_support':
                        correction_meta['lineage']['correction_features_dropped_insufficient_support'],
                }
                test_copy = [copy.deepcopy(r) for r in test_rows]
                for r2 in test_copy:
                    r2['_features'] = stage3.row_features(r2, feature_names=stage3.FEATURE_NAMES)
                corrected = correction_model.predict_rows(test_copy)
                football_alone = correction_model.football_model.predict(
                    stage3.feature_matrix(test_copy)) if test_copy else []
                for r, cp, fp in zip(test_rows, corrected, football_alone):
                    r['_correction_pred'] = cp  # None when this specific game has no market evidence
                    r['_football_alone_pred'] = float(fp)
            except (ValueError, RuntimeError) as exc:
                record['correction_fitted'] = False
                record['correction_abstention_reason'] = f'{type(exc).__name__}: {exc}'

        week_records.append(record)
        if progress:
            progress(record)

    return week_records, scored_rows


def stage3_row_id(r):
    return f"{r['season']}-w{r['week']:02d}-{r['home']}@{r['away']}"


def common_support(rows):
    """Games where the market quote exists -- the only fair comparison set."""
    return [r for r in rows if r.get('_market_pred') is not None]


def metric_block(rows):
    return {
        'n_games': len(rows),
        'n_weeks': len({r['_fit_week'] for r in rows}),
        'unified': stage3.paired_metrics(rows, 'actual_margin', '_unified_pred'),
        'market': stage3.paired_metrics(rows, 'actual_margin', '_market_pred'),
        'zero_information': stage3.paired_metrics(rows, 'actual_margin', '_zero_info_pred'),
    }


def interval_coverage(rows):
    if not rows:
        return {'n': 0, 'nominal': NOMINAL_INTERVAL_COVERAGE, 'empirical': None}
    covered = sum(1 for r in rows if r['_interval_covered'])
    return {
        'n': len(rows), 'nominal': NOMINAL_INTERVAL_COVERAGE,
        'empirical': covered / len(rows),
        'mean_width': float(np.mean([r['_interval_hi'] - r['_interval_lo'] for r in rows])),
        'note': 'split-conformal style interval from the calibration block; coverage here is '
                'in-sample to the audit window and carries no guarantee on dependent future games',
    }


def paired_difference(rows):
    """The point estimate only. The INTERVAL is not computed here on purpose.

    `SIGNIFICANCE_TOOL` already implements the week-clustered block bootstrap
    this comparison needs, is tested, and carries a correction a second
    implementation would not inherit. This returns the observed difference
    and the counts, and says where the interval comes from.
    """
    support = common_support(rows)
    if not support:
        return {'n_games': 0, 'point_estimate': None}
    unified = float(np.mean([abs(r['_unified_pred'] - r['actual_margin']) for r in support]))
    market = float(np.mean([abs(r['_market_pred'] - r['actual_margin']) for r in support]))
    return {
        'statistic': 'unified_mae_minus_market_mae (negative favors the unified model)',
        'point_estimate': unified - market,
        'unified_mae': unified,
        'market_mae': market,
        'n_games': len(support),
        'n_weeks': len({r['_fit_week'] for r in support}),
        'interval_not_computed_here': SIGNIFICANCE_TOOL,
        'cluster_key': 'fit_week (games within one week are not independent draws)',
    }


def correction_support(rows):
    """Games with a scored market-correction prediction -- a strict subset of
    `common_support`: it also needs that WEEK's correction head to have
    fitted at all, and that specific game to carry market evidence."""
    return [r for r in rows if r.get('_correction_pred') is not None]


def correction_metric_block(rows):
    support = correction_support(rows)
    return {
        'n_games': len(support),
        'n_weeks': len({r['_fit_week'] for r in support}),
        'correction': stage3.paired_metrics(support, 'actual_margin', '_correction_pred'),
        'football_alone': stage3.paired_metrics(support, 'actual_margin', '_football_alone_pred'),
        'market': stage3.paired_metrics(support, 'actual_margin', '_market_pred'),
    }


def correction_paired_difference(rows, against):
    """Same shape as `paired_difference`, scoped to `correction_support` and
    comparing the correction head against either 'market' or
    'football_alone' -- both baselines the plan requires beating before this
    is anything but a research candidate. The INTERVAL is deliberately not
    computed here either; see `paired_difference`'s own docstring.
    """
    if against not in ('market', 'football_alone'):
        raise ValueError("against must be 'market' or 'football_alone'")
    key = '_market_pred' if against == 'market' else '_football_alone_pred'
    support = correction_support(rows)
    if not support:
        return {'n_games': 0, 'point_estimate': None}
    correction = float(np.mean([abs(r['_correction_pred'] - r['actual_margin']) for r in support]))
    baseline = float(np.mean([abs(r[key] - r['actual_margin']) for r in support]))
    return {
        'statistic': f'correction_mae_minus_{against}_mae (negative favors the correction head)',
        'point_estimate': correction - baseline,
        'correction_mae': correction, f'{against}_mae': baseline,
        'n_games': len(support), 'n_weeks': len({r['_fit_week'] for r in support}),
        'interval_not_computed_here': SIGNIFICANCE_TOOL,
        'cluster_key': 'fit_week (games within one week are not independent draws)',
    }


def group_table(rows):
    out = {}
    support = common_support(rows)
    for name, predicate in sorted(DIAGNOSTIC_GROUPS.items()):
        selected = [r for r in support if predicate(r)]
        block = metric_block(selected) if selected else {'n_games': 0}
        block['inconclusive_small_sample'] = len(selected) < MIN_GROUP_GAMES
        out[name] = block
    return out


def correction_group_table(rows):
    """Same predeclared groups, scoped to `correction_support` -- a smaller
    set than `group_table`'s, since correction scoring additionally needs a
    fitted correction head that week and market evidence on that game."""
    out = {}
    support = correction_support(rows)
    for name, predicate in sorted(DIAGNOSTIC_GROUPS.items()):
        selected = [r for r in support if predicate(r)]
        block = correction_metric_block(selected) if selected else {'n_games': 0}
        block['inconclusive_small_sample'] = len(selected) < MIN_GROUP_GAMES
        out[name] = block
    return out


def build_verdict(overall, comparison, coverage, correction_overall=None,
                   correction_vs_market=None, correction_vs_football=None):
    u, m, z = overall['unified'], overall['market'], overall['zero_information']
    if not u['n']:
        return 'No week produced a scored prediction; there is no result to report.'
    lines = [
        f"Weekly refit over {overall['n_weeks']} weeks and {overall['n_games']} "
        f"games on common support with the market.",
        f"Unified margin model: MAE {u['mae']:.3f} / RMSE {u['rmse']:.3f} / bias {u['bias']:+.3f}.",
        f"Market baseline: MAE {m['mae']:.3f} / RMSE {m['rmse']:.3f} / bias {m['bias']:+.3f}.",
        f"Zero-information baseline: MAE {z['mae']:.3f}.",
    ]
    diff = comparison.get('point_estimate')
    if diff is not None:
        better = 'lower' if diff < 0 else 'higher'
        lines.append(
            f"The unified model's MAE is {abs(diff):.3f} points/game {better} than the market's. "
            'Whether that difference survives week-clustered resampling is NOT decided here: run '
            f'{SIGNIFICANCE_TOOL} over predictions.json. A point difference without that interval '
            'is not a finding, in either direction.')
    if coverage.get('empirical') is not None:
        lines.append(
            f"The nominal {coverage['nominal']:.0%} interval covered "
            f"{coverage['empirical']:.1%} of outcomes (mean width {coverage['mean_width']:.1f} "
            'points). Coverage measured inside the audit window is not a guarantee on future '
            'dependent games.')
    if correction_overall and correction_overall.get('n_games'):
        co = correction_overall
        lines.append(
            f"Market-correction head (Phase 1): over {co['n_games']} market-evidenced games, "
            f"correction MAE {co['correction']['mae']:.3f}, football-alone MAE "
            f"{co['football_alone']['mae']:.3f}, market MAE {co['market']['mae']:.3f}.")
        for label, comp in (('the market', correction_vs_market), ('football-alone', correction_vs_football)):
            d = (comp or {}).get('point_estimate')
            if d is not None:
                better = 'lower' if d < 0 else 'higher'
                lines.append(f"Correction vs {label}: {abs(d):.3f} points/game {better} "
                    f"(interval not computed here; see {SIGNIFICANCE_TOOL}).")
        lines.append(
            'Per Stage 3\'s own rule, the correction head must beat BOTH baselines on the same '
            'games to be anything more than a research candidate -- beating football-alone without '
            'beating the market proves nothing about betting.')
    return ' '.join(lines)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False, default=str))
    tmp.replace(path)


def run(args):
    out_dir = Path(args.output)
    started = datetime.now(timezone.utc)

    correction_recipe = {'v1': mc.RECIPE_V1, 'v2': mc.RECIPE_V2, 'v3': mc.RECIPE_V3}[args.correction_recipe]
    spec = protocol(args.min_test_season, args.through_season,
                     correction_recipe=correction_recipe, availability_path=args.availability,
                     qb_quality_path=args.qb_quality)
    protocol_hash = hashlib.sha256(json.dumps(spec, sort_keys=True, default=str).encode()).hexdigest()
    run_id = started.strftime('%Y%m%dT%H%M%SZ') + '-' + protocol_hash[:8]
    # Code is fingerprinted NOW, before any game is scored: the modules were
    # imported at process start, so this is the code that will run. Hashing
    # at report time instead would let an edit made during the run be
    # recorded as the run's provenance.
    code_at_start = code_identity()
    # Preregistration is written before a single game is scored, so the
    # configuration and metric cannot be chosen after seeing the answer.
    atomic_json(out_dir / run_id / 'preregistered.json',
                {**spec, 'run_id': run_id, 'protocol_hash': protocol_hash,
                 'code_identity': code_at_start,
                 'declared_at': started.isoformat(), 'results_exist_yet': False})

    built = shared_dataset.build_football_dataset(
        args.db, min_season=args.min_season, through_season=args.through_season,
        availability_path=args.availability, qb_quality_path=args.qb_quality)
    rows = built['rows']
    # An empty or near-empty dataset must fail loudly. Writing a report that
    # says "no result to report" and exiting 0 is how a silent query/filter
    # mistake gets mistaken for a genuine negative finding.
    if not rows:
        raise ValueError(
            f'dataset is empty for min_season={args.min_season} '
            f'through_season={args.through_season} against {args.db} -- refusing to write a report')

    def progress(record):
        if not args.quiet:
            tag = 'fit  ' if record['fitted'] else 'ABSTAIN'
            print(f"  {record['season']}-w{record['week']:02d} {tag} "
                  f"train={record['n_training_rows']:>5} games={record['n_games_in_week']:>3}"
                  + ('' if record['fitted'] else f"  {record['abstention_reason'][:70]}"),
                  flush=True)

    week_records, scored = run_walk_forward(
        rows, min_test_season=args.min_test_season, through_season=args.through_season,
        progress=progress, correction_recipe=correction_recipe)
    if not week_records:
        raise ValueError(
            f'no week fell inside the evaluation window (min_test_season={args.min_test_season}, '
            f'through_season={args.through_season}) despite {len(rows)} dataset rows')
    if not scored:
        raise ValueError(
            f'all {len(week_records)} evaluated weeks abstained; the first reason was '
            f'{week_records[0].get("abstention_reason")!r}. Refusing to write a report with no '
            'prediction in it -- fix the window or the recipe minimums first')
    n_window = check_accounting(rows, week_records, scored,
                                args.min_test_season, args.through_season)

    support = common_support(scored)
    overall = metric_block(support)
    overall_full_coverage = metric_block(scored)
    comparison = paired_difference(scored)
    coverage = interval_coverage(scored)
    correction_overall = correction_metric_block(scored)
    correction_vs_market = correction_paired_difference(scored, 'market')
    correction_vs_football = correction_paired_difference(scored, 'football_alone')

    per_season = []
    for season in sorted({r['season'] for r in scored}):
        season_rows = [r for r in support if r['season'] == season]
        block = metric_block(season_rows) if season_rows else {'n_games': 0}
        block['season'] = season
        block['interval_coverage'] = interval_coverage([r for r in scored if r['season'] == season])
        per_season.append(block)

    era = {
        f'pre_{stage3.PBP_ERA_SPLIT_SEASON}_no_pbp':
            metric_block([r for r in support if r['season'] < stage3.PBP_ERA_SPLIT_SEASON]),
        f'{stage3.PBP_ERA_SPLIT_SEASON}_plus_pbp_available':
            metric_block([r for r in support if r['season'] >= stage3.PBP_ERA_SPLIT_SEASON]),
    }

    import importlib.metadata
    packages = {p: importlib.metadata.version(p) for p in ('scikit-learn', 'numpy', 'lightgbm', 'scipy')}

    abstained = [w for w in week_records if not w['fitted']]
    report = {
        'schema': SCHEMA,
        'run_id': run_id,
        'protocol_hash': protocol_hash,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'duration_seconds': (datetime.now(timezone.utc) - started).total_seconds(),
        'authority': 'research_only',
        'production_changed': False,
        'db_path': str(Path(args.db).resolve()),
        'dataset_version': built['dataset_version'],
        'rows_total_in_dataset': len(rows),
        'rows_in_evaluation_window': n_window,  # == games_scored + games_in_abstained_weeks, asserted
        'quarantine_counts': built.get('quarantine'),
        'weeks_evaluated': len(week_records),
        'weeks_fitted': len(week_records) - len(abstained),
        'weeks_abstained': len(abstained),
        'games_scored': len(scored),
        'games_scored_on_common_support_with_market': len(support),
        'games_in_abstained_weeks': sum(w['n_games_in_week'] for w in abstained),
        'overall_common_support': overall,
        'overall_full_coverage': overall_full_coverage,
        'paired_comparison': comparison,
        'interval_coverage': coverage,
        'per_season': per_season,
        'per_era': era,
        'diagnostic_groups': group_table(scored),
        'market_correction': {
            'recipe_version': correction_recipe['version'],
            'availability_path': str(args.availability) if args.availability else None,
            'qb_quality_path': str(args.qb_quality) if args.qb_quality else None,
            'overall': correction_overall,
            'vs_market': correction_vs_market,
            'vs_football_alone': correction_vs_football,
            'diagnostic_groups': correction_group_table(scored),
            'weeks_correction_fitted': sum(1 for w in week_records if w.get('correction_fitted')),
            'weeks_correction_abstained': sum(
                1 for w in week_records if w.get('correction_fitted') is False),
        },
        'weeks': week_records,
        'packages': packages,
        'code_identity': code_at_start,
        # Non-empty only if a hashed file changed while the run was in flight.
        # The numbers are still from `code_at_start` (already imported); this
        # flags that the working tree no longer matches them.
        'code_files_modified_during_run': sorted(
            name for name, digest in code_identity().items() if code_at_start.get(name) != digest),
        'limitations': [
            'market_spread is the stored historical spread, not a verified decision-time '
            'executable quote; no result here is a betting or profitability finding.',
            'Horizons differ by construction: model weights are fit at the Wednesday-noon slot, '
            'row features are as of each game\'s own kickoff (both under the publication lag), '
            'and the market baseline and the correction head\'s market features are the stored '
            'CLOSING line. Correction-vs-market is horizon-matched; correction-vs-football_alone '
            'is not.',
            'This history has been inspected repeatedly and is development data. A prospective, '
            'frozen evaluation window is required before any forward claim.',
            'Interval coverage is measured inside the audit window and carries no guarantee for '
            'dependent future games.',
            'Diagnostic groups below the declared minimum game count are marked inconclusive and '
            'should not be read as findings.',
            'The market-correction head has no betting authority: it is not in '
            'weekly_training.py; its walk-forward output is exported to a lookup '
            '(export_market_correction_lookup.py) that the JS ensemble registers as a '
            'challenger-only component, structurally excluded from every live pick. It is gated '
            'on beating both the market and football-alone baselines.',
        ],
        'verdict': build_verdict(overall, comparison, coverage,
                                  correction_overall, correction_vs_market, correction_vs_football),
    }
    atomic_json(out_dir / run_id / 'report.json', report)

    # Every scored game, one row each -- the all-game record the plan requires,
    # kept out of report.json so the report stays readable.
    atomic_json(out_dir / run_id / 'predictions.json', [
        {'game': stage3_row_id(r), 'season': r['season'], 'week': r['week'],
         'fit_week': r['_fit_week'], 'actual_margin': r['actual_margin'],
         'unified': r['_unified_pred'], 'market': r['_market_pred'],
         'zero_information': r['_zero_info_pred'],
         'interval_80': [r['_interval_lo'], r['_interval_hi']],
         'interval_covered': r['_interval_covered'],
         'correction': r.get('_correction_pred'), 'football_alone': r.get('_football_alone_pred')}
        for r in scored])
    atomic_json(out_dir / run_id / 'preregistered.json',
                {**spec, 'run_id': run_id, 'protocol_hash': protocol_hash,
                 'code_identity': code_at_start,
                 'declared_at': started.isoformat(), 'results_exist_yet': True})

    # A stable pointer to the most recently COMPLETED audit, updated only
    # here -- at the end of a successful run, never mid-run or on failure
    # (an exception above never reaches this line). This is the seam the
    # explain-pick tool reads: it is what "the audit's timing" actually
    # means downstream -- upcoming-game explanations reference whatever the
    # last completed audit found, and that reference changes exactly when a
    # new audit finishes, never continuously and never mid-run. Deliberately
    # NOT the trigger for any automatic gate, threshold or stake change --
    # this is a reference for a human/explainer to read, not an actuator.
    atomic_json(out_dir / 'LATEST.json', {
        'schema': 'nfl-unified-margin-audit-latest-pointer-v1',
        'run_id': run_id, 'run_dir': str((out_dir / run_id).resolve()),
        'completed_at': datetime.now(timezone.utc).isoformat(),
        'db_path': report['db_path'], 'dataset_version': report['dataset_version'],
        'weeks_fitted': report['weeks_fitted'], 'weeks_abstained': report['weeks_abstained'],
        'games_scored': report['games_scored'],
        'overall_common_support': report['overall_common_support'],
        'paired_comparison': report['paired_comparison'],
        'diagnostic_groups': report['diagnostic_groups'],
        'market_correction': report['market_correction'],
        'verdict': report['verdict'],
        'authority': 'research_only',
    })

    print(json.dumps({'run_id': run_id, 'output': str((out_dir / run_id).resolve()),
                      'weeks_fitted': report['weeks_fitted'],
                      'weeks_abstained': report['weeks_abstained'],
                      'games_scored': report['games_scored'],
                      'verdict': report['verdict']}, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True, help='read-only path to the research database')
    parser.add_argument('--output', required=True, help='directory to write the run under')
    parser.add_argument('--min-season', type=int, default=1999, help='earliest season loaded into the dataset')
    parser.add_argument('--through-season', type=int, default=None, help='latest season loaded and evaluated')
    parser.add_argument('--min-test-season', type=int, default=None,
                        help='earliest season to EVALUATE (earlier seasons are still training history)')
    parser.add_argument('--availability', default=None,
                        help='path to scripts/export-availability-features.mjs JSON output; '
                             'omit to reproduce the dataset every existing baseline was measured on')
    parser.add_argument('--qb-quality', default=None,
                        help='path to scripts/export-qb-quality-features.mjs JSON output; '
                             'omit to reproduce the dataset every existing baseline was measured on')
    parser.add_argument('--correction-recipe', choices=['v1', 'v2', 'v3'], default='v1',
                        help='v1: football_prediction/market_spread/market_movement (default). '
                             'v2: v1 + home/away availability deficit (RUNBOOK Sec4.1); requires '
                             '--availability to have any effect. v3: v2 + home/away starting-QB QBR '
                             '(RUNBOOK Sec4.1 continued); requires --qb-quality to have any effect')
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()
    try:
        run(args)
    except Exception as exc:  # surface the reason, never a silent partial report
        print(json.dumps({'ok': False, 'reason': f'{type(exc).__name__}: {exc}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
