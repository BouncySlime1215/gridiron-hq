# Full-Codebase Diagnostic — 2026-09-02

**Round 2 (same day, continued):** the remaining Priority 0 items were closed
out — see §5 below for what changed and how each was verified.

Every line of the repository was read (306 server/script files, 34 test files,
the React client, all docs), and every claim below was checked against the
live database or by executing the code. Findings are grouped by what they do to
Week 1 (kickoff 2026-09-09 SEA v NE; 2026-09-10 LAR v SF at the Melbourne
Cricket Ground, a neutral site; 13 games 2026-09-13; NYG v DAL 2026-09-14).

Fixes applied the same day are marked **FIXED**. Everything else is queued in
`PROFITABILITY_PLAN.md` Priority 0.

## 1. What was actually true on the morning of 2026-09-02

| Claim in the 2026-09-01 milestone | What the code and database showed |
|---|---|
| "Froze forward shadow predictions for all 16 Week 1 games" | 144 of the 160 risk-lab rows had a residual of exactly 0.000 — the artifact tables were empty, so every model ran cold-start and returned the market line. The 16 mixture-of-experts rows were a uniform, untrained gate. `nfl_expert_forward_predictions` had zero rows for any season. |
| "All models remain shadow-only with zero betting authority" | True by absence of a staking path, not by enforcement. `nfl_auto_picks.units_staked` was hardcoded to 1 in the INSERT; every `staking_units: 0` / `authority: 'shadow_only'` was a string on a returned object that no code read. |
| The model abstains because "calibration not proven" | The pick path looked the calibration up under `coordinated-market-residual-v1`; the calibrator only ever writes `cover-logit-v2`. The stored walk-forward audit was never consulted. Behind that mismatch the substantive gate also fails (edge-slope z = 0.38 against 1.96), and behind *that*, the residual blend collapses to the market so `edge_points = 0` on all 16 games. Only the first gate was recorded. |
| Odds API budget "50-credit reserve" | Three different thresholds (50, 50, 60) in three call sites; none in the client; none at all in the evidence daemon or the MLB pregame capture. 498 of 500 credits were spent in the 29 hours after the September 1 reset. |
| Scores and settlement "automatic" | The only scheduled score writer skipped ESPN events without an odds object, and ESPN drops odds on final games. No 2026 result could ever land. `finalized_week` therefore stayed 0 forever; the learning cycle, shadow settlement and forward settlement were unreachable. |

## 2. Blockers found and their state

### Credit drain — FIXED
`evidence-daemon.js` called `captureMlbPregame(date)` for every due MLB window,
and that function fetched every game's odds with `ttlMs: 0` (3 credits per game,
15 games, no cache, no reserve). Partial windows were retried every 30 minutes
forever; the ledger showed 18,544 MLB attempts across 584 windows, one window
retried 171 times. On the NFL side the daemon called `snapshotLines()` with no
markets argument (3 credits) and no reserve check.

Fix: the reserve now lives in `odds-api.js#get()` and cannot be bypassed
(`ODDS_API_RESERVE`, default 50; `reserveStatus()` exposes holds). MLB quotes
are opt-in (`MLB_ODDS_CAPTURE=1`) and cached for an hour. The daemon requests
two markets, refuses paid capture when the reserve is exhausted, retries a
partial window at most three times, and raises an `odds_quota_exhausted` alert.
The scheduler now records a job that skipped as `skipped`, not `ok`.

### Scores never landing — FIXED
`gamescript.syncCurrentLines` now writes scores for final events that have no
odds object (scores only; the last pre-final line is preserved as the closing
reference), reads the opening line from the scoreboard's real field path
(`pointSpread.home.open.line` / `total.over.open.line` — the old path never
existed, so `open_spread` was always null), records `neutral_site` from ESPN,
and derives `roof` from the venue's `indoor` flag. `nfl_lines` runs hourly and
is free. Verified: all 32 Week 1 rows now carry opening lines; LAR/SF is
flagged neutral and open-air.

