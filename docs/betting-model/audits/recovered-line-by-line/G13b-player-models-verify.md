# Adversarial verification: G13b-player-models (18 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
DB checked read-only via `node:sqlite {readOnly:true}` one-liners only.
Live facts confirmed: `player_week_usage` MAX(season)=2025 (43243 rows), `player_gamelog` MAX(season)=2025,
`cfbd_player_season` COUNT=0, active shrinkage fit id=3 (24 k-values, activated 2026-08-27).

Legend: CONFIRMED = claim's mechanism verified in code and its stated impact is real/reachable now or imminently.
REFUTED (impact lens) = mechanism verified as coded, but no current caller/consumer ever reaches the failure
condition or surfaces the affected field, so it changes nothing Nick sees or any decision recorded → P3.

---

## #109 — projections.js:498 phantom cutoff-season availability (P2) → CONFIRMED

`server/services/projections.js:498`:
```
const teamG = teamGames.get(`${a.team}|${s}`) ?? (s === through && throughWeek != null ? throughWeek : GAMES);
availW += w * Math.max(1, teamG);
```
Verified `player-week-engine.js:143-144` calls `buildProjections({through: season, throughWeek: week-1})`.
Verified DB: `player_week_usage` has **zero** 2026 rows (MAX season = 2025) as of 2026-09-12. So for every
in-season 2026 call right now, `history()`'s log has no season-2026 rows, `teamGames.get('TEAM|2026')` is
undefined, and the ternary falls to `throughWeek` (not GAMES, since `s===through && throughWeek!=null` is true
even when throughWeek=0). For week 1 this yields `teamG=0` forced to `Math.max(1,teamG)=1`, i.e. one phantom
team-game with zero of the player's own games counted against it (`availPlayed += w*0`), for every player,
weighted at full `seasonWeight(2026,2026)=1`. This lowers `playRate` and hence `expected_games`/season points for
every player, right now, while the season-total numbers on `/model` routes are what Nick reads. Direction and
existence of the bias match the claim; did not re-derive the exact 4.4% figure (would require importing
projections.js, which pulls in `server/db/index.js` — skipped per the read-only-DB hard rule) but the mechanism
and its live-now applicability are verified.
**Verdict: not refuted, P2 as given.**

---

## #110 — projections.js:554 QBR nudge never reaches samplers (P2) → CONFIRMED

`params` built at :532-537 (no qbr fields at all — only structural rates: `ypa, pass_td_rate, int_rate`, etc.).
`qbrAdjustment` computed at :549-553, added only to `meanPpg = structuralPpg + qbrAdjustment` at :554, used for
the displayed `ppg`/`points` fields (:579-580). Every sampler (`sampleWeek` :636, `sampleWeeks` :657-670,
`weeklyDistribution` :686-699, `seasonDistribution` :709-747, and downstream `player-week-engine.js`,
`ceiling-lineup.js`) draws from `projection.params` — verified by reading the full sampling section
(lines 585-747) — which never includes the QBR shift. Confirmed: for any QB with `qbrAdjustment != 0`, the
displayed ppg disagrees with the mean of his own simulated distribution (boom/bust rates, percentiles, and
ceiling-lineup optimisation are all computed from the un-shifted distribution).
**Verdict: not refuted, P2 as given.**

---

## #111 — projections.js:746 seasonDistribution NaN on object mult (P2) → REFUTED, P3

