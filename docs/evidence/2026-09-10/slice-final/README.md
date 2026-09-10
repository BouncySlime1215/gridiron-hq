# Test evidence — September 10, 2026

Both runs use the same conditions the September 10 review used, and the same ones CI now enforces:
an isolated fixture database (`GRIDIRON_DB_PATH` pointing at a path with no history), an enforced
external-network guard, and `SCHEDULER_DISABLED=1`.

```bash
GRIDIRON_DB_PATH=/tmp/fixture.sqlite \
  NODE_OPTIONS="--import ./test/offline-guard.mjs" \
  SCHEDULER_DISABLED=1 npm test
```

| | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Before (`bbcdae2`, reproduces the review) | 1342 | 1312 | **24** | 6 |
| After | 1496 | 1472 | **0** | 24 |

The 24 skips are not the 24 failures renamed. Each is a fitted-model validation that names the
history it needs and why a synthetic fixture cannot honestly stand in for it; all 24 run and pass
against the populated development database. See `test/helpers/requires-real-history.js`.

- [`baseline-suite-before.txt`](baseline-suite-before.txt) — the run reproducing the review's 24 failures
- [`ci-conditions-suite.txt`](ci-conditions-suite.txt) — the run after this work