### Finalized-week detection — FIXED
`nfl-model-growth.js` treated any single final game as a finalized week. The
Wednesday opener would have triggered postgame truth, reliability artifacts and
the Week 2 fit with fifteen games unplayed. A week is now finalized only when
every game in it is final (regression-tested).

### Neutral site treated as home — FIXED
No neutral-site flag existed anywhere. Every ensemble component added the global
1.898-point home-field constant to LAR for the Melbourne game (91% of the raw
"edge" on that game), `weather_total` added a dome bonus because games.csv lists
SoFi, and the drive simulator gave LAR a 22.9% chance of a free touchdown.
`game_lines.neutral_site` is now populated from both nflverse (`location`) and
ESPN, the ensemble zeroes `hfa` per neutral game (fit and serve), and the
unified engine passes `homeFieldPoints: 0`. Measured: the raw LAR lean fell from
+2.08 to +1.24 after the change (the remainder is rating-based, not venue).

### Calibration lookup — FIXED
`nfl-auto-picks.js` now looks the cover calibration up under the version the
calibrator writes. Abstentions still read `calibration_not_proven`, but now for
the real reason: the stored walk-forward calibration fails its forward gate.

### Model-derived stake — FIXED
`ensurePicksFor` writes `units_staked = 0` (`NFL_MODEL_STAKE_UNITS` to override
after promotion). The five voided August rows keep their historical value.

### Settlement correctness — FIXED
- Four graders (forward ledger, Wong history, user bets, total picks) guarded on
  `team_score` alone; a half-ingested final graded as a loss (NaN) or, for
  totals, against a coerced `24 + null = 24`. All four now require both scores.
- Risk-lab settlement wrote one arbitrary horizon's market number into every
  horizon and model of a game; online-neural did the same across horizons. Both
  now settle row by row against the market number each row froze.
- Prop closing snapshots matched a quote against itself, producing a fabricated
  CLV of exactly zero for the last capture of every quote. The close now excludes
  the quote's own capture.

### Week 1 forward captures — FIXED
- `buildGbmDataset` required same-season prior weeks, so every Week 1 game of
  every season was dropped and the expert council could never freeze a Week 1
  row. The prior season is now the Week 1 prior.
- The council's "already captured" check compared against 12 experts while a
  ready coordinator produces 13 rows, permanently locking the coordinator out.
- The council silently reported success when the ensemble could not price a
  game; errors are now returned.
- A new scheduled job (`nfl_decision_ledger`, every 3 hours) records every
  decision and abstention for the live week, freezes pregame snapshots and the
  council, and stakes nothing. Before this, the forward ledger existed only
  behind a button. The manual capture route now includes the council.
- The evidence daemon's `open` horizon fires 10 days out rather than 7.
- NFL market routes default to the live week instead of Week 1 forever.

Verified after restart: 16 decisions, 32 pregame snapshots, 208 council rows
(13 × 16) at horizon `scheduled`, then a daemon pass at horizon `open` froze 32
shadow decisions, 16 online-neural rows, 64 risk-lab rows and 208 council rows
without spending a credit (`odds_usage` unchanged at 2 remaining).

### Data identity — FIXED (partially)
- Every Washington postgame packet was empty (158 of 158): `game_lines` uses
  `WAS`, the ESPN play log uses `WSH`, and the join accepted neither. Fixed at
  the query (0 → 198 plays on a 2025 sample). PHI v WAS is Sunday.
- 332 preseason plays were stored as "2026 Week 4". Deleted; the live poller now
  ignores non-regular-season slates.
- The availability edge returned 0 when the injury feed was empty. It now
  returns null so consumers abstain.

### UI — FIXED
`FootballFirst.tsx`, the page built for "record this week before kickoff,
append-only, settle with CLV", was never routed. It is now the **Forward
ledger** tab under Engine (`/betting/nfl/forward`), alongside the previously
unreachable Ensemble and Variables tabs. A no-op call-to-action on the ticket
builder now opens the line shop.

## 3. Still open (queued in the plan, in priority order)

