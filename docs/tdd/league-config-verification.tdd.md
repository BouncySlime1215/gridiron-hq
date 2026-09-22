# League config auto-ingest: verify, don't guess

2026-09-22. `server/services/league-config-verification.js` (new),
`server/services/scoring.js` (additive: `scoringConfirmationFor`),
`test/league-config-verification.test.js`, `test/fixtures/espn-scoring-items.js`.
Off `main` `654ff93`, on branch `effk`.

Nick's PART 5 item, verbatim: *"The model pulls and verifies ALL league settings
itself: scoring (PPR, pass TD value, bonuses), lineup slots, bench/IR, waiver type,
FAAB budget, trade deadline, playoff structure, keeper/dynasty rules. Then it PROVES
the projections use the right scoring with a verification check. If any setting can't
be confirmed, it says so loudly instead of guessing."*

## Phase A scoping (reported to the coordinator before any code was written)

Measured against the shipped tree, file:line, before building anything:

| Setting | State found |
|---|---|
| Scoring (per-stat) | ESPN: built (`scoring.js#scoringFor`). Sleeper: not — `routes/leagues.js:182-188` keeps only the `ppr` flag and discards Sleeper's own per-stat detail. |
| pass TD value, bonuses | Mostly built for ESPN; `first_down` bonus has no stat-id mapping (`scoring.js`'s `ESPN_STAT`), so it silently scores 0 forever. Not touched here — a behavior change to `scoreLine`'s output is a separate, larger change than a read-only verification layer. |
| Lineup slots | ESPN: partial (`routes/leagues.js:118` `ESPN_SLOT_NAME` names 7 of the real slot ids). Sleeper: full (raw API list). |
| Bench/IR | Not captured for ESPN — the unnamed-slot IDs are dropped by `.filter(Boolean)` before `roster_positions` is ever stored. |
| Waiver type / FAAB / trade deadline | Not implemented anywhere, either platform. |
| Playoff structure | Read ad hoc from the cached payload in two unrelated files (`season-sim.js:198`, `trade-horizon.js:59`), each defaulting silently to 6 teams if absent. Not stored. |
| Keeper/dynasty | Built and wired (`format.js#leagueTypeFromPayload`, stored in `leagues.league_type`, consumed by `trade-engine.js`/`tradelab.js` for valuation) — the one Nick called consequential, and it already works. |

**The "prove it" requirement did not exist anywhere.** `scoringFor`'s `matched >= 4`
check was the only verification-shaped logic in this area, and it fails silently: a
league whose scoring can't be confirmed gets the PPR default with nothing surfaced to
a caller or a page.

**This container cannot check any of it against the 5 real leagues.**
`server/data.sqlite` here carries the 42,133-row player-week corpus but `leagues`,
`drafts` and `draft_picks` are all empty — checked directly with `node:sqlite`,
`readOnly: true`, before writing a line of code. Every fixture below is a payload
shape built from field paths already used by shipped code in this repo, not a live
read and not invented.

**File-ownership ruling from the coordinator:** `server/services/scoring.js` and
`server/services/format.js` had no claimant in the file allocation and this file's
natural consumer is `projections.js`/`season-sim.js` (mine) — ownership assigned to
this thread. `routes/leagues.js` stays Google sign-in's; the actual ingest gaps
(Sleeper full scoring, ESPN bench/IR slots, waiver/FAAB/trade-deadline, stored
playoff structure) are a field-list contract for them, not built here.

## What this adds

`verifyLeagueConfig(lg)` — one report per league, one key per setting Nick named
(`CONFIG_VERIFICATION_KEYS`, frozen, asserted exhaustively by a test so a dropped key
can't be added quietly), each with a `status`:

- **`confirmed`** — read from a field path already used by shipped code elsewhere in
  this repo (cited per check, below), or ESPN scoring's existing `matched >= 4` gate.
- **`best_effort`** — read from a field, but the field name comes from external API
  documentation, not from anything already verified against a real payload in this
  codebase. Used for Sleeper's `waiver_type`/`waiver_budget`/`trade_deadline` and for
  ESPN's keeper heuristic.
- **`defaulted`** — the app is using a bucketed or assumed value in place of the
  league's real setting.
- **`unavailable`** — no path to the value exists at all (Sleeper scoring detail;
  ESPN waiver/FAAB/deadline, which have no known field mapping on ESPN's undocumented
  API).

Every check's field path, where one is claimed as `confirmed`, is a path already
read by shipped code elsewhere in this repo:

- ESPN lineup slots: `settings.rosterSettings.lineupSlotCounts` — the same field
  `routes/leagues.js:153` reads to build `roster_positions`.
- ESPN playoff structure: `settings.scheduleSettings.playoffTeamCount` — the same
  field `season-sim.js:198` and `trade-horizon.js:59` already read (and silently
  default to 6 when it's missing — a guess this function refuses to repeat).
- Sleeper playoff structure: `league.settings.playoff_teams` /
  `playoff_week_start` — the same fields `sleeper-history.js:33-38` already reads.
- Keeper/dynasty: `format.js#leagueTypeFromPayload`, called directly rather than
  re-implemented.

`summarizeConfigReport(report)` is the pure aggregation — `confirmed_count`,
`unconfirmed_settings`, and `loud_warning` (a plain-language string naming exactly
which settings aren't confirmed, or `null` when every one is). Split out from
`verifyLeagueConfig` on purpose: no real league can reach the all-confirmed branch
today (see below), so the aggregation needed to be testable on synthetic input, not
only through realistic fixtures.

**`scoring.js` gained one additive export, `scoringConfirmationFor(lg)`.** It mirrors
`scoringFor`'s own `matched >= 4` logic without touching `scoringFor`, `PPR`, or any
existing export — the four pre-existing tests in `test/scoring.test.js` pass
unchanged. It answers "why did this league get the scoring it got", which
`scoringFor` itself never needed to say.

## A finding named but not built here: two real wiring gaps

While tracing `scoringFor`'s callers to write the confirmed-path evidence above,
two call sites were found that build a season simulation WITHOUT passing the
league's scoring at all, silently defaulting to the global `PPR` constant:

- `server/services/title-odds-trades.js:66` — `tradeImpact(lg, {...})`, no `scoring`
  key.
- `server/routes/trades.js:1132` — `tradeImpact(lg, { ...simArgs, runs, seed: 1 })`,
  and `simulationArgsFor` (`routes/trades.js:1179-1199`) never includes `scoring`
  either.

Both are exactly the failure Nick's item is written to catch — a league's real
scoring never reaching the model that's supposed to use it — and both are outside
this file's ownership (`title-odds-trades.js` unclaimed elsewhere;
`routes/trades.js` is Trade Brain's). Not fixed here; routed to the coordinator by
file:line rather than edited.

## Mutations

Base `league-config-verification.js` = `c06f862ec966`, `scoring.js` = `5624c8347fb2`.
Each row applied alone from a clean base via the sweep runner, hashed before/after,
exact before/after text printed by the runner, file restored at the end.

| # | mutation | result | first sweep |
|---|---|---|---|
| L1 | dropped-slot arithmetic always reports 0 dropped | 1 fail | 1 fail |
| L2 | a dropped ESPN slot no longer flips `lineup_slots` to `defaulted` | 1 fail | 1 fail |
| L3 | `bench_ir` stops going `unavailable` when ESPN drops slots | 1 fail | 1 fail |
| L4 | Sleeper BN/IR check stops looking for `BN` | 1 fail | 1 fail |
| L5 | ESPN playoff structure reports `confirmed` even absent | 1 fail | 1 fail |
| L6 | ESPN keeper heuristic promoted `best_effort` → `confirmed` | 1 fail | 1 fail |
| L7 | Sleeper waiver/FAAB/deadline promoted `best_effort` → `confirmed` | 1 fail | 1 fail |
| L8 | ESPN waiver-type platform gate removed | 1 fail | **survived, 0** |
| L9 | `unconfirmed` stops filtering on status | 3 fail | 3 fail |
| L10 | `loud_warning` fires even when everything is confirmed | 1 fail | **survived, 0** |
| L11 | malformed-payload catch removed | 1 fail | 1 fail |
| S1 | `scoringConfirmationFor` drops the 4-match threshold | 1 fail | 1 fail |
| S2 | `scoringConfirmationFor` stops gating non-ESPN platforms | 1 fail | 1 fail |

**Two rows survived the first sweep at 0 fail, both missing tests rather than weak
mutations** — the same pattern as `S6`, `P9`, and `F1/F3/F9` earlier tonight, now
confirmed a fourth and fifth time on a different file:

- **L8**: no fixture gave an ESPN-platform league a payload shaped like Sleeper's
  (`payload.league.settings.waiver_type`), so removing the platform gate changed
  nothing observable — the field path itself already misses for real ESPN payload
  shapes, for an unrelated reason (ESPN payloads have no `.league` wrapper). Closed
  with a test that deliberately gives an ESPN league a Sleeper-shaped payload, so the
  platform gate — not a coincidental path miss — is what's being tested.
- **L10**: as documented directly in the code now, no real league can reach an
  all-confirmed report under today's checks (Sleeper scoring is always `defaulted`;
  ESPN's waiver/FAAB/deadline are always `unavailable`), so no realistic fixture
  could exercise the `loud_warning === null` branch. Closed by extracting
  `summarizeConfigReport` as its own exported, independently-testable function and
  asserting it directly on a synthetic all-confirmed input.

## Numbers

RED: 1 suite failed to import (module did not exist). GREEN, before closing the two
survivors: 33 tests, 33 passed, 0 failed. After closing L8/L10: **36 tests, 36
passed, 0 failed** in
`league-config-verification.test.js`/`scoring.test.js`/`format-bestball.test.js`
together.

Full local check `npm run check` on `effk` at this commit: exit 0 — **3,001 tests,
2,960 passed, 0 failed, 41 skipped**; typecheck, lint and build clean; `start:smoke`
passed on an isolated database (32 teams). Baseline on this branch before this work
(commit `2709263`'s own GREEN check) was 2,978/2,937/0/41 — a delta of **exactly
+23/+23/0/0**, which matches this file's own test count precisely (the new test
file contributes 36 of the 36 seen when run alongside the two pre-existing suites it
shares a run with; 36 − 4 (`scoring.test.js`) − 9 (`format-bestball.test.js`) = 23),
a stronger confirmation than a bare tree-hash would have given.

**`git write-tree` before/after was recorded but is not meaningful evidence here**,
stated plainly rather than left implied: the edits (`scoring.js`, the new module)
were never staged before the check ran, so the index — and therefore
`git write-tree`'s output — was identical before and after regardless of what the
check did. The test-count delta above is the real check on this run, not the tree
hash.

**Isolation, stated rather than implied:** source-isolated — one working tree,
shared `node_modules`, no install during the run. Not cross-checked against another
container's dependency tree.

## The five questions

**Is this well built?** One frozen key list, one status per setting, an aggregation
split out so it is testable without a realistic fixture, and every `confirmed`
status backed by a field path already used elsewhere in shipped code rather than a
fresh guess. What is not well built yet is the actual ingest — this file only
reports on what `leagues.js` already stores; it does not close a single one of the
gaps it finds.

**Is this based on stats, or is it made up?** Every `confirmed` path cites the
existing shipped code that already reads it. Every `best_effort` path is labeled as
such precisely because it is NOT cross-checked against a real payload in this
container — the honest distinction Nick's item asks for is which of the two applies
to a given setting.

**How do we know?** Thirteen mutations, all caught after two rounds; every fixture
built from field paths already read by shipped code, cited per check; the one
external constraint (no real league payload reachable from this container) stated
in the file's own header rather than worked around with an invented example.

**Should this data be pointed anywhere else on the platform?** Yes, directly: the
two wiring gaps found in `title-odds-trades.js:66` and `routes/trades.js:1132`,
where a league's real scoring never reaches the simulator. Routed by file:line, not
fixed here — neither file is this thread's to edit.

**How does it unify?** It gives every one of Nick's eight settings the same
four-state vocabulary this codebase already uses elsewhere for degraded data
(`availability-basis.js`'s `role`/`pooled`/`unvouched` shape) — confirmed, best
effort, defaulted, or unavailable, never silent. A caller that wants to say "this
league's numbers might be wrong for its actual rules" now has one function to ask.
