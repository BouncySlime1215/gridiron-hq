# Every audit finding in one place — 2026-09-20

One line per finding, from every audit document in this repository and in
`/mnt/project-files`, cross-checked against the hold-branch ledger in project
memory. Line numbers are `origin/main` at **791b131** unless the row says
otherwise.

**How to read the status column.** *Fixed (main)* means present in `791b131` and
verified by content, not by a PR's state. *Fixed (held)* means the fix exists on
a no-PR `-hold` branch during the 2026-09-20 GitHub freeze and lands when Nick
says go; the branch and head are in `gridiron-held-branches-2026-09-20` pages
1-3. *Open* means nobody has written the fix. *Decided* means it was examined
and deliberately left as it is.

**What I checked myself** is marked **[v]**. Everything else is another thread's
report, carried here as theirs with their owner attached — the standing rule in
this project is to verify the consumer rather than repeat the producer, and I
could not re-verify every row inside the hour this was asked for.

---

## A. The 2026-09-19 fantasy audit (`/mnt/project-files/fantasy-audit-2026-09-19.md`)

| # | Finding | Where | Status | Owner |
|---|---|---|---|---|
| A1 | Draft board served SQL row order when `computeConsensus()` came back empty | draft-assist | **Fixed (main)** — PR #30 | — |
| A2 | Start/Sit narrated a page of zeros as findings | lineup-brain | **Fixed (main)** — PR #27 | — |
| A3 | Matchup card invented a verdict from 0 vs 0 | lineup-brain | **Fixed (main)** — PR #27 | — |
| A4 | Every position on every team read NEED 0% | leagues/tradelab | **Fixed (main)** — PR #21 | — |
| A5 | A total data outage reported as good news | league analysis | **Fixed (main)** — PR #21 | — |
| A6 | Roster stars dropped and offered back as free agents | league sync | **Fixed (main)** — PR #21 | — |
| A7 | Chance-to-play shown with no basis in the fitted state | `lineup-brain.js:585` | **Fixed (main)** — PR #27 added `availability_basis` | — |
| A8 | Sync jobs reporting success on failure | `scheduler.js:118` exported, called at `:1613` inside `record()` **[v]** | **Fixed (main)** — closed 06:23Z; #21 took three and #19's `statusFromDetail()` is on main. Re-read here, so this row is now verified | — |
| A9 | Three disagreeing answers to "what week is it"; the fantasy pages use the worst | `trade-engine.js:172` **[v]** — `tradeWeekContext()` still takes no league argument | **Open**; default agreed (call `leagueCurrentWeek(lg)`, `routes/trades.js:19`) | feature-audit |
| A10 | `syncEspnMarket` was the sole writer of `espn_player_market` with no caller | scheduler | **Fixed (main)** — PR #50, 12-hour growth job | — |
| A11 | `players.bye_week` vestigial | players table | **Decided**: leave and comment; a no-behaviour migration is pure risk here | — |
| A12 | 35 `|| 2026` sites, and `draft-assist.js:872` uses the calendar year instead | `fly.toml [env]` on main holds only `HOST` **[v]**, so every site falls through to its fallback today | **Open** — #52 (dad6e1a) adds it at `fly.toml:24` (scheduler's claim) and is in the morning merge list | scheduler |

## B. The opportunity study (`docs/OPPORTUNITY-FINDINGS-2026-09-19.md`)

