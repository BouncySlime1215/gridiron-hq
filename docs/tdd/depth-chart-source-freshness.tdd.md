# depth-chart-source-freshness — TDD report

A depth chart is a listing, not a measurement, and this app holds three of them
that are not interchangeable. The one whose name most invites use is the stale
one.

## Read this before you write `SELECT ... FROM off_depth_chart`

That is the obvious table by name, and on its own it is the wrong one.

| Table | What it is | Timestamp |
|---|---|---|
| `nfl_depth` | a weekly ordering; from 2025 a dated ESPN scrape | `captured`, per row |
| `off_sleeper_players` | a **live snapshot**, current season only, no history at all | `fetched_at` |
| `off_depth_chart` | nflverse `depth_charts_YYYY.csv` — **"Opening-week ordering only"** | `source_dt` |

The third is documented as opening-week ordering in this repository's own
reference (`docs/reference/fantasy/OFFSEASON_DATA.md:54`), and `:78` adds that a
March chart "predates free agency and the draft". So a panel built on it renders
an ordering taken before the roster existed, as though it were this week's.

Coach's stat lexicon already carries the first half of this warning: a
depth-chart rank is a listing, not a measurement, so it can be stale or wrong,
and snap share is what settles an argument between the two. This is that failure
with a second one underneath it — not merely a listing wearing a measurement's
authority, but a listing from the wrong year's roster wearing it.

## The five questions

**Is it well built?** One module, one decision, and the decision is made on the
data's own timestamps rather than on a ranking of the tables that someone would
have to remember.

**Is this based on stats, or is it made up?** It is explicitly neither, and
saying so is the feature. A depth-chart rank is a published listing. The module
carries the measurement — snap share — beside it, so a reader can see when the
two disagree.

**How do we know?** A RED commit (`d4f3a3a`) and this one. Twelve mutations with
per-row SHA-256 before and after and the exact text of each edit; three controls
the runner refused. The RED was module-absent, so every test in the suite needed
its own killing row rather than the interesting ones only — see section 4.

**Should this data be pointed anywhere else on the platform?** Yes, and it is
the reason the accessor is a service and not a query inside a route: the player
page needs the same answer the team page does, and a second query is a second
freshness rule.

**How does it unify?** `snap_share` is a fraction here, as it is in
`who-plays.js`, `nfl-postgame-truth.js`, `role-changepoint.js` and — since the
unit was unified earlier in this stack — the news card. One stat, one unit, one
name.

## 1. The pattern, which matters more than the two cases

Both defects found here are the same shape: **a listing presented as belonging
to a time it does not belong to.**

- **The opening-week chart.** A March ordering served unlabelled as the current
  one. Caught by reading the reference rather than the table name.
- **The live snapshot.** `off_sleeper_players` has no season column, because
  Sleeper publishes one snapshot and no history. The first version of this
  module defaulted `currentSeason` to the season being asked about, which makes
  the snapshot eligible for **any** season — so a request for 2023 would have
  been answered with today's chart. That is the same fault in different clothes,
  and it was introduced by a default that looked harmless.

The rule that falls out, and the thing to carry forward: **a source that cannot
say which point in time it describes may only be used when the caller has
established that point in time independently.** The module now fails closed —
no declared current season, no live snapshot — and D8 pins both that and the
past-season case.

## 2. What the module does

Takes the source that spoke most recently, by its own reported timestamp; says
which one that was and when; marks the opening-week chart as stale whenever it
is what is left; carries each listed player's snap share beside his rank; and
returns a stated reason rather than an empty list when there is no chart.

Two smaller decisions, each with a test:

- **Freshest by timestamp, not by a fixed order of the tables** (D4, asserted in
  both directions so it is a comparison and not a preference). Which source is
  current depends on which last ran, and the one that is usually freshest is not
  always.
- **Null, never zero, for a player with no snap row** (D6). Absent and zero are
  different facts, and zero makes a listed starter look benched.

## 3. The lexicon wrapper, and why it does not read the JSON

`server/services/stat-lexicon.js` wraps `server/services/coach/stat-names.js`.
It holds none of that module's strings; L3 pins that structurally.