Code confirmed exactly as quoted: `t += sampleWeek(projection.params, scoring, mult * level)` with no
`typeof mult === 'object'` branch, unlike `sampleWeeks` (:657-663) which does handle it. `mult * level` where
mult is a plain object coerces via `toString` → `"[object Object]" * number` → `NaN`, so this would silently
poison every season-total sample.
**However**, grepped every caller: `seasonDistribution` is called only from `server/routes/model.js:462` and
`:504`, both with no `mult` argument (default `1`, a number). No other file in the repo calls
`seasonDistribution` with an object `mult`. This is exactly the "latent" case the claim itself describes ("no
current caller passes an object"). Per the impact lens (does it change a number Nick reads today?): no —
today's actual season-distribution calls never hit this path.
**Verdict: refuted for current impact; corrected_severity P3 (real bug, but dead code path today).**

---

## #112 — shrinkage-fit.js:34 fit/apply recency mismatch (P2) → CONFIRMED

`shrinkage-fit.js:34`: `SEASON_WEIGHT = (s, through) => ({0:1,1:0.55,2:0.28})[through-s] ?? 0.12`. Confirmed this
old hand-picked table is what every `fitK` dataset builder in the file uses to weight observations (verified
header comment :20-23 "every dataset builder below mirrors the exact... weighting").
`projections.js:109`: `export const RECENCY = { seasonDecay: 0.35, weekHalfLife: null }` — NOT null, so
`seasonWeight()` (projections.js) uses `Math.pow(0.35, back)` = {1, 0.35, 0.1225, 0.042875,...}, not the
{1,0.55,0.28,0.12} table the fit assumed. At back=2: fit weight 0.28 vs applied weight 0.1225 → ratio 2.286×,
matching the claim's "roughly 2.3x" almost exactly.
**Live-active check**: queried DB — `shrinkage_fits` has an ACTIVE row (id=3, activated 2026-08-27, 24
`shrinkage_k` rows). `buildProjections()`'s default `k = kOverride===undefined ? activeKVector() : kOverride`
means this mismatched k-vector is live in production right now, not a hypothetical.
**Verdict: not refuted, P2 as given (arguably could be argued higher given it's actively live).**

---

## #113 — projections.js:446 weekly qb_attempts/carry_share k applied to wrong evidence unit (P2) → CONFIRMED

`projections.js:446`: `const qbAttK = pickK(k, 'qb_attempts', 'QB', a.roleW, a.roleW, K.share);` — confirmed exact
line/text. `a.roleW` accumulated via `rowWeight(u, through, throughWeek, rr)` where
`rr = {...r, ...roleRecency}`. `player-week-engine.js:143-145` passes `roleRecency: WEEKLY_ROLE_RECENCY` =
`{seasonDecay:0.05, weekHalfLife:5}` (weekly-ensemble.js:8, confirmed). `shrinkage-fit.js:242-243` fits
`qb_attempts` (and `carry_share` similarly, :223-240) using `SEASON_WEIGHT(season, through)` — one-season-back
weight 0.55, no per-week half-life concept at all. So the weekly (in-season) path applies a k fitted under
0.55/season-only weighting against evidence built under 0.05/season + 5-week-half-life weighting — an
order-of-magnitude mismatch, and this weekly path (`player-week-engine.js`) is the one actually used for live
weekly projections/start-sit, year-round, independent of whether 2026 game data exists yet.
**Verdict: not refuted, P2 as given.**

---

## #114 — projections.js:166 LEVEL_UNCERTAINTY outside its own fit grid (P2) → CONFIRMED

`projections.js:166`: `export const LEVEL_UNCERTAINTY = { a: 0, b: 1.15, lo: 0.30, hi: 0.70, downMult: 1, conc: 3.5 };`
`scripts/fit-level-uncertainty.mjs:73-79` grid: `a` in `{0.30,0.40,0.50,0.60,0.70}` (0 is NOT a grid point),
`b` in `{0,0.3,0.6}`, `downMult` in `{1.0,1.3,1.6,2.0}`, fixed `lo=0.20, hi=1.60`. Script's own baseline
comparison (`:104`) uses exactly `{a:0,b:1.15,lo:0.30,hi:0.70,downMult:1,conc:3.5}` labelled
`'current (shipped) params'` — i.e. the shipped constant is literally the *pre-fix baseline* the script exists to
replace, not a value the grid could ever produce (a=0 isn't searched; lo/hi don't match the grid's 0.20/1.60).
The doc-comment directly above the export (projections.js:150-165) claims these values are "fitted, not
chosen" and describes the fix for the exact 0.63-0.70-coverage defect the baseline exhibits — but the shipped
value IS the unfixed baseline. `seasonDistribution` (real, called from `routes/model.js:462,504` for actual
season-total percentile bands Nick sees) uses this constant directly.
**Verdict: not refuted, P2 as given.**

---

## #115 — matchups.js:18 SEASON_WEIGHT keyed one season behind (P2) → CONFIRMED (imminent live impact)

`matchups.js:12-18`: `SEASON=2026`; `SEASON_WEIGHT = s => ({[2025]:1,[2024]:0.6,[2023]:0.35})[s] ?? 0.2` — any
`s===2026` (current season) row hits the `?? 0.2` catch-all, the same weight as a game from an arbitrary distant
season. `gamelog()` (:35-44) has no season filter, so once 2026 game logs start populating, the model's own
current-season evidence would be weighted below even 2023's 0.35. Verified via DB: `player_gamelog` MAX(season)
is currently 2025 — so this bug has not yet fired on any real 2026 row (today's date 2026-09-12, season just
starting) — but it is not a structurally-unreachable path like #111/#116/#122: as soon as 2026 gamelog rows are
ingested (imminent, this week), `dvpFor`/`matchupModel()` (consumed live by `ceiling-lineup.js:65`,
`season-sim.js:204`, `football-context.js:246`, `trade-engine.js`) will silently under-weight the current
season's own defensive performance for the rest of 2026.
**Verdict: not refuted, P2 as given — real, and about to become live rather than merely hypothetical.**

---

## #116 — matchups.js:37 gamelog() has no season cutoff → leakage in backtests (P2) → REFUTED, P3

`gamelog()` (matchups.js:35-44) confirmed to carry no WHERE clause on season/week — a global, all-time,
process-cached (`matchupModel()`, :181-182: `if (_cache) return _cache`) DvP model. This is real as coded.
**But**: checked every consumer. `ceiling-lineup.js`, `season-sim.js`, `trade-engine.js`, `football-context.js`
all hardcode `SEASON = process.env.NFL_SEASON || 2026` and are described/used for *live, forward-looking*
purposes only ("Plays the rest of the fantasy season..." — season-sim.js header). No script or test replays a
*completed* historical season through `dvpFor`/`matchupModel()` for grading purposes (grepped `scripts/`,
`test/` — no hits). Crucially, the codebase's own author already identified this exact defect class and fixed
it for the one place it actually mattered: `nfl-context-heads.js:20-28` explicitly documents "`dvpFor`
aggregates the WHOLE current season with no per-week cutoff, which is correct for live use... and wrong for a
backtest" and ships a separate leak-free `cutoffDvp()` (prior-seasons-only) specifically for its own prop-head
backtest pipeline. So the one real backtest that exists in this codebase (nfl-context-heads.js's prop-head
validation) does NOT use the leaky matchups.js path. There is currently no actual backtest or replay in the
repo that is contaminated by this.
**Verdict: refuted for current impact (no live backtest is actually contaminated; live use is, by the
codebase's own design, the intended/correct behavior); corrected_severity P3.**

---

## #117 — contingency.js:124 Full practice overrides Doubtful (P2) → CONFIRMED, high-impact

`contingency.js:108-127` verified exactly: the `status` if/else-if chain sets Doubtful → `active=Math.min(active,0.15)`
(:120). Then a **separate** `if` block (:124, guarded only by
`!/out|reserve|ir|pup|suspend/.test(status)` — which a Doubtful status passes) runs practice-status logic
unconditionally: `else if (/full/.test(practice)) active = Math.max(active, 0.96)` (:127). For a Doubtful player
practicing Full, this computes `Math.max(0.15, 0.96) = 0.96` — a 15%-likely-to-play player becomes a 96%-active
one. `weeklyAvailability()` is real and live, consumed by `trade-engine.js:33`, `season-sim.js:28`,
`role-scenario-engine.js:74`, `routes/model.js:18` — all real, currently-used lineup/valuation paths. This is a
genuine, currently-reachable defect that materially misrepresents a real injury-report scenario in numbers Nick
would act on for a live start/sit or trade decision.
**Verdict: not refuted, P2 as given (arguably the single most user-visible defect verified in this batch).**

---

## #118 — contingency.js:62 durability denominator ignores missed seasons (P2) → CONFIRMED

`contingency.js:39-49`: `byPlayer` built by iterating `player_week_usage` GROUP BY (player_id, season) — a
season with zero rows contributes NO entry at all, so `a.seasons++` (:49) never counts a season the player
missed entirely. Line 62: `const observed = a.games / (a.seasons * 17);` — denominator excludes missed seasons
entirely, unlike `projections.js:492-501` which explicitly loops `firstSeason..through` and charges
`gamesBySeason.get(s) ?? 0` (i.e. 0) for a season with no rows. Downstream: `handcuffValue()` (:262-263) calls
`availability({through})` and directly uses it as `starterAvail`/`missRate = 1-starterAvail` (:283-284) to
compute `expected_points` for backups (:296) — real, live handcuff-value output. A starter who missed a whole
season reads as perfectly durable here, understating exactly the backups whose value depends on that starter's
real injury history.
**Verdict: not refuted, P2 as given.**

---

## #119 — offseason-model.js:1858 vacated_share priced but never reported as a component (P2) → REFUTED, P3

Code confirmed exactly: `changeSignals()` (:1747-1763) is if/else-if — a player with `changed_team===1` gets
only the `'team_change'` key pushed; the `'vacated'` key (from `vacated_share_new_team >= MATERIAL.vacated_share`)
is only reached in the `else if` branch, so a mover never gets it. `partialChangeEffect()` (:1801-1815) sums
every `CHANGE_FEATURES` term unconditionally, including `vacated_share` (`COMPONENT_OF.vacated_share='vacated'`),
so its contribution IS baked into `total` (and hence the published `opportunity_multiplier = exp(total)`) for
any mover with material new-team vacated share. At :1855-1859, `components[k]` is only set `if (priced.has(k))`
— so `components.vacated` stays `null` even though it contributed to `total`. This genuinely breaks the file's
own stated invariant (:1722-1729, :1796-1799) that `components` sum to `log(multiplier)`.
**However**: traced every consumer of `offseasonAdjustment()`/`offseasonAdjustments()` — `lineup-brain.js:117`
(`DEFAULT_PROVIDERS.offseason`), `trade-engine.js:498` (via `compactOffseason`), and `draft-assist.js:1022/927`
(`enrichWithEvidence`). **None of the three ever reads `.components`** — all three only read `.drivers`,
`.opportunity_multiplier`, `.ppg_multiplier`, `.confidence`. Grepped the whole repo (`server/`, `client/src`) for
`.components` usage related to offseason output — zero hits outside the file itself and unrelated modules
(nfl-engine-registry.js, preseason-model.js — different `.components` shapes entirely). No route exposes the raw
`offseasonAdjustments()` map or its `components` field to any page or API response. The actual number Nick would
see (`opportunity_multiplier`, the driver sentences) is unaffected by this specific decomposition bug — it's the
unconsumed internal `components` breakdown that's wrong, not anything displayed.
**Verdict: refuted for current impact (the broken field is never surfaced to any page or decision);
corrected_severity P3.**

---

## #120 — offseason-model.js:1855 raw (uncentred) change partial shipped (P2) → REFUTED, P3

Confirmed `offseasonAdjustments()` (:1855) calls `partialChangeEffect(shareModel, row)` directly — the raw
variant, not the `_centred` one defined and validated in `multiplierWalkForward` (:1618-1637, confirmed:
"charges the league's average change twice... the centred variant subtracts the training-set mean partial").
**But** the double-counting concern in that comment is specifically about combining this raw partial with
"the mean-reversion prior a caller holds... fitted on every player, average change included" — i.e. it only
manifests if some consumer *adds* this multiplier's log onto another prior that itself already contains the
average-change effect. Traced the two named consumers precisely:
- `trade-engine.js:465-482` (`compactOffseason`): returns `opportunity_multiplier` **standalone**, with an
  explicit field `applied_to_value: false` (:481) — confirmed literally in the code — and the module's own
  header states "Evidence layers... the engine never re-prices on them, it explains with them." It is never
  multiplied into any trade `value` number.
- `lineup-brain.js`: `offseasonAdjustment` feeds only `statHeadline()`/`candidateEvidence()` evidence text
  (:117-138); the actual `week_points` used by the lineup solver (:284-287) is computed from
  `p.adj_ppg ?? p.ppg` times `vegasLift`'s multiplier — `offseasonAdjustment` is never referenced there.
Grepped the entire repo for every use of `opportunity_multiplier`/`ppg_multiplier` (draft-assist.js, lineup-brain.js,
trade-engine.js) — every single site uses it only for display thresholds/driver text, never multiplies it into
another number. So the specific double-counting failure mode described (raw partial ADDED to a mean-reversion
prior) does not occur anywhere in the current codebase's actual consumers.
**Verdict: refuted for current impact (no consumer combines this multiplier with any prior — it's shown
standalone everywhere it's used); corrected_severity P3.**

---

## #121 — player-case.js:280 first-initial+surname collision risk (P2) → CONFIRMED

`sameName()` (:274-281) confirmed to reduce a name to `firstInitial+surname` (e.g. "J.Allen"), used at
:217-218 to find a player in the TD-regression board and at :168 to exclude a player from the
teammate-injury list. The codebase has an established, documented awareness of exactly this bug class:
`player-availability.js:15-24` explicitly documents a prior real production bug from last-name-only matching
("falsely flag A.J. Brown, Wan'Dale Robinson and Juwan Johnson") and fixes it with a full-name match;
`player-ids.js:95-96` refuses to resolve a colliding name to either candidate ("resolves to nothing rather than
to a coin flip"). `player-case.js`'s own scheme (first-initial+surname) is less collision-prone than
last-name-only but still collides for any two players sharing an initial+surname (e.g., multiple NFL players
named "*.Johnson", "*.Jackson", "*.Williams", etc. are common). This is a real, live matching function used on
every player-case lookup, directly feeding a leading-headline-slot sentence (`factors[0]?.headline`, :242-250)
that reads as fact.
**Verdict: not refuted, P2 as given (plausible, real collision surface, live consumer, headline-slot output).**

---

## #122 — player-case.js:199 usage-trend leaks the decision week itself (P2) → REFUTED, P3

Confirmed exactly: `player-case.js:199` calls `playerTrends(player.id, season, {throughWeek: week, lookback: 3})`
— passing the CURRENT decision week, not `week-1`. `weekly-trends.js:327`:
`WHERE player_id=? AND season=? ${throughWeek ? 'AND week <= ?' : ''}` — confirmed `week <= throughWeek` includes
`week` itself when a row for that week exists.
**But**: traced every caller. `playerCase()` is only ever invoked from `lineup-brain.js:358`
(`safeCase(p, yr, wk)`), which is only ever invoked from `lineupCall()` (:269-358). `lineupCall()` takes only
`{myTeamId, objective, providers}` — it NEVER accepts an arbitrary `season`/`week`; it always derives
`{season, week} = tradeWeekContext()` (:279), i.e. the live, current, not-yet-played week. Grepped the whole
repo for any other caller of `playerCase` or for any historical-grading/postmortem feature for lineup-brain —
none exists (`lineupCall` has exactly one route, `trades.js:325`, which also passes no season/week). Since the
only call path always uses the live upcoming week, `player_week_usage` structurally has no row for that week
yet (the claim's own text concedes this: "Harmless pregame (the row does not exist yet)"). The "historical
grading" scenario the claim's impact rests on does not exist anywhere in this codebase today.
**Verdict: refuted for current impact (the only call path can never trigger the leak); corrected_severity P3.**

---

## #123 — ceiling-lineup.js:54 builds from prior seasons only, ignores current season (P2) → CONFIRMED

`ceiling-lineup.js:54`: `const proj = buildProjections({ through: season - 1, scoring });` — confirmed no
`throughWeek` passed, unlike every weekly consumer (`player-week-engine.js:143-144`:
`{through: season, throughWeek: week-1}`). `ceilingLineup(leagueId, {week, season=SEASON})` (:129-131) accepts
an arbitrary `week` (e.g. 12) but `season` always defaults to current-year `SEASON`, and `outcomePools()`
(:54) ignores `week` entirely when building projections — always `through: season-1`. Confirmed no ensemble
shift is applied either (no `weeklyEnsemblePrediction` call anywhere in ceiling-lineup.js). This is a real,
live, currently-reachable defect: a tournament/ceiling lineup recommendation for week 12 is built on a role
model that is up to 11 weeks stale relative to what the same app's start/sit page (player-week-engine.js) shows,
and role change is exactly what a ceiling call depends on.
**Verdict: not refuted, P2 as given.**

---

## #124 — vegas-fantasy.js vs gamescript.js: two independently-fit game-script models (P2) → CONFIRMED

Confirmed: `vegas-fantasy.js:124` exports `gameScriptFor(season, week, team, ...)`, clamped at :139-141 to
td 0.55-1.65 / yard 0.75-1.35 / rec 0.8-1.25. Separately, `gamescript.js:373-390` exports its OWN
`gameScriptFor(team, season, week)` (different argument order), clamped uniformly to 0.75-1.30 for both
pass_mult and rush_mult (`clamp = v => Math.max(0.75, Math.min(1.3, v))`, :385). Confirmed real consumer split:
`ceiling-lineup.js:35,67` and `season-sim.js:25,208` import `gameScriptFor` from `./gamescript.js` (the internal
lineup/simulation engines); `routes/model.js:666,676,686` dynamically imports `gameScriptFor`/`slateGameScript`
from `./vegas-fantasy.js` for the live `/model/game-script` and `/model/game-script/:team` API routes — pages
Nick can actually load. So a user comparing the `/model/game-script/:team` page against what the ceiling-lineup
or season simulator actually used internally for the same team-week gets two different sets of numbers from two
independently-fit models, with nothing in either output indicating a second model exists.
**Verdict: not refuted, P2 as given.**

---

## #125 — cfbd.js:49 sync never wired, table permanently empty (P2) → CONFIRMED

Confirmed via DB: `SELECT COUNT(*) FROM cfbd_player_season` → **0** rows, live, right now. Grepped the entire
repo for `syncCfbdSeason` — only `server/services/cfbd.js` (definition) and `test/cfbd.test.js` reference it; no
route, no scheduler/cron job calls it. `draft-assist.js:20,927` does import and call `cfbdSignalFor`
(read-only), so the draft board's college-signal slot is wired to READ a table nothing ever WRITES — the
signal is permanently null for every rookie, silently (per the codebase's own "degrade gracefully" design, so
nothing errors — it just never has data). `nfl-rookie-ingest.js:165` confirmed:
`cfbd: { configured: Boolean(process.env.CFBD_API_KEY), ... }` — status is keyed off the env var alone, not off
whether the table actually has rows, so even an operator with the key configured would see "configured: true"
while the feature silently produces nothing.
**Verdict: not refuted, P2 as given.**

---

## #126 — nfl-rookies.js: rookie prior has no fantasy consumer (P2) → CONFIRMED

Confirmed the module's own header describes `buildProjections` producing zero projection for any player with no
`player_week_usage` history. Grepped every exported function (`rookieOpportunityPrior`,
`evidenceAdjustedRookiePrior`, etc.) against `draft-assist.js`, `preseason-model.js`, `player-week-engine.js`,
`lineup-brain.js`, `trade-engine.js` — zero references anywhere in those five files. Actual importers, confirmed
via grep: `routes/nfl-betting.js` (x2), `nfl-rookie-ingest.js`, `nfl-roster-strength.js` — all betting/roster
infrastructure, none of it fantasy-facing. Separately confirmed `preseason-model.js:887`
(`componentsFor`) does have its own, different rookie fallback (market curve when `has_projection` is false),
which covers the *draft-board* case specifically — but that leaves the in-season weekly engine
(`player-week-engine.js`, which wraps `buildProjections` with no rookie-prior fallback of any kind) and
`trade-engine.js`'s in-season valuation both blind to any rookie until he accumulates enough real usage rows to
be picked up by ordinary shrinkage — exactly as claimed.
**Verdict: not refuted, P2 as given.**

---

# Summary table

| key | claim severity | verdict | corrected severity |
|---|---|---|---|
| #109 | P2 | confirmed | P2 |
| #110 | P2 | confirmed | P2 |
| #111 | P2 | refuted (latent, no caller) | P3 |
| #112 | P2 | confirmed | P2 |
| #113 | P2 | confirmed | P2 |
| #114 | P2 | confirmed | P2 |
| #115 | P2 | confirmed (imminent) | P2 |
| #116 | P2 | refuted (no real backtest uses this path) | P3 |
| #117 | P2 | confirmed | P2 |
| #118 | P2 | confirmed | P2 |
| #119 | P2 | refuted (components field unconsumed anywhere) | P3 |
| #120 | P2 | refuted (multiplier never combined with a prior anywhere) | P3 |
| #121 | P2 | confirmed | P2 |
| #122 | P2 | refuted (only caller always uses live/unplayed week) | P3 |
| #123 | P2 | confirmed | P2 |
| #124 | P2 | confirmed | P2 |
| #125 | P2 | confirmed | P2 |
| #126 | P2 | confirmed | P2 |

12 confirmed / 6 refuted (all 6 refutations are "real bug as coded, but unreachable by any current caller or
never surfaced to any page/decision" — the impact-lens P3 downgrade path).
