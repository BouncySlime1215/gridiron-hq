# Field-list contract: league config ingest gaps

2026-09-22. For `server/routes/leagues.js` (Google sign-in's file) — not built here,
handed over per the coordinator's file-ownership ruling on Phase A (league config
auto-ingest). Written from `docs/tdd/league-config-verification.tdd.md`'s Phase A
scoping, which measured every gap against the shipped tree before this was written.

`server/services/league-config-verification.js#verifyLeagueConfig(lg)` already
reports on all of these — once a field lands in `leagues`, its status moves from
`unavailable`/`defaulted` to `confirmed` automatically, with no change needed on the
verification side. Nothing here asks for a schema decision beyond "add a column and
populate it in `syncEspnLeague`/`syncSleeperLeague`" unless noted.

## 1. Sleeper full per-stat scoring

**Gap:** `syncSleeperLeague` (`routes/leagues.js:182-188`) extracts only
`scoring.rec` (the ppr flag) from `league.scoring_settings` and discards the rest.
Sleeper's API exposes the same per-stat detail ESPN does — `pass_td`, `rush_td`,
`rec_td`, bonuses, etc. — under `league.scoring_settings`, a flat object
(`{ pass_td: 6, rec: 1, bonus_rec_te: 0.5, ... }` per Sleeper's own docs; not
verified against a real Sleeper payload in this container).

**Ask:** store the full `league.scoring_settings` object (it's already inside
`payload`, so this may need no new column — `scoringFor`/`scoringConfirmationFor` in
`scoring.js` would need a Sleeper branch added to read `payload.league.scoring_settings`
the way the ESPN branch reads `scoringSettings.scoringItems`). That second half —
the `scoring.js` change — is this thread's file now (per the coordinator's ruling)
once the field is confirmed reachable; flagging the dependency rather than assuming
you'll build both halves.

## 2. ESPN bench/IR lineup slots

**Gap:** `ESPN_SLOT_NAME` (`routes/leagues.js:118`) maps only `QB/RB/WR/TE/DEF/K/FLEX`
(7 ids). Every other slot id in `rosterSettings.lineupSlotCounts` — including bench
and IR — is dropped by the `.filter(Boolean)` at `:155` before `roster_positions` is
ever stored. `league-config-verification.js` already detects and reports the count
of dropped slots (`bench_ir: unavailable, dropped_slot_count: N`), but can't name
them without knowing the real ids.

**Update, 2026-09-22:** the bench (`20`) and IR (`21`) slot ids are no longer just
"commonly documented" — confirmed against `cwendt94/espn-api`'s `constant.py`
(an actively maintained open-source ESPN Fantasy API client), which maps slot id
`20` to `"BE"` (bench) and `21` to `"IR"`. Still **not** cross-checked against one of
this project's own 5 real leagues' actual `lineupSlotCounts` — that one-line check
is still worth doing before shipping, since a wrong id silently mismaps rather than
erroring, but the id values themselves now rest on a citable external source rather
than a guess.

**Ask:** the real ESPN bench slot id (`20`) and IR slot id (`21`) added to
`ESPN_SLOT_NAME` as `'BN'` and `'IR'`.

## 3. Waiver type

**Gap:** not read from either platform. Sleeper: `league.settings.waiver_type`
(Sleeper's documented enum, roughly 0=rolling/1=reverse-standings/2=FAAB — not
verified here).

**Update, 2026-09-22:** ESPN DOES have a real field for this —
`settings.acquisitionSettings.acquisitionType`, a string enum (`"WAIVERS_TRADITIONAL"`
confirmed present in a real captured payload published at thomaswildetech.com).
Confirmed against two independent external sources (`cwendt94/espn-api`'s
`base_settings.py` reads the same path); `league-config-verification.js` now reports
this `confirmed` for ESPN, not `unavailable`. Not the full enum — only
`"WAIVERS_TRADITIONAL"` has been seen in a real example; other values (rolling
waivers, no waivers) presumably exist under different strings, not enumerated here.

**Ask:** a `waiver_type` column, populated from `league.settings.waiver_type` for
Sleeper and `settings.acquisitionSettings.acquisitionType` for ESPN.

## 4. FAAB budget

**Gap:** not read from either platform. Sleeper: `league.settings.waiver_budget`
(documented, unverified here).

**Update, 2026-09-22:** ESPN has real fields —
`settings.acquisitionSettings.isUsingAcquisitionBudget` (boolean gate) and
`.acquisitionBudget` (the value) — but with a subtlety worth carrying into the
ingest, not just the verification layer: a real captured payload
(thomaswildetech.com) shows `isUsingAcquisitionBudget: false` alongside
`acquisitionBudget: 100` at the same time — ESPN populates a default budget value
even for leagues that don't use one. **Any ingest of this field must gate on
`isUsingAcquisitionBudget`, never read `acquisitionBudget` unconditionally**, or a
non-FAAB league gets a fake $100 budget stored as if real.

**Ask:** a `faab_budget` column from Sleeper's `waiver_budget`, and from ESPN's
`acquisitionBudget` **only when `isUsingAcquisitionBudget` is `true`** (store `null`
otherwise, matching how `league-config-verification.js#verifyFaabBudget` already
treats it).

## 5. Trade deadline

**Gap:** not read from either platform. Sleeper: `league.settings.trade_deadline` (a
week number, documented, unverified here).

**Update, 2026-09-22:** ESPN's `settings.tradeSettings.deadlineDate` is now
confirmed, not just community-documented — `cwendt94/espn-api`'s
`base_settings.py` reads exactly this field and initializes its own
`trade_deadline` to `0` before conditionally overwriting it, which is where the
"`0` means no deadline configured" convention comes from. `deadlineDate` is an
epoch-ms timestamp when a real deadline is set, and `0` (or absent) means none is
configured — an ingest should store `null` for the `0` case, not the literal `0`.

**Ask:** a `trade_deadline` column from Sleeper's field, and from ESPN's
`settings.tradeSettings.deadlineDate` (stored as `null` when the value is `0` or
absent).

## 6. Playoff structure, stored rather than re-parsed ad hoc

**Gap:** not a stored column at all. `season-sim.js:198` and `trade-horizon.js:59`
(both this thread's files) each independently do
`JSON.parse(lg.payload).settings?.scheduleSettings?.playoffTeamCount ?? 6` on every
call, silently defaulting to 6 teams when the field is missing. Sleeper has no
equivalent read anywhere outside `sleeper-history.js` (a different, historical-scrape
context, not the live 5 leagues).

**Ask:** a `playoff_teams` column (and ideally `playoff_week_start` for Sleeper),
populated at sync time from the same fields `league-config-verification.js` already
reads to report `playoff_structure`: ESPN `settings.scheduleSettings.playoffTeamCount`,
Sleeper `league.settings.playoff_teams`/`playoff_week_start`. Once stored, this
thread would update `season-sim.js`/`trade-horizon.js` to read the column instead of
re-parsing the payload and silently defaulting — that edit is ours, not yours, once
the column exists.

## What's NOT in this contract

Two live wiring bugs found while building the verification layer, unrelated to
missing fields — the league's *already-confirmed* scoring never reaches the
simulator in two call sites (`title-odds-trades.js:66`, `routes/trades.js:1132`,
both defaulting silently to the global `PPR` constant). Neither is `routes/leagues.js`
and neither is this thread's file (Trade Brain's territory) — reported separately,
not part of this ingest contract.