It imports the module rather than reading `docs/stat-lexicon.json` because the
JSON is a *printout* of the module, emitted for the client build. A server-side
reader of the emitted file would be a second source of truth whose freshness is
guaranteed only by a check gate — between an edit to the module and the next
emit, it would serve yesterday's explanations beside a catalogue serving
today's. The dynamic import with a fallback is a sequencing accommodation, not a
design: the Coach namespace has not merged yet (#82), and when it does the
fallback becomes dead code rather than a permanently live branch.

**The pinned shape was taken from a read, not from a relay.** The concept entry
is `{ name, unit, better, plain, why, source }`, read out of `stat-names.js` at
commit `f5406ee`, line 30. It was described to this thread as `{ label, unit,
direction, plain, why }` — three names wrong and one field missing. Asserting
the description would have gone red on merge, or worse rendered `entry.label` as
undefined and shown a stat with no name, which does not announce itself. Two
threads independently reading the module is what caught it.

One consequence worth stating for whoever renders this: **`better` has three
values, not two** — `higher`, `lower` and `neither`, and at `f5406ee` the counts
are 24, 6 and 8 of 38. A two-branch arrow would point somewhere on 8 stats where
no direction is good. L5 pins it. `source` is free text (nflverse, Next Gen
Stats, Pro Football Reference, ESPN, ffopportunity, this app), so nothing
switches on it and no test pins the set.

## 4. The mutations

Run at `d4f3a3a` with this commit's code in the working tree. APPLIED is decided
by `count(old) == 1`; SHA-256 recorded before the edit, after it, and after the
restore. Re-derive with:

```
python3 docs/tdd/sweeps/mutation-runner.py \
  docs/tdd/sweeps/depth-chart-source-freshness.mutations.json /tmp/out.json
```

| # | Mutation | File | SHA-256 before → after | Aimed at | Fails | Killed by | Kind |
|---|---|---|---|---|---|---|---|
| 1 | P1 an absent chart is served as an empty one | `server/services/depth-chart.js` | `7d7dff31caf0` → `a06d42902e95` | D1 | 1 | `D1` | mutation |
| 2 | P2 the opening-week chart stops being marked stale | `server/services/depth-chart.js` | `7d7dff31caf0` → `44ed92df61a5` | D2 | 1 | `D2` | mutation |
| 3 | P3 the opening chart forgets when it was taken | `server/services/depth-chart.js` | `7d7dff31caf0` → `177ae160b286` | D2 | 1 | `D2` | mutation |
| 4 | P4 the freshness comparison always returns the same answer | `server/services/depth-chart.js` | `7d7dff31caf0` → `eb38e4227de5` | D4 | 3 | `D2`<br>`D3`<br>`D4` | mutation |
| 5 | P5 the source is taken by table order instead of by timestamp | `server/services/depth-chart.js` | `7d7dff31caf0` → `e275f6ef200a` | D3 | 3 | `D3`<br>`D4`<br>`D8` | mutation |
| 6 | P6 the snap share is served as a percentage | `server/services/depth-chart.js` | `7d7dff31caf0` → `d19154247f18` | D5 | 1 | `D5` | mutation |
| 7 | P7 an unmeasured player is served as zero snaps | `server/services/depth-chart.js` | `7d7dff31caf0` → `66832c491291` | D6 | 1 | `D6` | mutation |
| 8 | P8 every listed player is grouped under one position | `server/services/depth-chart.js` | `7d7dff31caf0` → `b639bb387334` | D7 | 1 | `D7` | mutation |
| 9 | P9 the live snapshot stops failing closed | `server/services/depth-chart.js` | `7d7dff31caf0` → `9015e3829714` | D8 | 1 | `D8` | mutation |
| 10 | P10 the absent catalogue stops saying it is absent | `server/services/stat-lexicon.js` | `1a7ff41d3ec8` → `ed192563fac5` | L1 | 1 | `L1` | mutation |
| 11 | P11 an accessor throws instead of answering while the catalogue is away | `server/services/stat-lexicon.js` | `1a7ff41d3ec8` → `28e3a9ca3ed1` | L2 | 1 | `L2` | mutation |
| 12 | P12 the wrapper grows an explanation of its own | `server/services/stat-lexicon.js` | `1a7ff41d3ec8` → `0f46721316b3` | L3 | 1 | `L3` | mutation |
| 13 | CONTROL A (no-op): a pattern that is not in this file | `server/services/depth-chart.js` | `7d7dff31caf0` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 14 | CONTROL B (no-op): a pattern from a different feature entirely | `server/services/stat-lexicon.js` | `1a7ff41d3ec8` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 15 | CONTROL C (anchor x2): a pattern present twice, which the runner refuses | `server/services/depth-chart.js` | `7d7dff31caf0` → unchanged | none | — | **NOT APPLIED — anchor x5** | anchor control |

Restored to the before-hash after every row: yes, all 12 applied rows.

### The exact text of each edit

**1. P1 an absent chart is served as an empty one**

```diff
-  const empty = { team, season: season ?? null, source: null, captured: null, stale: false,
-    unavailable_reason: 'no_chart_on_file', positions: [] };
+  const empty = { team, season: season ?? null, source: null, captured: null, stale: false,
+    unavailable_reason: null, positions: [] };
```

**2. P2 the opening-week chart stops being marked stale**

```diff
-    name: 'opening_week',
-    stale: true,
+    name: 'opening_week',
+    stale: false,
```

**3. P3 the opening chart forgets when it was taken**

```diff
-SELECT gsis_id, player_name, pos_abb, pos_rank, source_dt AS captured
+SELECT gsis_id, player_name, pos_abb, pos_rank, NULL AS captured
```

**4. P4 the freshness comparison always returns the same answer**

```diff
-const newest = list => list.reduce((max, r) => (r.captured && r.captured > max ? r.captured : max), '');
+const newest = list => '';
```

**5. P5 the source is taken by table order instead of by timestamp**

```diff
-  const chosen = candidates.reduce((best, c) =>
-    (newest(c.list) > newest(best.list) ? c : best));
+  const chosen = candidates[candidates.length - 1];
```

**6. P6 the snap share is served as a percentage**

```diff
-      snap_share: raw == null ? null : Number(raw)
+      snap_share: raw == null ? null : Number(raw) * 100
```

**7. P7 an unmeasured player is served as zero snaps**

```diff
-      snap_share: raw == null ? null : Number(raw)
+      snap_share: Number(raw ?? 0)
```

**8. P8 every listed player is grouped under one position**

```diff
-    const pos = row.pos_abb;
+    const pos = 'WR';
```

**9. P9 the live snapshot stops failing closed**

```diff
-    load: (team, season, _week, currentSeason) => (currentSeason == null || season !== currentSeason ? [] : rows(
+    load: (team, season, _week, currentSeason) => (false ? [] : rows(
```

**10. P10 the absent catalogue stops saying it is absent**

```diff
-  if (!coach) return { ...lexiconStatus(), concepts: {}, fields: {}, not_stored: [] };
+  if (!coach) return { concepts: {}, fields: {}, not_stored: [] };
```

**11. P11 an accessor throws instead of answering while the catalogue is away**

```diff
-  return coach ? coach.describeField(field) : null;
+  return coach.describeField(field);
```

**12. P12 the wrapper grows an explanation of its own**

```diff
-export function lexiconStatus() {
+export const TARGET_SHARE_PLAIN = 'Of every pass his team threw, the fraction thrown at him.';
+export function lexiconStatus() {
```

**13. CONTROL A (no-op): a pattern that is not in this file**  — searched for, not found (anchor x0)

```diff
-function teamDepthChartLegacy(
+function teamDepthChartOld(
```

**14. CONTROL B (no-op): a pattern from a different feature entirely**  — searched for, not found (anchor x0)

```diff
-const FAIRNESS_TONE
+const FAIRNESS_TONE_X
```

**15. CONTROL C (anchor x2): a pattern present twice, which the runner refuses**  — searched for, not found (anchor x5)

```diff
-pos_rank
```

### The row that was NOT APPLIED first, and was fixed rather than kept

P3's anchor was wrong on the first run and the runner reported `anchor x0`. That
is a **gap in the sweep, not a control** — a mutation I intended to apply and
did not — so the anchor was corrected against the real line and the whole sweep
re-run, rather than the row being reclassified as a no-op after the fact. The
table above is the re-run.

This is the case the runner's `count(old) == 1` rule exists for. Under the older
runner, which decided APPLIED by `old in src`, a wrong anchor that happened to
appear elsewhere would have edited the wrong site and reported a kill.

## 5. Every test has a killing row

The RED at `d4f3a3a` was **module-absent**: all seven tests failed on one
`ERR_MODULE_NOT_FOUND`, so none of them is per-test RED evidence. The seventh
part of the evidence standard therefore applies to every test in the suite.

| Test | Killed by |
|---|---|
| D1: an absent chart is reported, not served empty | 1 |
| D2: an opening-week chart is labelled as one | 2, 3, 4 |
| D3: the weekly chart beats the opening-week one | 4, 5 |
| D4: freshest wins on the timestamp | 4, 5 |
| D5: snap share beside the rank, as a fraction | 6 |
| D6: no snap row is null, never zero | 7 |
| D7: grouped by position | 8 |
| D8: the live snapshot fails closed | 5, 9 |
| L1: an absent catalogue is reported, not served empty | 10 |
| L2: accessors answer null rather than throwing | 11 |
| L3: the wrapper carries none of the catalogue's text | 12 |

Eleven of eleven. L4, L5 and L6 are **skipped, not passing**, and the stated
reason is that the Coach namespace is not on this branch; they activate on
merge. A skipped test earns a reason under the seventh part exactly as an
unkilled one does, and that is theirs.

## 6. Two instrument defects, both mine, both caught by the instrument

Recorded because the pattern is the point: a test that cannot fail looks exactly
like a test that passes.

Three instrument defects from this thread today, none of them found by a passing
test, every one surfaced because something failed that should not have. That is
the argument for writing mutations expected to fail loudly rather than quietly,
and it is evidence from practice rather than from principle.

- **L3's string matcher paired the wrong quotes.** `/'([^']{33,})'/` matched
  from one literal's *closing* quote to the next literal's *opening* one and
  reported the code between them as a long string. It failed on first run naming
  the import line, which is how it was found. Newlines are now excluded from the
  class, since a single-quoted JS literal cannot span lines.
- **P3's anchor did not exist**, as above.

## 7. Also in this commit: a dead branch in `title-odds-drill`

`test/title-odds-drill.test.js:97` carried
`/graded on\s*\n?\s*\*?\s*week W alone|graded on week W alone/`. Every quantifier
between the words in the first branch can match empty, so the first branch
already matches the plain form, and it is tried first. The second branch is not
merely unexercised by the current fixtures — it is **unreachable for any input**,
and no fixture present or future can make it the branch that decides.

Verified rather than argued, across four probe strings:

| Probe | branch 1 | branch 2 |
|---|---|---|
| `graded on week W alone` | matches | matches |
| `graded on\n * week W alone` | matches | no |
| `graded on  week W alone` | matches | no |
| `graded on\n*week W alone` | matches | no |

Nothing branch 2 matches is missed by branch 1. Deleted; the suite is 5/5
unchanged, which is the point — removing it changes the test's meaning by
exactly nothing. How it got there is worth keeping: the second branch was a
safety net added when the first looked fragile, and the first was then made
permissive enough to cover it. Harmless in effect, but it reads as though two
shapes are accepted when only one is.

One thing noticed while proving it, and **fixed rather than filed**: branch 1
also matched `graded onweek W alone`, because the first `\s*` can match empty, so
the pattern accepted the two words run together. Leaving a known-loose assertion
in place after naming it is how a named thing becomes a permanent one. The first
group is now `\s+`, which requires at least one separator.

Checked against the real source rather than assumed, since tightening an
assertion can break the thing it asserts: `server/services/weekly-backtest.js:17`
carries the string across a line break (`graded on\n * week W alone`), and the
tightened pattern matches it, matches all four probes above, and rejects only the
run-together form.

| Probe | loose | tight |
|---|---|---|
| the real source at `weekly-backtest.js:17` | matches | matches |
| `graded on week W alone` | matches | matches |
| `graded on\n * week W alone` | matches | matches |
| `graded on  week W alone` | matches | matches |
| `graded onweek W alone` | matches | **no** |

## 8. Full check

`npm run check` measured on the tree of `d4f3a3a` plus this commit's code and
tests, with no documentation in it:

| Step | Result |
|---|---|
| typecheck | clean |
| lint | 913 JavaScript files syntax-checked |
| test | **3,220 tests, 3,176 pass, 0 fail, 44 skipped** |
| build | `✓ built in 2.72s` |
| start:smoke | passed on an isolated database (32 teams) |

`68d621a` measured 3,206 / 3,165 / 0 / 41. The fourteen added are the eight in
`test/depth-chart-source-freshness.test.js` and the six in
`test/stat-lexicon-wrapper.test.js`. **The skipped count moves 41 → 44**, and
those three are L4, L5 and L6 waiting on the Coach namespace — named here so the
rise is not read as three tests quietly going away.

Documentation written after that run, and inert to it:

```
git diff --name-only d4f3a3a HEAD | grep -E '^docs/design/design-system\.md$|^docs/CLAUDE-NEXT-STEPS\.md$'
```

Nothing printed.

Source restored after the mutation run and verified with `git status` and the
runner's own after-restore hash.

## 9. What is not built yet

This commit is the reader and its evidence. The panels that render it — the
depth chart on the team page and the advanced-stats block on the player page —
are not in it, and neither is the route that serves the reader. Nothing in the
app calls `teamDepthChart` yet, which is why the suite total moves and no
existing test does.
