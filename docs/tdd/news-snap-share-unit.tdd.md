# news-snap-share-unit — TDD report

`snap_share` now means one thing on every surface, and a share this layer
cannot read says so instead of being coerced into a plausible one.

## The five questions

**Is it well built?** The unit is declared once, in one function, with the
reason written beside it. Before, it was decided per row by a ternary.

**Is this based on stats, or is it made up?** The unit is not a judgement call
and is not inferred from the data's shape, which is what the old guard did.
`player_week_snaps.offense_pct` is written straight from nflverse's
`snap_counts_<season>.csv` with no arithmetic on the way in
(`server/services/nflverse.js:283`), and this repository's own reference
documents it: `docs/reference/fantasy/OFFSEASON_DATA.md:117` defines
`prior_snap_share` as the mean weekly `offense_pct`, and
`docs/reference/fantasy/OFFSEASON_MODEL.md:420` grades it at thresholds of
`≥0.71` and `≤0.43`. Those are fractions.

**How do we know?** A RED commit with seven failing tests (`f7e22aa`), then
this one. The tests run the real `newsFantasyTracker` against a real database
and a real migration run, reading the served payload — not the source text,
except for the card, which `node:test` cannot import. Nine mutations, each
with the file's SHA-256 before and after and the exact text of the edit; three
controls the runner refused.

**Should this data be pointed anywhere else on the platform?** It already is,
and that is the finding. Six other services serve this same quantity, all as a
fraction: `contingency.js:351` (averaged into a `share`),
`role-scenario-engine.js:480` (ratio bars applied to that share),
`nfl-postgame-truth.js:289` (`offense_snap_share`, untouched),
`who-plays.js:79` (rounded to four decimals), `role-changepoint.js:39` (three),
`nfl-player-value.js:91`. News was the seventh and the only one in percent.

**How does it unify?** By deleting the exception. One stat, one name, one unit,
and the conversion to a percentage happens once, at the display boundary, where
a reader can see it happening.

## 1. What was actually wrong, stated exactly

```js
snap_share: actual?.offense_pct == null ? null
  : round(Number(actual.offense_pct) * (Number(actual.offense_pct) <= 1 ? 100 : 1))
```

**For every value the column legally holds, this arithmetic is right.** 0.85
becomes 85, the card prints "85% snaps", and the reader is correctly informed.
This is not a bug report about a number on screen, and writing it up as one
would be the overstatement the five questions exist to catch.

What is wrong is two things that do not show up as a wrong figure:

1. **One stat name, two units.** A consumer reading `snap_share` off the news
   card gets 85 where the same field from `who-plays` gives 0.85. That is the
   normalised-name rule broken at exactly one site, and the kind of thing that
   is only ever found by someone joining the two.

2. **The row decides its own unit, so a unit error upstream is
   unfalsifiable.** If a row ever stored `85` meaning 85%, the second arm
   passes it through untouched, the card prints "85% snaps", and the output is
   the right answer *by accident* — indistinguishable from a measured 0.85.
   A silent rescue of bad data is the shape of fault this repository has
   shipped twice; CLAUDE.md's rule is that a layer which cannot do its job has
   to say so.

### One input where the figure on screen was simply wrong

Writing U5 turned this up rather than assuming it. A negative `offense_pct`
takes the *first* arm — `-0.2 <= 1` — and is multiplied by 100, so the card
printed **"-20% snaps"**. A share below zero is not a value this column should
ever hold, which is the point: the guard's job was to catch exactly that, and
instead it scaled it up and shipped it.

## 2. The fix

```js
function snapShare(offensePct) {
  if (offensePct == null) return { snap_share: null, snap_share_unreadable: false };
  const share = Number(offensePct);
  if (!Number.isFinite(share) || share < 0 || share > 1) {
    return { snap_share: null, snap_share_unreadable: true };
  }
  return { snap_share: round(share, 3), snap_share_unreadable: false };
}
```

Three decisions, each with a test that fails without it:

- **Three decimals** (U3). The module's default `round()` is one, which
  flattens a 1% snap share to zero. `role-changepoint.js:39` already serves
  this quantity at three.
- **Two failure states, not one** (U6). "Never measured" and "measured, and I
  cannot read what was stored" are different answers, and a card that leaves the
  clause off entirely reads as "he took no snaps".
- **A closed range, both ends** (U4, U5). Mutations 4 and 5 drop one end each;
  each leaves the other test passing, which is why both ends are asserted
  separately rather than in one alternation.

The card converts:

