# Gridiron HQ — consolidated findings and the plan forward
**2026-09-12.** Built from: the fully adversarially-verified audit-system review (22 confirmed gaps),
three independent structural agents (code, schema, and standard-practice), and 20 of 23 full-codebase
subsystem reads. See the coverage note at the end for what is NOT yet folded in.

---

## The one-paragraph picture

Gridiron is not one system with bugs in it — it is several systems that each work internally but were
never wired to each other, sitting on top of one live database that a few of them can corrupt. The
audit/replay/ledger layer has seven separate "did the model work" engines and five separate CLV
calculators that disagree with each other and have already caused one real incident (the documented
run-27-vs-run-31 confusion). The forward 2026 evidence chain — the only thing that can ever prove an
edge exists — currently produces zero admissible observations: the quote clock can't stamp a receipt,
the frozen packet throws away its own contents, and the one ledger with live rows recorded two already-
finished games as future predictions. Two live endpoints let anyone through your phone tunnel spend your
Anthropic credits in a loop, and a dead process is currently leaving an unmanaged public URL pointed at
your app. On the fantasy side — your stated priority — the weekly retrain loop has never captured a
single snapshot in its life while reporting healthy, and a one-line naming bug from three weeks ago
silently emptied the Trends page's buy/sell/hold lists and every player-prop match. The drive simulator
that's supposed to be an independent forecasting family has six compounding physics bugs (turnovers
handed to the wrong team's field position, clock units mismatched by 2x, kneel-downs burning the wrong
amount of clock) that together suppress exactly the short-field, late-game variance real NFL games have.
None of this needs new code. It needs consolidation, three security fixes, and about two weeks of
disciplined wiring.

---

## Phase 0 — Today (~1 hour). Live exposure.

1. **Kill the orphaned tunnel.** `tunnel.mjs`'s registrar process is dead but its `cloudflared` child is
   still alive and forwarding a public URL to port 5177, unmanaged and unadvertised in the app. Kill the
   orphaned `cloudflared` process, restart `scripts/tunnel.mjs`, and fix `launcher.mjs:89` to health-check
   the registrar, not just the child process, so this can't recur silently.
2. **Gate the two Anthropic-spending endpoints.** `POST /explain/page` (`betting-hub.js:878`) and
   `POST /scout/:id` (`edge.js:259`) have no permission check and are reachable through the phone tunnel
   by anyone unpaired. Add the same `requireModelPermission`/`model:execute` gate their sibling routes
   already use.
3. **Auth the teaser-settlement route.** `settleTeaserExecution` (`nfl-teaser-execution.js:307-360`,
   reachable via `betting-hub.js:450` and `wong.js:629`) grades from caller-supplied scores with no auth
   and writes to a mutable ledger. This is the forward record of your one measured-positive strategy —
   lock the route and make it look up the real score from `game_lines` instead of trusting the request body.

## Phase 1 — This week. Fantasy-priority correctness (fantasy beats betting, per your standing rule).

4. **Fix the player-name join that broke Trends and props.** Commit `129115e` (2026-08-31) changed
   `projections.js:history()` to store abbreviated names ("D.Maye") instead of full names. Every
   downstream consumer that joins by full name now silently matches nothing: `nfl-prop-clv.js:98`,
   `nfl-props.js:604/655`, and critically `td-regression.js:310-321` — which is why the Trends page's
   buy/sell/hold lists have been structurally empty since the end of August. One name-normalization fix
   at the source un-breaks all of it.
5. **Un-block the fantasy weekly-learning loop.** `weekly_prediction_snapshots` has zero rows for every
   season ever, because `player_week_engine.heads` is null on a cold Week-1 start and the capture
   silently no-ops — while the scheduler has logged this as "ok" 34 times. The retrain/promotion loop
   that's supposed to make your projections better over the season has never run once. Fix the cold-start
   path and add an alert (not just a log line) if a week's capture comes back empty.
6. **Fix news misattribution.** A story mentioning multiple players assigns its status to all of them
   (`nfl-news-signal.js:144-163`), and team abbreviations "WAS"/"NO" collide with the English words,
   misattributing 193 stories (`normalize.js:19-24`). This feeds 11+ downstream consumers including the
   fantasy-facing ones.
