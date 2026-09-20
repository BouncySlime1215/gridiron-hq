# league-outlook-route — TDD report

**Item:** `GET /api/leagues/:id/outlook` — the League Hub's way in to
`leagueOutlook()`, for a league the caller is actually in.

**Files owned and changed:** `server/routes/leagues.js` (one route, one
import), `test/league-outlook-route.test.js` (new), this document.

**Base:** `803074d`, the O4 tip that carries `league-outlook.js`,
`outlook-fit-store.js`, `history-corpus.js`, `team-outlook.js` and
`espn-weekly-scores.js`. This change cannot land before that stack: all five
are absent from `main`.

---

## The five questions

**Is this well built?** It is deliberately the thinnest thing that can work:
assert membership, read the row, return `leagueOutlook(lg)` unchanged. The
design claim is that the route should hold no opinion of its own, and the tests
enforce exactly that by deep equality rather than by naming fields.

**Is this based on stats, or made up?** The route computes nothing. Every
number on the panel comes from the stored fit, and the model refuses in words
when it is not entitled to a number.

**How do we know?** Five cases, four of them red before the route existed, and
five injections each proved applied by hash and each killing the one test it
names, with a control injection that reports NO-OP.

**Should this data be pointed anywhere else?** The panel answers "who is in
trouble and how sure are we", which the Trade Brain's counterparty pricing also
wants. Not wired here; named so it is not rediscovered.

**How does it unify?** One producer, one consumer, one shape. The route adds no
second opinion about a league to the page.

## 1. What the route must not do

`leagueOutlook()` returns exactly two shapes: `{ ready: false, reason }` with a
sentence a page can print as it stands, or the full panel with every team
priced. A route that filled in a missing field, dropped `reason`, or flattened
the not-ready case into an empty panel would put a second opinion about this
league on the page beside the model's, and the page would have no way to tell
them apart.

So the assertions are `deepEqual` against a direct call on the same league row,
not a spot-check. A spot-check passes for a route that drops whatever the
spot-check forgot to name.

## 2. RED

Against `803074d` with the test file and no route, 4 of 5 fail. The fifth, the
unauthenticated 401, passes because the mount authenticates before routing; it
is kept as the statement that it does.

```
not ok 1 - with no fit stored the route answers the reason, word for word, not an empty panel
not ok 2 - with a fit stored the route answers the whole panel, unchanged
not ok 3 - an account that is not in the league is refused, and told nothing about it
ok   4 - an unauthenticated caller is refused
not ok 5 - access to a league dies with the league: the membership cascades away, so it is 403
# tests 5 · pass 1 · fail 4
```

GREEN after the route: 5 pass, 0 fail.

## 3. Two fixture traps, avoided on purpose

**A constant column is not a feature.** Every league in the fit panel gets its
own season length. Give them all fourteen weeks and `weeks_left` is constant
within a fitted week; standardisation turns a constant column into zeros and L2
drives its coefficient to nothing. The feature is then in the model with no
effect, and no test can tell a corrected panel from an uncorrected one.

**A saturating fixture measures the clamp.** The weekly scores are mixed rather
than a blowout. If one team outscores another by twelve every week, every
probability pins against `team-outlook.js`'s `clamp01`, and at the clamp no
input changes the output.

Case 2 asserts every probability is strictly inside `(0, 1)`, so the fixture
states that it is measuring the model rather than the bounds.

## 4. The case that was wrong, and what it taught

The last case first expected 404 for a member whose league row had been
deleted. It got 403, and the code was right.
`league_memberships.league_id` is `REFERENCES leagues(id) ON DELETE CASCADE`
(migration 006) and the connection runs `PRAGMA foreign_keys = ON`, so deleting
a league deletes its memberships and the caller is no longer a member of
anything. **Access to a league dies with the league**, which is the behaviour
worth pinning, so that is what the case asserts now — reading the league
successfully first, so the delete proves something.

That makes the route's own 404 unreachable in any ordinary sequence: the
membership check can only pass while a foreign key guarantees the row exists.
It is kept because every other `:id` route in this file carries the same line,
and the one gap it covers is real — a delete landing between the check and the
read. It is recorded as defensive, not counted as covered.

## 5. Injections

Each row records the file's SHA-256 before and after, because a pattern that
does not match leaves the file unchanged and the run is the baseline wearing a
mutation's name. Each row names the test that must be **among** the failures —
the one the injection is aimed at — because an injection that lands and leaves
that test passing is unfinished, not a result. It is not a claim that only that
test fails: the `Fails` column is the total, and two of these injections break a
second case as well, which is a wider guard rather than a weaker one. The last
row is a control whose pattern is not in the file.