```tsx
if (actual.snap_share != null) parts.push(`${Math.round(actual.snap_share * 100)}% snaps`);
else if (actual.snap_share_unreadable) parts.push('snap share unreadable');
```

Nothing a reader sees changes for a healthy row — "85% snaps" before and after.

## 3. RED

`f7e22aa`, with only `test/news-snap-share-unit.test.js` added: **7 tests, 0
pass, 7 fail**, each for the reason it states.

| Test | Expected | Got at `557d9f6` |
|---|---|---|
| U1 | `0.85` | `85` |
| U2 | `1` | `100` |
| U3 | `0.01` | `1` |
| U4 | `null` + a reason | `85` |
| U5 | `null` + a reason | `-20` |
| U6 | absent ≠ unreadable | no such distinction |
| U7 | the card converts and can say "unreadable" | it did neither |

## 4. The mutations

Run at `f7e22aa` with this commit's code in the working tree. APPLIED is
decided by `count(old) == 1`; SHA-256 recorded before the edit, after it, and
after the restore. Re-derive with:

```
python3 docs/tdd/sweeps/mutation-runner.py \
  docs/tdd/sweeps/news-snap-share-unit.mutations.json /tmp/out.json
```

| # | Mutation | File | SHA-256 before → after | Aimed at | Fails | Killed by | Kind |
|---|---|---|---|---|---|---|---|
| 1 | N1 the fraction is rounded at the module default of one decimal | `server/services/news-fantasy-impact.js` | `096a71aae864` → `f04dc73bc03a` | U3 | 2 | `U1`<br>`U3` | mutation |
| 2 | N2 the served share goes back to being a percentage | `server/services/news-fantasy-impact.js` | `096a71aae864` → `364de220657a` | U1 | 3 | `U1`<br>`U2`<br>`U3` | mutation |
| 3 | N3 a full snap count falls outside the readable range | `server/services/news-fantasy-impact.js` | `096a71aae864` → `93e100498af7` | U2 | 1 | `U2` | mutation |
| 4 | N4 the upper bound is dropped, so a percent-scaled row passes through | `server/services/news-fantasy-impact.js` | `096a71aae864` → `d05cf8b6e9f9` | U4 | 1 | `U4` | mutation |
| 5 | N5 the lower bound is dropped, so a negative share passes through | `server/services/news-fantasy-impact.js` | `096a71aae864` → `84a1b4989a4d` | U5 | 1 | `U5` | mutation |
| 6 | N6 an absent measurement is reported as an unreadable one | `server/services/news-fantasy-impact.js` | `096a71aae864` → `ba28108799b1` | U6 | 1 | `U6` | mutation |
| 7 | N7 a refused value is refused without saying so | `server/services/news-fantasy-impact.js` | `096a71aae864` → `48a9a44720f0` | U4 | 2 | `U4`<br>`U5` | mutation |
| 8 | N8 the card stops converting the fraction it is handed | `client/src/pages/News.tsx` | `1fe99f5d884b` → `52f5cf1ba223` | U7 | 1 | `U7` | mutation |
| 9 | N9 the card drops the unreadable clause | `client/src/pages/News.tsx` | `1fe99f5d884b` → `1f5b7d6d71b5` | U7 | 1 | `U7` | mutation |
| 10 | CONTROL A (no-op): a pattern that is not in this file | `server/services/news-fantasy-impact.js` | `096a71aae864` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 11 | CONTROL B (no-op): a pattern from a different feature entirely | `client/src/pages/News.tsx` | `1fe99f5d884b` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 12 | CONTROL C (anchor x2): a pattern present twice, which the runner refuses | `server/services/news-fantasy-impact.js` | `096a71aae864` → unchanged | none | — | **NOT APPLIED — anchor x2** | anchor control |

Restored to the before-hash after every row: yes, all 9 applied rows.

### The exact text of each edit

**1. N1 the fraction is rounded at the module default of one decimal**

```diff
-  return { snap_share: round(share, 3), snap_share_unreadable: false };
+  return { snap_share: round(share), snap_share_unreadable: false };
```

**2. N2 the served share goes back to being a percentage**

```diff
-  return { snap_share: round(share, 3), snap_share_unreadable: false };
+  return { snap_share: round(share * 100, 3), snap_share_unreadable: false };
```

**3. N3 a full snap count falls outside the readable range**

```diff
-  if (!Number.isFinite(share) || share < 0 || share > 1) {
+  if (!Number.isFinite(share) || share < 0 || share >= 1) {
```

**4. N4 the upper bound is dropped, so a percent-scaled row passes through**

