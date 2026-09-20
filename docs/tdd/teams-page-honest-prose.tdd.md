# The teams page: prose labelled as prose — TDD evidence

Retroactive RED by mutation, the shape set by `docs/tdd/week2-numbers.tdd.md`.

## What the complaint actually was

Nick: "the page with the teams is so fucked lol. No model stuff but the
descriptions etc fucked."

The first half turned out to be wrong, and finding that out is most of this
change. There **is** model content on that page:
`server/services/nfl-team-tendencies.js` computes a "Measured identity" block
from thousands of team-weeks of play-by-play, every number a percentile against
the other 31 teams in the same season, served at `/teams/:abbr/tendencies` and
rendered by `TeamDetail.tsx`. It is good, and it was already there.

The second half is real. The scheme note and the coach outlook are prose
somebody typed — `server/db/seed/teams.js` says so in its own header,
"Schemes/analyses are editorial seed content" — and they sat directly beneath
the measured block in **identical cards at identical weight**. A sentence
written before the season read as authoritatively as a percentile computed from
play-by-play. Thirteen values in that file are still placeholders, several
reading `TBD (camp)`, and camp is over.

## What was NOT done, and why it matters more than what was

**The prose was not rewritten.** Who each team's actual offensive or defensive
coordinator is cannot be answered from anything in this repository. Filling those
in would replace a visible placeholder with an invisible invention, which is
strictly worse: "TBD (camp)" at least tells the reader the page does not know.

**No date was invented.** `nfl_teams` has no `updated_at` column
(`core-and-fantasy.js:62-84`) and the edit route at `routes/teams.js:103-112`
writes none, so nothing in the system knows when any of this text was written or
last edited. The label says it is undated rather than saying "as of preseason
2026", which would be a guess presented as provenance — the exact failure the
basis vocabulary exists to prevent. A test pins that: if a timestamp column is
ever added, that test fails and tells whoever added it to show the real date.

## What was done

1. A coaching slot whose stored value still matches `/\bTBD\b/i` renders as an
   absence rather than as a name. The head coach, which always renders, says
   "not recorded" — a blank where a name belongs reads as a layout bug, not as a
   fact.
2. Both hand-written cards carry an `assumed` chip with one shared note saying
   the text is hand-written, undated, and outranked by the measured block above
   it when the two disagree. That last clause is not new policy: the
   `Tendencies` component's own header already said "when the two disagree, the
   measurement is the one to trust". The page simply never told the reader.

## The mutations

Control after restoring: **5 pass, 0 fail**.

| # | Mutation | Result |
|---|---|---|
| t1 | Remove the placeholder guard from the head coach | **4 pass, 1 fail** |
| t2 | Label one prose card instead of both | **4 pass, 1 fail** |
| t3 | Make the note claim "as of the 2026 preseason" | **4 pass, 1 fail** |
| t4 | Move the prose above the measured identity block | **4 pass, 1 fail** |

t3 is the one worth keeping. It is the tempting change — a date makes the label
look more rigorous — and it is the dishonest one, because the date would be made
up. t4 guards an ordering that carries the whole argument: a page that leads with
the sentence and follows with the evidence has inverted which one it trusts.

## Honest limit

