# The three merge reconciliations, resolved and proven before the merge

Written 2026-09-20 on `claude/project-thread-o3wt2p`, while pushes to any
branch with a PR were frozen. Nothing here was pushed to a PR branch and no
PR was opened; the work sits on a hold branch.

The scheduler branch collides with three other branches. Each collision was
known, and each was going to be discovered at merge time by whoever ran the
merge, under time pressure, on a morning that already has a deploy in it.
This file resolves all three ahead of that, and — the part that matters —
tests each resolution rather than asserting it.

## 1. `server/services/scheduler.js` against `d01df31` (the ESPN market timer)

**The collision.** Both branches edit the `league_rosters` registry line.

```
HEAD      league_rosters: { run: refreshLeagueRosters, maxAgeMinutes: 60, tier: 'live', offThread: true,
d01df31   espn_market: { ... },
          league_rosters: { run: refreshLeagueRosters, maxAgeMinutes: 60, tier: 'live',
```

**Why the union is safe, not a guess.** The merge base is `791b131`, and on
the base the line reads:

```
league_rosters: { run: refreshLeagueRosters, maxAgeMinutes: 60, tier: 'live',
```

with no `offThread`. `git log 791b131..d01df31 -- server/services/scheduler.js`
is two commits, neither of which touches that key. So `d01df31` did not
*remove* `offThread` — it never had it. Taking both sides adds their
`espn_market` entry and keeps this branch's `offThread: true`, and reverts
nothing on either side. Had the base carried `offThread`, the union would
have been a silent revert of a deliberate removal, which is exactly the
mistake this check exists to catch.

## 2. `test/health-route-single.test.js`, three ways

Three branches independently made the same fix: `63ca21e` (this branch,
merges first), `caac88a` (the wiring map), `73e0760`. All three drop the
line number from the assertion and keep it in the failure message. The
recorded plan was to take the wiring map's version because its explanation
is the fullest.

**"Semantically identical" was an assertion, so it was tested.** All three
files were run against one identical tree (`791b131`), then against the same
two injected faults. Each mutation was hash-verified as applied and the tree
restored afterwards.

| version | clean tree | line shifted | second registration |
|---|---|---|---|
| `791b131` (the original) | pass 3 / fail 0 | **fail 1** | fail 1 |
| `63ca21e` (this branch) | pass 3 / fail 0 | pass 3 / fail 0 | **fail 1** |
| `caac88a` (wiring map) | pass 3 / fail 0 | pass 3 / fail 0 | **fail 1** |
| `73e0760` | pass 3 / fail 0 | pass 3 / fail 0 | **fail 1** |

The shift injection is an unrelated comment inserted at line 10, which moves
the registration from line 86 to 87 and changes nothing else. The original
test fails on it — that is the bug all three were fixing, reproduced. The
duplicate injection adds a second `app.get('/api/health', …)`; every version
including the original still fails on it, which is the guard the file exists
for and which none of the three weakened.

So the resolution is a **resolve, not a clean merge**, and taking any of the
three loses nothing. Take `caac88a`.

## 3. `test/league-roster-schedule.test.js` against `8b1a0363` (PR #71)

**The collision.** Orthogonal in intent, overlapping in text. This branch
split the test in two — the wiring asserted against the registry, the
behaviour asserted by calling `refreshLeagueRosters` directly instead of
driving it through `runIfStale`, because the old shape made the tests
silently conditional on the job running inline. `8b1a0363` added an
`espn_s2`/`swid` pair to the same fixture `INSERT`s, because `syncEspnLeague`
now resolves credentials per league and throws rather than fetching
anonymously.

**Resolution:** this branch's structure, their fixture columns, both
explanations kept.

**Proven order-independent.** The resolved file was run twice:

- on the merged tree, where `server/platform/espn-credentials.js` is present
  — 3 tests, 3 pass, 0 fail;
- on `8709ec6` alone, where that module is **absent** — 3 tests, 3 pass,
  0 fail.

That second run is the one worth having. It means #48/#71 and this branch may
land in either order without a broken intermediate state, which was an open
assumption until it was measured.

## What is on the branch

`8709ec6` (the hold head, unchanged) → `0e0bb86` (merge of `8b1a0363`,
resolved) → `7462c4c` (merge of `d01df31`, resolved). The hold branch itself
is untouched and still fast-forwards cleanly.

## The five questions

**Is this well built?** It is three merge resolutions and a test harness, not
a feature. The build quality claim is narrow: each resolution was applied to
a real tree and the result executed, rather than reasoned about in a message.

**Is this based on stats or is it made up?** Measured. Every row in the table
above is a `node --test` run against a named tree with a hash-verified
mutation. The `791b131` base-line claim in §1 is `git show` output, not
recollection.

**How do we know?** The three commands are reproducible as written: the
merge-base lookup in §1, the injection matrix in §2, the two-tree run in §3.
The mutation-and-restore steps each print whether the file hash actually
changed, because a mutation result is evidence only if the mutation landed.

**Should this data be pointed anywhere else on the platform?** No. This is
repository-mechanical and has no runtime surface. The one durable piece is
the order-independence result in §3, which belongs in the merge ledger rather
than in any page.

**How does it unify?** It removes three unknowns from the morning sequence.
The merge order in the release plan stays exactly as recorded; what changes
is that none of the three collisions now has to be understood at the moment
it appears.
