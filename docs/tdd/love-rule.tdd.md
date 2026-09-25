# LOVE-RULE: a BUY / PASS / AVOID tag, luck weight 0, shadow

RED first · GREEN follows · `test/love-rule.test.js`.

## Pre-registration (written before any code)

Unit: ONE-PLAN section 5 night 5 and section 4d night 5. `campaign/love.js`
tags a buy-low candidate BUY / PASS / AVOID from usage (WR/TE target SHARE,
spot-check row 2; RB/QB ffopportunity expected points per game, "usage
through week N"), draft capital (`overall_pick`, from DRAFT-ID-MAP when it
is on) and a healthy role (the injury report; radar flags when #377 is
merged). Luck (actual minus expected points) is ONE sentence with weight 0.
TD-over-expected is a sell-high LABEL with weight 0 (spot-check row 1).

It is a TAG only, never a search constraint (section 7: "LOVE as a search
constraint: PARK"). It ships as shadow behind `GRIDIRON_LOVE_TAG`: with the
flag on, the producer writes `_run.inputs.love`; no served field changes.

Metric and pass bars, fixture level (this PR):

1. Luck weight 0: over a seeded sweep of 2,000 made-up players, changing
   actual points and actual TDs changes the tag 0 times. Fails at 1.
2. Never a constraint: the plans entry with the flag on is deep-equal to the
   flag-off entry outside `_run.inputs.love`. Fails on any difference.
3. Flag off: no `love` key anywhere in the entry.
4. Missing inputs are named, not guessed: a player with fewer than 2 prior
   games of usage is UNRATED with a reason; an absent table is reported as
   `table_absent` in the sources block, never a thrown error and never a
   silent empty.
5. Grade: every tag carries `grade.status = 'ungraded'` with its reason until
   the luck-free r52 re-run supplies a held-out hit rate with a CI.
6. No names: the summary carries player ids only (repo is public).

Metric and pass bars, league level (Needs local measurement, not claimed here):
McLaurin BUY and London PASS reproduce; Rice carries the luck sentence and
whatever tag the luck-free rule gives, printed with the CI once graded.
What would fail it: either reproduction misses with the thresholds as written.
The thresholds in `LOVE_RULE` are GUESSES until that run; they are declared
in one frozen object so the local run can report exactly what it judged.

## RED

`dd17697b`: `ERR_MODULE_NOT_FOUND: server/services/campaign/love.js`; the whole file fails.

## GREEN

- `server/services/campaign/love.js`: `loveTag` (the rule), `LOVE_RULE` (frozen thresholds,
  labelled GUESS), `loveSummary` (ids and counts for `_run.inputs.love`), `loveIdsOf` (the
  players an entry shows), `loveEnabled` (`GRIDIRON_LOVE_TAG`, off unless `'1'`).
- `server/services/campaign/love-inputs.js`: one parameterised read per source, weeks before
  N only; absent tables reported per source.
- `scripts/campaign/league-adapter.mjs`: `adapter.love(ids, { draft })`, flag-gated.
- `scripts/campaign/produce-plans.mjs`: `_run.inputs.love`, read after planning.

21 of 21 pass.

## Decision the rule takes that the plan left open

Section 4d says LOVE uses "actual AND expected" points; section 5 and CT-29 say luck has weight 0.
Actual minus expected IS the luck term, so the tag reads expected points and share only, and
actual points appear only in the luck sentence. Flagged in the PR under "Not confirmed".
