import copy
import json
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, '/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/research/betting/nfl')
import model_artifact as ma
import stage3_team_strength as stage3
from test_stage3_team_strength import _synthetic_multiseason_rows

rows = _synthetic_multiseason_rows()
changed = copy.deepcopy(rows)
for row in changed:
    row['actual_margin'] += 5
model1, info1 = ma.fit_ridge_artifact(rows, alpha_grid=[10.0])
model2, info2 = ma.fit_ridge_artifact(changed, alpha_grid=[10.0])
kwargs = dict(feature_names=stage3.FEATURE_NAMES, dataset_version='fixture-v1',
    training_cutoff={'fit_through_instant':'2010-01-01T00:00:00+00:00'},
    training_row_ids=[f"{r['season']}-{r['week']}-{r['home']}-{r['away']}" for r in rows],
    min_season=2000, through_season_query_cap=2009)
with tempfile.TemporaryDirectory(prefix='gridiron-artifact-review-') as temp:
    directory, meta = ma.save_artifact(temp, model=model1, model_meta=info1, **kwargs)
    try:
        ma.save_artifact(temp, model=model2, model_meta=info2, **kwargs)
    except FileExistsError as exc:
        print('REVIEW_RESULT '+json.dumps({'probe':'revised_training_values_same_artifact_identity',
            'blocked':True,'error':str(exc),'code_files_hashed':meta['code_files_hashed']}))
    else:
        raise AssertionError('Expected the reviewed identity collision was not reproduced')
