# NFL betting desk — terminology

Source of truth for user-facing labels on `/betting/nfl` (`NflMarketBoard.tsx` and
everything under `client/src/pages/betting/`). Written after a round of UX
audits found the same words meaning different things on different tabs. This
file is meant to be loaded directly as glossary input for the "what am I
looking at" explainer chatbot — treat every term below as the canonical
definition a user-facing answer should use.

Internal variable/API field names were **not** renamed (too risky, out of
scope). This file documents what a given user-facing label means on each tab
so the underlying field names don't need to match for the concepts to read
consistently.

## Edge

**Canonical meaning: the model's predicted advantage over the market** — how
much better the model thinks a side is than the price/line implies. Shown in
points (Board's "Gap" column, `edge_points`) or as a probability gap
(Ensemble's "Edge" cell, `spread_edge`).

Two other things used to be called "edge" and were renamed to stop the
collision:

| Old label | New label | Where | What it actually is |
|---|---|---|---|
| "Edge" (per-side %) | **Price improvement** | Line Shop → Best book per side | How much better the best book's number is than the median book's, in win-rate points. Pure arithmetic on existing prices — not a forecast. |
| "Avg/Best single edge" | **Avg/Best single price improvement** | Line Shop → Execution board summary tiles | Same concept, aggregated across the board. |

Left alone, and worth knowing about even though it's outside this page's
scope: the fantasy side of the app (`FantasyLab.tsx`) has an "Edge Tools" nav
item, and `App.tsx` still has a `/edge` route (redirects to `/lab`) — both
predate this pass and are a fourth, unrelated sense of the word ("tools for
finding a fantasy roster edge"). Flag for whoever eventually does a
cross-app terminology pass.

## Win rate vs. break-even rate

Two genuinely different things were both being called "win rate":

- **Win rate** (canonical) — a *measured, historical* fraction: of settled
  picks/bets, how many actually won. Used in Decisions, Training,
  FootballFirst, MlbAutoPicks. This is an outcome, computed after the fact.
- **Break-even rate** — a *threshold implied by the price/vig*, not an
  outcome at all. "The win rate you need [to clear before this bet profits]."
  Used in Line Shop and Venue Routing's hold/routing copy. Previously worded
  as "win rate you need," which reads like the first sense; now consistently
  worded as **"break-even rate you need"** in both places.

MLB's "hit rate" (MlbAutoPicks.tsx) is a synonym for the historical win-rate
sense, already labeled distinctly — left as is.

## Pick / bet / ticket / recommendation / candidate

These form a hierarchy, not four names for one thing — the confusion was
using them interchangeably rather than the words being wrong:

- **Candidate** — a model-generated option that hasn't been acted on yet
  (`AllGameRow`/`AutoPick` on Board; `TeaserCandidate` in Ticket Builder).
  Exists whether or not it's eligible.
- **Pick** — a candidate that passed policy and was added to the paper
  ledger ("Paper track" on Board, `pick_source` in Pick Watch). Always a
  single spread/total/prop selection.
- **Ticket** — what Ticket Builder logs: a *combined* instrument (e.g. a
  two-leg teaser spanning two games). Genuinely a different object than a
  single pick — it has its own price and its own win condition — so "ticket"
  should stay reserved for multi-leg combined bets, not used loosely for a
  single pick.
- **Bet** — the general verb/noun for "money at risk on an outcome." Since
  nothing on this desk risks real money yet, every current "bet" is a paper
  bet; UI copy should keep saying "paper track" / "paper ledger" rather than
  bare "bet" where it might be read as real-money action.

Recommendation is not a formal term used on this desk after this pass; where
it appeared informally it meant "candidate," and callers should prefer
"candidate."

## "Not proven yet" — the one message, restated everywhere else

The fact that the model hasn't beaten real market lines and stakes nothing
real yet was independently worded four different ways in four places. There
is now one canonical sentence (`client/src/pages/betting/copy.ts`,
`NOT_PROVEN_MESSAGE`), reused verbatim, with each spot's own technical detail
kept directly underneath rather than replaced:

> This model hasn't beaten the real betting lines yet, so no real money is at
> risk — everything below is practice, tracked so we'll know the moment that
> changes.

Appears in: the hero banner's "Real money" tile (`BettingWorkspace.tsx`), the
Board sidebar's "Evidence state" panel (`NflMarketBoard.tsx`), Engine → Audit
→ Gates ("Model staking is off"), and Engine → Diagnostics → Profit
diagnostic ("Honest verdict"). If a fifth spot needs this fact, import
`NOT_PROVEN_MESSAGE` from `copy.ts` rather than writing new wording.

## Live vs. simulated

"Live" used to label the fully pre-generated, randomly-seeded drive
simulator (`FieldSim.tsx`) — confusable with actually-live game data. Renamed
to **Simulator** in the top nav, with an on-page caption stating plainly it's
a simulated matchup for sanity-checking the model, not a live game or a
betting signal. Reserve "live" for things that are actually live: the
multi-book price feed, Pick Watch's re-shopped picks, Venues' live in-game
board.

Within the simulator: the team-summary tiles show the **final score of the
full simulated game**; the field's black pill shows the **score at this
point in the drive** — these can legitimately differ and are now each
labeled to say which is which.

## Line Shop vs. Venue Routing

Both answer "which book has the best number for this side right now," with
different math, and are legitimately different (not a duplicate bug):

- **Line Shop → Best book per side**: prices each side's edge against the
  real NFL scoring-margin distribution (`nfl-execution-edge.js`'s
  `bestExecution`) — a half-point through a key number counts for more than
  a half-point that isn't.
- **Venue Routing → Best routing gains**: a generic win-rate-saved score
  (`nfl-execution.js`'s `rankBooks`/`routeSlate`) aggregated across the whole
  slate, meant for routing a bet you've already decided on rather than
  evaluating a specific side's price quality.

Each page now cross-references the other inline so a user isn't left
thinking one is broken or redundant.

## Always-live math vs. gated picks

Line Shop's vig/middles panels are correctly always-live and actionable with
no staking gate — a middle's hit rate or a book's hold is pure arithmetic on
prices/lines that already exist, not a forecast. Everything else on Execute
(Board, Pick Watch, Ticket Builder's teaser gate) correctly waits for a model
gate because it depends on a prediction. Line Shop now states this
distinction explicitly rather than leaving the inconsistency unexplained.