`node:test`, no DOM, source text only. Also: `/\bTBD\b/i` catches the thirteen
placeholders that exist today. A future placeholder phrased differently ("to be
named", "vacant") would pass straight through, and there is no way to detect
that generally — a test asserts at least one `TBD` still exists in the seed, so
if the seed is ever cleaned up, that test says so rather than the guard silently
protecting against nothing.

## Commands

```
GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr-XXXXXX).sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/teams-page-honest-prose.test.js
```

---

## Mutation run at the stack tip

Re-run against **one tree**, the tip of this stack at `af7f01a`, so every row
below is measured on the same code rather than on the tree each commit had when
it was written. Each entry records the mutated file's SHA-256 before and after,
which is what proves the mutation was APPLIED: a pattern that does not match
leaves the file unchanged, and the run is then the baseline wearing a
mutation's name. Each entry names the **test title** that turned red, not the
rule it was meant to check — a mutation that lands and kills a different test is
unfinished, not a result. And each quotes the **exact before and after text**,
not a description of the edit, so the mutation can be reproduced from this file
rather than taken on trust.

Files mutated: `client/src/pages/TeamDetail.tsx`, `server/db/schema/core-and-fantasy.js`, `server/db/seed/teams.js`.

**T1 the placeholder pattern stops matching TBD** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `de82b711270c` — **RED**, 1 failing · killed by *a coaching slot that still says TBD renders as an absence, not as a name*

```diff
-const PLACEHOLDER = /\bTBD\b/i
+const PLACEHOLDER = /\bNEVERMATCHXYZ\b/i
```

**T1 a coordinator slot renders without the guard** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `6a2ffcd8a7d6` — **RED**, 1 failing · killed by *a coaching slot that still says TBD renders as an absence, not as a name*

```diff
-coachName(team.oc_name)
+team.oc_name
```

**T1 an unrecorded head coach renders as nothing at all** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `4604b2595c0a` — **RED**, 1 failing · killed by *a coaching slot that still says TBD renders as an absence, not as a name*

```diff
-coachName(team.head_coach) ?? 'not recorded'
+coachName(team.head_coach)
```

**T2 the seed stops stating that its analyses are editorial** (`server/db/seed/teams.js`) — APPLIED `9dab8e677c45` → `90e1adda2a6c` — **RED**, 1 failing · killed by *the placeholders this guards against are really in the data*

```diff
-editorial seed content
+reference content
```

**T3 only one of the two prose cards is labelled** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `3f56128db1ca` — **RED**, 1 failing · killed by *the prose says it is prose, beside the measurement that outranks it*

```diff
-<BasisChip basis="assumed" note={SEED_NOTE} />
+<BasisChip basis="assumed" />
```

**T4 nfl_teams grows a timestamp the page does not show** (`server/db/schema/core-and-fantasy.js`) — APPLIED `f8d12d1a4cd5` → `38a3ecdf492d` — **RED**, 1 failing · killed by *the label does not invent a date the app does not have*

```diff
-  CREATE TABLE IF NOT EXISTS players (
+  -- updated_at
+  CREATE TABLE IF NOT EXISTS players (
```

**T4 the note stops admitting there is no date** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `59eb3a11ea3a` — **RED**, 1 failing · killed by *the label does not invent a date the app does not have*

```diff
-does not record when
+was recorded at
```

**T5 the measured identity block leaves the page** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `f868f6e74b1d` — **RED**, 1 failing · killed by *the measured block is still above the prose, which is the whole argument*

```diff
-<Tendencies abbr
+<XTendencies abbr
```

**T5 the prose heading renders above the measurement** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `8e423af6bb54` — **RED**, 1 failing · killed by *the measured block is still above the prose, which is the whole argument*

```diff
-        <Tendencies abbr={team.abbr} />
+        {false && 'Coach & Fantasy Outlook'}
+        <Tendencies abbr={team.abbr} />
```

**NO-OP CONTROL: a comment word on the page** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `dead7d651f61` — **green — survived, as intended**

```diff
-className="
+className=" 
```

**NO-OP CONTROL: a timestamp on a LATER table, outside the slice** (`server/db/schema/core-and-fantasy.js`) — APPLIED `f8d12d1a4cd5` → `7c074527f050` — **green — survived, as intended**

```diff
-  CREATE TABLE IF NOT EXISTS ranking_sets (
+  CREATE TABLE IF NOT EXISTS ranking_sets (
+    updated_at TEXT,
```

9 mutations applied and red, 2 applied and green. The green
rows are the deliberate no-op controls — edits that are real (the SHA changes) but
touch nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**One mutation survived the first run, and it was a real hole.** Each
coordinator slot appears twice in `TeamDetail.tsx` — once as the guard that
decides whether the slot renders, once as the name inside it — and the test
matched `coachName(team.oc_name)` anywhere in the file, so replacing the *guard*
with the raw value left the *render* to satisfy the pattern. With a raw guard, a
team whose coordinator is still "TBD (camp)" renders "· OC " followed by
nothing: exactly the empty-space-where-a-name-belongs failure the head-coach
branch of this same test was written to prevent. Both positions are now pinned,
and the occurrence count is what pins them. The row is red above.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database, **measured on commit `6a8df0d`** — the commit this
section lands in, whose parent is `af7f01a`. The source was restored after the
mutation run and verified clean with `git status` rather than assumed clean
because the runner said so.