| Mutation | Verification | Result | Fails | Named test red? |
|---|---|---|---|---|
| skip the membership check | APPLIED `41f996e06dae` → `9f014d5c6dec` | RED | 2 | yes |
| drop `reason` from a not-ready answer | APPLIED `41f996e06dae` → `47e7897d446e` | RED | 1 | yes |
| flatten not-ready into an empty panel | APPLIED `41f996e06dae` → `45f9bbcb9a2e` | RED | 1 | yes |
| serve only `teams`, dropping the rest | APPLIED `41f996e06dae` → `a4e306e51b28` | RED | 2 | yes |
| check the row before the membership | APPLIED `41f996e06dae` → `9342415d641e` | RED | 1 | yes |
| **CONTROL** — pattern not in the file | **NO-OP — pattern not found** | — | — | — |

5/5 turned the test aimed at them red; the control ran nothing. Source restored
and verified clean afterwards. The two rows with a `Fails` of 2 also broke
case 1 or case 5 in passing, which is recorded rather than trimmed: an
injection that reaches further than intended says something about the guard,
and hiding it would make the table look tidier than the run was.

The fifth is worth naming: reordering the existence check ahead of the
membership check keeps every happy path working and only changes what an
outsider learns. It turns case 5 red, so the ordering is pinned as
information-hiding rather than as style.

## 6. Deployment

The test points the league-history corpus at a path that does not exist,
because the Docker runtime stage copies `client/dist`, `server` and `scripts`
and never `data/`. A consumer that secretly depends on the corpus passes on a
development machine and renders nothing on Fly.

## 7. Full check

`npm run check` on this tree — typecheck, lint, suite, build, `start:smoke` —
**exit 0: 3,063 tests, 3,022 pass, 0 fail, 41 skipped**, and the startup smoke
passed on an isolated database (32 teams). Nothing else was running against the
tree while it ran.

That is `803074d` with all three commits of this patch applied, which is the
tree this report ships on. The only change after the measurement is the commit
that writes these figures into this paragraph, and nothing the check reads
lives in `docs/`: `scripts/lint.mjs` walks `server`, `scripts` and `test` for
`.js`/`.mjs` only, `tsc` covers the client, and the suite, build and smoke
never open the directory. A measurement cannot be quoted inside the tree it
measures without that step, so the step is named rather than hidden.

The five cases this patch adds account for five of that total. Four of them
fail against `803074d` before the route exists; the fifth is the
unauthenticated 401, which passes because the mount authenticates before
routing.

CI is not run: GitHub Actions is out of minutes until 2026-10-01 and the
workflow is deliberately disabled. A red or missing check on a PR carrying this
work is that, not its content.

---

## Appendix A — the exact text of every injection

A row that describes an edit cannot be re-run from the description; a row that
quotes it can. Everything below is extracted from the script that actually ran,
not retyped, so the quoted text is the text that was matched and written. The
sweep asserted its `before` text appeared exactly once before writing, and
restored the file afterwards.

### The outlook route — §5

Injected into `server/routes/leagues.js`. Each pair is the exact text matched and the exact text
written in its place, copied from the script that ran, so a reader can reproduce
the row without reconstructing it from a description.

**skip the membership check**

before:
```js
r.get('/:id/outlook', (req, res) => {
  assertLeagueMember(req.auth.userId, req.params.id);
```
after:
```js
r.get('/:id/outlook', (req, res) => {
```
must turn red: `an account that is not in the league is refused, and told nothing about it`

**drop the reason from a not-ready answer**

before:
```js
  res.json(leagueOutlook(lg));
```
after:
```js
  const { reason, ...rest } = leagueOutlook(lg);
  res.json(rest);
```
must turn red: `with no fit stored the route answers the reason, word for word, not an empty panel`

**flatten not-ready into an empty panel**

before:
```js
  res.json(leagueOutlook(lg));
```
after:
```js
  const out = leagueOutlook(lg);
  res.json(out.ready ? out : { ready: false, teams: [] });
```
must turn red: `with no fit stored the route answers the reason, word for word, not an empty panel`

**serve only the teams, dropping the rest of the panel**

before:
```js
  res.json(leagueOutlook(lg));
```
after:
```js
  res.json({ teams: leagueOutlook(lg).teams ?? [] });
```
must turn red: `with a fit stored the route answers the whole panel, unchanged`

**answer 404 instead of refusing a non-member**

before:
```js
  assertLeagueMember(req.auth.userId, req.params.id);
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
  if (!lg) return res.status(404).json({ error: 'league not found' });
  res.json(leagueOutlook(lg));
```
after:
```js
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
  if (!lg) return res.status(404).json({ error: 'league not found' });
  assertLeagueMember(req.auth.userId, req.params.id);
  res.json(leagueOutlook(lg));
```
must turn red: `access to a league dies with the league: the membership cascades away, so it is 403`

**CONTROL — pattern that does not exist in the file**

before:
```js
res.json(await leagueOutlook(lg));
```
after:
```js
res.json(null);
```
control row: this text is not in the file, so nothing ran.