1. **Paid multi-book quotes for Weeks 1–4 do not exist.** Credits reset
   October 1. Options: upgrade The Odds API ($30/month for 20,000 credits), or
   create a free SportsGameOdds account (9 books, spreads/totals/moneylines/
   props/results, 10 requests a minute, 2,500 objects a month) and add it as a
   second provider. Account creation is the owner's action. Until then the only
   line is ESPN's DraftKings reference, captured hourly.
2. `nfl-specialists.js` movement family keys line-snapshot moves by team only,
   so a 2026 snapshot is broadcast onto 2016–2025 training labels (leak).
3. `nfl-orthogonal-specialists.js` chooses family influence on the same
   validation block it then reports.
4. `nfl-execution.js#rankBooks` line edge has no sign; routing can recommend the
   worst number. Copy the sign logic from `bestExecution`.
5. `nfl-capture-dispatch.js` trigger dedup embeds a timestamp, and its state
   updates are unscoped by id.
6. `nfl-news-market-latency.js` matches teams by substring (`NE` matches
   Minnesota, Tennessee, New Orleans, both New Yorks).
7. `nfl-market.js` never applies between-season carryover to the upcoming
   season, so Week 1 uses undecayed end-of-2025 ratings.
8. `nfl-officials.js` referee join is a cartesian product within each week
   (3,029 rows → 44,392), inflating every z-score ~4×.
9. `nfl-tweet-line-correlation.js` watches can only resolve when a paid
   snapshot lands; `nfl_quote_tape` has no producer wired.
10. Eight name normalizers, five team-code maps, six cutoff representations.
11. `player_week_engine` bypassed by season-sim and ceiling-lineup; the
    TD-luck cache never invalidates; identical `gameScriptFor` names in two
    modules.
12. Docs: four different forward-sample targets (200/250), three audit names,
    the "six measured dead" header versus three retired capabilities.

## 4. Verification (round 1)

- 342 tests pass (335 existing + 7 new in `test/week1-readiness.test.js`).
- `npm run typecheck`, `npm run lint`, `npm run build` pass.
- Server restarted on the patched code; the checks in §2 were run against it.

## 5. Round 2 — the rest of Priority 0

### A second, free quote provider — SportsGameOdds (new)
`server/services/sportsgameodds.js` is a complete, opt-in second provider:
spreads, totals and moneylines from up to 9 books, on its own 2,500-object
monthly budget that never touches the Odds API reserve. It is a no-op without
`SPORTSGAMEODDS_API_KEY` — nobody has an account yet, so this changes nothing
today — and writes into the exact `nfl_line_snapshots` table and row shape
`line-shopping.js` already owns, so every existing consumer (shopping board,
sharp-book divergence, the specialists' movement feature, bet routing) reads
it unchanged the moment a key exists. Wired into the evidence daemon (fills in
when the Odds API reserve is held) and a new `nfl_sgo_snapshot` scheduler job.
The event/odds JSON shape was built from SportsGameOdds' published
documentation, not a live key — `sportsGameOddsSnapshotStatus()` says so
explicitly and reports `events_matched` on the first real capture so the shape
can be confirmed once a key exists. 4 tests verify the parser against the
documented oddID shape (`points-{home|away}-game-sp-{home|away}`,
`points-all-game-ou-{over|under}`, `byBookmaker`), including that an
`available:false` book quote is never stored as live.

### Correctness fixes
- **`nfl-execution.js#rankBooks`** — the line-edge term was unsigned, so a
  book offering a worse number by the same margin as a better one scored an
  identical positive edge; the furthest-from-median book in either direction
  could rank first, including the worst price on the board. Signed to match
  `bestExecution`'s convention. Verified against the real database's margin
  distribution: a book at -4.5 against a -3 field now scores a negative edge
  and a book at -1.5 scores positive, and the router correctly prefers -1.5.
- **`nfl-officials.js`** — the referee-to-game join was `season = season AND
  week = week`, attributing every crew to every game that week (3,029 rows →
  44,392 joined rows, confirmed by direct query). The officials feed's
  `game_id` is a legacy numeric id with no team columns; fixed by resolving
  each id to its home/away teams once at ingest, via nflverse's own
  `old_game_id` crosswalk in games.csv (the same file and `LA→LAR`
  normalization `gamescript.js` already uses), then joining exactly on
  `(season, week, home_team, away_team)`. Verified against live nflverse data:
  21,977 of 22,012 assignments (99.8%) resolved, and `refereeTotals()` now
  returns 3,014 referee-games instead of 44,392.
- **`nfl-specialists.js` movement family** — line-snapshot moves were keyed by
  team abbreviation only, so a snapshot captured today attached to every game
  that team played back to 2016. Keyed by `(team, kickoff date)` instead.
  Verified: a synthetic 2026 snapshot no longer shows up on an otherwise
  identical 2016 game for the same team.
- **`nfl-orthogonal-specialists.js`** — each family's influence (how much to
  trust it) was chosen by the incremental error reduction on a validation
  block, and that same block's error reduction was then reported as the
  "validation result" — in-sample for the one number the module exists to
  report honestly. Split into three chronological blocks (train fits
  coefficients, tune selects influence, report is graded afterward on data
  neither step touched).
