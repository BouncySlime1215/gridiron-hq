#!/bin/bash
# ML-TESTBENCH: one command runs every section (docs/tdd/ML-TESTBENCH-PREREG.md).
#
#   scripts/eval/ml-testbench/run-all.sh <copy.sqlite> [out_dir]
#
# <copy.sqlite> must be a COPY of the app database (every script refuses ~/gridiron-local/data.sqlite).
# Make one read-only from the live file with:
#   sqlite3 -readonly ~/gridiron-local/data.sqlite ".backup '<copy.sqlite>'"
# Outputs (ids and counts only) go to out_dir, default ~/gridiron-local/evidence/ml-testbench.
# Python: ~/gridiron-local/venv-ml (numpy, scipy, xgboost, lightgbm; scripts/eval/requirements-exgb.txt).
# ESPN RETRO projections for section B are read from ~/gridiron-local/evidence/exgb/espn-retro-<season>.json
# (scripts/eval/exgb-espn-retro.mjs writes them). 8 GB Mac: runs under nice, after mem-ok.sh.
set -euo pipefail
DB="${1:?usage: run-all.sh <copy.sqlite> [out_dir]}"
OUT="${2:-$HOME/gridiron-local/evidence/ml-testbench}"
PY="${PY:-$HOME/gridiron-local/venv-ml/bin/python}"
RETRO="${RETRO_DIR:-$HOME/gridiron-local/evidence/exgb}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
if [ "$(cd "$(dirname "$DB")" && pwd)/$(basename "$DB")" = "$HOME/gridiron-local/data.sqlite" ]; then
  echo "refusing the live database; pass a copy" >&2; exit 2; fi
if [ -x "$HOME/gridiron-local/bin/mem-ok.sh" ]; then "$HOME/gridiron-local/bin/mem-ok.sh"; fi
mkdir -p "$OUT"
cd "$ROOT"
echo "== A: acceptance models"
nice -n 10 node "$HERE/a_export_offers.mjs" --db "$DB" --out "$OUT/a-offers.json"
nice -n 10 "$PY" "$HERE/a_acceptance.py" --offers "$OUT/a-offers.json" --db "$DB" --out "$OUT/a-results.json"
echo "== B: projections (rolling origin; about 10 minutes)"
nice -n 10 "$PY" scripts/eval/exgb_panel.py --db "$DB" --out "$OUT/panel.npz"
RETRO_ARGS=()
for f in "$RETRO"/espn-retro-*.json; do RETRO_ARGS+=(--espn-retro "$f"); done
nice -n 10 "$PY" "$HERE/b_projections.py" --panel "$OUT/panel.npz" --db "$DB" "${RETRO_ARGS[@]}" --out "$OUT/b-results.json"
echo "== C: weekly range coverage"
nice -n 10 "$PY" "$HERE/c_ranges.py" --db "$DB" --out "$OUT/c-results.json" > /dev/null
echo "== D: matchup win probability"
nice -n 10 "$PY" "$HERE/d_winprob.py" --db "$DB" --out "$OUT/d-results.json" > /dev/null
echo "done: $OUT/{a,b,c,d}-results.json"
