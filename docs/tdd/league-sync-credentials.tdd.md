# league-sync-credentials — TDD report

**Item:** league refresh (`syncEspnLeague`) resolves credentials the same way
every other ESPN call does, instead of reading the league row directly and
fetching anonymously when that row is bare.

**Files owned and changed:** `server/routes/leagues.js`,
`test/league-sync-credentials.test.js`, `test/league-roster-schedule.test.js`
(fixtures only), this document.

**Parent:** #48, `claude/project-thread-n4052e`. This depends on
`platform/espn-credentials.js`, which does not exist on `main`.

**Origin:** found by exercising the read path rather than reading it. Not a
report from anyone; the end-to-end test built for #48 pointed at a path #48
had not covered, and the PR body for #48 had overclaimed as a result — it said
"there is no third case: a league with no connection throws and names itself",
which was true of the draft path and false of this one.

---

## 1. Audit

`fetchEspn` (`leagues.js:127`) read `lg.espn_s2` / `lg.swid` straight off the
league row, and when they were empty sent no cookie and carried on.

It never borrowed another account's pair, so the leak that
`espn-credentials.js` exists to close did not exist here. Two other things did:

1. **Anonymous is not a graceful fallback.** An unauthenticated fetch of a
   private ESPN league does not fail. ESPN answers 200 with a thin public
   payload, `syncEspnLeague` writes it into `leagues.payload`, and
   `trade-engine.js#loadRosters` reads that column directly with no cache of
   its own. A league that looks connected and reports no rosters is
   indistinguishable from a league that really did empty out.
2. **After #48, this path could no longer see the credentials.** #48 makes
   `espn_credentials` the canonical store. A league whose row is bare but whose
   **owner is connected** therefore fetched anonymously — a connected user
   getting anonymous syncs.

Measured on the parent branch rather than inferred: `POST /api/leagues/:id/sync`
for exactly that league returned **200**, made **3 ESPN calls**, and sent
**`Cookie: null`**.

## 2. RED

`test/league-sync-credentials.test.js`, assertions made on the wire — ESPN
calls counted, `Cookie` header inspected — because from a return value
"refused" and "asked anonymously and liked the answer" look identical.

Against the parent branch `f108ca9`:

```
not ok 1 - a bare league row uses its connected owner's credentials instead of going out anonymously
  error: 'THE BUG: this call went out with no cookie at all — https://lm-api-reads.fantasy.espn.com/...'
ok   2 - a league whose row holds its own pair is unchanged
not ok 3 - a league nobody connected refuses and never reaches ESPN
not ok 4 - the refusal names the league it is about
# pass 1
# fail 3
```

Case 2 passes in both states by design: it is the no-regression guard for the
common path, where the pair sits on the league row and nothing should change.

## 3. GREEN

```js
const { s2, swid } = requireCredentialsForLeague(lg.id);
```

The resolver reads the league's own pair first, so the common path is
untouched; what is new is that a member's credentials are reachable from here,
and that "nobody who can see this league is connected" throws instead of
guessing.

Callers already handled it, which is why this is one line and not a refactor:
the route answers 409, and `scheduler.js#refreshLeagueRosters` catches per
league, writes `connection_status='sync_failed'` with the message onto that row
alone, and keeps going. An inert league now says so instead of sitting at
"connected" with stale rosters underneath — the behaviour CLAUDE.md asks for
when a layer goes inert.

## 4. Two fixtures changed, and why that is not the suspicious move it looks like

`test/league-roster-schedule.test.js` went red: two fixtures insert ESPN
leagues with no credentials anywhere — no pair on the row, no member, nothing.
Under this change both throw, so one test saw a stale name and the other
counted 2 failures where it expected 1.

Neither test is about credentials. One asserts `league_rosters` is a real
scheduled job that refreshes `leagues.payload`; the other that one league's
failure does not block the rest.

Each fixture league was given an `espn_s2`/`swid` pair. **No assertion
changed.** The first fixture already declared `connection_status = 'connected'`
— the pair is what that column was always claiming, it simply never had to be
true before. Same shape as the `draft-ingest` fixture earlier in this stack.

Recording it explicitly because "the change broke two tests so I edited the
tests" is exactly the move that deserves suspicion. What separates it from that
move: the assertions are untouched, and the fixture now matches its own
premise.

## 5. Injection sweep

| Injection | Result |
|---|---|
| baseline | 26 pass / 0 fail |
| league refresh reads the league row directly again | **3 fail** |
| `requireCredentialsForLeague` returns nulls instead of throwing | **6 fail** |
| league's own stored pair ignored | **1 fail** |
| most-recently-fetched fallback restored | **5 fail** |
| commissioner preference dropped | **1 fail** |
| per-user lookup borrows when the row is missing / blank | **1 / 3 fail** |
| connect token matches any account | **3 fail** |

## 6. The consequence, stated rather than buried

A genuinely public ESPN league that nobody has connected can no longer sync at
all, where it previously worked anonymously. That is a behaviour change beyond
the security fix, and it is deliberate: a thin public payload written down as
the truth is worse than a refusal. All five of Nick's leagues carry pairs
today, so nothing on this install is affected. If a public league ever needs
syncing, the answer is to connect an account that can see it, not to restore a
silent anonymous path.

## 7. Full suite

2,976 tests, 2,935 passed, 0 failed, 41 skipped. `npm run check` (typecheck,
lint, test, build, start:smoke) clean.
