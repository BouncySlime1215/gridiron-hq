# NEGOTIATOR-SAFETY: pre-registration (2026-09-25)

Deep-queue item 11 (research R3/R11). Written and committed before any code or test of the unit.
Behind its own switch `GRIDIRON_NEGOTIATOR_SAFETY=1`, default off. The preview switch
(`GRIDIRON_PREVIEW_UNCONFIRMED`) never turns it on. It moves no served number: it withholds a
verdict, rejects a text, adds a why line, and marks an offer to withdraw. P(yes), title odds and the
plan's ranking are untouched.

## The four parts and where each lives

| part | what | where (extends, no new producer) |
|---|---|---|
| a | every counter is re-priced by the planner/sim before Coach says anything about it | `coach/negotiator.js#negotiate`: a take needs the engine's price of his counter; a counter-with needs the engine's price of ours. Unpriced, Coach gives no verdict ("wait") and drafts nothing. The walk rule (his ask richer than the walk-away) is the plan's, not a judgement, and stays. |
| b | a message filter rejects any drafted text that would worsen the plan or name a blocked player | new pure `campaign/negotiator-safety.js#filterText`; blocked ids come from `never-give.js` (pinned never-give / never-get, objectives untouchables, sold this season). Called by the negotiator's drafts, Coach's `warroom_draft_message`, and the producer's step texts. |
| c | every offer carries an expiry, with auto-withdraw on material news | `warroom-negotiate.js#threadView` gets an `offer` block: `expires_at` = last send + 48 h (playbook `SWITCH_HOURS`), `state` live / expired / withdraw. News = an injury-report revision, a depth-chart rank change, or a roster move for any player in the deal after the last send (new reader `campaign/deal-news.js`). The app cannot cancel on ESPN: withdraw means the card says so and drafts the note. |
| d | every card's message includes a one-line "why this helps you" for the partner | producer pass `negotiator-safety.js#applyNegotiatorSafety` over next move + alternatives: the message opens with `negotiator-defaults.js#whyLine`, else a plain fallback; kept within 280 characters. |

## Metric, pass bar, what fails it

All on fixtures and made-up players (no live DB, no league chat).

1. **Counters (a).** Over the negotiator fixture (the contract producer's league 4, made-up adapter):
   with the engine removed, 0 take or counter-with verdicts and 0 drafts; with the engine present,
   every take / counter-with carries the engine's `title_after` for the package it names.
   Fails on any verdict without a price.
2. **Filter (b).** A labelled set of at least 20 texts: every pinned id (160, 80, 277, 290) by full name
   and by surname alone, pressure phrases, a Nick-side player outside the step's give / walk-away,
   and a counter priced below the backup. Pass: 100% of bad texts rejected with the right reason, and
   0 false rejections on the planner's own texts for the fixture plan. Fails on one miss.
3. **Expiry (c).** Every thread view with the flag on has `expires_at` = last send + 48 h. News on a
   deal player after the send -> `withdraw`, for each of the three kinds. News before the send, or on
   a player not in the deal -> not `withdraw`. Pass: 0 misses, 0 false withdraws. A news source that
   is missing is named as missing, never read as "no news".
4. **Why line (d).** Flag on, 100% of fixture step messages open with a why line, stay at or under 280
   characters and pass `message-check.js#checkMessage`. Fails on one step without it.
5. **Flag off.** The committed producer fixture is reproduced byte for byte, and the existing
   negotiator, rules-everywhere and negotiate-UI tests pass unchanged.

## Not measured here

No offer has been sent under these rules, so their effect on acceptance is not measured (ONE-PLAN
spot-check row 18: external evidence only). The real league's news sources and names are measured
on the Mac (see the PR's "Needs local measurement").
