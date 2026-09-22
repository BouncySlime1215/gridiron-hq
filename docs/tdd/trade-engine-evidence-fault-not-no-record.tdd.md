# TDD evidence: an unreadable career layer is not "no NFL record"

**What this is.** `playerEvidence()` (`server/services/trade-engine.js`) wraps
each of its three evidence sources in a bare `catch` and leaves the field
absent on a throw. That degradation is deliberate and documented on the
function ("Every layer is optional... so the engine behaves exactly as before
on a database that has no play-by-play history or no fitted model"), and for
*pricing* it is correct — `value`, `adj_ppg` and every lineup number are
untouched either way.

The defect is what the **text** does with that absence. `playerRiskProfile()`
reads an absent career as `seasons = 0` and assigns `profile: 'unproven'`;
`describeProfile()` renders that as **"a player with no NFL record"** and
`packageNumbers()` as **"0 seasons on record"**. Both are positive factual
claims about the player, and they are reached whenever the career source
*throws* — a broken query, an unmigrated table, a fault in
`player-career.js` — not only when the player genuinely has no record. The
user reads that sentence inside a trade verdict, where the whole point of the
line is "you are trading a 5-year top-12 floor for a 1-season spike".

This is CLAUDE.md's named failure shape exactly: *"No bare `catch {}` that
swallows a fault — this project has shipped two real bugs of exactly that
shape, where a silent catch deleted a whole data layer and the page kept
printing numbers as if nothing had happened. If a layer goes inert, the
surface must say so."*

**Measured before fixing**, against this session's offline rig, through the
public API only:

| player | career source | `headline_read` |
|---|---|---|
| Real Veteran | returns a 5-season record | `a 5-of-5 top-24 floor` |
| Genuine Rookie | returns `null` (correctly, no record) | `a player with no NFL record` |
| Real Veteran | **throws** | `a player with no NFL record` |

The third row is the bug: byte-identical to the second, with
`profile: 'unproven'`, `seasons: 0`, `top24: 0` on a five-year starter.

---

## Commits

Every sha below is an ancestor of this branch's head as pushed, rebased onto
`main` at `6e72271`. An earlier revision of this table cited the pre-rebase
shas (`77ccbbc` … `5b8a345`); the rebase orphaned every one of them, and the
merge gate requires the shas to be rewritten in the same push that rewrites the
commits. They were not, so the table below replaces them. The orphaned shas are
not cited anywhere in this file or the PR body any more.

| stage | commit | subject |
|---|---|---|
| RED (round 1) | `b6e0641` | `RED: a failed career-evidence read is stated as "no NFL record"` |
| GREEN (round 1) | `5c1560d` | `GREEN: a career layer that could not be read says so instead of "no NFL record"` |
| docs (round 1) | `59dd5a1` | `docs: evidence for the unreadable-career-layer fix` |
| RED (round 2) | `44adbca` | `RED: a partly unreadable package reports the readable half as the whole` |
| GREEN (round 2) | `bce6958` | `GREEN: the evidence line says how much of a package it could read` |
| docs (round 2) | `1c8ad78` | `docs: evidence for the unreadable-career-layer fix, rounds 1 and 2` |
| RED (round 3) | `b8b29f9` | `RED: the trade card's Floor cell calls an unreadable package "no record"` |
| GREEN (round 3) | `07af90c` | `GREEN: the trade card says which records it could not read` |
| docs (round 3) | `c38abb6` | `docs: RED round 3 and the rebased shas` |
| docs (gate, round 1) | `3fcb752` | `docs: the guard result on the pushed head` |
| test (mutation fix) | `d84dfb0` | `test: run floorOf instead of grepping it — a surviving mutant said so` |
| docs (v2 gate) | `4807e2e` | `docs: the v2 merge gate sections, including the surviving mutant` |
| docs (sha rewrite) | *this head* | `docs: the post-rebase shas` — cited as the head rather than by sha, since a commit cannot carry its own hash |

### RED round 1 — the failing assertion, verbatim

`test/trade-engine-evidence-fault.test.js`, six cases through
`_setEvidenceSources` (the file's own hook for simulating a missing layer).
Three failed against the pre-fix function; three passed, pinning the honest
cases so the fix could not buy the distinction by breaking them.

```
✖ a veteran whose career source THREW is not described as having no NFL record
  AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly unequal to:

  'unproven'
      at TestContext.<anonymous> (test/trade-engine-evidence-fault.test.js:62:10)
```

### RED round 2 — the failing assertion, verbatim

```
✖ a partly unreadable package reports the shortfall, not the readable half as the whole
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression
  /top-24 seasons for \d+ of \d+, \d+ records? could not be read/. Input:

  'give: 5/5 top-24 seasons, ±5% swing, 17 g min · get: 1 record could not be read'
      at TestContext.<anonymous> (test/trade-evidence.test.js:276:12)
```

### GREEN — what changed

- `playerEvidence()` (`:915`) records `evidence_unreadable: ['career' |
  'preseason' | 'offseason']` for the layers that threw. The fields stay
  absent, so pricing degrades exactly as before; only the lost distinction is
  restored.
- `playerRiskProfile()` (`:945`) returns `profile: 'unknown'` when the career
  layer is unreadable, checked before the `!seasons` branch.
- `describeProfile()` (`:962-964`) → "a player whose record could not be read".
- `packageNumbers()` (`:1007-1019`) → "1 record could not be read" for a wholly
  unreadable package, and, for a partly readable one, "3/15 top-24 seasons for
  1 of 2, 1 record could not be read".
- `packageRisk()` (`:975-981`) carries `unreadable` and a comment saying why it
  is load-bearing rather than cosmetic.

### RED round 3 — the failing assertion, verbatim

```
✖ R1: the Floor cell does not call an unreadable package "no record"
  AssertionError [ERR_ASSERTION]: floorOf never looks at PackageRisk.unreadable,
  so a failed career query still reads as a finding
      at TestContext.<anonymous> (test/trade-risk-strip-unreadable.test.js:31:10)
```

**Server:** 11 of 19 cases fail against the pre-fix implementation; 19/19 pass
with it. **Client:** 5 of 5 fail against the untouched client; 5/5 pass with
the fix. 44/44 across the four affected test files together.

---

## The four user-visible surfaces, and where each is pinned

**This section said "three" and ended "Nothing is left uncovered." That was
wrong, and the audit caught it.** Three of the four are in `trade-engine.js`;
the fourth is on the trade card itself, in `RiskStrip.tsx`, and it makes the
same claim one layer higher up. The sentence is corrected below rather than
quietly deleted, because "I checked and found nothing" is itself a claim this
unit is about making honestly.


`playerEvidence` feeds `slim()` (`:1213`), so every outgoing player object
carries the flag; three places turn it into a sentence a user reads.

1. **`describeProfile` at `:962`**, reached through `headline_read` at `:1001`
   and `sideRisk`'s "trading X for Y" line. Pinned by
   `trade-engine-evidence-fault.test.js`: *"a veteran whose career source THREW
   is not described as having no NFL record"*, and by the pair test, which
   asserts both readings in one breath so neither can drift alone —
   **thrown → `unknown`, "could not be read"; null → `unproven`, "a player with
   no NFL record"**. The rookie sentence is not collateral damage of the fix;
   it is still asserted to be exactly what it was.
2. **`packageNumbers` at `:1007`**, reached through `verdict_evidence` at
   `:1039-1040`. Pinned end to end through `findTrades` in
   `trade-evidence.test.js`: *"the verdict evidence line states an unreadable
   record instead of '0 seasons on record'"*.
3. **`packageRisk`'s `withRecord = seasons > 0` filter at `:985`**, which drops
   an unknown player from the season/top-24/top-12 sums. Pinned twice: at the
   data level (*"an unreadable record in a package is counted, not silently
   dropped from the sums"* — `unreadable: 1` while `seasons` stays 5), and at
   the text level end to end (*"a partly unreadable package reports the
   shortfall, not the readable half as the whole"*, half the league's careers
   throwing so both sides of a deal are mixed).

4. **`RiskStrip`'s Floor cell**, `client/src/components/trade/RiskStrip.tsx:5-6`,
   reached from `deal.me.risk` (`sideRisk`, `trade-engine.js:1125`) through
   `TradeCard.tsx`. It renders `PackageRisk` directly and read `seasons === 0`
   as a fact, exactly as `playerRiskProfile` did:

   ```tsx
   const floorOf = (r: PackageRisk) => r.players.length === 0 ? '—'
     : r.seasons ? `${r.top24_seasons}/${r.seasons} top-24` : 'no record';
   ```

   Three faults, not one. A side whose careers all threw reads **"no record"**.
   A mixed package prints the readable man's seasons as the package's, because
   `seasons` is summed over `withRecord`. And `floorBetter` (`:31-32`) divides
   those two partial sums against each other and colours the cell green or red
   off the result. A fourth, found while fixing it: with career *and* preseason
   both failing, `seasons` is 0 and `p80` is null on both sides, so `anyRecord`
   is false and the **entire strip returns null** — the failure rendered as
   nothing at all, which is the same silent-default shape one more time.

   Now: `'not readable'` for a wholly unread package, `3/15 top-24 (1/2)` for a
   mixed one, no colour on the Floor comparison unless both sides were fully
   read, a `title` that says so, and `anyRecord` counting an unreadable side so
   the strip still renders. `client/src/components/trade/types.ts` carries
   `unreadable: number` on `PackageRisk` and `'unknown'` in the profile union.

   Pinned by `test/trade-risk-strip-unreadable.test.js`, five source-read cases
   in the idiom this repo already uses for `RiskStrip` and `ManagerRead`
   (`test/trade-manager-read.test.js:42`); 5/5 fail against the untouched
   client. The first draft of R2 matched `players.length` anywhere inside
   `floorOf`, which the pre-fix one-liner satisfies through its empty-package
   guard — a trivially green assertion, caught by re-running RED against the
   untouched client after the regex was relaxed. Same lesson as the
   cache-liveness check below: an assertion the defect itself can satisfy is
   not an assertion.

The `preseason` and `offseason` layers record their faults too, but no surface
turns either into a claim, so nothing downstream of them changed and there is
nothing to pin.

---

## The safety half, at full strength

The property the old degrade test existed to protect is asserted **harder**,
not looser, and with a layer that THREW rather than one that returned null:

- `ppg_delta`, `value_delta`, `score` and `verdict` are `deepEqual` between a
  search with null sources and one with a throwing source.
- `'career' in p`, `'preseason' in p`, `'offseason' in p` are all still `false`
  — a failed layer adds no data field.

The two halves are split into two tests on purpose. The decision half must be
byte-identical; the text half is *allowed* to move, because saying "this record
could not be read" is the entire point.

### A hole in the fixtures, found while doing it

`findTrades`' cache is fingerprinted on `manager_profiles`' row **count** and
`MAX(updated_at)` (`tradeIdeasFingerprint`, `:1478`; `fingerprint()` in
`compute-cache.js:48-68` reads exactly those two). The existing fixture idiom
upserts `tradeability` alone, which moves **neither** — so a second
`findTrades` in the same test silently returns the first one's deal objects.
Two of the tests above passed against unfixed code that way before this was
caught.

Replaced by `reSearch()`, which writes a strictly newer `updated_at` on the
same row at the unchanged `'fair'` default tier — the cheapest real change that
leaves every valuation input and the engine's own filtering alone. The
end-to-end test additionally asserts **reference inequality** of the two result
objects, which is the one liveness check the fix itself cannot satisfy: a text
comparison would have been satisfied by the bug's own symptom.

---

## The cache: a transient fault is sticky

Stated because it is a real consequence and not obvious. `playerEvidence`
memoises per player id (`:897`, `:916-917`), and the memo now holds the
faulted result too. So a **transient** throw is sticky: that player reads
"record could not be read" until the cache turns over —
`buildAssetUniverse()` clears it on a data change (`:272`),
`_setEvidenceSources()` clears it (`:837`), and it self-clears past 5000
entries (`:916`).

The same is true one level up, and for the same reason: `findTrades()`'s own
result cache stores the assembled deals, faulted evidence and all, and turns
over on that same data-change trigger — so a transient fault is sticky on the
trade card too, not only inside `playerEvidence`.

The cache is kept because `evaluate()` runs thousands of times inside
`findTrades()` and an always-throwing source would otherwise be re-invoked on
every one of them. The Auditor's recommendation — do not cache a result
containing a thrown layer — is not taken in this unit and is not blocking; it
would trade the sticky read for an unbounded re-invocation on the failure path,
and deserves its own measurement rather than a change made in passing. The
behaviour is pinned by *"a faulted evidence read is memoised like any other, so
the fault is sticky"*, which asserts the throwing source is called **once**.

---

## One existing test was changed, deliberately

**`test/trade-evidence.test.js:173`**, under the title:

> `'a null source leaves its field absent; a throwing source is swallowed; a neutral offseason read is dropped'`

asserted:

```js
assert.deepEqual(playerEvidence(1), {});
```

That assertion pinned **the swallow itself** — the behaviour CLAUDE.md §2
forbids in as many words (*"No bare `catch {}` that swallows a fault... If a
layer goes inert, the surface must say so"*), and the behaviour measured in the
table above to state a falsehood about a real player. Per CLAUDE.md's *"fix the
implementation, not the test, **unless the test is wrong**"*, it was wrong.

The change is narrow. The title's middle clause became "a throwing source is
**recorded**", and the assertion became:

```js
assert.deepEqual(playerEvidence(1), { evidence_unreadable: ['preseason'] });
assert.equal('preseason' in playerEvidence(1), false);
```

The property that test exists to protect is untouched and still asserted: a
failed layer never moves ppg, value, score or verdict, and never adds its own
data field. Only the "and nobody is told" half changed.

---

## Merge gate (v2)

### 1. One guard run on one tree

`bash /mnt/project-files/verify2x-v4.sh <head>` — source-isolated detached
worktree, `node_modules` hard-linked from the primary tree, primary repo clean
and its write-tree unchanged either side. RUN 2 killed per verify-once.

| step | result |
|---|---|
| `git status --porcelain` before | empty |
| `npm ci` | **not re-run**, and the reason is checkable: `package-lock.json` last changed on `017a38c` (2026-09-19), and this branch's diff against `main` touches neither `package.json` nor `package-lock.json` |
| `npm run check` | **exit 0** — `# tests 3571  # pass 3530  # fail 0  # skipped 41` |
| worktree status after | 0 paths |
| write-tree after | equal to before; nothing outside `client/dist` changed |

`npm run check` now contains the wiring check (#129 folded it in), so one
command covers both gates. The figure above was measured on the pre-rebase head
`5b8a345`; this branch has since been rebased onto `main` at `6e72271` and
re-run, and the head's own figure is recorded in the PR body.

### 2. TDD record with a liveness proof

RED, GREEN and an evidence file per round; every sha below is an ancestor of the
head. Three behaviour changes, three liveness proofs — each RED quoted verbatim
above fails against the unfixed code, which is what a liveness proof is.

**Mutation sweep**, run in an isolated worktree, 10 mutants plus two designed
controls. Unit mutants and one call-site mutant, per §2.

| id | target | expected | got |
|---|---|---|---|
| M1 | `playerEvidence` stops recording which layer threw | killed | **killed** (10 fail) |
| M2 | `playerRiskProfile` loses the `unknown` branch | killed | **killed** (6 fail) |
| M3 | `describeProfile` conflates unknown back into the rookie sentence | killed | **killed** (2 fail) |
| M4 | `packageNumbers` drops the partial-package branch | killed | **killed** (1 fail) |
| M5 | `packageRisk` always reports nothing unreadable | killed | **killed** (3 fail) |
| M6 | `floorOf` calls an unread package "no record" again | killed | **SURVIVED → fixed → killed** |
| M7 | the Floor colour guard is always satisfied | killed | **killed** (1 fail) |
| M8 | `anyRecord` stops counting an unreadable side | killed | **killed** (1 fail) |
| M9 | *call site:* `verdictEvidence` passes the WRONG package to `packageNumbers` | killed | **killed** (1 fail) |
| M10 | *call site:* the Floor cell is handed no colour (`sign(floorBetter)` → `null`) | survived | **survived** — standing row |
| C1 | **designed survivor:** a comment-only edit | survived | **survived** |
| C2 | **designed not-applied:** an anchor that exists nowhere | not applied | **not applied** (matched 0 times) |

**M6 survived, and that is the most useful line in this document.** Reverting
`floorOf`'s unread branch — so an unreadable package reads "no record" again —
left all 44 tests passing. R1 and R2 asserted that the *source* mentioned
`unreadable` and `'no record'` near each other and that some template carried
`players.length`; after the revert `unread` is still computed for the
mixed-package branch, so every token those assertions looked for was still
present while the cell printed the falsehood again. The assertions could not
tell the fix from the defect.

Fixed by running the function rather than tightening the regex (commit
`d84dfb0`). `floorOf` is plain JavaScript once its single type annotation is
stripped, and this suite has no TSX transform (see
`test/trade-manager-read.test.js`), so R1 and R2 extract the declaration and
evaluate it against `PackageRisk` fixtures: all-unreadable → `'not readable'`,
genuine no-record → `'no record'`, mixed → `'5/5 top-24 (1/2)'` and explicitly
**not** `'5/5 top-24'`, empty → `'—'`. If the extraction stops matching it
asserts false rather than skipping. M6 is killed on the re-sweep.

M10 is recorded as a standing survivor rather than silently dropped: the tests
pin how the Floor colour guard is *derived*, not the argument the JSX hands the
cell. Killing it needs a render harness this suite does not have.

### 3. Claims

- Every figure above names the tree it was measured on.
- `nfl_injuries` is the table read by `availabilityPicture`
  (`server/services/football-context.js`) — **not** `player_week_snaps` or
  `nfl_snaps`, which are different tables with near-identical names.
- No statistical claim is made: nothing here is a model, a projection or a
  fitted number. `evidence_unreadable` is a fact about whether a call threw.
- The absence is named from a field, not a sentence: `evidence_unreadable`
  distinguishes *unreadable* from *absent*, and `packageRisk.unreadable`
  distinguishes *partial* from *complete*. That distinction is the whole change.
- No figure withdrawn by an auditor is quoted here.

### 4. Nick's five questions

Answered in full below, plus the four one-liners §4 requires:

- **Defect fixed, `file:line` on the tree it was measured on:** a thrown career
  source reached `describeProfile` (`server/services/trade-engine.js:962`),
  `packageNumbers` (`:1007`), `packageRisk`'s `withRecord` filter (`:985`) and
  `client/src/components/trade/RiskStrip.tsx:5-6`, each of which stated the
  absence as a fact about the player.
- **The incumbent, by command:** `git show 6e72271:server/services/trade-engine.js`
  and `git show 6e72271:client/src/components/trade/RiskStrip.tsx` — on `main`
  today, a thrown career still prints "a player with no NFL record" and
  "no record".
- **What this does NOT cover:** the `preseason` and `offseason` layers record
  their faults but no surface turns either into a claim, so neither is pinned;
  the `Ceiling` and `Consistency` cells are untouched and still render `'—'`
  or `'n/a'` for a missing read; and the memoised fault stays sticky until the
  cache turns over (below). No pricing number changes.
- **What would make it wrong:** if a future caller reads
  `profile === 'unknown'` as a weak `'unproven'` rather than as "not known",
  the distinction this adds would be re-conflated one level up. The union in
  `client/src/components/trade/types.ts` now carries `'unknown'` explicitly so
  that a reader has to handle it.

## Five questions

1. **Well built?** Yes — the fault is recorded at the one place it was being
   destroyed, and every consumer of the distinction reads it from there. No new
   data, no new query, no pricing change, no new module surface.
2. **Stats or made up?** Not a model change. `evidence_unreadable` is a fact
   about whether a call threw.
3. **How we know:** the three-row table above, measured through the public API
   before any code changed; then 11/19 failing against the pre-fix
   implementation and 19/19 passing with it, 5/5 on the client failing against
   the untouched `RiskStrip.tsx` and passing with the fix, plus the five existing test files
   that touch these symbols (`trade-evidence`, `model-integrity`,
   `betting-fantasy-link`, `lineup-evidence`, `nfl-execution-edge`) green.
4. **Pointed anywhere else?** Every outgoing player object carries the flag, so
   any future reader of `profile === 'unproven'` now has a distinct state
   available rather than a conflated one. The fixture hole found here is the
   larger carry-over: the `manager_profiles` cache-bust idiom appears in this
   file and is worth checking wherever else a test runs two searches and
   compares them.
5. **How it unifies:** third instance this session of the same discipline —
   state the absence rather than guess through it (`offense_pct` measured and
   left alone, `football-context.js:93` traced and found inert,
   `availabilityPicture` fixed in #115). This is the same fix as #115 one layer
   deeper: there an empty table read as "healthy", here a thrown query reads as
   "never played".
