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

**Ask:** the real ESPN bench slot id (commonly documented as `20`) and IR slot id
(commonly documented as `21`) added to `ESPN_SLOT_NAME` as `'BN'` and `'IR'`. Not
verified against a real ESPN payload in this container — worth a one-line check
against any of the 5 leagues' actual `lineupSlotCounts` before shipping, since a
wrong id silently mismaps rather than erroring.

## 3. Waiver type

**Gap:** not read from either platform. Sleeper: `league.settings.waiver_type`
(Sleeper's documented enum, roughly 0=rolling/1=reverse-standings/2=FAAB — not
verified here). ESPN: no known field path — ESPN's API is undocumented and nothing
in this repo has ever read it; worth checking `settings.acquisitionSettings` in a
real payload rather than guessing a sub-field.

**Ask:** a `waiver_type` column, populated from `league.settings.waiver_type` for
Sleeper. For ESPN, only if a real payload confirms where the value actually lives —
otherwise leave it `unavailable` rather than guess, consistent with how
`league-config-verification.js` already treats it.

## 4. FAAB budget

**Gap:** same shape as waiver type. Sleeper: `league.settings.waiver_budget`
(documented, unverified here). ESPN: no known field path.

**Ask:** a `faab_budget` column from Sleeper's `waiver_budget`. Same ESPN caveat as
above.

## 5. Trade deadline

**Gap:** same shape again. Sleeper: `league.settings.trade_deadline` (a week
number, documented, unverified here). ESPN: `settings.tradeSettings.deadlineDate` is
the community-documented field in reverse-engineered ESPN clients, but nothing in
this repo has confirmed it against a real payload.

**Ask:** a `trade_deadline` column from Sleeper's field. ESPN only after a real
payload confirms the field path.

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