| # | Finding | Where | Status | Owner |
|---|---|---|---|---|
| B1 | Volume shrinkage constants hand-set; the fitter's answer was never persisted | `projections.js:94-96`, `shrinkage-fit.js` **[v]** | **Open — and it is a database write, not code.** See section D for what it is worth | run sheet / Nick |
| B2 | `playerOpportunity` assigned and never read | `nfl-expert-council.js` | **Fixed (held)** — Opportunity's branch | Opportunity |
| B3 | `priorFfOpportunity` attached to every projection, read by nothing | `player-week-engine.js:359` **[v]** | **Open** | fantasy plan |
| B4 | `opportunity-model.js` fitted and graded, no consumer | 425 lines, two importers **[v]** | **Decided** — payoff inside the noise; unwired on purpose, not a defect | Opportunity |
| B5 | `syncDepthCharts` reported success while storing nothing | nflverse | **Fixed (held)** — now raises, naming the missing dependency | Opportunity |
| B6 | Two scripts hardcoded an absolute `/Users/...` path | eval scripts | **Fixed (held)** | Opportunity |
| B7 | `cascades()` multiplier unbounded (x26.38 off a 0.11 base) | `contingency.js` | **Fixed (held)** — #72, null below nine observed divisor events | Opportunity |
| B8 | `cascades()` never graded | — | **Fixed (held)** — graded walk-forward and *refused*; both intervals straddle zero | Opportunity |

## C. Number provenance (`docs/NUMBER-PROVENANCE.md`, 2026-09-18, re-resolved tonight)

| # | Finding | Where | Status | Owner |
|---|---|---|---|---|
| C1 | Item (c)-9, playoff odds not reaching the trade horizon | `trade-engine.js:1317-1319` | **Fixed (main)** | — |
| C2 | Item (c)-14, `findTrades` cache ignored chat and counterparty inputs | `counterparty-pricing.js:917` called at `trade-engine.js:1447` **[v]** | **Fixed (main)** — closed on both halves; the doc's own citation was stale and is corrected | — |
| C3 | Every `file:line` in the document had drifted | — | **Fixed (held)** — staleness banner naming exactly what was re-resolved and what was not | this thread |
| C4 | The counterparty row is superseded by a better document | Trade Brain's branch | **Fixed (held)** — pointer added, with the branch named because it is not on main | Trade Brain |

## D. This audit (`docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md`, PR #68)

