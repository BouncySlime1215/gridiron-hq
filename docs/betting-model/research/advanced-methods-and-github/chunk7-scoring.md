# Chunk 7/21 — Scoring notes (F15/F16/F17 candidates)

Grounded in full reads of F15-team-strength-shrinkage.md (read in full this pass) and the
candidate blurbs themselves for F16/F17, which already carry file:line citations from prior
code reads (server/services/nfl-devig.js, nfl-ensemble.js, nfl-auto-picks.js, staking.js,
nfl-drive-sim.js, nfl-team-strength.js, nfl-preseason-blend.js).

## Key cross-check that changes a verdict

F15's own code read (section 1) establishes, by reading the actual files, that:
- `nfl-team-strength.js` is NOT a hand-tuned blend — it's a GBM-challenger-feature aggregator,
  already walk-forward gated, that has never shown significant lift. It has no "fixed
  blend-weight logic" to replace.
- The real hand-tuned-by-feel constants live in `nfl-roster-strength.js` (0.5/0.23/0.17/0.10
  etc., undocumented, un-fit).
- `nfl-preseason-blend.js` is the actual principled single-unit Bayes shrink engine — correctly
  derived, but missing the cross-sectional (James-Stein) pooling step.

**F17-fix-4** proposes replacing "the current fixed blend-weight logic" inside
`nfl-team-strength.js` with a Glickman-Stern AR(1) state-space update. Per the above, that file
does not contain the blend logic the candidate describes — the premise misidentifies the target.
The correct fix for the real defect (nfl-preseason-blend.js's missing cross-sectional pooling) is
already covered, correctly targeted, by **F15-fix-2**. F17-fix-4 is scored down for this reason
and marked reject/redirect rather than build.

## Scoring

Fantasy-over-betting priority (per Nick's standing instruction) pulls applicability down for
pure-betting candidates (F15-new-1, F16-NEW-1) and up for fantasy-facing ones (F15-new-2/3).
Cost-hours items with existing test harnesses (F16-FIX-1/2, F17-fix-1/2) score highest on
value_per_cost since they're cheap, use infrastructure that already exists, and directly close
gaps already confirmed in tonight's verified-findings list.

| id | evidence | applicability | v/c | verdict |
|---|---|---|---|---|
| F15-fix-2 | 4 | 3 | 4 | test-first |
| F15-fix-3 | 2 | 3 | 2 | later |
| F15-new-1 | 4 | 2 | 2 | later |
| F15-new-2 | 3 | 5 | 5 | build |
| F15-new-3 | 3 | 5 | 3 | test-first |
| F16-FIX-1 | 4 | 4 | 5 | build |
| F16-FIX-2 | 3 | 5 | 5 | build |
| F16-FIX-3 | 2 | 4 | 3 | test-first |
| F16-NEW-1 | 3 | 2 | 2 | later |
| F16-NEW-2 | 2 | 3 | 4 | test-first |
| F16-NEW-3 | 2 | 4 | 4 | build |
| F17-fix-1 | 4 | 5 | 5 | build |
| F17-fix-2 | 4 | 5 | 5 | build |
| F17-fix-3 | 4 | 5 | 4 | build |
| F17-fix-4 | 3 | 2 | 2 | reject |

Notes:
- F17-fix-1/2/3 are the highest-confidence items in this chunk: each directly patches a defect
  already on tonight's verified-findings list (flat-7 HFA lump, no key-number regression check,
  no halftime/OT in simulateRemainder), each is cheap-to-days cost, and F17-fix-2's exit
  condition uses Gridiron's own already-fitted margin-distribution.js as ground truth — no new
  empirical work needed.
- F16-FIX-1/2 close a live, worse-than-documented bug (zero-devig at GET /nfl/stake) and add a
  cheap regression test proving the dog/over bias is a margin-blend artifact, not a devig
  artifact — both cheap, both grounded in exact file:line grep citations.
- F15-new-2 (classical James-Stein A/B on the fantasy player-week panel) is the single best
  value_per_cost item: hours of cost, plugs into the existing fit-shrinkage-weekly.mjs harness,
  and directly serves the fantasy-over-betting priority.
- F15-fix-2 is real and correctly targeted (unlike F17-fix-4) but is a betting-model surface
  gated behind an existing walk-forward test that already returned a null for the single-stage
  version — worth one clean re-test, not an assumed win.
