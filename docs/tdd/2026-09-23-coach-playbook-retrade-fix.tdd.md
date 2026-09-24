# RL-15-1: Fix stale "avoid recent trade acquisitions" rule in COACH-PLAYBOOK.md

## Unit
RL-15-1 (plan item NX-04 / COACH-PLAYBOOK). Doc-only correction; the drop-watch
predictor half of this row (B4 NX-04) is not built — TM-03 target board is
unbuilt and depends on TM-01. This unit ships only the playbook fix.

## Audit (extend-or-build)
`docs/COACH-PLAYBOOK.md` T4 (line 73, "Avoid" column) and item 17 (line 180,
state field rationale) both asserted an endowment-effect rule: avoid/deprioritize
targeting a player the counterparty acquired by trade recently, on the theory
their endowment for it is highest right after acquisition. This is a doc-only
"producer" of a heuristic, not a code path — no other file encodes this rule
(`grep -rn "acquired by trade\|endowment.*trade" --include=*.js` outside docs:
no hits), so this is a fix-in-place, not an extend.

Per the unit row, a held-out test qualified the rationale as unsupported: assets
that were recently acquired by trade were re-traded 2.13x [1.77, 2.52] MORE
often than other assets, not less. That result contradicts the "avoid them,
endowment is highest" rule — the data points the opposite direction from the
heuristic the doc encoded.

## RED
Grep test (pre-registered by the unit row): the doc must not contain the
literal string `never target a player they acquired by trade`.

Before fix (origin/main, commit 24fdf434):
```
$ grep -n "never target a player they acquired by trade" docs/COACH-PLAYBOOK.md
73:...never target a player they acquired by trade < 3 weeks ago...
```
Failing assertion: grep exits 0 (match found) — test expects exit 1.

## GREEN
Fix (this commit, working tree):
```
$ grep -n "never target a player they acquired by trade" docs/COACH-PLAYBOOK.md; echo "exit=$?"
exit=1
$ grep -n "endowment.*highest on recent trade" docs/COACH-PLAYBOOK.md; echo "exit=$?"
exit=1
```
Both pre-registered greps now exit 1 (no match), as the unit row's grep test requires.

### What changed
- Line 73 (T4 Avoid column): removed the clause "never target a player they
  acquired by trade < 3 weeks ago". The other two Avoid clauses in that cell
  (don't chase the untouchable in-thread, don't tell them they're overvaluing)
  are untouched — they are not addressed by this held-out result.
- Line 180 (item 17, state-field rationale): replaced "endowment is highest on
  recent trade acquisitions" with a note that the held-out test found the
  opposite (re-traded 2.13x [1.77, 2.52] more) and that recency-of-trade should
  not be used as a reason to avoid or deprioritize a target.

### Round 2 (skeptic fix): duplicate rule at line 149
The first-round grep matched only the exact T4 phrase and missed a second copy
of the same rule in section 6 ("What the Coach never does"). The test is now
widened to any mention of the phrase `acquired by trade`, case-insensitive.

RED (origin/main 24fdf434; also HEAD 555ac23c, before this fix):
```
$ git show origin/main:docs/COACH-PLAYBOOK.md | grep -n -i 'acquired by trade'
73:| T4 | ... never target a player they acquired by trade < 3 weeks ago | ...
149:- Asks for a stated untouchable, or a player they acquired by trade in the last 3 weeks. [BE, PON]
```
Known-nonzero control: the same grep on origin/main returns 2 lines, so an
empty result on the fixed tree means the lines are gone, not that the grep is broken.

GREEN (working tree after this fix):
```
$ grep -n -i 'acquired by trade' docs/COACH-PLAYBOOK.md; echo "exit $?"
exit 1
$ sed -n 149p docs/COACH-PLAYBOOK.md
- Asks for a stated untouchable. [BE, PON]
```
Line 180 (item 17) says "recent trade acquisitions", so it does not match the
widened grep. It is the one remaining statement of the rule, and it now says
not to avoid these players.

## Mutation test
- Designed survivor: reintroducing the exact removed phrase into line 73 alone
  (revert only that clause) makes the RED grep fail again (exit 0) — confirms
  the test is sensitive to the specific defect it targets.
- Not-applied control: a mutation to an unrelated line (T1's trigger text) does
  not change either grep's exit code — confirms the test doesn't false-positive
  on unrelated doc edits.
- Verified: `git stash`-based check re-inserting the T4 phrase reproduces
  RED (grep exit 0); restoring the fix returns to GREEN (exit 1). Ran directly
  against the file in this worktree, not scripted into a test runner since this
  is a doc unit with no test harness of its own.

## Known defects / scope not covered
- The drop-watch predictor itself (item B4/NX-04, TM-03 target board, AI-05)
  is NOT built in this unit. It depends on TM-01, which is unbuilt. This unit
  is the doc correction only, as the unit row specifies ("drop-watch predictor
  itself not ready to build").
- No code reads `acquisition_source_and_date` for T4 gating today (this is a
  human-facing Coach playbook doc, not a wired feature) — so there is no
  "reader reaching a route/job/page" to check under the one-number-one-producer
  rule; this unit changes advice text only, not a data pipeline.
- The 2.13x re-trade figure is taken as given from the unit row's pre-registered
  held-out result; this unit did not re-run that held-out test (out of scope —
  the row marks the number as already produced, this row's job is the doc fix).

## Nick's five questions
1. What changed for the Coach? It no longer tells itself to avoid targeting a
   player just because the other manager traded for them recently — that advice
   was backwards per the held-out data (they get re-traded MORE, not less).
2. What's the evidence? Unit row's held-out result: 2.13x [1.77, 2.52] more
   re-trades for recent trade acquisitions vs. baseline. Not re-verified here.
3. What ships and what doesn't? Only the two doc lines (T4 avoid clause, item
   17 rationale). The drop-watch predictor (the other half of this row) does
   not ship — not built, depends on unbuilt TM-01.
4. Any risk? None to running code — this is a static markdown doc with no
   reader in the app today.
5. What's next? TM-01 must land before TM-03's target board, before the
   drop-watch predictor half of NX-04 can be attempted.
