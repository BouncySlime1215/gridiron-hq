# WA workflow — complete record

Written 2026-09-18. Nick: "make a new doc and point to this stuff." This is the
full version of `docs/FANTASY-ENGINE-MASTER-PLAN.md` part B4, which has the
headline summary and links here for everything B4 itself didn't have room for.

**Identity.** Run id `wf_90ebcd25-088`, label `wa-essentials-audits-trade-brain`.
Background task_id: **not recoverable from this session** — assigned before a
context compaction, never logged (see plan A2 rule 10's gap note). Use the
user's own `/tasks` or `/workflows` panel to find it. Journal (raw, durable,
still on disk):
`~/.claude/projects/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/subagents/workflows/wf_90ebcd25-088/journal.jsonl`

## 1. Every agent (17 so far), with its id

Same table as plan B4 — repeated here as the canonical copy:

| # | Label | Phase | Agent id | Verdict |
|---|---|---|---|---|
| 1 | `build:play-chance-live` | Essentials | `ac2b2c92621fbf08e` | shipped_partial |
| 2 | `review:silent-failure-hunter` | Essentials | `a717da9ae86fd8579` | findings, read-only |
| 3 | `review:mle-reviewer` | Essentials | `a519e0fce305cfc76` | findings, approve with warnings |
| 4 | `build:manager-data-pipeline` | Essentials | `a85c2b185aaf74483` | shipped |
| 5 | `build:llm-plumbing` | Essentials | `a63133b881d7040b3` | shipped |
| 6 | `verify:llm-plumbing` | Verify | `aa8e05ef5f7d490d8` | confirmed_with_fixes |
| 7 | `verify:play-chance-live` | Verify | `abe103df9d34d1ef2` | confirmed_with_fixes |
| 8 | `verify:manager-data-pipeline` | Verify | `af7755fa8a915a6e6` | confirmed_with_fixes |
| 9 | `build:infra-essentials` | Essentials | `aff856d6f5985e385` | shipped |
| 10 | `verify:infra-essentials` | Verify | `a91f92b6637b5f6cd` | issues_unfixed |
| 11 | `fix:review-findings-2` | Review fixes | `a40f521415c9e1024` | 5 applied / 1 rejected / 4 deferred |
| 12 | `build:trade-engine-correctness` | Trade Brain | `a3636deea5a8e6561` | shipped |
| 13 | `verify:trade-engine-correctness` | Verify | `ac2f2f3a087554881` | issues_unfixed |
| 14 | `build:valuation-map` | Trade Brain | `aa91b1f6c902f1599` | shipped |
| 15 | `verify:valuation-map` | Verify | `ac93274f51587f5f6` | issues_unfixed |
| 16 | `build:tactics-and-packages` | Trade Brain | `a9a744c291074cfdc` | shipped (`ffe97c9`, then `9cee38a`, `f92bb5f`) |
| 17 | `verify:tactics-and-packages` | Verify | `ac60b583127cb402a` | running (as of last check) |

Find any of these directly: `grep '"agentId":"<id>"' journal.jsonl`, or read
`agent-<id>.jsonl` in the same directory for that agent's full transcript.

## 2. mle-reviewer — all 4 findings (only #1 made it into plan B4)

1. **(medium)** `trade-engine.js:269` — the fantasy coordinator is served on a
   different basis than it was trained on: fit on the gap to the STRUCTURAL
   projection, served on the ensemble number, so the ensemble shift is
   counted twice from week 5 on; `boom_bust_signal` is always null at serve
   though it was present for 9,795 of 23,334 training rows, so every player
   takes the learned -0.78 missing-value penalty, not just the ones actually
   missing it. **Deferred** (see §4).
2. **(medium)** `lineup-posture.js:225` — the Vegas game-script lift is the
   shared basis for posture, League Hub, and Start/Sit, and has never been
   graded on fantasy points; on replay it makes weekly accuracy significantly
   worse in both validation seasons (MAE +0.0131 [+0.0040,+0.0227] 2024,
   similar 2025), no gain anywhere. **Deferred.**
3. **(medium)** `player-week-engine.js:285` — the prediction log doesn't
   record which model actually served: weeks 2-4 use fit-2's early bucket,
   but the logged weights are still the fit-1 vector, contradicting
   `weekly-ensemble.js`'s own instruction. **Partially applied** — the mode
   label and "frozen" wording were fixed; the remainder (weight_fit isn't
   part of the snapshot identity; 2026 week 2 logged under frozen-2023 and
   can never be graded for the model Nick actually uses) is **deferred.**