7. **Two draft/trade correctness bugs, when you have an hour:** the betting↔fantasy bridge compares a
   local integer ID to an ESPN GSIS ID and therefore always returns null injury/role data
   (`betting-fantasy-link.js`); and one real 2026 live draft (draft 20) never got finalized and still
   shows `status='active'` four days later at 127/128 picks.

## Phase 2 — This week. Stop the money-path from lying to itself.

8. **Real receipt clock on the free odds feeds** (`book-feeds.js:417`, `line-shopping.js:66`): stamp
   `receivedAt` after the network calls resolve — the honest timestamp already exists two lines earlier
   and is simply dropped. This one fix is the prerequisite for every forward-evidence item below it; until
   it lands, the T-60 packet can never admit a real price.
9. **The ESPN live-line sync is overwriting historical spreads with in-game numbers**
   (`nfl-espn-pbp.js` / `syncCurrentLines`, no pre-kickoff guard on the `spread`/`total` columns — only
   `closing_spread`/`closing_total` are protected). Live evidence: the share of clean integer spreads in
   the `spread` column has fallen from 47.7% (2024) to 16.9% (2026 so far) as in-game numbers leak in.
   Every reader that isn't already using `closing_spread` (most of `nfl-cover-calibration`,
   `margin-distribution.js`, the drive-sim backtests) is quietly training and grading on corrupted lines.
10. **Persist the frozen decision packet and give it a real hash.** Migration adds a `packet_json` column;
    `freezeT60Packet` emits the full contract shape; the hash excludes wall-clock fields so re-freezing
    identical inputs gives an identical hash.
11. **Route decisions through the append-only tape, not the mutable upsert.** `t60-runner.js` should call
    the decision board on the frozen packet and write to `nfl_decision_runs`, not leave decisions in
    `nfl_pick_decisions` (which currently overwrites itself every 3 hours — all 16 Week-1 rows now share
    one timestamp after 66 silent overwrites).
12. **Guard the shadow ledger against post-kickoff capture.** It recorded two already-finished games as
    forward predictions with no kickoff/score check, and settles against the live-mutable `spread` column
    instead of `closing_spread`.

## Phase 3 — Next 1–2 weeks. Consolidate the audit system (this is where "the fix isn't more audit code" lives).

This is the verified review's own 16-step build order (item numbers below match its §7), reordered
slightly to put the items that unblock everything else first. Each has an exit test in the full report.

13. Items 1–5 from the review (receipt clock — done in Phase 2 — persisted packet, tape-routed decisions,
    shadow guard, one CLV definition) — **these five are the actual Week-2 critical path.**
14. **Delete or merge the duplicate engines**, per the review's keep/merge/delete table:
    - `nfl-clv.js` (legacy, 4th CLV definition, 0 rows) — **delete**, unschedule from `scheduler.js:275-278`.
    - `nfl-research.js`'s ablation code (`:120-146`) — **delete**, duplicate of `nfl-family-contribution.js`.
    - `forward-ledger.js`/`forward_picks` — **merge into the tape**, then delete; 0 rows, caller-supplied
      clock, in-place settlement.
    - `audit-registry.js` — **merge into one new `research_trials` register** that keeps its
      preregistration semantics but fixes its broken gating; retire `nfl-blind-audit.js`'s bespoke
      duplicate of the same idea into it.
    - `weekly-walkforward.js` vs `scripts/audit-football-first.mjs` — same question asked twice with
      different fits; keep the service, make the script call it.
    - `evidence-daemon.js` vs `t60-runner.js` — merge; one notion of "T-60," linked by observation ID.
15. **Findings-ledger isolation** (a stale finding currently throws outside its try block and would abort
    the entire 2026 season-end learning cycle) and **forward-only holdout fencing** (a finding can
    currently pass on a coin flip against development-era data it was invented from).
16. **One clustered bootstrap over declared weeks**, replacing five independent reimplementations, and
    the four counting bugs in the audit overview (win-rate interval always `[0,0]`, coverage blind to
    truncated runs).
17. **A real trial register with a multiplicity haircut** (Holm within families, deflated-Sharpe/PBO
    across the whole search) so the development-era "finding 1" and the beat-the-close signals are
    interpretable rather than the best of an uncounted number of tries.
