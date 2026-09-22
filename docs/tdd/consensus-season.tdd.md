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
Date().getFullYear()`.

When this file was written, `NFL_SEASON` was not set in production: `fly.toml`'s
`[env]` block held only `HOST`, so the live app took the calendar-year branch.
That was correct in 2026 and would have been wrong from 2027-01-01, when a
January read of the 2026 season asks for 2027.

That is no longer true, and the correction is recorded here rather than the
paragraph being deleted. #52 (`Tell the deployment which NFL season it is
playing`, squash-merged as `9075e33`) added `NFL_SEASON = "2026"` to that same
`[env]` block, and it is present on `654ff93`:

```toml
[env]
  HOST = "0.0.0.0"
  ...
  NFL_SEASON = "2026"
```

So the deploy-time step this section said was outstanding is done, and the
calendar-year branch is no longer the one production takes. The predicate in
this PR is unchanged by that: it reads whichever season the environment names,
and #52 only makes the environment name one. What #52 does add is a standing
cost this file should carry: the pin has to be bumped each September, and a
stale pin is a wrong season everywhere at once.

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

---

## Addendum, 2026-09-20 02:40Z: the table has no live writer, which makes this worse, not better

Verified against `791b131` with `git grep`, because the Google sign-in thread
routed a separate finding about this same file and checking it turned up
something that changes how this PR should be read.

**On `main`, nothing imports `server/services/espn-market.js` at all.**

- `syncEspnMarket` — **zero callers.** Not a route, not a scheduler job, not a
  script, not a dynamic import. The only occurrences of the string `espn-market`
  anywhere in the tree are its own definition, two schema-manifest entries, a
  line in `scripts/schema-files.txt`, a row in the architecture folder map, and a
  sentence in `docs/FANTASY-ENGINE-MASTER-PLAN.md` proposing that someone run it.
- `espnMarketFreshness` — zero callers, as this PR already said.
- `espn_player_market` — **exactly one writer**, the `INSERT` at
  `espn-market.js:45`, inside that uncalled function. Five readers:
  `routes/aggregates.js`, `consensus-weights.js`, `draft-assist.js`,
  `manager-archetypes.js`, `preseason-model.js`.

**What that means for this PR.** The framing in the body — "if the table held
last year's rows" — was too tentative. The table cannot be refreshed by anything
running on this deployment. Whatever it holds is a frozen snapshot from whenever
that function was last called by hand, or it is empty. So the ESPN vote is not
*at risk* of going stale; it is incapable of being anything else, and it is
weighted 2 against 1 and 1.

**What would disprove it**, since a negative claim from `grep` deserves one: any
call site reached by a computed module specifier, a job registered by name
through the scheduler's source registry rather than by import, or a caller added
on a branch not yet merged. The first two were checked — no dynamic `import(` of
this path exists and the scheduler's registry does not name it. The third is by
definition not on `main`.

**Why this PR is still right, and still not enough.** The season predicate is
correct either way: a frozen wrong-season table is exactly the case it refuses.
But the honest reading is that the fix converts a confidently wrong ESPN vote
into an absent one, and the board then runs on FFC and Sleeper alone, which is
the correct behaviour and also a quiet loss of the source the board's own
docstring calls the most relevant market signal it has. **Wiring a caller for
`syncEspnMarket` is the real fix and it is not in this PR.**

## A follow-up recorded rather than taken: the cookie read

Routed from the Google sign-in thread. The claim is correct on `791b131`:
`syncEspnMarket` reads `espn_s2, swid` off the league row (`:19`) and, when they
are absent, sets no `Cookie` header at all (`:31`) and goes out anonymously
rather than failing. That is the same fault `#71` fixed in league refresh, and
the fix pattern is the single resolver in `platform/espn-credentials.js`.

**Not taken tonight, and the reason is the finding above: the code is not
reachable.** There is no live fault to fix, only a latent one in a function
nothing calls. Fixing it now would mean a branch based on `#48`'s — which is not
on `main` — for a dead code path, during a freeze, creating a cross-thread
dependency for no behaviour change.

**The requirement instead, for whoever wires the caller:** `syncEspnMarket` must
take its credentials from the resolver in `platform/espn-credentials.js`, not
from the league row, and must fail rather than fetch anonymously when there are
none. That belongs in the same commit as the caller, because that is the commit
that makes it reachable. Stated here so the next person does not have to
rediscover it.