4. **(low)** `preseason-model.js:328` — ROS's market prior carries 40% weight
   at week 2, was graded on FantasyPros ECR 2021-2025, but live 2026 builds
   it from ESPN ADP instead (never graded, filled by a one-off fetch nothing
   in the codebase re-syncs). Not yet routed to a fix or a deferral record.

## 3. silent-failure-hunter — all 6 findings (only #1 made it into plan B4)

1. **(high)** `contingency.js:414` — the validated chance-to-play role layer
   silently isn't running in production; every read error becomes "no role
   layer," no log, no flag. Live: healthy starters (Jayden Daniels, Bucky
   Irving, etc.) show 57-75% "check before kickoff" with no real injury
   concern. **The code half is fixed and committed** (per `fix:review-
   findings-2`); the production write is deliberately held for the reason
   in play-chance-live's own report (§ plan B4) — not yet live.
2. **(high)** `contingency.js:563` — ESPN's OUT/INJURY_RESERVE designations
   never reached `active_probability` (Charbonnet 0.805, A.J. Brown 0.794,
   rival IR players 0.73-0.83 despite being ruled out). **Rejected as a
   fix-here** — already fixed at HEAD by the play-chance-live work this
   finding was reviewing; not a live bug, just found mid-flight.
3. **(medium)** `jev_league_chat.mts:215` — failed chat classifications are
   parked as done and never retried; script exits 0 on failure. **Applied**
   — `jev_chat_done` gained an `attempts` column, retried while `attempts < 3`.
4. **(medium)** `promote-early-week-weights.mjs:414` — a promotion that fails
   its own read-back check stays promoted ("Demote by hand," exit 1).
   **Applied** — new `promoteWeeklyFitChecked()` does an atomic promote +
   verify + auto-demote-on-failure.
5. **(medium)** `trade-engine.js:148` — the asset-universe/findTrades cache
   can't see in-place injury-report updates (`nfl_injuries` stamped on a
   column, `id`, that doesn't exist; the resulting SQL error was silently
   swallowed). **Applied** — cache fingerprint fixed to stamp on
   `modified_at`, and the swallowed error now surfaces.
6. **(low)** `trade-engine.js:2245` — a Decision Inbox write/retire failure
   in `lineupDiff()` is only logged, never surfaced, so a stale high-urgency
   card can sit for its full 72-hour expiry after the lineup changed.
   **[Step: WB action plan/dashboard home]** — not yet routed to a fix.

## 4. `fix:review-findings-2` — the actual breakdown (plan B4 only had the count)

**Applied (5):** silent-failure-hunter #1 (split "no role layer" into a real
state with a reason), #3 (chat retry column), #4 (checked promotion), #5
(cache fingerprint fix); mle-reviewer #3 (mode label + wording, partial).

**Rejected (1):** silent-failure-hunter #2 — already fixed at HEAD by
concurrent work, not a live bug.

**Deferred (4):** mle-reviewer #1 (coordinator double-count + missing-value
penalty — needs its own re-fit, bigger than a review-fix budget); mle-reviewer
#2 (Vegas lift's negative replay result — needs a decision on whether to keep
using it at all); mle-reviewer #3's remainder (snapshot identity + frozen-2023
week-2 logging); silent-failure-hunter #1's remainder (the production write
itself, held on purpose per play-chance-live's own report, not a defect).

## 5. The 3 `issues_unfixed` verifiers — every problem, not just the headline one

**infra-essentials** (`verify:infra-essentials`, `a91f92b6637b5f6cd`) — 6 total:
1. *(medium)* No supervised process restarts the refresh loop after a reboot
   or crash (only running now via manual `nohup`); `npm start` still runs a
   conflicting scheduler-on config.
2. *(medium)* The report claims a "Data Health" page shows new status rows;
   that page was removed 09-17. Failures are invisible except in raw JSON/logs.
3. *(low)* `weekly-learning.js`'s coverage check tests distance-from-0.80
   using point estimates, not whether the change is significant — rejects
   some genuinely-better candidates that land on the other side of 0.80.
4. *(low)* `collect-roster-snapshots.mjs` marks a mismatched week "final"
   anyway; the mismatch flag gets overwritten by the next tick 15 min later.
5. *(low)* No deadline stated for week 2's pregame statuses — a restart slip
   past Sunday 09-20 13:00 ET loses that week's data permanently.
6. *(low)* Minor doc inaccuracies (launcher log readability claim, a test
   count off by one, an unlocked-rows count that leaves out 47 defense rows).

