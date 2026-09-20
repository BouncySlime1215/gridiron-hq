# TDD evidence: the contention window's age axis is dynasty-only

**Change.** `claude/project-thread-5f9c3y-window-honest`, one commit on top of
`791b131`.

**Defect.** `analyzeLeague` (`server/routes/tradelab.js:98`) classifies every team
on a market-capital x core-age grid and hands back a label and a one-line stance
that the Trade Lab renders as advice (`client/src/components/TradeCard.tsx:237`,
via `their_window` at `trade-engine.js:1172`). Four of the seven labels are decided
by the age axis, and each is a claim about seasons that have not happened:

| Label | Stance |
|-------|--------|
| Win-now | "Window is closing — spend youth and depth on proven help now." |
| Juggernaut | "Strong and young — hold the core, buy only at the margins." |
| Rebuild | "Ascending — accumulate youth, sell aging vets while they hold value." |
| Reset | "Weak and aging — sell everything with value for youth." |

`core_age` was computed for every team with no format guard, so a redraft league —
where the roster is dissolved in January and a player is worth exactly what he
scores between now and week 17 — received all four. The Rebuild case is not merely
unhelpful, it is backwards: it tells a manager to trade away the players who win
games this season for assets that do not exist in his league.

**The rule was already settled in this same file.** `dynastyAgeAdjustment` is
applied only `if (isDynasty)` (`tradelab.js:47`), and `deriveFormat` defines
`isDynasty` once, as `league_type === 'dynasty' || league_type === 'keeper'`
(`format.js:62`) — keepers carry players over, so age is real for them. The window
now follows that same definition rather than inventing a second one.

In redraft the grid collapses to its capital axis and yields the three
format-neutral labels it already had (Contender / Retool / Balanced). `core_age` is
still computed and still reported: it is a true fact about the roster and the page
may show it, it simply decides nothing. `window.basis` names which axes were used,
so a reader can tell a suppressed age axis from an absent core age.

**This changes no number.** `market_capital`, `competitiveness`, `core_age`,
`needs`, `surplus` and every price are untouched; only the label and stance move,
and only in redraft. Test 5 pins that.

## Why the fixture prices both formats identically

`leagueRosters` reads `dynasty_values WHERE format_key = ?`, so a redraft league
and a dynasty league normally see different prices, and a label difference between
them would be unattributable — it could be the gate or it could be two market
value sets disagreeing. The fixture therefore writes the **same** values and ages
into both format keys. The two runs then differ in exactly one input: the league's
type.

## RED (`test/contention-window-redraft.test.js`, 7 tests, at `791b131`)

```
# tests 7
# pass 4
# fail 3
ok 1 - the fixture really does separate the four corners of the grid
ok 2 - a dynasty league still gets all four age-driven labels
not ok 3 - a redraft league is never told to accumulate youth or sell aging vets
not ok 4 - redraft falls back to the capital axis it already had
ok 5 - the two formats disagree only where age was the reason
not ok 6 - the payload says which axes decided the label
ok 7 - a keeper league is treated as dynasty, because it keeps players
```

with test 3 failing as:

```
error: 'Strong Young got "Juggernaut", which is a claim about next season'
```

Four of the seven pass on both sides, deliberately:

- **1** is the premise, not a behaviour. If capital or core age came out flat in the
  fixture, tests 3 and 4 would hold vacuously and the file would prove nothing.
- **2** and **7** are the regression pins: this change removes nothing from dynasty,
  the format the grid was built for, and a keeper league must stay on the dynasty
  side of the one definition of `isDynasty`.
- **5** is the no-op pin: every numeric input to the grid is identical across the
  two formats before and after.

## GREEN

All 7 pass at this branch's head, with the full suite green (numbers in the PR body).

## Deliberately not in this change

The window reads market capital and age. It does **not** read the Team Outlook
verdict (`fine` / `watch` / `act_candidate`), which is the other half of making
this surface honest: a label that says "Contender" while the outlook says the
season is slipping is two pages disagreeing in front of the user. That read is
held because `server/services/team-outlook.js` is not on `main` — it lives on
`claude/project-thread-f921do-outlook-basis`, where it is purely additive and
unmerged — and stacking this pull request on another thread's branch to reach it
would trade a two-line fix for a cross-thread dependency. It is queued to follow
once that branch lands.

The `act`-gating of Trade Lab's recommendations is also out of scope here, by
the same reasoning: this pull request changes what the page *says*, not what it
*does*.
