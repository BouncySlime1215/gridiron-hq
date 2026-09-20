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

**The four files the matrix ran.** Named by content, so the table above can be
reproduced against the exact bytes rather than against a ref that may move:

| version | git blob id | sha256 (first 16) | bytes |
|---|---|---|---|
| `791b131` | `5f94736d60487e3b87e3f0de2facfc9afc5c5109` | `38e57dd4c6eb2e45…` | 4183 |
| `63ca21e` | `f47e0db31df47732d2462d380abf6698c5829932` | `e8854f7371e388df…` | 4537 |
| `caac88a` | `d5b021ea8a389b3d4603e396cb8679406fc9ec66` | `0097ba7703dbcba6…` | 5053 |
| `73e0760` | `97fba11772929f315ae449be6b4e6ad784eb4fe7` | `53b76aca01d1a054…` | 4689 |

Each is `git rev-parse <ref>:test/health-route-single.test.js`; the sha256 is of
the file content as `git show` emits it.

**The two injections, quoted rather than described.** Both are applied to
`server/index.js` at `791b131` (blob `c01a70685b6ebce45c77f65d388b60fe47633558`,
sha256 `95107fa1edcc7909…`), one at a time, with the file restored in between.

*Injection A — the harmless shift.* Insert one comment line at line 10. Before,
lines 8-12:

```js
const PORT = Number(process.env.API_PORT) || 5177;
try {
  await assertPortAvailable(PORT);
} catch (error) {
  console.error(error.message);
```

After (sha256 `cba654479519f08e…`):

```js
const PORT = Number(process.env.API_PORT) || 5177;
try {
// mutation A: unrelated comment that shifts later lines
  await assertPortAvailable(PORT);
} catch (error) {
```

The inserted line is a comment, so the program is unchanged; its only effect is
that `app.get('/api/health', healthHandler());` moves from line 86 to line 87.
That is the whole of the bug all three versions were fixing, reproduced.

*Injection B — the real fault.* Insert a second registration at line 87. Before,
lines 85-88:

```js

app.get('/api/health', healthHandler());

// Public only on the loopback interface. It removes the fresh-install token
```

After (sha256 `63084efe915eb0dd…`):

```js

app.get('/api/health', healthHandler());
app.get('/api/health', healthHandler()); // mutation B: a second registration

// Public only on the loopback interface. It removes the fresh-install token
```

`grep -n "app.get('/api/health'"` then reports two registrations, at 86 and 87.
Every version including the original still fails on this, which is the guard
the file exists for and which none of the three weakened.

Both injections were re-applied from a clean checkout when this section was
written, and the quoted text above is what the file actually contained, not a
reconstruction from the commands. The md5 of the shifted state
(`dc76647e13479dccfb865f4545f50302`) is the same value the original run
recorded, so the two runs injected the same bytes.

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

**The files that run named by content**, `test/league-roster-schedule.test.js`:

| version | git blob id | sha256 (first 16) |
|---|---|---|
| `791b131` (base) | `601e1184d5c1810b6ad56e0800fc1383955c6c0c` | `8688397f4c8ba20e…` |
| `8709ec6` (this branch) | `d8c9ad32cb375c3103205163b383ae1277d17479` | `88d77c3b5d48f719…` |
| `8b1a0363` (#71) | `f5c6c1047a0b180e6af75b615d7b0bc8e7b324b6` | `52b50e58b368b7d4…` |
| **`e852884` (resolved)** | `79371eee47b2bb7bec2e9ce1d5d64341d26be4a4` | `51eceb8e32040b46…` |

That second run is the one worth having. It means #48/#71 and this branch may
land in either order without a broken intermediate state, which was an open
assumption until it was measured.

## What is on the branch

`8709ec6` (the hold head, unchanged) → `0e0bb86` (merge of `8b1a0363`,
resolved) → `7462c4c` (merge of `d01df31`, resolved). The hold branch itself
is untouched and still fast-forwards cleanly.

## The full check

Measured on **`e852884`**, this branch's head at the time of the run, with the
machine to itself:

```
3054 tests, 3013 pass, 0 fail, 0 cancelled, 41 skipped
typecheck + lint + test + build + start:smoke, exit 0
Application startup smoke passed on isolated database (32 teams).
```

3054 against this branch's own 3021 — the extra 33 are `8b1a0363`'s credential
test files (`espn-cookie-owner-e2e`, `espn-credential-ownership`,
`league-sync-credentials`), which the merge brought in and which pass.

The commit that adds this section is docs-only and touches only this file, so
it does not reopen that number. That is checkable rather than asserted: the one
test that reads the docs tree at runtime is
`test/nfl-execution-integrity.test.js:258`, and it reads
`docs/CLAUDE-NEXT-STEPS.md`. Nothing reads `docs/tdd/`.

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
