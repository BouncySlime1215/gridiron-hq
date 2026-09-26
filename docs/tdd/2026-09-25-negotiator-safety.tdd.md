# NEGOTIATOR-SAFETY: evidence (2026-09-25)

<!-- prereg: docs/tdd/2026-09-25-negotiator-safety-prereg.md -->

Deep-queue item 11 (research R3/R11). Behind `GRIDIRON_NEGOTIATOR_SAFETY=1`, default off; the preview
switch never turns it on. No served number moves: the unit withholds a verdict, rejects a text, adds a
why line, and marks an offer to withdraw.

## 0. Audit (extend or build)

- (a) The counter re-price already existed (COACH-NEGOTIATE #327: the campaign adapter's rescore and
  priceStep). What was missing: with no engine, Coach still said "take" on the walk-away alone. Extended
  `coach/negotiator.js`; the rule itself is `negotiator-safety.js#counterGate`.
- (b) `never-give.js#draftNamesBlocked` covered Coach's free-text drafts by full name only; the plan's own
  texts and the negotiator's drafts had no filter. New `negotiator-safety.js#filterText`, blocked ids from
  `never-give.js` (`blockedIds(ruleGate(...).rules)`, pinned ids always), pressure phrases from
  `negotiator-defaults.js#pressureTactics`, names read with `message-check.js` (`splitName`, `surname`,
  `COMMON_WORDS`).
- (c) `negotiator-defaults.js` already stated an expiry and a withdraw rule as text (`OFFER_HOURS`,
  `WITHDRAW_IF`) under its own flag; nothing checked either. New `offerState` + reader `deal-news.js`
  over the three stores that keep history (`nfl_feature_revisions` injury_report, `nfl_depth`,
  `league_roster_snapshots`); `warroom-negotiate.js#threadView` gets an `offer` block. No schema change.
- (d) `negotiator-defaults.js#whyLine` existed but `firmOfferText` drops it first when the text is long, and
  the template/coach paths never add it. New producer pass `applyNegotiatorSafety` after COACH-MSG; one
  new optional contract key `steps[].safety` (`plans-schema.js`).

## 1. Tests (RED first)

`test/campaign-negotiator-safety.test.js` (13 tests) and `test/coach-negotiator-safety.test.js` (5 tests).

RED (commit `c6cef9f7`, implementation absent):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/negotiator-safety.js'
# tests 1  (campaign-negotiator-safety)
# tests 5  # pass 3  # fail 2  (coach-negotiator-safety: the two flag-on verdict tests fail on main's behaviour)
```

## 2. Results against the pre-registration

| # | bar | result |
|---|---|---|
| 1 | engine removed: 0 take / counter-with verdicts, 0 drafts; engine present: every verdict priced | PASS: both counters give no verdict and no draft without the engine; with it, the take carries his package's `title_after`, the counter-with carries ours (0.5459 vs backup 0.4879) |
| 2 | 100% of >= 20 labelled bad texts rejected for the right reason; 0 false rejections of the plan's own texts | PASS: `caught=21/21 false_rejections=0/9` |
| 3 | expiry = last send + 48 h; withdraw on each news kind after the send; 0 misses, 0 false | PASS: `news found=3/3 false=0`; before-send and other-player news stay live; absent sources are named |
| 4 | 100% of flag-on fixture messages open with a why line, <= 280 chars, pass `checkMessage` | PASS: template texts `why_line=6/6`, coach texts `why_line=6/6`, max 179 chars, contract valid |
| 5 | flag off: byte-identical producer fixture; existing tests unchanged | PASS: see the suite run in the PR |

## 3. Choices worth knowing

- A bare surname of a blocked player fails closed even when an allowed player shares it ("Brown" beside
  Marquise Brown is rejected). For Nick's other players a shared surname is read as the allowed one.
- A lowercase common word ("love", "brown") is the word, not the player (message-check's list).
- "Withdraw" cannot cancel on ESPN; the thread says to, with the note drafted. Nick cancels.
- Role news is a depth-chart rank change only; snap share is not read (hand-set, not fitted).
