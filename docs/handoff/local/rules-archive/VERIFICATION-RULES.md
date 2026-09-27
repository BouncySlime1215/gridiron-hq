# VERIFICATION RULES: every unit, micro and macro (2026-09-23 ~2:30 AM ET; Nick: "rules in place for verifying each thing, looking at the structure to see if things can be wired elsewhere, micro and macro")
These rules bind every workflow (build-unit, study-unit, train-model, lean-build, verify-pr) and the merge queue. A unit that skips one is held.

## A. Before the build (the REUSE step, new, first stage of every build workflow)
1. The builder greps the tree for every existing producer and consumer of the concept (git grep by symbol, by table, by route, by page text), reads STRUCTURE-MAP.md and the wiring map, and writes a REUSE section: what it reuses, what it replaces, what it must not duplicate. A number that already has a producer is never re-computed; the unit imports it or replaces it in place.
2. The builder lists every other place the new number, table or component could serve (micro "wired elsewhere" list) and either wires it now or files it as INT-<unit>-n. Question 4 of the merge gate ("Pointed anywhere else?") must quote this list.

## B. During the build
3. RED test first for every behaviour and every defect; GREEN commit after; shas cited as subject + sha in the PR body; liveness proof (revert the implementation, the RED fails for the stated reason; two mutants killed).
4. One number, one producer: any new served number is a function with one call site per surface; a contract test asserts every page shows the same value for the same input.
5. Every new table or field has a reader reaching a route, job or page, or it does not merge (wiring gate 0 new findings on the merged tree).
6. Statistics: pre-registration committed before any result; holdout ledger updated; MDE at 80% power on every decline; Benjamini-Hochberg across a family; week-clustered CIs; forward-only grading for anything an LLM touched; a number that cannot be reproduced by a skeptic's own code is blocking.
7. Every recommendation carries a why with at least one number traceable to a row (Coach verifier); guesses labelled "guess".

## C. After the build: independent skeptics by lens (default to blocking when evidence is missing)
8. claims (re-derive every number), wiring (a real consumer exercised end to end), liveness (RED fails on broken code; mutants die), structure (every producer of each number; duplicates run on the same input; unwired data), and, for anything a page shows, ui (section E). Risk tier decides the lens set; model/lineup/trade numbers add the Independent Auditor (Fable) before merge.
9. The fixer answers every blocking issue with a fix (RED first) or a dispute with a command and output; re-checks by the same skeptics; two rounds maximum, then held.

## D. Merge and after (macro)
10. CI green on the exact head that contains current main; PR body with sections 1-5 and the five questions; squash by the local merge queue only; integration card written by the gate; the intake fills "what it uses, what it routes to, follow-ups" and files INT units.
11. Synergy review every 8 merges (synergy-review.js): across the last 8, where can A feed B, where are two Bs one B, what became stale, what is now unwired; results become SY units with cites. The structure scout (R5) re-runs the STRUCTURE-MAP every 2 days: duplicate numbers, hand-set constants behind served numbers, tables without readers, evidence whose numbers the code no longer produces.
12. Re-audit rule: any evidence file older than 7 days that a served number depends on is re-measured (R units) or the number is labelled stale on the page.
13. The wiring map (docs/wiring/wiring-map.json + annotations) is regenerated at every phase exit (F-10 owner) so the macro picture is never more than a phase old.

## E. UI lens (new skeptic in verify-pr.js and build-unit.js for any page change)
14. The skeptic opens the page against the local server with the browser pane (preview "gridiron-local" on 5177), with fixture data for: normal, empty, thin-n, error, loading and "guess" states; checks: every number has its why and cite within one tap; three lines per card; no wall of text; mobile 375 px with no horizontal scroll; dark mode; no console errors; interactive elements reachable by keyboard; one-tap actions confirm only when irreversible; names never in a screenshot that leaves the machine. A screenshot per state is attached to the PR as evidence. Any failure is blocking.

## F. Micro and macro checklists (run by the structure lens and the synergy review; commands in the skeptic's report)
MICRO (per unit): producers of this number (git grep concept) -> one? | consumers exercised? | could it also serve: Coach, the report card, the target board, the command center, the analyst, another league? | replaces a hand-set constant? | evidence file dated and reproducible? | registry entry for any model?
MACRO (per 8 merges): same number on two pages -> same value on the same input? | two services doing one job -> merge | a job nobody reads -> kill or wire | an alert nobody sees -> route to the command center | a new table -> who else needs it | anything the wiring map calls orphan -> reason or removal.

## Enforcement (how these rules get into the machinery without breaking resumes)
The killed runs (BLEND-01, HX-01, S-03, C-01, skill study) resume on their ORIGINAL scripts so their cached steps replay (changing a prompt restarts a unit from zero). Every NEW launch uses v2 scripts written first on "go": build-unit-v2.js and verify-pr-v2.js (REUSE stage first; ui lens with browser-pane screenshots for page changes; structure lens prompt carries the MICRO checklist), plus finish-unit.js, study-unit.js, train-model.js, lean-build.js with the same stages. synergy-review.js gains the MACRO checklist. The merge gate (gate-merge.sh) adds two checks: the PR body quotes the REUSE section and the wired-elsewhere list, and page-changing PRs carry state screenshots. A unit launched on an old script after "go" is a rules violation.
