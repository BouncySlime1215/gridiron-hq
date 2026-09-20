# The league outlook panel — RED/GREEN evidence

`client/src/lib/outlook.js`, `client/src/lib/percent.js`,
`client/src/components/league/OutlookPanel.tsx`, the `outlook_probability`
glossary entry, and `test/league-outlook-panel.test.js`.

Retroactive RED by mutation. Built behind the payload's presence: the route
does not exist on every deployment yet, and the panel renders nothing until it
answers.

## Two different playoff numbers, deliberately kept apart

`GET /api/leagues/:id/outlook` is **not** the simulation that produces the
championship number higher up the same page. That one plays the rest of the
season out thousands of times. This one is a model fitted on finished seasons
reading the season so far. Two methods, two answers.

They have two glossary entries — `outlook_probability` ("Chance to qualify")
and `playoff_odds` ("Playoff chance") — for exactly the reason the glossary
exists: `floor` already means two things on one screen in this codebase, and
one name over two methods is how that happened. The mutation that folds one
entry's `raw` into the other goes red.

## The clamp is on the string, and it lives in one place

The payload guarantees `probability` is never 0 and never 1. That is not
enough. At one decimal place 0.9999 renders `100.0%` and 0.00004 renders
`0.0%`: the value obeys the promise and the screen still tells a manager his
season is decided in week 3.

So the clamp is applied to the **rendered string**, by rounding first and then
asking whether the result is one of the two claims that may not be made. A
hand-chosen epsilon instead would clamp a number that renders fine and miss one
that does not — the first draft of this used one and did both.

It lives in `client/src/lib/percent.js`, used by `formatValue` through the
glossary entry's `neverCertain` flag **and** by the panel. Two
implementations would drift and only one of them would be the one on screen.
Nothing else in the app silently gains a hedge: without the flag `percentText`
is an ordinary percentage, and the mutation that removes that guard goes red.

## `act` is never synthesised

The server sends `fine`, `watch` and `act_candidate` and never `act`. Act means
a specific move exists that raises these odds, and only a caller holding the
trade engine's best move can know that. A panel that upgraded the label itself
would be telling a manager to do something without having found anything for
him to do.

`verdictOf('act')` returns null, and the panel says the limit out loud rather
than leaving an absent button: *"Worth a look" marks where a move would matter
most. Whether a move is actually available is a different question, and this
panel does not answer it — Trade Lab does.* Both mutations go red.

## The decomposition

Shown in the server's stated `order`, because the three parts are not equally
important in every league and the server knows which dominates — a fixed order
would put the biggest one last in half of them.

`real` is a **remainder**: what is left after luck and noise, not a separately
measured quantity. `real_is` carries the server's sentence saying so, it is
attached to `real` alone, and the mutation that attaches it to every part goes
red — a caveat on everything is a caveat on nothing.

`no_results_yet` is the same model with the result features neutral. It is
rendered as *"With everything that has happened this season set aside…"* and
never as a preseason forecast, which would invent a comparison the server did
not run.

With no weeks played the three parts are a split of nothing, so they are not
shown at all. A chart of zero is a claim.

A part the server did not send is a dash, never a zero.

## Not ready is a sentence, printed as it arrives

Five distinct reasons, two of which are deliberate refusals rather than missing
data. The sentence is the only thing that distinguishes them and the server
wrote them finished, so the panel prints `outlook.reason` and has no wording of
its own. The mutation that substitutes "Not ready yet." goes red.

The route's own absence is different again and is silent: "this build has no
outlook route" is not something a manager can act on, and an error card there
would be the page reporting its own roadmap.

## An assertion that watched a symbol, for the third time in this stack

"the glossary entry lost its flag" matched `/neverCertain: true/` against the
whole file. Removing the flag from the entry left `formatValue`'s own call site
— `percentText(value, t.precision, { neverCertain: true })` — further down, so
the mutation came back **green**. It now slices to the entry.

This is the third instance: a slice on a common token, an identifier checked
instead of a guard, and now a literal matched anywhere in a file. Same lesson
each time — assert the decision, not the symbol — and the mutation run is what
tells them apart.

## Mutation runs

Baseline: 8 tests, 8 pass, 0 fail. All sixteen red.