**trade-engine-correctness** (`verify:trade-engine-correctness`, `ac2f2f3a087554881`) — 7 total:
1. *(medium)* `offerFor`/`offerForMany` refuse a genuinely good horizon-
   weighted upgrade (Ja'Marr Chase, live-verified) on a stale weekly-only
   ceiling gate — `trade-engine.js:1935-1959`, `2101-2118`.
2. *(low)* 4 of 74 surfaced ideas score negative and still show (pre-existing,
   not a regression, but the count grows with longer lists).
3. *(low)* 19 of 74 ideas make the playoff-weeks lineup worse — intended
   (real playoff odds weighting "now"), disclosed via `horizon.note`, just
   needs to stay visible wherever a UI reads this.
4. *(low)* `GATE.md`'s stated 0.55 ratio criterion is loose text; the real
   measured ratio is 0.454/0.515 — the code and test are correct, the gate
   wording isn't.
5. *(low)* A cited `baseline.log` evidence file is missing from the scratch
   dir; the number itself was independently reproduced, so the claim holds.
6. *(low)* Quoted playoff odds are ~1 point stale (live data moving, not
   non-determinism — confirmed deterministic across 3 processes).
7. *(low)* Two harmless doc-wording inversions (which routes read `context`;
   which function wraps which).

**valuation-map** (`verify:valuation-map`, `ac93274f51587f5f6`) — 10 total:
1. *(medium)* FALSE CLAIM — the report said "no source changes which ideas
   surface"; disproven live (one league's idea set genuinely changes). Root
   cause: variant collapse in `trade-engine.js:1682-1692`, a file this item
   doesn't own.
2. *(medium)* EDGE TEST VIOLATION — one trade scores positive only via the
   perception multiplier while it's -0.48 ppg for Nick on real numbers,
   against the plan's own non-negotiable rule. `trade-engine.js:1354-1358`.
3. *(low)* 26 of 79 ideas fail the edge test on pure engine numbers,
   pre-existing (not this item's doing) — belongs with trade-engine's
   horizon step.
4. *(low)* A look-ahead leak in a cutoff comparison (string-sort bug on
   mixed timestamp formats), measured and proven inert (0 of 30 rows change
   price) — but the same pattern exists in shipped code elsewhere
   (`build-negotiation-profiles.mjs:75`) where it isn't provably inert.
5. *(low)* Rounding inconsistency between the displayed multiplier and the
   actual priced value (28 of 76,275 cells off by >2 cents) — cosmetic.
6. *(low)* `profileListHit` silently drops 6 of 72 profile entries that use
   a surname only instead of a full name — a fuzzy-match design decision,
   not a bug per se.
7. *(low)* Stated confidence-tier counts don't match the live corpus (2/2/6
   vs. the report's 2/2/5/1); a doc-stale test-suite count (2,635/2,593 vs.
   the real 2,637/2,595).
8. *(low)* 28 of 58 real accept/decline rows are excluded before the
   "skipped" count can see them (an ESPN sync gap, not an analyst choice) —
   makes the already-tiny sample (6 accepts) even more caveat-worthy.
9. *(low)* The same positional-need evidence enters the objective by two
   routes (gate + price) — not technically the double-charge rule forbids,
   but worth an explicit decision rather than leaving it implicit.
10. *(low)* The "what Nick will see" headline omits its own condition (only
    true after `build-manager-signals.mjs` runs) — stated correctly further
    down, just not where it's read first.

## 6. What's still not transcribed even here — pointers, not copies

- **Per-agent spend/timing.** Some `llm_spend_usd` values are visible per
  result; not systematically pulled for all 17. `python3 -c "import json; ..."`
  over the journal, same pattern as everything above, gets them in one pass.
- **Full `results_table` / `gate` / `risks_and_open` / `handoff` fields** for
  every shipped item — only `summary_plain` was transcribed anywhere. Same
  journal, same extraction pattern.
- **Exact shipped-commit SHAs** for llm-plumbing, manager-data-pipeline,
  infra-essentials (have them for tactics-and-packages: `ffe97c9`, `9cee38a`,
  `f92bb5f`) — `git log --oneline` around each item's timestamp gets them.
- **The other 22 workflow runs on disk**, all from 2026-09-17 — listed by ID
  only in plan A5/HANDOFF.md's note, not individually here; their findings
  are already folded into the plan's E-sections (E1-E5), which is the reason
  they weren't re-extracted.