| # | Finding | Where | Status | Owner |
|---|---|---|---|---|
| D1 | **The opportunity number as shipped is worse than the player's own season average and worse than an EWMA of his recent games** — and beats both with the fit. 4,828 paired player-weeks, every interval clear of zero **[v]** | `projections.js:94-96` | **Open** — the fix is B1's database write | run sheet / Nick |
| D2 | What that write is worth: Chase 16.25 → 22.01 ppg, McCaffrey 22.26 → 26.69, Jefferson 12.95 → 17.14, and 3.62 → 3.63 for a player with no sample **[v]** | `projections.js:461` is the one read | **Open** (same write) | run sheet / Nick |
| D3 | **The promotion changes nothing on a running process.** The memo keys the shrinkage fit as the constant string `'active'` while carrying the ensemble fit's id; `clearPlayerWeekEngineCache()` has no caller **[v]** | `player-week-engine.js:267`, `:68` | **Open** — order the promotion before the scheduler deploy, or key the memo on the fit id | fantasy plan |
| D4 | The fit is withheld from season-long callers by design, so the title odds and draft board will not move **[v]** | `shrinkage-fit.js:499-513` | **Decided** — correct; state it before he looks | — |
| D5 | The fantasy coordinator's correction was fitted and gated against the **structural** head and both live call sites add it to the **ensemble** number. Mean 2.09 pts on 30% of startable players **[v]** | `trade-engine.js:354`, `fantasy-coordinator.js:571` | **Open**; the `:571` half is on the fantasy-plan coordinator-head hold | feature-audit + fantasy plan |
| D6 | `fantasy_coordinator_refit` is `tier: 'heavy'` and heavy is empty unless `AUTO_HEAVY_SYNC === '1'`, so any active fit is stale **[v]** | `scheduler.js:1339`, `:1759` | **Open** (operational) — the wrong-base fix must merge before `fly secrets set AUTO_HEAVY_SYNC=1` | run sheet |
| D7 | Whether a fit is active on the live database is unknown from here (the route that would answer returns 401) | `routes/model.js:665` | **Open** — one query settles it | Nick |
| D8 | Title odds replay from week 1 on through-2025 projections; the real record is discarded | `MyTeam.tsx:62` sends no `from_week` | **Open** — one-line start | UI |
| D9 | No historical calibration of the title odds exists anywhere in the repo | — | **Open** — a build; a gate exists on the fantasy-plan odds-calibration hold but is not shipped | fantasy plan / Nick |
| D10 | `title_delta` is printed two decimals of a percent against a measured seed-to-seed sd of ~1.1pp | `TradeLab.tsx:291` | **Open** | UI |
| D11 | "Over the season" is `× 17` at week 2, with a fantasy calendar the app already knows | `trade-engine.js:1096`, `TradeCard.tsx:109` | **Open** | feature-audit |
| D12 | The rest-of-season rate carries no availability term. A confirmed season-ender **is** caught; the unguarded case is the graded middle and the hand-set 0.92 | `trade-engine.js:385`, `:346` | **Open**; the proposed persistence curve is a new model | feature-audit → Nick's word |
| D13 | "Fair" is the FantasyCalc price passed through, and `?? 0` makes an unlisted player free in every fairness calculation | `trade-engine.js:419` **[v]** | **Open** | feature-audit |
| D14 | Nothing on the deployed app collects ESPN transactions; the collector runs from an off-server loop against a ~3-day window **[v]** | `scripts/collect-league-transactions.mjs`, `refresh-live-data.mjs:99` | **Open** — a Fly worker or a cron on his machine | Nick / scheduler |
| D15 | The luck read's silent paths: the smallness return precedes the `min_n` branch for all eight sources, and a manager with no archetype row falls through to a sentence that is false in both halves **[v]** | `counterparty-pricing.js:381`, `:452`, `:775` | **Fixed (held)** — Trade Brain, RED 7730804 / GREEN a066001 | Trade Brain |
| D16 | The counterparty layer is a **read, not a price**: never beat plain value on 30 real decisions, and the code caps its whole contribution at ±10% **of a deal's score** (`perceptionFactorFor`; the 0.20 player cap and the 0.15 package cap are different layers) **[v]** | `trade-engine.js:1362-1366` | **Open (wording)** — the pages describe it as pricing | Trade Brain + UI |
| D17 | `/api/model/setup-status` documents itself as "unauthenticated on purpose" and returns 401 | `routes/model.js:655-659` vs `server/index.js:126` **[v]** | **Open** — the mount is right, the comment is false | wiring map |
| D18 | `Confidence` prints "Calibrated" from three literals with no fit; no consumer today | `DesignSystem.tsx:47-49` **[v]** | **Open** | UI |
| D19 | Snap share **is** rendered (`% snaps`) through a per-row unit guess, over a column stored unscaled with no unit in the schema; the other branch has never fired and its failure case prints fringe players near full-time | `news-fantasy-impact.js:136`, `News.tsx:471`, `nflverse.js:294` **[v]** | **Open** | UI (reader) + fantasy plan (ingest) |
| D20 | O4's corpus is never in the image, so the model can produce no number on the deployed app | `history-corpus.js:48` — **not on main [v]**; lives only on #42's branch | **Open (pre-merge)** — caught before it could ship; needs migration 065 too | fantasy plan |
| D21 | No O4 figure should be quoted to Nick until it is known whether his own clone has the corpus built | — | **Open** | fantasy plan |
| D29 | **A league with no ESPN cookie pair still gets fetched, and the public payload is written as that league's own market.** `if (lg.espn_s2 && lg.swid)` sets the cookie header, then the fetch and the write run either way **[v]** | `espn-market.js:31`, fetch `:33`, write `:37+` | **Open — and it wants fixing before #50 merges**, since #50 is what registers the sync. Refuse with the league named | feature-audit |
| D22 | The same ratio means different things on two pages: `starter_value` from `p.vor` against `p.value` | `tradelab.js:125` vs `leagues.js:387` | **Open** | feature-audit |
| D23 | Trade Lab reported a confident NEED for any position the corpus cannot price | `tradelab.js:154` divided by `(avg[pos] \|\| 1)` | **Fixed (held)** — feature-audit #74 | feature-audit |
| D24 | Weekly fantasy scores per league-season are held nowhere, though `view=mMatchup` is requested and the payload persisted | `routes/leagues.js:125`, `:160` | **Open** — unblocks fitting four of feature-audit's thresholds. **The parser already exists and does not need writing**: `espnWeeklyRows` (`server/services/team-outlook.js:375`) takes one league row and returns per-team weekly scores with season, team count, playoff teams, regular periods, weeks played, last week, and refuses unplayed weeks. **Verified here — and it is not on main**: `team-outlook.js` is absent from 791b131 entirely, and the function lives on the fantasy plan's `outlook-fit-hold`, `outlook-consumer-hold`, `odds-calibration-hold` and `odds-gate-hold` branches (the older `outlook-basis` has the file but not the function) **[v]**. So the row is: `routes/leagues.js` reads the raw payload instead of calling it; the function moves to its own service and Google sign-in imports it — after the branch carrying it merges | fantasy plan + Google sign-in |
| D25 | The advice layer is hand-set literals throughout: bye risk 0.25 and 5, waivers 0.05, contention 25.5 / 27.5 / ±5%, ESPN rank weight 2, chance to play 0.92 | several | **Partly fixed (held)** — feature-audit shipped the copy fixes; fitting waits on D24 | feature-audit |
| D26 | For next-week **volume**, advanced stats were tried in a 16-feature ridge and lost to a four-line EWMA — a tested negative, not a gap **[v]** | `opportunity-model.js` | **Decided** — do not propose this build | — |
| D27 | Fitting the **efficiency** k was tried and rejected on evidence (2025 4.773 vs 4.749) **[v]** | `shrinkage-fit.js:465-473` | **Decided** — do not re-open | — |
| D28 | Outside signals for the **efficiency** half (aDOT, air-yards share, CPOE, RACR, PACR — all already on the same table) have never been tried **[v]** | `player_week_usage` | **Open** — the one ML build with a prior reason to work | Nick's word |

