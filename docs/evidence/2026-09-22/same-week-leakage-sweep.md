# Same-week leakage sweep of the shipped fantasy feature builders

**Verdict: five for five clean. The trap that caught my own research harness
this morning does not appear in shipped code.** That is a finding worth stating
plainly rather than a null worth burying — this codebase gets a hard thing right
in five independent places, and each one shows its work in a comment.

---

## What was being looked for

From `opponent-defence-the-oracle-was-the-player.md`: **any feature built from a
same-week team aggregate contains the player's own contribution to that
aggregate.** My hindsight oracle — the opponent's actual pass EPA allowed in the
week being predicted — fired at +1.5496 MSE across 5 of 5 seasons and was almost
entirely an artifact, because a receiver who scores 30 points is part of what
made that defence look bad. Cleaned of his own targets it gives +0.0533 with an
interval containing zero. The contaminated and clean versions correlate
**+0.9530**, so a high correlation between them proves nothing.

Team passing volume this week, team red-zone trips this week, opponent yards
allowed this week, target share against this week's team total — all the same
shape. This sweep asked, of every shipped fantasy feature builder: does any
feature for week W read a team aggregate from week W?

## The results

| module | verdict | why |
|---|---|---|
| `opportunity-model.js` | **clean** | `teamVolume` and `defenceFaced` are pushed only *after* the graded week's features are emitted (`:261-268`, after the feature block at `:195-243`), so `team_volume_ewma` and `opp_volume_faced` are strictly prior |
| `boom-bust.js` | **clean** | `opportunityShares()` aggregates a whole season, but is only ever called on `season - 1` and `season - 2` (`:237-238`), and training runs `throughSeason: season - 1` (`:324`) |
| `nfl-teammate-competition.js` | **clean** | every feature comes from `prior = sorted.filter(g => g.week < target.week)` (`:78`), and teammate shares are drawn only from `prior.map(g => g.week)` (`:88-96`) |
| `opportunity-redistribution.js` | **clean** | the absorption table is fitted once over a fixed historical range, `fromSeason = 2021, toSeason = 2025` (`:84`), and applied forward by `redistribute()` |
| `player-week-engine.js` | **clean** | every history query is `week < ?` or `(season < ? OR (season = ? AND week < ?))` (`:144`, `:459`, `:493`, `:528`) |

### The two cases that look like the trap and are not

**A share is *defined* against its own week's team total.** Both
`opportunity-model.js:266-268` and `nfl-teammate-competition.js:52` divide a
player's week-W volume by his team's week-W total. That is what a share *is*,
and it is correct — because the share is then consumed as a *prior-week*
feature. The trap is reading a same-week aggregate as a feature *for that same
week*, not computing a historical quantity that happens to be a ratio.

**`vacated_same_pos` reads the current week's injury report**
(`opportunity-model.js:180-192`). The Friday injury report is published before
kickoff, so it is information the model legitimately has. `opportunity-model.js`
states this rule for itself at `:18-21` — *"Every feature is computed from weeks
before the graded week, or from information published before kickoff"* — and the
code keeps it.

### One thing to watch, not a finding

`opportunity-redistribution.js:84` hard-codes `toSeason = 2025`. Today that is
strictly historical relative to the 2026 season being served, so the table is
clean. If anyone later advances it to the current season to "keep it fresh", the
table becomes mildly in-sample. The exposure is small — it is a pooled rate per
position-rank cell over thousands of absence events, so one player-week barely
moves it — but the fix is to keep the fitting range strictly behind the season
being served rather than to reason about how small the bias is.

## Why the sweep came back clean

Not luck. Four of the five modules carry an explicit comment naming the hazard
before the code that avoids it — `opportunity-model.js:18-21` and `:165`
(*"team totals for this week, used only to update history AFTER grading"*) and
again at `:257` (*"now, and only now, the graded week joins the history"*),
`boom-bust.js:23` (*"using only features knowable BEFORE the season being
predicted"*), `nfl-teammate-competition.js:10-21`, and
`opportunity-redistribution.js:45-47`.

The one place the trap did bite was a research harness written in a hurry this
morning, with no such comment, by me. The lesson transfers in the direction
nobody expects: **the shipped code was more disciplined than the analysis
auditing it.**

## The five questions

- **Well built?** A read-only sweep. No server file is changed by this document.
- **Stats or made up?** Neither — this is a code trace, and every verdict is
  anchored at `file:line` so it can be re-checked rather than believed.
- **How do we know?** For each module the ordering of "emit features" against
  "update history" was read directly, not inferred from a comment; where a
  comment states the rule, the code was checked to keep it.
- **Pointed anywhere else on the platform?** It is a clearance, not a change.
  The one watch item is `opportunity-redistribution.js:84`.
- **How does it unify?** It closes the loop on this morning's contamination
  finding by testing the claim where it would actually cost something, and
  reports the answer that does not flatter the auditor.
