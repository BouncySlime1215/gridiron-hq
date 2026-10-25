---
name: gridiron-research-corpus-home
description: What the 63 MB gridiron-hq research corpus actually contains and the recommendation (a second private repo) for where it should live instead of the code repo.
metadata:
  type: project
  modified: 2026-09-19T15:48:58.561Z
---

Measured on 2026-09-19 against `cursor/betting-model-audit-fixes-1c85`.

`docs/betting-model/` — 529 files, **63.2 MB**:
- 24.8 MB in 90 `.json` experiment dumps (one `dataset.json` is 190k lines)
- 22.2 MB in **27 PDFs of third-party academic papers**
- 7.2 MB in 58 `.txt` paper extracts
- **6.6 MB in 320 `.md` research notes** — the part with lasting value
- 1.2 MB CSV, plus 3 `.joblib` model binaries, 2 zips, 7 `.py`, 5 logs
- a `SHA256SUMS` file already covers provenance

`docs/evidence/` — 168 files, 30.2 MB, of which only 1.39 MB (70 files) is
markdown; the other 28 MB is JSONL/JSON run dumps and zipped bundles.

`data/line-history/availability_predictions.csv` — 3.6 MB, and it is the
`OUT_CSV` of `scripts/news-line/availability_model.py`, so regenerable.

**Recommendation given to Nick: a second private repository** (e.g.
`gridiron-hq-research`). 63 MB is unremarkable for a repo of its own, only
individual files over 100 MB are refused, and it keeps history, browsing and
the SHA256SUMS provenance while leaving clones of `gridiron-hq` small.
Private matters: redistributing 27 third-party papers from a public repo is a
licensing problem. Object storage (Fly's Tigris) is the alternative but loses
browsing and diffs.

The markdown in `docs/evidence/` DID come into the code repo, in PR #12;
`docs/betting-model/` did not, in any form. Its 320 markdown notes could be
brought in later as a separate decision — that was deliberately not bundled
into the split.

**Nothing was deleted.** The corpus is still on
`cursor/betting-model-audit-fixes-1c85` and in PR #6.

See [[pr6-split-into-five]].