- **`nfl-market.js`** — two related fixes. (1) Between-season carryover was
  only ever applied when the walk-forward simulation crossed a season
  boundary in the data; with zero completed games in the upcoming season it
  never crosses that boundary, so a Week 1 prediction used full, undecayed
  end-of-last-season ratings. `predictGame` now takes an optional `season` and
  applies `carryover ^ seasons_elapsed` itself. (2) Neutral-site games (LAR v
  SF, Melbourne) got the fitted home-field constant like every other game;
  `historicalGames`/`simulate`/`predictGame`/`boardFor` now read
  `game_lines.neutral_site` and zero it. Verified with a synthetic 30-season,
  1,080-game dataset: the formula-level assertion (`predictGame` three
  seasons past the last completed one equals the same-season prediction times
  the fitted `carryover^3`, to within rounding) passed against the model's
  own fitted carryover, not a hardcoded one.
- **`nfl-capture-dispatch.js`** — the trigger-queue's `UPDATE ... WHERE state
  IN ('pending','deferred')` touched every pending/deferred row in the table,
  not just the `LIMIT 100` batch actually considered; a slate with more than
  100 outstanding triggers could mark events "captured" that were never
  looked at. Scoped to the exact batch of ids selected.
- **`nfl-news-market-latency.js`** — team matching used a raw substring test
  against BOTH the abbreviation and the full name; the odds provider's
  `home_team`/`away_team` fields are always full names, so the two-letter
  abbreviation was a live collision source ("NE" inside "miNNEsota",
  "teNNEssee", "NEworleans", both New Yorks). Dropped the abbreviation probe;
  matching is now the full name only, which is unambiguous. A regression test
  confirms Minnesota/Tennessee/New Orleans/both New Yorks no longer match a
  "New England" claim, and New England itself still does.

### Verification (round 2)
- 351 tests pass (347 after round 2's own fixes + 4 new SportsGameOdds parser
  tests + 4 new model-fix regression tests, one of which — the officials join
  — was additionally confirmed against a full live nflverse ingest, not just
  synthetic data).
- `npm run typecheck`, `npm run lint` pass.
- New test files: `test/sportsgameodds.test.js`, `test/nfl-model-fixes.test.js`.

### Still open after round 2
Everything in the original §3 not listed as fixed in round 2: the redundant
`(g.team || g.opponent) IS NOT NULL` tautology is now removed as part of the
officials fix, but the rest — eight name normalizers, five team-code maps, six
cutoff representations, the season-sim/ceiling-lineup bypass of the shared
player engine, the TD-luck cache that never invalidates, the two
identically-named `gameScriptFor` implementations, and the doc contradictions
(forward-sample target, audit names, "six measured dead" vs three retired) —
remain queued and are not touched by this pass. `nfl-market.js`'s own fitting
methodology (alpha/carryover chosen by grid search over the ENTIRE history,
not a separate held-out window) is a deeper redesign and stays open; only its
serving-time application of the fitted carryover was fixed.