```diff
-  if (!Number.isFinite(share) || share < 0 || share > 1) {
+  if (!Number.isFinite(share) || share < 0) {
```

**5. N5 the lower bound is dropped, so a negative share passes through**

```diff
-  if (!Number.isFinite(share) || share < 0 || share > 1) {
+  if (!Number.isFinite(share) || share > 1) {
```

**6. N6 an absent measurement is reported as an unreadable one**

```diff
-  if (offensePct == null) return { snap_share: null, snap_share_unreadable: false };
+  if (offensePct == null) return { snap_share: null, snap_share_unreadable: true };
```

**7. N7 a refused value is refused without saying so**

```diff
-    return { snap_share: null, snap_share_unreadable: true };
+    return { snap_share: null, snap_share_unreadable: false };
```

**8. N8 the card stops converting the fraction it is handed**

```diff
-  if (actual.snap_share != null) parts.push(`${Math.round(actual.snap_share * 100)}% snaps`);
+  if (actual.snap_share != null) parts.push(`${actual.snap_share}% snaps`);
```

**9. N9 the card drops the unreadable clause**

```diff
-  else if (actual.snap_share_unreadable) parts.push('snap share unreadable');
```

**10. CONTROL A (no-op): a pattern that is not in this file**  — searched for, not found (anchor x0)

```diff
-function snapSharePercent(
+function snapSharePct(
```

**11. CONTROL B (no-op): a pattern from a different feature entirely**  — searched for, not found (anchor x0)

```diff
-const FAIRNESS_TONE
+const FAIRNESS_TONE_X
```

**12. CONTROL C (anchor x2): a pattern present twice, which the runner refuses**  — searched for, not found (anchor x2)

```diff
-snap_share: null
```

## 5. Every test has a killing row

| Test | Killed by |
|---|---|
| U1: a stored 0.85 is served as the fraction 0.85 | 1, 2 |
| U2: every snap played is 1, not 100 | 2, 3 |
| U3: one snap in a hundred survives the rounding | 1, 2 |
| U4: a value outside [0, 1] is refused with a reason | 4, 7 |
| U5: a negative share is refused the same way | 5, 7 |
| U6: never measured and cannot be read are different answers | 6 |
| U7: the card does the formatting, and says so when it cannot | 8, 9 |

Seven of seven. No applied mutation survived, and no test is red for nothing.

Two rows reach past what they aimed at, and are recorded rather than trimmed:
mutation 1 was aimed at U3 and also kills U1 (one decimal turns 0.85 into 0.9),
and mutation 7 was aimed at U4 and also kills U5, since both refused values take
the same return. Mutation 2 kills three, which is what changing the unit does.

## 6. What these tests cannot see

U1–U6 read the served payload from the real module against a real database, so
they see what a caller sees. U7 reads `News.tsx` as text, because `node:test`
has no build step and cannot import `.tsx`; it pins that the card multiplies and
that it carries the unreadable clause, not that either renders.

Nothing here checks the column's unit *at the source*. It is established from
`nflverse.js:283` doing no arithmetic on the CSV value, from the six other
readers treating it as a fraction, and from this repository's own reference
documentation grading it at `≥0.71` / `≤0.43`. That is a strong reading, but it
is a reading of code and documents, not a measurement of the live table — and
the live table is exactly where a unit error would sit. **That is why the range
check exists**: if the premise is ever wrong for some rows, those rows now
arrive as "snap share unreadable" rather than as a confident number.

## 7. Full check

`npm run check` measured at **12:39:35Z–12:45Z on the tree of `f7e22aa` (the
RED commit) plus this commit's code**, with no documentation in it:

| Step | Result |
|---|---|
| typecheck | clean |
| lint | 908 JavaScript files syntax-checked |
| test | **3,203 tests, 3,162 pass, 0 fail, 41 skipped** |
| build | `✓ built in 2.65s` |
| start:smoke | passed on an isolated database (32 teams) |

`557d9f6` measured 3,196 / 3,155 / 0 / 41. The seven added tests are the seven
in `test/news-snap-share-unit.test.js`; nothing else moved, and the seven that
were red at `f7e22aa` are green here.

The documentation in this commit was written after that run and cannot have
affected it:

```
git diff --name-only f7e22aa HEAD | grep -E '^docs/design/design-system\.md$|^docs/CLAUDE-NEXT-STEPS\.md$'
```

Nothing printed. Those two paths are the only `docs/` files any part of
`npm run check` opens at runtime; `docs/tdd/` is read by nothing.

Source restored after the mutation run and verified with `git status` and the
runner's own after-restore hash.
