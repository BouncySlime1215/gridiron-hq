# TDD evidence (retroactive): the consensus draft board is season-gated

**Change.** `claude/project-thread-5f9c3y-consensus-season`, PR #55, one commit
(`b85d758`, "Stop last season's ESPN ADP voting on this season's draft board")
on top of `791b131`.

**Defect.** `computeConsensus()` (`server/routes/aggregates.js:218`) joined
`espn_player_market` on `espn_id` alone, with no season predicate. That table is
keyed `espn_id INTEGER PRIMARY KEY` (`db/migrations/core-and-fantasy.js:595`), so
it holds one row per player for whichever season was last synced. The blend at
`:250` gives the ESPN rank **double weight** against FantasyFootballCalculator and
Sleeper:

```js
const weighted = [[ffcRank.get(p.id), 1], [slRank.get(p.id), 1], [espnRank.get(p.id), 2]]
```

so a stale row is not a minor contaminant, it is the heaviest single vote. Worse,
the `WHERE` clause admitted a player to the board on `em.adp IS NOT NULL` alone:
a player with no team and no current market could be ranked into this year's draft
on last year's ADP. `POST /aggregates/create-board` (`:263`) then freezes that
ordering into `ranking_entries`, so the contamination outlives the row.

**Why a season predicate and not a scoring-format one.** The scheduler thread
proposed keying the guard on scoring format. That is true but not load-bearing:
the join has no season filter at all, so the first thing a format guard would do
is pass a 2025 row through as valid 2025 data. The predicate has to be the season.

## RED

The tests were written against the unfixed code and run at `791b131`
(`test/aggregates-consensus-season.test.js`, 5 tests):

```
# tests 5
# pass 1
# fail 4
not ok 1 - a past-season ESPN row does not put a player on this season's board at all
not ok 2 - a past-season ESPN row casts no vote for a player who is on the board anyway
ok 3 - a current-season ESPN row still ranks, at full weight
not ok 4 - the freshness read says which season the table is for
not ok 5 - a table caught between seasons reports both, rather than one plausible number
```

Test 3 is the control and passes on both sides: the fix must not cost a
current-season row its vote. Tests 4 and 5 are the second half of the change —
`espnMarketFreshness()` (`server/services/espn-market.js:76`) previously returned a
count and a timestamp with no season at all, which is exactly the shape that lets a
stale table look fresh. It now reports `newest_season` and `oldest_season` so a
table caught mid-sync reads as caught mid-sync rather than as one plausible number.

## GREEN

At `b85d758`, all 5 pass, and the full suite is green (see the PR body for the
run numbers).

## Note on production, which this change does not fix

The season the predicate binds to is `Number(process.env.NFL_SEASON) || new
Date().getFullYear()`. **`NFL_SEASON` is not set in production** — `fly.toml`'s
`[env]` block holds only `HOST` — so the live app takes the calendar-year branch.
That is correct today and wrong from 2027-01-01, when a January read of the 2026
season will ask for 2027. Setting the secret is a deploy-time step, not a code
change, and is tracked separately.

## Injection

The one test that passes at `791b131` is test 3, so the RED run does not prove it.
Injected against the fixed code: the season predicate shifted by one, so a
current-season row can no longer match.

```js
- LEFT JOIN espn_player_market em ON em.espn_id = p.espn_id AND em.season = ?
+ LEFT JOIN espn_player_market em ON em.espn_id = p.espn_id AND em.season = ? + 1
```

```
# tests 5
# pass 4
# fail 1
not ok 3 - a current-season ESPN row still ranks, at full weight
```

It bites the intended test and only that one.

## Is this well built

- **Well built:** yes, in the narrow sense that it adds a predicate that should
  always have been there. The `WHERE` clause change is the larger one: admitting a
  player on `em.adp IS NOT NULL` alone was the path by which a teamless player
  could reach this year's board.
- **Stats, or made up:** neither. Nothing is estimated. The double ESPN weight
  (`2` against `1` and `1`) is **hand-set and uncited** — it predates this change
  and this change does not touch it. It is the reason a stale row mattered so
  much, and it is worth someone deciding on its merits.
- **How we know:** no backtest. What is verified is structural: the table is keyed
  `espn_id INTEGER PRIMARY KEY` (`core-and-fantasy.js:595`), so it holds exactly
  one row per player for whichever season was last synced; the consumers are
  `draft-assist.js:413`, `routes/drafts.js:80` and `:445`.
- **Pointed anywhere else:** `espnMarketFreshness()` had no callers at all before
  this. It should be on whatever surface tells Nick how fresh the draft board is,
  which does not exist yet — that is a real gap, not a claim this PR closes.
- **How it unifies:** the same season predicate this repository already uses
  everywhere else, applied to the one join that had none.
- **A held-out test would look like:** consensus rank in week 0 of a season
  against end-of-season PPR finish, scored two ways — with and without the ESPN
  vote — over several seasons of `nfl_player_week_stats`. That would settle the
  weight of 2. Nobody has run it.