## E. Scope and housekeeping (`/mnt/project-files/remaining-work-scope.md`)

| # | Finding | Status | Owner |
|---|---|---|---|
| E1 | The restart cycle: a growth job on the request thread blocks the loop past the 60 s watchdog fuse | **Fixed (held)** — the #56 → #59 → #61 → #63 stack | scheduler |
| E2 | `AI_GATEWAY_API_KEY` appeared in a screenshot on 2026-09-18; rotation never confirmed | **Open** | Nick |
| E3 | GitHub Actions allowance exhausted; the one workflow disabled until 2026-10-01 | **Open (operational)** — local checks are the gate; never re-enable | — |
| E4 | The offline guard did not cover the Anthropic SDK; a `mock.module` shape reported a `TypeError` as a connection failure | **Fixed (main)** — PR #7, per CLAUDE.md; I did not re-verify | — |
| E5 | Zero of 848 betting ensemble fits cleared the promotion gate | **Open** — out of scope, betting | — |

---

## What this ledger says, read as a whole

Three things, and the third is the one worth acting on.

**The 2026-09-19 fantasy audit is essentially closed.** Nine of its twelve
findings are fixed in `main`, one is a decided leave-it, and the two open ones
(A9, A12) each have an agreed one-line default and an owner.

**Tonight's work is mostly held, not open.** Eight of the rows above are *Fixed
(held)* — they exist, tested, on branches with no PR, waiting on one word to
land. The freeze is the only thing between them and main.

**The open list is dominated by one shape**: a number that is hand-set where it
could be fitted, or fitted where nothing reads it. B1/D1/D2 (the shrinkage
promotion), D5 (a validated correction added to the wrong base), D24/D25 (the
advice layer's literals and the table that would let them be fitted), D28 (the
efficiency half) and B3 (a fitted quantity attached to every projection and read
by nothing) are all the same defect wearing different clothes. The single
highest-value item is still B1/D1: it is a database write, it is already gated,
and it moves the number the lineup is ranked by by four to six points a week —
provided D3 is handled, because otherwise the write is invisible until a
restart.
