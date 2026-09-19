"""Export the market-correction head's out-of-fold predictions as a lookup
table the JS ensemble can read, so the two model groups can finally combine
into one joint decision instead of remaining unjoined siloes.

WHY A LOOKUP, NOT A LIVE CALL. `nfl-ensemble.js`'s `componentPredictionStream`
calls every component's `predict(ctx)` synchronously, in a tight loop, across
every historical week -- there is no `await` in that loop, and there cannot
be: `fitEnsemble`'s joint ridge fit needs one synchronous pass over the whole
walk-forward replay. A live Python subprocess call per game would make that
replay call out to a subprocess thousands of times, at ~seconds each. So this
script precomputes every OUT-OF-FOLD prediction once, offline, and the JS
side reads a plain number from a lookup -- exactly the same shape
`ctx.spread`/`ctx.openSpread` already are.

WHY THIS REUSES `unified_margin_audit.run_walk_forward` RATHER THAN WRITING A
SECOND WALK-FORWARD LOOP. That function already implements the exact
out-of-fold discipline this needs (fit on `base`, score `combination`
out-of-fold, refit on `base+combination` for `calibration`) and is tested
(`test_market_correction.py`'s two mutation tests). A second implementation
here would be a second thing that could silently drift from the first.

WINDOW. `server/services/nfl-ensemble.js`'s own `MIN_SEASON = 2015` is the
earliest season it ever scores; `--min-test-season 2015` matches that
exactly so no row is computed that the JS side could never use. Training
history still starts from `--min-season` (default 1999), giving the
football/correction fits maximum legitimate history.

MISSING COVERAGE IS NOT AN ERROR. A week the correction head abstained on
(insufficient market-evidenced rows) or a specific game with no market
quote simply has no entry in the output. The JS component reads that as
`null` and abstains for that game -- the same missing-evidence pattern every
other component in `nfl-ensemble.js` already follows. This script does not
paper over a gap with a guessed number.
"""
import argparse
import json
import sys
from pathlib import Path

import dataset as shared_dataset
import model_artifact as ma
import unified_margin_audit as audit


def run(args):
    built = shared_dataset.build_football_dataset(
        args.db, min_season=args.min_season, through_season=args.through_season)
    rows = built['rows']
    if not rows:
        raise ValueError(f'dataset is empty for min_season={args.min_season} '
                          f'through_season={args.through_season}')

    def progress(record):
        if not args.quiet:
            tag = 'fit  ' if record.get('correction_fitted') else 'ABSTAIN'
            print(f"  {record['season']}-w{record['week']:02d} correction={tag}", flush=True)

    week_records, scored = audit.run_walk_forward(
        rows, min_test_season=args.min_test_season, through_season=args.through_season,
        progress=progress if not args.quiet else None, score_market_correction=True)

    entries = []
    for r in scored:
        if r.get('_correction_pred') is None:
            continue
        entries.append({
            'season': r['season'], 'week': r['week'], 'home': r['home'], 'away': r['away'],
            'market_correction_margin': r['_correction_pred'],
        })

    weeks_fitted_correction = sum(1 for w in week_records if w.get('correction_fitted'))
    weeks_abstained_correction = sum(1 for w in week_records if w.get('correction_fitted') is False)

    payload = {
        'schema': 'nfl-market-correction-lookup-v1',
        'source': 'research/betting/nfl/market_correction.py via unified_margin_audit.run_walk_forward',
        'db_path': str(Path(args.db).resolve()),
        'min_season': args.min_season, 'through_season': args.through_season,
        'min_test_season': args.min_test_season,
        'weeks_evaluated': len(week_records),
        'weeks_correction_fitted': weeks_fitted_correction,
        'weeks_correction_abstained': weeks_abstained_correction,
        'games_with_correction': len(entries),
        'authority': 'research_only -- feeds a challengerOnly ensemble component; '
                     'structurally excluded from any live-blended pick until explicitly promoted',
        'entries': entries,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(args.out).with_suffix('.tmp')
    tmp.write_text(json.dumps(payload, indent=2, allow_nan=False))
    tmp.replace(args.out)
    print(json.dumps({'out': str(Path(args.out).resolve()), 'games_with_correction': len(entries),
                      'weeks_correction_fitted': weeks_fitted_correction,
                      'weeks_correction_abstained': weeks_abstained_correction}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--min-season', type=int, default=1999)
    parser.add_argument('--through-season', type=int, default=2026)
    parser.add_argument('--min-test-season', type=int, default=2015,
                        help='matches nfl-ensemble.js MIN_SEASON exactly')
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()
    try:
        run(args)
    except Exception as exc:
        print(json.dumps({'ok': False, 'reason': f'{type(exc).__name__}: {exc}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
