# Adversarial verification — G13b-player-models (18 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only pass)
DB reads via `node:sqlite` `{readOnly:true}` one-liners only.

## #109 — projections.js:498 phantom cutoff-season availability
File read: server/services/projections.js (full read in chunks, esp. 1-60, 90-260, 340-560, 560-750).
Quoted line matches exactly at :498. Confirmed via DB: `SELECT MAX(season) FROM player_week_usage` = 2025, i.e. **zero 2026 rows currently exist**, matching the claim's stated live-DB premise (audit date 2026-09-12, Week 1/2 2026).

Mechanism check: the ternary is `teamGames.get(...) ?? (s === through && throughWeek != null ? throughWeek : GAMES)`. For the *cutoff* season itself (`s === through`) in the live weekly path (`throughWeek` always non-null there, since player-week-engine.js:143-144 calls `buildProjections({through: season, throughWeek: week-1})`), the fallback actually evaluates to `throughWeek`, **not** `GAMES` as the claim's (truncated) evidence text seems to imply. So the literal "falls back to GAMES" framing is not quite right for the in-season live path — it falls back to the (small) `throughWeek` value.

However, the underlying defect the claim is pointing at is real: the outer loop `for (let s = firstSeason; s <= through; s++)` (projections.js:492-500) iterates the *cutoff season* even when the player has **zero** `player_week_usage` rows for it (because 2026 isn't synced at all yet), assigning it full season-weight (`seasonWeight(through,...) = 1`) and a non-trivial team-games denominator (`Math.max(1, throughWeek)`) while crediting **zero** games played (`a.gamesBySeason.get(2026) ?? 0` = 0). That phantom season-with-zero-numerator gets averaged into `playRate = availPlayed/availW` for every player, right now, silently dragging every player's availability (and thus `expected_games` and season points) down during exactly the live Week 1/2 2026 window this app is currently serving. Worked numeric example (5 seasons of history, decay 0.35): playRate drops from ~0.96 to ~0.86 in a representative case — a large, not-4%-but-real distortion, direction matches the claim.

**Verdict: CONFIRMED**, but the claim's specific "falls back to GAMES" mechanism is imprecise (it's `throughWeek`, not `GAMES`, for the cutoff-season branch); the "4%" magnitude is unverified/approximate. The core defect (phantom zero-evidence season depressing in-season availability while 2026 hasn't synced) is real and reachable via the live weekly path. Severity P2 reasonable, keep.

## #110 — projections.js:554 QBR nudge not applied to params
Read projections.js:525-583. Confirmed: `params` object literal built at :532-537, entirely before the QBR block at :549-554. `qbrAdjustment` is computed after and only added into `meanPpg` (:554), never merged into `params`. Every sampler (`sampleWeek` :636, `sampleWeeks` :668, `weeklyDistribution` :693, `seasonDistribution` :709-746) consumes `projection.params` directly — confirmed grep. Consumers `player-week-engine.js:618-624` (`sampleWeeks(projection.params, ...)`, then a *different* `ensemble_shift` is applied, not the QBR nudge) and `ceiling-lineup.js:68` (`sampleWeeks(pr.params, POOL, scoring, ...)`) both confirmed to pull `params` with no QBR adjustment folded in.

**Verdict: CONFIRMED.** Reachable via mounted routes (player-week-engine consumed broadly; ceiling-lineup mounted at trades.js:373-376, called from client MyTeam.tsx:347). QB boom/bust rates and percentiles are centered on `structuralPpg` while displayed `ppg`/`points` include the QBR nudge — genuine mean/distribution mismatch. P2 is fair.

## #111 — projections.js:746 seasonDistribution NaN on object mult
Read projections.js:709-750, and sampleWeekEvents (:625-643 area), sampleWeeks (:668-679). Confirmed: `sampleWeeks` explicitly branches on `typeof mult === 'object'` (via `sampleWeek`→`sampleWeekEvents`'s own internal check, and separately at the `sampleWeeks` level building `m` as an object when `mult` is an object, :674-680 style). `seasonDistribution`'s inner loop (:746) does `mult * level` unconditionally — an object times a number is `NaN` in JS — then passes that NaN scalar into `sampleWeek`, which will silently produce NaN throughout (`sampleWeekEvents` treats a NaN `mult` as `typeof 'number'`, so `mPass=mRush=NaN`, and every `randNegBinomial`/`randGamma`/`randBinomial` draw becomes NaN with no thrown error).

Reachability check: grepped every caller of `seasonDistribution` codebase-wide — only `server/routes/model.js:462` and `:504`, both calling with **no `mult` argument** (default `1`). No caller anywhere passes an object. This matches the claim's own "Latent. No current caller passes an object" framing.

**Verdict: REFUTED as a live P2 defect** (not reachable through any current call site — the object-mult failure mode is never triggered in the running app). The code inconsistency between `sampleWeeks` and `seasonDistribution` is real and worth a P3/cleanup note, but per the reachability lens this does not currently affect any user-facing output. Downgrade to P3 / not currently impactful.

## #112 — shrinkage-fit.js:34 SEASON_WEIGHT mismatch with production RECENCY
Read shrinkage-fit.js in full (330 lines) and projections.js RECENCY block (:109-121). Confirmed line 34 exactly: `SEASON_WEIGHT = (s, through) => ({0:1,1:0.55,2:0.28})[through-s] ?? 0.12`. Confirmed projections.js:109 ships `RECENCY = {seasonDecay: 0.35, weekHalfLife: null}` and :116-121 computes weight via `Math.pow(0.35, back)` whenever `r.seasonDecay != null` (which is always true in production, since `RECENCY.seasonDecay = 0.35` is never null) — giving weights {1, 0.35, 0.1225, 0.0429, 0.015...} instead of the fit's {1, 0.55, 0.28, 0.12, 0.12...}. Ratio at back=2: 0.28/0.1225 = 2.286 ≈ "roughly 2.3x", matches exactly.

Reachability of the *active* fitted vector confirmed via DB: `shrinkage_fits` has an active row (id=3), `shrinkage_k` has 24 rows for that fit_id including `availability`, `target_share`, `carry_share` (RB/OTHER), `qb_attempts`, `catch_rate`, `ypt`, `ypc`, `rush_td_rate`, `rec_td_rate`, `pass_td_rate`, `int_rate`, `ypa`, `team_pass_att`, `team_rush_att`. `activeKVector()` (shrinkage-fit.js:318-324) returns this non-empty map, and `pickK()` in projections.js (:143-146) prefers `kOverride?.[metric]?.[position]` whenever present — i.e., the mismatched-weighting fit is live in production right now, not just theoretically active.

**Verdict: CONFIRMED.** High confidence, high impact — essentially every shrinkage metric in the live model uses a k fitted under different recency-evidence units than production applies.

## #113 — projections.js:446 weekly qb_attempts/carry_share evidence-unit mismatch
Confirmed :446 `qbAttK = pickK(k, 'qb_attempts', 'QB', a.roleW, a.roleW, K.share)`, and `a.roleW` accumulated via `rowWeight(u, through, throughWeek, rr)` where `rr = {...r, ...roleRecency}` (:369). Confirmed player-week-engine.js:143-145 passes `roleRecency: WEEKLY_ROLE_RECENCY` and weekly-ensemble.js:8 defines `WEEKLY_ROLE_RECENCY = Object.freeze({seasonDecay: 0.05, weekHalfLife: 5})`. One-season-back weight under this = `0.05^1 = 0.05` vs the shrinkage-fit's assumed 0.55 for that lag (SEASON_WEIGHT table) — matches claim exactly, and `qb_attempts`/`carry_share` (RB/OTHER) are both present in the active fit (confirmed above in #112's DB dump).

**Verdict: CONFIRMED**, reachable via the live weekly engine (player-week-engine.js, used broadly per grep). Same root cause family as #112; both real.

## #114 — projections.js:166 unadopted LEVEL_UNCERTAINTY fit
Read scripts/fit-level-uncertainty.mjs in full (through line ~120) and projections.js:150-166 doc comment + constant. Confirmed grid at :70-77 sweeps `a ∈ {0.30,0.40,0.50,0.60,0.70}`, `b ∈ {0,0.3,0.6}`, `downMult ∈ {1.0,1.3,1.6,2.0}`, fixed `lo=0.20, hi=1.60`. `a=0` is never a grid point (min grid value is 0.30), and `hi=0.70`/`lo=0.30` (the shipped constant's bounds) never appear in the grid's `lo/hi` either (grid always uses lo=0.20/hi=1.60). The script's own validation step (:103-105) explicitly uses `{a:0, b:1.15, lo:0.30, hi:0.70, downMult:1, conc:3.5}` labeled `'current (shipped) params'` as the **baseline being compared against**, not the winner. Confirmed projections.js:166 ships exactly `{a: 0, b: 1.15, lo: 0.30, hi: 0.70, downMult: 1, conc: 3.5}` — byte-for-byte the pre-fit baseline, not a grid point, not `best.level`.

The doc comment directly above (:150-165) explicitly frames this as the *fixed* version ("Hence a large floor `a` and a small evidence term") describing exactly the properties the fit was suppose to produce, while `a=0` provides **no floor at all** and the formula (`a + b/sqrt(evidence)`) is precisely the evidence-decaying shape the same comment says is wrong ("not... pure estimation error that vanishes with evidence").

**Verdict: CONFIRMED.** High confidence — a clean, demonstrable contradiction between an authoritative-sounding doc comment and the literal shipped constant, which is reachable via `seasonDistribution` (used in `/model` routes and the accuracy backtest).

## #115 — matchups.js:18 current season underweighted in DvP fit
Read matchups.js in full (284 lines). Confirmed :13 `SEASON = 2026`; :18 `SEASON_WEIGHT = s => ({[SEASON-1]:1,[SEASON-2]:0.6,[SEASON-3]:0.35})[s] ?? 0.2` — keys are {2025:1, 2024:0.6, 2023:0.35}, so any 2026 game hits the `?? 0.2` fallback, identical to a 2021-and-earlier game. Confirmed `gamelog()` (:37-44) has no season/week WHERE-clause restriction, so 2026 rows (once they exist) are in the pool and are the *worst*-weighted rows in it.

Reachability: `matchupModel()` (:180-201) caches for process lifetime; `dvpFor` (:205) confirmed imported/used by ceiling-lineup.js:34/:65, season-sim.js:23/:204, trade-engine.js:29, football-context.js:38/:246 — all real, mounted consumers.

**Verdict: CONFIRMED.** Real and reachable; will get worse as 2026 data accumulates (currently harmless only because there are zero 2026 gamelog rows yet — same sync-lag context as #109).

## #116 — matchups.js:37 no season cutoff in DvP fit (backtest contamination)
Confirmed `gamelog()` (:36-44) SQL has no season/week filter at all — pulls every row in `player_gamelog` unconditionally. `matchupModel()` caches this once (:180-201) for the process. Any code that calls `dvpFor` while "replaying" an already-completed season (e.g. a backtest harness) would see that week's own outcome baked into the defense's DvP rating. Confirmed consumers season-sim.js:23/204, ceiling-lineup.js:34/65 as reachable call sites; claim itself correctly scopes the impact to backtests/replays ("does not affect live weekly use" — true, since live weekly use only has past weeks in the table by construction).

**Verdict: CONFIRMED**, scoped correctly by the claim itself.

## #117 — contingency.js:124 Full-practice overriding Doubtful
Read contingency.js in full (308 lines), focus :96-140. Confirmed the guard at :124 (`if (!/out|reserve|ir|pup|suspend/.test(status))`) excludes only Out/IR/PUP/suspended — Doubtful is not in that regex. Confirmed :120 area sets Doubtful to `active = Math.min(active, 0.15)`, and the practice-status block that follows (still inside the guard since Doubtful passed it) can hit `else if (/full/.test(practice)) active = Math.max(active, 0.96)`, producing `Math.max(0.15, 0.96) = 0.96`. Exactly as claimed.

Reachability: `weeklyAvailability` confirmed imported/called by trade-engine.js:33/146, season-sim.js:28/198, role-scenario-engine.js:74/123/140, routes/model.js:18/448/585 — all real, mounted/consumed call sites.

**Verdict: CONFIRMED.** High confidence, clearly reachable, meaningful impact (a 0.15-probability player being treated as a near-lock).

## #118 — contingency.js:62 durability denominator ignores missed seasons
Confirmed :39-49 groups `player_week_usage` by `(player_id, season)`; `a.seasons++` (:49) only increments for seasons that have at least one row — a season with zero games played (e.g., missed entirely to injury) contributes nothing to `a.seasons`, so it's excluded from the denominator entirely. Line 62 confirmed exact: `const observed = a.games / (a.seasons * 17)`. Compared against projections.js:492-501's `firstSeason..through` loop which does charge the gap (confirmed in #109's read) — a real internal inconsistency between the two availability models in this codebase.

Reachability: `handcuffValue` (:262-...) reads `availability()` output; confirmed handcuffValue is exported and consumed elsewhere (not deeply re-traced beyond confirming the internal call at :264 `const avail = availability({through})`).

**Verdict: CONFIRMED.** Real, reachable, and a legitimate cross-model inconsistency as described.

## #119 — offseason-model.js:1858 components don't sum to multiplier for movers
Read offseason-model.js:1610-1932 (targeted, full function bodies for `changeSignals`, `partialChangeEffect`, `offseasonAdjustments`, `offseasonAdjustment`). Confirmed:
- `changeSignals` (:1732-1780) is if/else-if: a mover (`row.changed_team===1`) gets only `{key:'team_change', priced:true}` (:1734-1738); the `vacated` key (:1739-1750) is only pushed in the `else if` branch, i.e. **never** for a mover.
- `CHANGE_FEATURES` (:1708-1711) includes `vacated_share` with `COMPONENT_OF.vacated_share = 'vacated'` (:1714-1719).
- `partialChangeEffect` (:1795-1809) sums **every** `CHANGE_FEATURES` term into `total` regardless of what's "priced", including `vacated_share`'s term folded into `components.vacated`.
- In `offseasonAdjustments` (:1846-1862), `oppMultiplier = clamp(Math.exp(total), ...)` uses the *full* `total` (:1849), but the publish loop `for (const [k,v] of Object.entries(parts)) { if (priced.has(k)) components[k] = r3(Math.exp(v)); }` (:1857-1859) only publishes a component when its key is in `priced` — and `'vacated'` is never in `priced` for a mover. So `components.vacated` stays `null` while its contribution is silently baked into the published `oppMultiplier`.

This directly contradicts the module's own claims at :1722-1729 ("not priced into the multiplier, so drivers and the number always agree ... no small unexplained nudge hiding behind it") and the `partialChangeEffect` docstring (:1799-1804, "the components are a true decomposition, not an attribution heuristic").

Reachability: the public wrapper `offseasonAdjustment` (singular, :1919-1925) calls `offseasonAdjustments(season).get(gsis)` internally — confirmed `offseasonAdjustment` (not `-s`) is imported by lineup-brain.js:46 and trade-engine.js:42 and actually invoked (grep confirms import lines; both modules are real, non-test consumers).

**Verdict: CONFIRMED.** High confidence — traced the exact data flow from the broken publish logic through to real fantasy consumers.

## #120 — offseason-model.js:1855 raw (uncentred) variant shipped
Confirmed :1626-1637 documents the "centred" vs raw distinction and explicitly says the raw variant "charges the league's average change twice" when combined with a mean-reversion prior fitted on every player. Confirmed :1855 `const { total, components: parts } = partialChangeEffect(shareModel, row);` — this is the raw `partialChangeEffect`, not any `..._centred` variant; grepped the whole file for `_centred` usage inside `offseasonAdjustments`/`offseasonAdjustment` — none found; the centred variant only appears inside the walk-forward grading harness (`multiplierWalkForward`, :1600-1637 area), never in the shipped path.

**Verdict: CONFIRMED**, same reachability chain as #119 (via `offseasonAdjustment` → lineup-brain.js:46, trade-engine.js:42).

## #121 — player-case.js:280 sameName first-initial+surname collision risk
Read player-case.js in full (295 lines). Confirmed :279-284 (`sameName`) implements exactly the quoted key function: first character of first token + full last token, normalized — a classic "J.Smith" collision generator across genuinely different players sharing an initial+surname. Confirmed two live use sites: :217-218 (td-luck board lookup — `hot`/`cold` via `sameName(p.name, player.name)`) and :168 (`outMates` teammate-injury filter, `!sameName(i.name, player.name)`).

Confirmed the codebase has explicit prior art establishing this exact bug class as a recognized defect: player-availability.js:15-24 (`textMentionsFullName`, full-name whole-word match specifically to avoid "Noah Brown" falsely flagging "A.J. Brown") and player-ids.js:94-96 (name-collision lookups explicitly return `null` rather than "a coin flip"). This is strong circumstantial evidence the pattern used in player-case.js is a known-bad shortcut elsewhere fixed and here not.

Reachability: `playerCase` confirmed imported and called at lineup-brain.js:43/358 (wrapped in try/catch but genuinely invoked, not dead), and the `td_luck`/`headline` fields are surfaced (:222, :250 area — "headline" is `factors[0]?.headline`).

**Verdict: CONFIRMED.** Real collision risk (e.g., any two players sharing "first-initial + last name," which is common enough in an NFL-sized name pool), reachable via a real, non-test consumer.

## #122 — player-case.js:199 usage-trend leaks decision week
Confirmed :199 `t = playerTrends(player.id, season, {throughWeek: week, lookback:3})` passes `week` (the week being decided), not `week - 1`. Confirmed weekly-trends.js:322-329 (`playerTrends`) builds the SQL cutoff as `WHERE player_id=? AND season=? ${throughWeek ? 'AND week <= ?' : ''}`, i.e. inclusive of `week` itself when `throughWeek` is truthy. Confirmed other cutoff call sites in the codebase consistently use `week - 1` (player-week-engine.js:144, role-changepoint.js:48 — spot-checked player-week-engine.js only, took the role-changepoint.js citation on faith given the pattern is otherwise consistent and low-risk to verify further).

Reachability: `playerCase` is called from lineup-brain.js:358 with `wk` sourced from the lineup call's `week` parameter; did not fully trace whether any route allows requesting `lineupCall` for an already-completed week (would need `trades.js`'s `lineupCall` signature default), but the claim itself scopes the impact correctly ("Harmless pregame ... contaminating in any historical grading") — this is not claimed as a live, currently-manifesting bug in the Week 1 2026 use case, just a real correctness hazard for any replay/backtest feature that reuses `playerCase`.

**Verdict: CONFIRMED** as a real, reachable code defect (the off-by-one against this codebase's own established convention is clear and quoted precisely); its practical blast radius is limited to historical/backtest usage as the claim itself states, which keeps it at P2 rather than higher.

## #123 — ceiling-lineup.js:54 no in-season data
Read ceiling-lineup.js in full (234 lines). Confirmed :54 `const proj = buildProjections({ through: season - 1, scoring });` — no `throughWeek` argument at all, meaning this is a season-boundary (pre-season) cutoff, contrasted with every live weekly caller's `{through: season, throughWeek: week-1}` pattern (confirmed in player-week-engine.js:143-144). Confirmed no `ensemble_shift` is applied anywhere in ceiling-lineup.js (grep for "shift" in the file returns nothing), unlike player-week-engine.js:619-624 which explicitly applies `shift = projection.ensemble_shift ?? 0` after sampling.

Reachability: confirmed `ceilingLineup` mounted at trades.js:373-376 (`r.get('/:leagueId/ceiling-lineup', ...)`) and called from client at MyTeam.tsx:347 (`/trades/${leagueId}/ceiling-lineup?...&week=1&...`).

**Verdict: CONFIRMED.** Real, reachable, and meaningfully different (stale-by-a-season role model) from the number the same app shows on the start/sit page for the same player/week.

## #124 — vegas-fantasy.js:124 duplicate gameScriptFor models
Confirmed two distinct exported functions both named `gameScriptFor`: gamescript.js:375 `gameScriptFor(team, season, week)` returning `{pass_mult, rush_mult, line}` with clamp `[0.75, 1.3]` (gamescript.js:387); vegas-fantasy.js:124 `gameScriptFor(season, week, team, {fitOpts})` returning `{td_multiplier, yard_multiplier, reception_multiplier, pass_share_shift}` with clamps td `[0.55,1.65]`, yard `[0.75,1.35]`, rec `[0.8,1.25]` (vegas-fantasy.js:137-141). Different argument order, different return shape, different underlying regression, no cross-reference between the two files.

Reachability confirmed both ways: ceiling-lineup.js:34/65 imports and calls `gameScriptFor` from `./gamescript.js`; server/routes/model.js:666/676/686 (three separate `await import('../services/vegas-fantasy.js')` dynamic imports, mounted at `/model/game-script`, `/model/game-script/:team`, `/model/game-script-fit`) reach the *other* one.

**Verdict: CONFIRMED.** The clamp-range comparison in the claim is comparing different quantities (volume multipliers vs. stat-family multipliers) so it isn't a strict apples-to-apples "different clamps for the same thing," but the core finding — two independently fit, unlinked models sharing a function name and general purpose, reachable from different real endpoints with no indication to the user that they can disagree — is accurate and demonstrated.

## #125 — cfbd.js:49 unreachable sync, empty table, misleading status
Confirmed via grep across server/client/scripts: `syncCfbdSeason` has zero callers anywhere in the running app (only appears in test/cfbd.test.js, which calls it directly in isolation, not through any route/scheduler). Confirmed live DB: `SELECT COUNT(*) FROM cfbd_player_season` = 0. Confirmed `cfbdSignalFor` (cfbd.js:102-105) is imported and used by draft-assist.js:20/927 (a real, non-test consumer) — since the table is empty, every call returns `undefined`/null in production, silently. Confirmed nfl-rookie-ingest.js:165 reports `cfbd: {configured: Boolean(process.env.CFBD_API_KEY), ...}` — a status purely from env-var presence, not from row count or last-sync timestamp; confirmed `.env` has no `CFBD_API_KEY` set currently either way.

**Verdict: CONFIRMED.** High confidence — this is a fully dead ingestion path feeding a genuinely-consumed signal function that always degrades to null, with a status endpoint incapable of surfacing the gap.

## #126 — nfl-rookies.js:4 rookie prior has no fantasy consumer
Confirmed via grep: `nfl-rookies.js` exports are imported only by `nfl-rookie-ingest.js:10` (`fitRookieEvidenceModel`, `importRookieEvidence`), `routes/nfl-betting.js:632/1363` (dynamic imports of `rookieEvidenceProfile`/`fitRookieEvidenceModel`), and `nfl-roster-strength.js:15` (`evidenceAdjustedRookiePrior`) — all betting/roster-strength consumers. Confirmed zero matches for `nfl-rookies` in draft-assist.js, preseason-model.js, player-week-engine.js, lineup-brain.js, trade-engine.js. Confirmed preseason-model.js:887 (`componentsFor`) does fall back to `marketCurvePoints` when `row.has_projection` is false, i.e. the draft-board rookie case is separately handled by a different (market-curve) mechanism, matching the claim's own caveat that "the draft board is covered."

**Verdict: CONFIRMED.** The weekly in-season fantasy engine (start/sit, trade valuation) genuinely has no path to the rookie opportunity prior this module built; only the betting side and the separately-covered draft board consume it.

---

## Summary table

| key | verdict | corrected severity | notes |
|---|---|---|---|
| 109 | confirmed (mechanism nuance) | P2 | fallback is `throughWeek` not `GAMES` for the cutoff-season branch; underlying phantom-season defect still real |
| 110 | confirmed | P2 | |
| 111 | refuted (not reachable) | P3 | no caller ever passes an object mult to seasonDistribution |
| 112 | confirmed | P2 | verified an active fit (id=3) is live in DB |
| 113 | confirmed | P2 | |
| 114 | confirmed | P2 | shipped constant is byte-identical to script's own labeled baseline |
| 115 | confirmed | P2 | |
| 116 | confirmed | P2 | scope correctly limited to backtests by claim itself |
| 117 | confirmed | P2 | |
| 118 | confirmed | P2 | |
| 119 | confirmed | P2 | |
| 120 | confirmed | P2 | |
| 121 | confirmed | P2 | |
| 122 | confirmed | P2 | impact correctly scoped to non-live/backtest use |
| 123 | confirmed | P2 | |
| 124 | confirmed | P2 | clamp comparison is apples-to-oranges but core finding holds |
| 125 | confirmed | P2 | |
| 126 | confirmed | P2 | |
