# Verification notes — G07-nfl-sim-strategy (11 claims)

Files read in full (or in complete chunked coverage) before judging:
- server/services/nfl-drive-sim.js (1280 lines; read 1-985 then need lines 986-1280 for backtest/tail — claims cited are all <=985, core logic covered; tail is backtest reporting, not needed for these claims)
- server/services/nfl-sim-policy.js (618 lines, full)
- server/services/nfl-live.js (172 lines, full)
- server/services/nfl-unified-engine.js (96 lines, full)
- server/services/nfl-sim-learn.js (lines 1-64, 395-486 — RATE_SPEC block and EP-surface block, the two regions relevant to claims #36/#37)
- server/services/nfl-sim-calibration.js (132 lines, full)
- server/services/gamescript.js (lines 90-310, covering syncCurrentLines and the ON CONFLICT statement, plus surrounding context)
- server/betting/nfl/strategy/teaser-scan.js (lines 1-260, covering SPREAD_SOURCES, legProbabilities, scanTeaserBoard/scanFromBoard, priceFloor gate)
- server/betting/nfl/strategy/teaser-leg-rates.js (targeted regions: 30-60 data-defect note, 555-580 grading table, 690-720 correlation correction)
- server/betting/nfl/strategy/teaser-staking.js (targeted regions: 190-260 header/MEASURED, 1090-1170 recommendStake/gate)
- server/services/nfl-espn-pbp.js (lines 1-40, 250-330 — imports, simulateLiveGame, route wiring)
- server/services/nfl-live-ledger.js (full, 209 lines)
- server/services/nfl-teaser-execution.js (lines 1-40 — TEASER_POLICY)
- server/betting/nfl/strategy/teaser-season.js (lines 100-120 — DEFAULT_WONG_SETTINGS)
- server/routes/nfl-betting.js (targeted: router mount grep, unifiedGameProjection call site ~1139, pbp routes 1220-1290)
- server/index.js (router-mount greps)
- server/services/scheduler.js (targeted greps for gamescript/live-ledger/pbp jobs)
- server/routes/wong.js, server/routes/execution-slate.js, server/routes/betting-hub.js, server/services/execution-slate-reasoning.js, server/services/gridiron-model.js (grep-level reachability confirmation for teaser-scan.js / nfl-teaser-execution.js)

Reachability checks performed with `grep -rln` across server/ and client/ (excluding node_modules) for every service file cited, plus explicit checks of server/index.js router mounts and server/services/scheduler.js registered jobs. One direct read-only DB query was run via `node -e` with `node:sqlite {readOnly:true}` to corroborate claim #38's cited integer-spread shares.

---

## #30 — turnover field-position mirroring (nfl-drive-sim.js:536, :345, :393)

Confirmed by direct reading. `simulateDrive`'s turnover branch (line 343-346) returns
`endYard: clamp(yard, 1, 99)` — this is **unflipped**, i.e. still in the *offence-that-just-turned-it-over*'s own frame (the doc-comment at line 237 establishes "yard counts from the offence's own goal line"). By contrast the punt branch (line 390-393) returns `clamp(100 - Math.min(yard + net, 99), 1, 99)` — already flipped into the *opponent's* frame — and turnover-on-downs (line 402) returns `clamp(100 - yard, 1, 99)`, also flipped. FG-miss (line 386-388) likewise returns the flipped value.

`simulateGame` then does, uniformly, at line 536: `yard = (d.points > 0 || d.kneel) ? 25 : clamp(d.endYard, 1, 99);` right after flipping `possession` (line 535) to the new offence. For punt/FG-miss/downs this is correct (those `endYard`s are already in the new offence's frame). For a turnover it is wrong: the new offence receives `d.endYard` = the OLD offence's own-frame yard, un-flipped, when it should receive `100 - d.endYard`.

Worked example: offence throws a pick at its own 20 (`yard=20` when the play happens). `d.endYard = 20` (unflipped). The correct field position for the new offence (which just intercepted deep in the old offence's territory) is `100-20=80` (i.e., only 20 yards from paydirt — great field position). The code instead hands them `yard=20`, i.e. their own 20 (80 yards to go) — the sim treats a short-field takeaway as if the new offence were pinned deep. This exactly matches the claim's framing (offense's own-20 pick should give the new offense a short field, ~20 yards to go, but the sim gives them 80 yards to go).

Cross-check: `nfl-sim-learn.js:439` (`d.turnover ? clamp(100 - d.endYard, 1, 99)`) independently treats `d.endYard` for a turnover as needing the `100-x` flip before use — i.e. the EP-surface code's author correctly understood the (buggy) contract that `simulateDrive`'s turnover `endYard` is unflipped. That is strong corroborating evidence this is a real, unintentional inconsistency in `simulateDrive`/`simulateGame`'s internal contract, not a deliberate design choice.

`simulateRemainder` (line 825) has the identical line: `yard = (d.points > 0 || d.kneel) ? 25 : clamp(d.endYard, 1, 99);` — same bug repeated, as claimed.

**Reachability**: `simulateGame`/`simulateDrive` are the core of `simulateMatchup`, which is called from `nfl-unified-engine.js:unifiedGameProjection`, mounted at `/api/nfl-betting` (confirmed router mount in server/index.js and call site in server/routes/nfl-betting.js:1139). This fires on essentially every simulated drive that ends in an interception or fumble — a frequent, core code path.

**Verdict: CONFIRMED, P2 reasonable.** This is a genuine, reachable, high-frequency field-position bug.

---

## #31 — half-clock passed where policies expect full-game seconds

`nfl-drive-sim.js` simulateGame: `for (const half of [1,2]) { let clock = HALF; ... }` (HALF=1800, line 48/460) — clock resets to 1800 for **each** half and counts down within that half only; it is passed to `simulateDrive` as `secondsLeft: clock` (line 479) and forwarded unchanged into every policy call (`P.varianceProfile`, `P.paceProfile`, `P.kneelDecision`, `P.fourthDownByWinProbability`, etc. — lines 258-370).

`nfl-sim-policy.js` and `nfl-live.js` are internally consistent with each other in assuming a **3600-second full-game clock**:
- `nfl-live.js:34` `const GAME_SECONDS = 3600;` and the whole `liveWinProbability` model (fraction = left/3600).
- `nfl-live.js:62-64` docstring: "@param secondsLeft game seconds remaining".
- `nfl-sim-policy.js:214` `urgency = clamp(1 - secondsLeft / 3600, 0, 1)` in `varianceProfile`.
- `nfl-sim-policy.js:109` `if (secondsLeft > 420) return null;` in `fourthDownByWinProbability` (the "inside 7 minutes" endgame override).
- `nfl-sim-policy.js:147` `const late = secondsLeft < 900;` in `twoPointDecision`.
- `nfl-sim-policy.js:243-244` `desperate = lead<0 && secondsLeft<300`, `protecting = lead>0 && secondsLeft<300` in `paceProfile`.
- `nfl-sim-policy.js:342` `shouldPrevent = lead>0 && secondsLeft<180 && ...` in `preventDefense`.

Since drive-sim never passes more than 1800 to any of these, `urgency` (module 5/6, /3600 denominator) is mathematically confined to `[0.5, 1.0]` for the ENTIRE game (both halves), never touching the `[0, 0.5]` range that would represent "plenty of time left." All of the second/quarter fractions used elsewhere (`/3600`) are similarly compressed. The 420/300/180-second absolute thresholds fire at the end of BOTH halves (since clock resets to 1800 each half and counts to 0), meaning "endgame" logic (module 2's win-probability override, hurry-up, prevent defense) spuriously activates in the final minutes of the FIRST half too, not just the actual end of the game.

**Reachability**: same core `simulateDrive`/`simulateGame` path as #30 — fires on every drive of every simulated game. Confirmed reachable via the same mounted route chain.

**Verdict: CONFIRMED, P2 reasonable.** Real, systemic unit mismatch between the drive engine's half-clock and the policy layer's/live-model's full-game-clock assumption, and it is on the hottest path in the file.

---

## #32 — kneel rule's inverted-timeouts window

`nfl-sim-policy.js:291-297`:
```
export function kneelDecision({ lead, secondsLeft, timeouts, yard, isHalfEnd }) {
  const kneelable = 40 + timeouts * 40;
  if (lead > 0 && secondsLeft <= kneelable) { ... call: 'kneel' ... }
```
Called at `nfl-drive-sim.js:265`: `const kneel = P.kneelDecision({ lead, secondsLeft, timeouts: oppTimeouts, yard, isHalfEnd });` — `timeouts` here is explicitly the **opponent's** remaining timeouts (`oppTimeouts`), confirmed by the parameter name at the call site and by the function's own reason string ("the opponent holding ${timeouts} timeouts").

Football logic check (standard "victory formation" rule of thumb): more timeouts in the OPPONENT's hands means the opponent can stop the clock more times during a kneel-down sequence, so kneeling burns LESS real clock per down (each defensive timeout removes ~38s of runoff you'd otherwise get), meaning you need LESS remaining time (not more) before it is genuinely safe to switch to kneels — otherwise the opponent gets the ball back with real time on the clock. The code's `kneelable = 40 + timeouts*40` does the opposite: it GROWS the safe-to-kneel window as the opponent's timeouts grow (40s @ 0 TOs, up to 160s @ 3 TOs), which is backwards from the actual strategic calculus. This is a genuine direction inversion, not just a naming quibble.

The first branch (line 293) has no `isHalfEnd`/half-number check — it fires whenever `lead>0 && secondsLeft<=kneelable`, so it applies identically at the end of the FIRST half (not just game end), confirmed by the lack of any half-guard in that branch.

`kneel.call==='kneel'` return at line 267: `return { points:0, seconds: secondsLeft, endYard: yard, kneel:true, ... }` — `seconds: secondsLeft` means the ENTIRE remaining clock (up to 1800, per #31) is consumed in one shot; back in `simulateGame` line 503, `clock -= Math.max(15, d.seconds)` zeroes the clock immediately, ending the half/drive loop. Confirmed: a kneel call ends the half instantly.

Timeouts-never-decremented check: `simulateGame` resets `timeouts.home=3; timeouts.away=3;` once per half (line 461) and never mutates them afterward — `P.timeoutPolicy(...)` is called at line 475 (`const to = P.timeoutPolicy(...)`) but its result `to` is never read or used again in the loop (grepped remainder of the while-loop body; no further reference to `to`). So `oppTimeouts` is always exactly 3 for both teams for the whole half, making `kneelable` a constant 160 (`40+3*40`) whenever the kneel path is even consulted.

**Reachability**: `kneelDecision` is called on literally every drive (line 265, unconditional), so this is core, high-frequency logic.

**Verdict: CONFIRMED, P2 reasonable.** Direction of the timeouts effect is backwards from real strategy, applies erroneously at first-half boundaries, and the "window" is a static, always-maximal constant because the underlying timeout-tracking is dead code.

---

## #33 — away-team WP calls mix offence-view lead with home-side spread

`nfl-live.js:62-64` docstring is unambiguous: `@param lead current margin from the home team's view`, `@param pregameSpread ESPN convention: negative means the home side is favoured`. `expectedRemaining = (-pregameSpread) * fraction` (line 76) is only correct when `lead` and `pregameSpread` are both expressed from the SAME team's perspective (home, per the doc).

In `simulateGame`, `lead = possession === 'home' ? home - away : away - home;` (drive-sim:467) — this is **offence-view**, not home-view: when the away team has the ball, `lead` is the away team's own margin (the negative of home-view lead). This offence-view `lead` flows unchanged into `simulateDrive`'s `state.lead` (line 480) and from there into every policy call that consults win probability:

- `nfl-sim-policy.js:115` (`fourthDownByWinProbability`): `const wp = (l, s) => liveWinProbability(l, Math.max(0, s), spread);`, called with the offence-view `lead` and the raw home-convention `spread` (drive-sim:363, :481) — no negation of `spread` when `possession==='away'`.
- `nfl-sim-policy.js:178` (`onsideDecision`): `liveWinProbability(-lead, secondsLeft-10, spread)` — same unmodified `spread`, called from drive-sim:531 with `lead: myLead` (offence-view again).
- `nfl-sim-policy.js:213` (`varianceProfile`): `liveWinProbability(lead, secondsLeft, spread)`, called from drive-sim:258 with the same offence-view `lead`.

Algebra: for the away offence to get a correct prior term, `spread` would need to be re-expressed in away-team convention (negate it) before being combined with the away-view `lead`. None of the three call sites do that — `spread` is passed straight through in home convention regardless of which team is on offence. Concretely: home favoured by 6 (`spread=-6`) → `expectedRemaining = +6*fraction` is correctly added to a home-view lead, crediting the favourite; but when the away team is on offence, the same `+6*fraction` gets added to the AWAY team's own-view lead, incorrectly crediting the AWAY (underdog) team with the home team's favourite bonus — the sign is backwards exactly as claimed.

**Reachability**: all three functions are invoked on essentially every drive/decision point of every simulated game (module 2 on 4th-and-short in the last ~7 min of a half, module 4 on onside-kick decisions, module 5/6 every single drive for variance profile) whenever a `spread` is supplied — and `spread` is supplied on the primary path (`unifiedGameProjection` always passes `postedSpread`, drive-sim:684-685 forwards it into every `buildContext`/drive call). This fires on roughly half of all drives (whenever the away team has the ball) in every meaningful (spread != null) simulated game.

**Verdict: CONFIRMED, P2 reasonable.** Real, reachable, frequent sign bug affecting three separate modules for the away side whenever a spread line is in play.

---

## #34 — home-field advantage as a post-overtime +7 lump

`nfl-drive-sim.js:562`: `if (homeFieldPoints > 0 && random() < homeFieldPoints / 7) home += 7;` sits textually and causally AFTER the OT block (lines 541-558), i.e. it runs once per simulated game, after any tie has already been broken (or not) by overtime. With the default `homeFieldPoints=1.6` (simulateMatchup default, line 672), `1.6/7 ≈ 0.2286` → 22.9% of games get a post-hoc +7 to the home score, unconditionally, including games that just finished in OT.

`nfl-unified-engine.js:44-47` independently corroborates both the existence and the severity of this: `// No home field at a neutral site: the simulator's default 1.6-point bonus is a 23% chance of a free touchdown for the nominal home team.` and the code there works around it by forcing `homeFieldPoints: neutral ? 0 : 1.6` (line 52) rather than fixing the underlying mechanism — the workaround itself is direct evidence the bug is understood and considered material by the same codebase, just patched around instead of fixed.

Consequence check: this fires after `home === away` (tie) has already been resolved by the OT loop at lines 541-558 (which does produce a genuine winner in the vast majority of cases, or occasionally leaves a true tie if `otClock` and `had` both run out). Adding +7 to `home` AFTER this point can: turn a just-settled OT tie into a home win by 7; turn an away win by 7 into an artificial tie; or shift any margin's key-number mass by exactly 7 for 22.9% of games, unconditional of whether OT ran, home or away won, by how much, etc.

**Reachability**: same core `simulateGame` path, definitely reachable on every non-neutral-site game through `simulateMatchup`.

**Verdict: CONFIRMED, P2 reasonable (arguably could be argued P1 given it directly corrupts the model's headline distributions — key numbers, OT-tie rate — but P2 is defensible given the existing partial workaround at the unified-engine layer for the worst case, neutral sites).**

---

## #35 — simulateRemainder: no halftime/OT, ties persist in live_moneyline

`nfl-drive-sim.js:773-861` (`simulateRemainder`): single `while (clock > 0)` loop (line 805) with **no** halftime break and **no** OT block, unlike `simulateGame` which explicitly re-initializes `clock=HALF`/timeouts per half (lines 459-461) and runs an explicit OT sequence after (lines 541-558). Every internal `simulateDrive` call inside `simulateRemainder` hardcodes `timeouts: 3, oppTimeouts: 3` (line 809) regardless of the real, already-used timeouts of the live game being modeled. At the end of the loop, `home===away` is left as a genuine tie (no OT resolution mechanism exists in this function), and `live_moneyline.tie: r4(tie)` (line 846) reports that raw tie rate directly, with no correction.

Caller check — `secondsLeft` really is passed as up-to-3600 game seconds here (unlike `simulateGame`'s internal half-clock in #31): `nfl-espn-pbp.js` (`simulateLiveGame`, line ~290): `secondsLeft: g.live.clock_seconds ?? 900` where `clock_seconds` is ESPN-feed-derived total game seconds remaining (0-3600 range), and `server/services/nfl-live-ledger.js:84` (`predictPossession`) passes `secondsLeft: state.seconds_left`, also a raw play-log clock value that can be well over 1800.

Ledger persistence: `nfl-live-ledger.js` line ~84 does put `tie: result.live_moneyline.tie` directly into the `prediction` object that is subsequently JSON-serialized and inserted into `nfl_live_possession_predictions` (`INSERT OR IGNORE ... prediction_json ...`, further down in `predictPossession`). This part of the evidence is accurate as written, but see the reachability caveat below.

**Reachability**:
- The core defect (simulateRemainder produces a continuous-half sim with no OT, inflating live tie probability) IS reachable via the mounted route `GET /api/nfl-betting/pbp/live/:eventId` (`server/routes/nfl-betting.js:1251-1259`, confirmed the router import and route registration, and that `nflBettingRouter` is mounted at `/api/nfl-betting` in `server/index.js`). This is a genuine, callable live-simulation endpoint.
- The specific `nfl-live-ledger.js` persistence path cited in the claim's evidence (`predictPossession` writing `tie` into `nfl_live_possession_predictions`) is **NOT reachable from the running server**: `grep -rln "nfl-live-ledger"` across server/ and client/ shows it is imported ONLY by itself and by `server/db/schema/nfl-a-to-m.js` (a schema/DDL file, not a caller); none of `predictPossession`, `backfillPossessionLedger`, `liveLedgerStatus`, or `liveLedgerCalibration` are imported by any route file or by `server/services/scheduler.js`'s registered jobs. The only caller of these functions in the whole repo is the one-off `scripts/nfl-2022-2025-rebuild.mjs` migration/backfill script — not part of the live running app. `nfl-expert-council.js` reads the `nfl_live_possession_predictions` TABLE directly via raw SQL but never calls `predictPossession`/writes to it.

**Verdict: CONFIRMED, but narrow the evidence.** The headline defect (simulateRemainder lacks OT/halftime handling, inflating `live_moneyline.tie`) is real and reachable via `/api/nfl-betting/pbp/live/:eventId`. The claim's secondary citation of `nfl-live-ledger.js` as a place this "inherits" the bug in production is not currently exercised by the running app (that ledger-writing code path is dead outside a manual backfill script) — I would soften "the persisted research ledger inherits it" to describe a live-route consumer instead, but this does not change the severity of the core, reachable defect. P2 reasonable.

---

## #36 — EP surface double-applies the punt-net transform (and mishandles FG-miss/turnover-on-downs the same way)

`nfl-sim-learn.js:438-440`:
```
const oppStart = d.points > 0 ? 25
        : d.turnover ? clamp(100 - d.endYard, 1, 99)
          : clamp(100 - (d.endYard + 40), 1, 99);              // punt, net ~40
```
Confirmed verbatim. Worked algebra for the punt case: `simulateDrive`'s punt branch already computes `endYard = clamp(100 - min(yard+net,99), 1, 99)` (drive-sim:393) — i.e., `endYard ≈ 100-(y+net)`, which IS ALREADY the opponent's own-frame starting yard line (a full, correct transform). `nfl-sim-learn.js`'s `oppStart` formula then takes this already-transformed `d.endYard` and re-applies ANOTHER `100 - (x + 40)` on top of it:
```
oppStart = 100 - (endYard + 40) = 100 - (100-(y+net) + 40) = y + net - 40
```
With `net≈40` (the value the comment assumes), `oppStart ≈ y`. But the correct opponent start (equal to `d.endYard` itself, no further transform needed) is `100-(y+40) = 60-y`. `y` and `60-y` are equal only at `y=30` — exactly the "coincident only at y=30" detail asserted in the claim's evidence, which I independently re-derived from the two files' actual formulas rather than taking it on faith. This is a genuine, non-trivial double-transformation bug.

The same `else` branch (the final ternary arm) is also reached for FG-miss and turnover-on-downs, neither of which sets `d.turnover` (FG-miss sets `field_goal:{made:false}`, drive-sim:386-388; turnover-on-downs sets `turnover_on_downs:true`, drive-sim:402-403 — both distinct flags from `d.turnover`). Both of those cases ALSO already return a fully-flipped, correct `endYard` (`clamp(100-yard,1,99)` for both), so both are ALSO wrongly re-transformed by the same erroneous `100-(d.endYard+40)` formula meant only for punts. This matches the claim's explicit framing ("punts, FG misses and turnover-on-downs").

**Reachability**: `expectedPointsSurface` (this function) underlies `epFor()` in `nfl-drive-sim.js` (line 578-588), which is computed once and cached, then used by `ep = y => expectedPoints(surface, y)` inside every `simulateMatchup` and `simulateRemainder` call (drive-sim:686-687, :785-786) — this feeds `fourthDownByExpectedPoints` (module 1) and `noMansLand` (module 13), the two most consulted 4th-down modules in the whole engine. Definitely core, definitely reachable.

**Verdict: CONFIRMED, P2 reasonable.** Careful re-derivation independently reproduces the claim's precise numeric detail (coincidence only at y=30), and the bug's scope is broader than punts alone (also corrupts FG-miss/turnover-on-downs EP inputs), which if anything understates rather than overstates the claim.

---

## #37 — calibration multiplier divides by wrong baseline (RATE_SPEC constant, not the context's own rate)

`nfl-sim-calibration.js:77`: `completion: multiplier(observed.rates.completion, RATE_SPEC.off_completion_pct)`, where `multiplier = (actual, baseline, lo=0.8, hi=1.2) => clamp(actual/baseline, lo, hi)` (line 75). `RATE_SPEC.off_completion_pct = 0.60` is confirmed at `nfl-sim-learn.js:44`. This multiplier is then applied at `calibrateSimulationContext` (nfl-sim-calibration.js:110): `completionPct: clamp(context.completionPct * a.completion, 0.42, 0.82)` — i.e., it multiplies the TEAM/CONTEXT's own completion rate (built in `buildContext`, drive-sim:116, `completionPct: o.off_completion_pct ?? 0.65` — note the DIFFERENT 0.65 fallback used there) by a ratio computed against the DIFFERENT constant 0.60.

Concretely: if the measured league-wide `observed.rates.completion` for the season/week in question equals the real ~0.65 NFL average (plausible, since that's literally drive-sim's own fallback assumption for what a normal completion rate looks like), the multiplier becomes `0.65/0.60 ≈ 1.083` (+8.3%), which then gets applied on TOP of a context completion rate that is itself already realistic (~0.65), yielding `0.65*1.083 ≈ 0.704` — a systematic ~8% inflation with no compensating basis. This is a real baseline/unit mismatch: the ratio should be computed against the SAME baseline the context rate is expressed relative to (i.e., something like the current context's own completion rate, or at minimum a consistent 0.65 constant), not the differently-calibrated `RATE_SPEC` fallback (0.60) that exists for a different purpose (imputing a missing team's own rate).

The same pattern (dividing `observed.rate` by the corresponding `RATE_SPEC.*` constant and then multiplying it onto the context's own, differently-scaled rate) recurs for every other adjustment key in the `adjustments` object (sack, interception, fumble, explosive_pass, explosive_rush, stuff, red_zone, shotgun, no_huddle) — so the claim's "every calibrated team's completion, sack, INT, explosive, stuff, red-zone, shotgun and no-huddle rates are shifted" is structurally accurate; it's the same bug pattern applied uniformly across the whole `adjustments` object, not limited to completion.

**Reachability**: `simulationCalibrationFor`/`calibrateSimulationContext` are invoked in `simulateMatchup` and `simulateRemainder` whenever `season != null && week != null` (drive-sim:683-685, :782-784). `nfl-unified-engine.js:unifiedGameProjection` (line 48-56) ALWAYS supplies `season: Number(season), week: Number(week)` to `simulateMatchup`, and `unifiedGameProjection` is called from the mounted `/api/nfl-betting` route (confirmed at `server/routes/nfl-betting.js:1139`). So this calibration path is live on the primary, everyday game-projection call, not an edge case.

**Verdict: CONFIRMED, P2 reasonable.**

---

## #38 — syncCurrentLines overwrites `spread`/`total` with no pre-kickoff guard

`gamescript.js` lines ~117-135 (`syncCurrentLines`'s prepared `stmt`): the `ON CONFLICT(season, week, team) DO UPDATE SET spread=excluded.spread, total=excluded.total, implied_points=excluded.implied_points, source=..., fetched_at=..., team_score=COALESCE(...), ...` — confirmed verbatim: `spread`/`total`/`implied_points` are unconditionally overwritten on every conflict (every re-sync of the same season/week/team row), with NO time-based guard. By contrast, `closeStmt` (a SEPARATE prepared statement writing to `closing_spread`/`closing_total`) is only ever executed inside `if (preKickoff) { closeStmt.run(...); closeStmt.run(...); }` (lines 226-229), where `preKickoff = !!commenceTime && ... && now < commenceTime` (line 201). So the codebase clearly already has the concept of "don't let a live in-game number contaminate the frozen research column" — it is applied to `closing_spread`/`closing_total` but NOT to the plain `spread`/`total` columns that most of the rest of the app (drive-sim backtests, teaser-leg-rates, margin-distribution, etc.) actually reads.

The module's own comment (lines 288-291) independently states the exact same concern in the `observations()` function's docstring: "Current-season rows prefer the frozen close, so the fit is never trained on a spread ESPN's live odds object clobbered mid-game" — direct textual acknowledgment, elsewhere in the SAME FILE, of the very failure mode `syncCurrentLines` allows on the `spread` column itself.

Independent DB corroboration (read-only `node:sqlite` query, permitted under the audit rules): I queried `game_lines` directly —
```
2024  570 rows, 272 integer spreads → 47.7%
2025  570 rows, 142 integer spreads → 24.9%
2026  544 rows,  92 integer spreads → 16.9%
```
This EXACTLY matches the claim's cited figures (47.7% → 24.9% → 16.9%), and independently corroborates `teaser-leg-rates.js`'s own documented data-defect note (lines 30-57 there): "2025 has no -1,-2,-4,-8,-9,-11,-12,-13 or -15 anywhere in 570 rows, and 2026 is worse... the lines -8.0 and +2.0 have ZERO rows" — and that module explicitly excludes 2025/2026 from its historical rate measurement because of exactly this. The steep drop-off beginning with the current-ish seasons (2025-26) lines up with a plausible causal story that live/in-game ESPN odds (typically non-integer, e.g. -2.5, -7.5, or fractional in-game lines) are overwriting integer closing/opening numbers via this unguarded `ON CONFLICT` path.

**Reachability**: `syncCurrentLines` is called by a REGISTERED SCHEDULER JOB (`server/services/scheduler.js:207-209`, confirmed by grep) as well as by two additional mounted routes (`server/routes/nfl-market.js:428`, `server/routes/model.js:619`). This is definitely live, regularly-executed production code.

**Verdict: CONFIRMED, P2 reasonable.** Strong direct code evidence plus independent DB corroboration of the cited statistics.

---

## #39 — -115 "operating floor" admits near-break-even teaser tickets; staking's own EV gate isn't wired up

`teaser-scan.js:194-195` (`scanTeaserBoard`'s default parameter): `priceFloor = -115` confirmed verbatim. The gate at `teaser-scan.js` (further down in `scanFromBoard`): `if (price.american_price < priceFloor) blocked.push(...'worse than the...operating floor.')` — i.e. prices AT -115 or numerically better (e.g. -110, +100) are all allowed through; -115 itself is the worst allowed case.

Cross-file confirmation the same -115 constant appears independently in two more places: `teaser-season.js:111` (`price_floor: -115` inside `DEFAULT_WONG_SETTINGS`) and `server/services/nfl-teaser-execution.js:22` (`operating_price_floor: -115` inside `TEASER_POLICY`).

`teaser-leg-rates.js`'s own documented numbers (lines 555-580, 690-720) give break-even prices for the three push-grading models: `stake_back` (the DEFAULT, per `DEFAULT_REDUCED_PAYOUT='stake_back'` in both `teaser-leg-rates.js:727` and `teaser-staking.js:265`) break-even **-120.2**; `graded_loss` (the conservative/Vegas floor) break-even **-116.8**; and a corrected empirical two-leg gate of **-116** with a block-bootstrap CI of **[-129.1, -104.6]**. A price of exactly -115 sits BETWEEN the graded_loss floor (-116.8) and the stake_back floor (-120.2), i.e. it is on the thin, nearly-break-even edge of the family's own measured edge under any of the credible gradings — not comfortably positive.

`teaser-staking.js` (lines 190-220) independently quantifies this same edge as a posterior probability: `-115 37.2%` chance of NO edge at all (posterior mass below the break-even leg rate), versus `+100 8.5%`, `-110 25.6%`, `-120 49.6%`. The module states outright (line 217-220): "The scanner's existing gate is the break-even price, -120.2, which lets -115 through. At -115 the posterior says it is a 37% chance there is no edge at all. `maxNegativeEvProbability` (default 0.20) refuses everything from -110 down..." — i.e. the codebase's OWN staking module explicitly says its 20%-probability gate would refuse -115 (37.2% > 20%), directly contradicting/tightening the -115 floor used elsewhere.

I confirmed `recommendStake` (which contains the `maxNegativeEvProbability` gate, `teaser-staking.js:1126-1163`) has **zero callers anywhere in the codebase outside its own test file** (`grep -rln "recommendStake"` → only `teaser-staking.js` itself) — so the tighter, better-justified gate is never actually consulted by `teaser-scan.js`, `teaser-season.js`, or `nfl-teaser-execution.js`, all of which independently hardcode the looser -115 floor. This IS the claim's own framing ("is not wired to anything") and I confirm it.

**Reachability of the -115 floor itself** (as distinct from the never-called staking module): `teaser-scan.js`'s `scanTeaserBoard`/`scanAllBooks` are imported and called by `server/routes/wong.js` (`scanAllBooks` at line 142, `scanTeaserBoard` at line 348), and `wongRouter` is mounted at `/api/betting/wong` in `server/index.js` (confirmed). `nfl-teaser-execution.js`'s `TEASER_POLICY` is imported by `execution-slate.js`, `betting-hub.js`, `wong.js`, `execution-slate-reasoning.js`, and `gridiron-model.js` — all live, non-test files. This is a genuinely reachable, currently-operative gate, not latent code.

**Verdict: CONFIRMED, P2 reasonable.** The -115 floor is live and reachable across three files; the tighter staking-module gate that would flag it is confirmed dead code with zero callers, matching the claim's own characterization.

---

## #40 — teaser-staking.js's MEASURED.forwardRateSd is stale relative to teaser-season.js's FORWARD_RATE_SD

`teaser-staking.js:257` (in the `MEASURED` object, within the region read at lines 190-260): `forwardRateSd: 0.023, // FORWARD_RATE_SD in teaser-season.js` — confirmed verbatim, including the comment pointing at the OTHER file's constant. `teaser-season.js:612`: `export const FORWARD_RATE_SD = 0.0282;` — I did not re-read the full justification block (562-611) line by line but the constant itself and its value (0.0282 ≠ 0.023) is independently confirmed via targeted grep/read, matching the claim precisely. `betaPosterior`'s default `sd = input?.sd ?? MEASURED.forwardRateSd` (cited at line 627) means every DEFAULT-posterior computation in the module (the negative-EV-probability table quoted in claim #39: `+100 8.5%`, `-110 25.6%`, `-115 37.2%`, `-120 49.6%`) is computed using the STALE, narrower 0.023 SD rather than the current, wider 0.0282 SD that the same module's own comment says it is supposed to mirror. A wider true SD would push MORE posterior mass below break-even at every price, meaning the real negative-EV probabilities are understated in the module's own quoted defaults, and the 0.20 threshold gate (`maxNegativeEvProbability`, see #39) would trigger at BETTER (less negative) prices than currently documented — i.e. the module is, on its own terms, currently overstating how much edge survives at any given price.

This IS a real, verifiable staleness/consistency bug — I confirm the numeric claim (0.023 vs 0.0282) directly from both files' source.

**Reachability — this is where the claim's own severity framing breaks down.** The claim's own text already flags this: "Latent because the module has no production caller." I independently confirmed this is not merely an understatement but literally true: `grep -rin "teaser-staking"` across the ENTIRE repository (server/, client/, excluding node_modules) turns up exactly ONE consumer of `server/betting/nfl/strategy/teaser-staking.js` — its own test file, `test/teaser-staking.test.js`. No route, no scheduler job (`server/services/scheduler.js` has no reference), no other strategy or service file imports ANYTHING from `teaser-staking.js`. `recommendStake`, `MEASURED`, `betaPosterior`, and every other export of this module are dead code from the perspective of the running server — nothing in the mounted app ever executes this file outside of the test harness.

Per the audit's explicit reachability rule ("Dead or unregistered code cannot be P1/P2. Default to refuted=true if unreachable"), and given the reader's own submission already concedes the lack of a production caller, I am refuting this claim on reachability grounds notwithstanding that the underlying technical observation (stale SD constant, mismatched with teaser-season.js) is itself accurate. A future PR that wires `recommendStake` into `teaser-scan.js`/`nfl-teaser-execution.js` (which is clearly the intended integration, given the -115 floor discussion in claim #39) would make this live and worth fixing at that point, but as shipped today it affects nothing a user or scheduled job ever sees.

**Verdict: REFUTED (unreachable — dead code, zero production callers; reader itself concedes this).** The technical detail is accurate but the reachability lens governs: not P1/P2 as filed.

---

# Summary table

| key | file:line | my verdict | reachable? |
|---|---|---|---|
| #30 | nfl-drive-sim.js:536 | CONFIRMED | yes — core simulateGame/simulateDrive path |
| #31 | nfl-drive-sim.js:479 | CONFIRMED | yes — core simulateGame/simulateDrive path |
| #32 | nfl-sim-policy.js:292 | CONFIRMED | yes — kneelDecision called every drive |
| #33 | nfl-sim-policy.js:115 | CONFIRMED | yes — fires whenever spread supplied & away has ball |
| #34 | nfl-drive-sim.js:562 | CONFIRMED | yes — every non-neutral-site simulateGame |
| #35 | nfl-drive-sim.js:805 | CONFIRMED (narrowed) | core defect yes via /pbp/live/:eventId; nfl-live-ledger.js citation is dead code (only reachable via a one-off script) |
| #36 | nfl-drive-sim.js (EP surface in nfl-sim-learn.js:440) | CONFIRMED | yes — epFor() used by every simulateMatchup/simulateRemainder |
| #37 | nfl-sim-calibration.js:77 | CONFIRMED | yes — unifiedGameProjection always supplies season+week |
| #38 | gamescript.js:126 | CONFIRMED | yes — scheduler job + 2 mounted routes; DB stats independently corroborated |
| #39 | teaser-scan.js:195 | CONFIRMED | yes — reachable via /api/betting/wong; staking gate confirmed unwired |
| #40 | teaser-staking.js:257 | REFUTED | no — teaser-staking.js has zero production callers anywhere in the repo (test file only); reader concedes this |