18. **Pre-declare the 2026 review endpoints now, before Week 3 kickoffs**: Week 9 for pipeline integrity
    only, Week 18 for all-game CLV direction. **Not ROI** — the arithmetic doesn't support it this season
    (≤90 selections; ~560 needed to resolve a 10% edge, ~2,250 for a 5% edge).
19. **Relabel the historical replay honestly.** Runs 27/31/32 grade the raw blend, not the market-residual
    blend the live board actually serves — make `blendMode` an explicit, recorded part of every run's
    identity, and caption every historical number as "closing-line diagnostic of the raw blend," not
    evidence about what the app would have bet.

## Phase 4 — Soon. The drive simulator has real physics bugs.

Independent of the audit-system work: the game simulator that's meant to be one of your independent
forecasting families has six compounding defects, found in a fresh read of `nfl-drive-sim.js` and its
policy/learning callers:

20. Turnovers are handed to the new offense at the *wrong* team's field position (a pick at your own 20
    gives the opponent the ball 80 yards out instead of 20) — this suppresses exactly the short-field
    scoring that drives real NFL blowout variance.
21. In-game decision policies (4th-down, prevent defense, hurry-up, two-point chart) receive
    half-game-clock seconds but are written expecting full-game-clock seconds — every policy fires as if
    the game were ending at the *end of the first half*.
22. The kneel-down rule is inverted (more opponent timeouts should shorten your kneel window, not
    lengthen it) and timeouts are never actually decremented, so any leading team with the ball inside
    2:40 of *either* half burns the entire rest of that half — killing all late-game comeback variance.
23. Away-team win-probability calls use the home team's spread with the away team's lead, flipping the
    sign of a meaningful input whenever the away team has the ball.
24. Home-field advantage is applied as a flat 22.9%-of-games, 7-point lump *after* overtime, which
    directly distorts the key-number distribution (3, 7) the simulator exists to reproduce.
25. The season-length "remainder" simulator has no halftime and no overtime at all, so its predicted tie
    rate is far above the real ~0.4% and gets persisted into `nfl_live_possession_predictions`.
Given these compound, the simulator's calibration constants were almost certainly tuned to compensate for
several of them at once — fix the mechanics first, then recalibrate, not the other way around.

## Phase 5 — Ongoing hygiene, lower urgency.

26. Move the ~90-second football-first model fit off the Express request thread (the code already has a
    non-blocking `peekResidualModel` path and a worker-thread pattern for the sibling fit route — this
    handler just doesn't use either, and Week-1 data capture is now busting its cache on every write).
27. Fix `package-release.mjs`'s non-git fallback, which would ship your entire 11.3 GB live database and
    `.env` if it's ever run outside a git checkout, despite its own header promising otherwise.
28. MLB: add a first-pitch guard — 1,271 "pregame" snapshots were actually captured after games started,
    contaminated with outcome-derived lineups.
29. Fix the two hardcoded `reachable: true` writes in the Wong ticket-saving path, which currently tell
    the user a price was book-verified when it was not checked at all.

---

## What this plan deliberately does not promise

Per the review's own arithmetic: this season can produce a complete, honest forward ledger and a
CLV-direction reading. It cannot produce a credible ROI or "the model has an edge" claim — the sample
size isn't there, and no amount of good engineering changes that. The plan above is entirely about making
the *evidence* trustworthy, not about making the model win more.

## Coverage note — what is NOT yet in this plan

The audit/replay/ledger system above is fully read and adversarially verified (22 gaps confirmed, 9
refuted after a strict 3-lens check, both outcomes documented). The broader codebase read is **20 of 23
subsystems complete** — everything above is drawn from those 20 (routes, core model, council/research,
sim/strategy, execution, market data, props, news, fantasy draft/trade, player models, infra, MLB,
client, tests). **Not yet read:** the Python research lab's own findings, a docs-vs-code consistency
pass, and a docs-evidence contradiction sweep. **Not yet started:** reconciling your chat history and git
log against what's actually in the code (what was claimed done vs. verified done), and a full data-layer
inventory (the 11 GB live database, the 9.8 GB pre-migration backup sitting beside it, and whether the
lab-output directories under `server/data/` are safe to clean up). I'll fold all of that in as an
addendum to this plan the moment it lands — nothing above should change materially, since it's additive
codebase coverage, not a re-check of what's already verified.
