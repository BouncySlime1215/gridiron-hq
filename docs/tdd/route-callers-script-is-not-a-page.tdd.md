# A route whose only caller is a script is not wired

RED `40f6627` · GREEN this commit · `scripts/inventory.mjs`, `test/inventory-route-callers.test.js`

## What was wrong

The inventory decided a route file's status by subtraction: routes registered,
minus routes carrying a `route-no-caller` finding, remainder counted as "with
callers". That reads the absence of a finding as evidence of a consumer.

The wiring map has a second rule for a route that no page calls but a script in
this repository dials over HTTP: `route-called-from-outside-the-app`. A route in
that state is reported by that rule *instead of* the no-caller rule, never as
well as it — the rule body `continue`s before reaching the orphan branch. Those
routes therefore landed in the remainder and were counted as page callers.

Three files came out `wired` on that basis, every route accounted for:

| file | routes | `route-no-caller` | outbound | unexplained |
| --- | --- | --- | --- | --- |
| `server/routes/nfl-betting.js` | 170 | 168 | 2 | 0 |
| `server/routes/stats.js` | 3 | 2 | 1 | 0 |
| `server/routes/tradelab.js` | 5 | 4 | 1 | 0 |

The outbound routes are `POST /api/nfl-betting/roster/rookies/sync`,
`.../college-sync`, `POST /api/stats/sync` and
`POST /api/tradelab/trending/sync`.

## How it was found, and a wrong answer on the way

The model-evidence audit thread graded the same three files `half_done`, with
the evidence "no file under `client/src` requests this prefix at all, reachable
or not". Their reading and this map's `1 with callers` looked like a flat
contradiction, so it was investigated as one.

The first diagnosis was wrong and was reported before it was checked. It read
the rule's *detail* string — "no page or extension calls it, and it is not
cheap" — and concluded the rule skips cheap routes, so silence meant nothing.
That is not what the code does; the string is built from a weight that only
changes the wording. Reading the rule body instead showed the two `continue`
paths, and the real answer: **both threads were right**. They were counting
pages; this was counting callers of any kind. No side had a bug.

What was wrong is the collapse. A route a script syncs and a route a page
renders are not the same kind of alive, and an inventory whose entire purpose
is to say what is really wired cannot spend that distinction one rule after the
map took the trouble to draw it.

## The fix

```js
+    const scriptOnly = findingsFor(p).filter((f) => f.rule === 'route-called-from-outside-the-app').length;
+    const pageCalled = routeCount - noCaller - scriptOnly;
...
+    } else if (pageCalled <= 0) {
+      c = { status: 'half_done', evidence: `... registers ${routeCount} routes and no page calls any of them; ...` };
     } else {
-      c = { status: 'wired', evidence: `... ${routeCount - noCaller} with callers` };
+      c = { status: 'wired', evidence: `... ${pageCalled} called by a page` + (scriptOnly ? ` and ${scriptOnly} dialled only by a script` : '') };
```

`scripts/inventory.mjs` also gains its exports and a main guard. None of this
was reachable from a test before: the script did all its work at module scope,
so importing it read the map, opened the local database and wrote `docs/`.

Effect on the inventory: `wired` 77 → 74, `half_done` 174 → 177, 873 rows
unchanged. Exactly the three files moved. `server/routes/aggregates.js` stays
`wired` on 2 page callers and 1 script caller, which is the correct outcome and
is also the row still in dispute with the model audit on a different axis
(whether a caller outside `App.tsx`'s import closure counts) — left for the
coordinator, not settled here.

## Defect injection

Tree sha256 is the first 16 hex of `sha256sum scripts/inventory.mjs`. Baseline
green `5454ac1e7595d7d3`, 4 pass / 0 fail.

### R1 — disable the new branch, restoring the defect · `72bf263b4395deb1` · **KILLED** (3/1)
```
-    } else if (pageCalled <= 0) {
+    } else if (false) {
```
KILLED BY: *a route file whose only caller is a script is not wired*

### R2 — count the wrong rule · `ed505d98bbb6fb8b` · **KILLED** (3/1)
```
-    const scriptOnly = findingsFor(p).filter((f) => f.rule === 'route-called-from-outside-the-app').length;
+    const scriptOnly = findingsFor(p).filter((f) => f.rule === 'route-no-caller').length;
```
KILLED BY: *a route file with a real page caller is still wired*

### R3 — off-by-one on the threshold · `21ccced75e124a88` · **KILLED** (3/1)
```
-    } else if (pageCalled <= 0) {
+    } else if (pageCalled < 0) {
```
KILLED BY: *a route file whose only caller is a script is not wired*

### R4 — over-correct: any script caller makes the file half_done · `7393d9d1357aeb04` · **SURVIVED, then KILLED** (3/1)
```
-    } else if (pageCalled <= 0) {
+    } else if (scriptOnly > 0) {
```
This is the finding of the run. It survived the suite as first written, because
all three tests used fixtures that had either a page caller or a script caller,
never both — so the over-correction that downgrades every mixed file passed
cleanly, and it would have moved `aggregates.js`, which two pages really do
call, out of `wired` for no reason.

A fourth test was added for the mixed case, and the same injection is killed by
it. Recorded in this order rather than as a clean kill, because the useful fact
is that the suite did not hold the boundary until it was made to.

KILLED BY: *a page caller and a script caller in the same file still reads wired*

### R5 — control, comment text only · `717ae65157b5af10` · **SURVIVED** (4/0)
```
-    // syncs and a route a page renders are not the same kind of alive.
+    // syncs and a route a page renders are not the same kind of alive. (control)
```
Must survive, and does.

## The five questions

**Well built?** The tests call `buildRows` with a hand-built map and read the
row that comes back, so they test the classification rather than the text of
the file. Two of the four existed from the start to pin the over-correction,
and the third boundary was found by an injection rather than by inspection.

**Stats or made up?** Measured. 170 = 168 + 2 + 0, 3 = 2 + 1 + 0, 5 = 4 + 1 + 0;
`wired` 77 → 74 and `half_done` 174 → 177 across 873 rows, nothing else moved.

**How do we know?** `node --test test/inventory-route-callers.test.js` — 2 pass
/ 1 fail at RED `40f6627`, 4 / 0 at GREEN. Five injections: four killed with the
killing test named, one control, and one of the four killed only after the
suite was strengthened in response to it.

**Pointed anywhere else on the platform?** Yes. It is the same fault as the job
citations one commit earlier — a number that was reported without checking what
the number was made of. Three route files were being reported to the project as
working when no page reaches them.

**How does it unify?** It resolves a cross-thread disagreement without either
thread being wrong, by keeping both readings instead of picking one. The
contested rows that are a genuine definitional difference are still marked as
contested, because a disputed verdict is not a verdict.