| Mutation | Result | Caught by |
|---|---|---|
| the clamp is dropped, so 0.9999 reads 100% | 6/**2** | never reads as certain; clamp in one place |
| the clamp is applied to every percentage in the app | 7/**1** | clamp in one place |
| the outlook glossary entry loses its flag | 7/**1** | clamp in one place |
| `formatValue` stops applying the clamp | 7/**1** | clamp in one place |
| the outlook number is folded into the simulation's entry | 7/**1** | clamp in one place |
| the panel invents an `act` verdict | 7/**1** | act is never produced |
| the panel stops saying it cannot tell you what to do | 7/**1** | act is never produced |
| the decomposition order is hard-coded | 7/**1** | shown in the server's order |
| the remainder caveat is dropped | 7/**1** | shown in the server's order |
| the caveat is attached to every part | 7/**1** | shown in the server's order |
| a missing part becomes zero | 7/**1** | shown in the server's order |
| the decomposition shows with nothing played | 7/**1** | nothing to take apart |
| the not-ready reason is reworded | 7/**1** | printed as it arrives |
| `no_results_yet` is called a preseason forecast | 7/**1** | not a preseason forecast |
| the page surfaces an error for a route that may not exist | 7/**1** | rendered beside the simulation |
| the panel is removed from the page | 7/**1** | rendered beside the simulation |

## One assertion was scoped to what is shown

Two checks forbid wording the panel must not use — "preseason", "not ready
yet". The panel's own header explains that `no_results_yet` is *not* a
preseason forecast, and a whole-file check forbade the explanation along with
the mistake. The checks now run against the file with its comments stripped.
Naming what was avoided is the opposite of doing it.

---

## Mutation re-run at the stack tip

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

Files mutated: `client/src/components/league/OutlookPanel.tsx`, `client/src/lib/glossary.ts`, `client/src/lib/outlook.js`, `client/src/lib/percent.js`, `client/src/pages/MyTeam.tsx`.

**the clamp is dropped, so 0.9999 reads 100%** (`client/src/lib/percent.js`) — APPLIED `7845502ba241` → `4031f7be3446` — **RED**, 2 failing · killed by *a probability never reads as certain, whatever it rounds to*

```diff
-  if (!neverCertain) return `${shown}%`;
+  return `${shown}%`;
+  if (!neverCertain) return `${shown}%`;
```

**the clamp is applied to every percentage in the app** (`client/src/lib/percent.js`) — APPLIED `7845502ba241` → `1260bca690fa` — **RED**, 1 failing · killed by *the clamp lives in one place and the glossary applies it*

```diff
-  if (!neverCertain) return `${shown}%`;
-
+  (the text is removed)
```

**the outlook glossary entry loses its flag** (`client/src/lib/glossary.ts`) — APPLIED `651cd69a37a7` → `3eb15abe4741` — **RED**, 1 failing · killed by *the clamp lives in one place and the glossary applies it*

```diff
-unit: 'percent', precision: 1, neverCertain: true
+unit: 'percent', precision: 1
```

**formatValue stops applying the clamp** (`client/src/lib/glossary.ts`) — APPLIED `651cd69a37a7` → `99eb290dd12f` — **RED**, 1 failing · killed by *the clamp lives in one place and the glossary applies it*

```diff
-  if (t.neverCertain && t.unit === 'percent') {
+  if (false) {
```

**the outlook number is folded into the simulation's entry** (`client/src/lib/glossary.ts`) — APPLIED `651cd69a37a7` → `dbe7da4e7cb4` — **RED**, 1 failing · killed by *the clamp lives in one place and the glossary applies it*

```diff
-    raw: 'outlook.probability',
+    raw: 'sim.playoff_odds',
```

**the panel invents an 'act' verdict** (`client/src/lib/outlook.js`) — APPLIED `c95d1f50bb3a` → `e0ece3d62c55` — **RED**, 1 failing · killed by *act is never a verdict this panel can produce*

```diff
-  act_candidate: {
+  act: { label: 'Act', plain: 'Do something.' },
+  act_candidate: {
```

**the decomposition order is hard-coded** (`client/src/lib/outlook.js`) — APPLIED `c95d1f50bb3a` → `0ca70f49d8be` — **RED**, 1 failing · killed by *the decomposition is shown in the order the server stated*

```diff
-  const order = Array.isArray(d.order) && d.order.length ? d.order : ['real', 'luck', 'noise'];
+  const order = ['real', 'luck', 'noise'];
```

**the remainder caveat is dropped** (`client/src/lib/outlook.js`) — APPLIED `c95d1f50bb3a` → `9745f8ae7890` — **RED**, 1 failing · killed by *the decomposition is shown in the order the server stated*

```diff
-      note: key === 'real' ? (d.real_is ?? null) : null
+      note: null
```

**the remainder caveat is attached to every part** (`client/src/lib/outlook.js`) — APPLIED `c95d1f50bb3a` → `17c6171d349b` — **RED**, 1 failing · killed by *the decomposition is shown in the order the server stated*

```diff
-      note: key === 'real' ? (d.real_is ?? null) : null
+      note: d.real_is ?? null
```

**a missing decomposition part becomes zero** (`client/src/lib/outlook.js`) — APPLIED `c95d1f50bb3a` → `79ead514a44c` — **RED**, 1 failing · killed by *the decomposition is shown in the order the server stated*

```diff
-      value: Number.isFinite(d[key]) ? d[key] : null,
+      value: d[key] ?? 0,
```

**the decomposition shows with nothing played** (`client/src/lib/outlook.js`) — APPLIED `c95d1f50bb3a` → `93c2b9848da0` — **RED**, 1 failing · killed by *with nothing played there is nothing to take apart*

```diff
-  return (outlook?.weeks_played ?? 0) > 0 && !!outlook?.teams?.some(t => t.decomposition);
+  return !!outlook?.teams?.some(t => t.decomposition);
```

**the not-ready reason is reworded** (`client/src/components/league/OutlookPanel.tsx`) — APPLIED `53059030253b` → `01fe64e4d1c7` — **RED**, 1 failing · killed by *the not-ready reason is printed as it arrives*

```diff
-<BasisLine basis="none">{outlook.reason}</BasisLine>
+<BasisLine basis="none">Not ready yet.</BasisLine>
```

**no_results_yet is called a preseason forecast** (`client/src/components/league/OutlookPanel.tsx`) — APPLIED `53059030253b` → `74d3cc6b0767` — **RED**, 1 failing · killed by *no_results_yet is not called a preseason forecast*

```diff
-                  With everything that has happened this season set aside, the same model reads this
+                  As a preseason forecast, the same model reads this
```

**the panel stops saying it cannot tell you what to do** (`client/src/components/league/OutlookPanel.tsx`) — APPLIED `53059030253b` → `abf6515ab70a` — **RED**, 1 failing · killed by *act is never a verdict this panel can produce*

```diff
-        "Worth a look" marks where a move would matter most. Whether a move is actually available is
-        a different question, and this panel does not answer it — Trade Lab does.
+        "Worth a look" marks where a move would matter most.
```

**the page surfaces an error for a route that may not exist** (`client/src/pages/MyTeam.tsx`) — APPLIED `98c171e444ff` → `0d0d390f4467` — **RED**, 1 failing · killed by *the page renders it beside the simulation, not blended into it*

```diff
-  const { data: outlook } = useApi<any>(outlookUrl);
+  const { data: outlook, error: outlookError } = useApi<any>(outlookUrl);
+  if (outlookError) throw new Error(outlookError);
```

**the outlook panel is removed from the page** (`client/src/pages/MyTeam.tsx`) — APPLIED `98c171e444ff` → `7f169f5d8239` — **RED**, 1 failing · killed by *the page renders it beside the simulation, not blended into it*

```diff
-          <OutlookPanel outlook={outlook} teamName={teamName} myRosterId={myTeamId} />
-
+  (the text is removed)
```

**NO-OP CONTROL: a comment word changed in the outlook module** (`client/src/lib/outlook.js`) — APPLIED `c95d1f50bb3a` → `75eab9df1391` — **green — survived, as intended**

```diff
- * Nothing in this file touches the DOM or React.
+ * Nothing in this file touches the DOM or React (control).
```

16 mutations applied and red, 1 applied and green. The green
row is the deliberate no-op control — an edit that is real (the SHA changes) but
touches nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database. The tree is `af7f01a` plus the working tree of
the commit this section lands in; the source was restored and verified clean
after the run.
