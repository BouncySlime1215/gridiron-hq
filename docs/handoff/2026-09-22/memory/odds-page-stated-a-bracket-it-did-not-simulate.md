---
name: odds-page-stated-a-bracket-it-did-not-simulate
description: My Team hardcoded "real playoff bracket weeks 15-17" under the title odds; that string is the simulator's FALLBACK, taken when the league schedule could not be read. Fixed in PR #58.
metadata:
  type: project
---

`season-sim.js#playoffRounds` returns one of four `basis` values:
`league_schedule`, `league_schedule_short_of_field`,
`sleeper_playoff_week_start`, and `default_weeks_15_17` — the last being the
fallback taken when the payload is unparseable, a Sleeper league has no
`playoff_week_start`, or an ESPN league has no `matchupPeriods`. My Team
printed "real playoff bracket weeks 15-17" as a flat sentence under the title
odds regardless. False for any league whose bracket is not those weeks, and
worse when it happens to be right: it read as a fact about the reader's league
while being a fact about our default. PLAYOFF_WEEKS is already recorded as
wrong for league 4.

Two sibling fields were served on the same response and rendered nowhere:
`projection_basis` (which games the odds rest on, including the case where the
current-season usage log is empty) and `odds_interval` (the range beside the
championship number is run-to-run Monte Carlo error only, not forecast
uncertainty). PR #58 renders all three, client-only, stacked on
`claude/project-thread-f921do-sim-basis`; retarget to main when #44 lands.

**The half that is still missing, and why nobody built it:** whether a
projection used the fitted shrinkage constants or the hardcoded ones.
`activeFitMeta()` (shrinkage-fit.js:537) exists to report exactly that and has
ZERO callers anywhere — server, client or scripts. Field spec sent to the
fantasy plan thread: `projection_fit: { fit_id, fitted_at, recency:
'weekly_role' | 'season_long' } | null` beside `projection_basis`. Until that
is served the step-8 split cannot be labelled truthfully, and it was left
unlabelled rather than guessed.

**Why:** the odds page is where a hardcoded sentence is hardest to catch,
because it sits under numbers that are genuinely computed and inherits their
credibility. Same family as [[basis-fields-served-never-rendered]].

**How to apply:** Model.tsx also renders odds and is one of the four unrouted
pages, so it was not touched — My Team (`/league?view=team`) is the live odds
surface. Related: [[hosted-readers-cannot-run-the-fix]].
