# editor — plan-editor pass over the five sweep readers

2026-09-12. Read WHAT_NEXT.md (244 lines) in full, then all five reader files
(`s1-news.md`, `s2-models.md`, `s3-research.md`, `s4-audits.md`, `s5-github.md`).
Independently re-verified the four largest claims against the READ-ONLY checkout at
`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` and `server/data.sqlite`
via `node:sqlite` `readOnly:true`. No edits to the repo, no processes touched.

---

## What I verified myself, rather than taking on the reader's word

### 1. s2 F1 — CONFIRMED, and stronger than stated

`nfl-ensemble.js:1185-1189` gates the residual blend on
`residual_n >= 250 && residual_rmse_gain >= 0.03 && residual_paired_t <= -1.645`, and
`:1299` makes `market_residual` return `marketMargin` when nothing clears it.

I scanned every artifact myself:

```
artifacts parsed: 848   component rows: 26288   gate_passed: 0
best gain: {"g":1.42,"t":-1.703,"n":14,"id":"trenches","cutoff":"2017|7"}
```

s2 said "840 artifacts, zero passed". It is 848 artifacts and **26,288 component-cutoff
rows, zero of which have ever passed**. The best result in the repository's whole history
is `trenches` at cutoff 2017|7 with n=14 — blocked on the n≥250 floor by a factor of 18.
So the production spread forecast is the market line by arithmetic, at every cutoff ever
computed. Accepted as the lead of Step 2.

### 2. s2 F2 — CONFIRMED verbatim

`nfl-ensemble.js:60` is `NULL AS open_spread, NULL AS open_total` inside `games()`, the
only history source for both fitting and grading. Accepted.

### 3. s5 §4 — PARTLY WRONG, and the correct cause is worse

s5 claims "nothing schedules it; the only caller is a manual route". **False.**
`server/services/scheduler.js:761` registers `beat_the_close` (`refreshBeatTheClose`,
`maxAgeMinutes: 60`, tier `live`), which at `:381` imports and calls `runBeatTheClose()` —
snapshot + decide + settle. `sync_log` shows `runs: 197`, `last_status: 'ok'`,
`last_run_at: 2026-09-13T01:05:29Z`. The job is running fine.

The real cause is in that same log line:

```json
"snapshot":{"season":2026,"week":1,...,"signals_written":176},
"decided":{"season":2026,"week":1,"frozen":0,"already_frozen":47,"below_threshold":17,...},
"settlement":{"settled":0,"waiting":55}
```

On 13 September it is still snapshotting and deciding **week 1**.
`currentNflWeek()` (`weekly-learning.js:206-209`) is
`MIN(week) FROM game_lines WHERE season=? AND team_score IS NULL`. I queried it:

```
MIN unscored week 2026: 1
week 1: 16 games, 14 with NULL team_score
week 2: 16 games, 16 NULL
SCORED: LAR 7 – SF 27 ; SEA 13 – NE 10   (2 of 16)
```

**Week-1 scores never landed for 14 of 16 games**, so `currentNflWeek` is pinned to 1 and
every consumer of it is frozen there — `beat-the-close.js`, `nfl-prop-clv.js`,
`nfl-external-ratings.js`, `book-feeds-extra.js`, `weekly-learning.js`, `scheduler.js`,
`routes/nfl-market.js` (7 modules). `settleBeatTheClose` (`:277-279`) also joins
`game_lines` for the scores it grades `result` from, so the 55 waiting rows cannot settle.

This is the finding no reader got right and the plan does not carry. It is time-critical:
the plan's own stated 2026 target is "a complete, trustworthy forward record", and that
record is not being written right now. Promoted to the lead of a new **Step 0**, with the
corrected causal chain rather than s5's diagnosis.

### 4. The reader corpus is otherwise reliable

Spot-checks of s4's post-merge claims (branch content), s3's provider row counts, and
s1's `nfl-news-signal.js` line citations all matched. s4 in particular did the right thing
by checking candidates against the *merged branch* rather than `main`, and correctly
withdrew a large block of findings that tonight's build already fixed.

---

## Editorial principle applied

The bias-toward instruction (structural/execution over predictive) did most of the sorting
for me. Every predictive port in s5's Q1 tail — Elo, Glicko, NGBoost, mixture-density
networks, conformal prediction, the time-series foundation models — is a bid to predict
better, which is the one thing measured three times not to work here. All rejected as weak
in one block rather than argued individually.

The second filter was: does the candidate make an existing number *interpretable*, or does
it add a new number? This project's problem is not a shortage of numbers. Almost everything
that survived is of the first kind — a control, a fence, a repair, or a clock.

The third filter was irreversibility. Several accepted items are ordinary-priority as
engineering and top-priority as *timing*, because the data they protect stops existing if
they wait (week-1 scores, receipt clocks, Pinnacle closes, the 2026 injury timestamps, the
pre-Week-3 registration deadline). Those are all now in Step 0 with the reason stated.

---

## Structural change to the document

The old numbering had a genuine collision: Step 2's sub-items were lettered 5a-5e while
separate top-level sections were named "Step 5", "Step 5b" and "Step 5c". Renumbered so
sub-items carry their own step's number (2a-2e, 4a-4f) and the lettered sections became
Steps 8 and 9. Numbered items now run 1..34 continuously. Two genuinely new sections were
warranted and added: **Step 5 — Execution and market structure** (the bias-toward category,
which the plan had no section for at all despite it being where every real edge lives) and
**Step 6 — News and information timing** (the word "news" did not appear in the document,
and Nick asked about it directly).

---

## Accept / reject tallies

Added: 34 numbered items across Steps 0, 2, 4, 5, 6, 8, 9, 10 plus amendments to Steps 1,
3, 7, the NOT-DO list and the open decisions.

Rejected as duplicate: 16. Rejected as weak: 8. Full reasons in the structured return.

## The headline

Two things changed materially. First, the production spread model has never once left the
market line — so the settled −7.7% verdict grades a function that was never staked, and
Step 2 has to say which function each row is. Second, the 2026 forward record the plan
names as the season's honest target is not currently being written: week-1 scores never
landed, which freezes seven modules at week 1 and leaves 55 shadow decisions permanently
unsettled. Neither changes the betting *outlook* — no prediction edge, execution and props
are where it lives — but both change what has to happen this week.
