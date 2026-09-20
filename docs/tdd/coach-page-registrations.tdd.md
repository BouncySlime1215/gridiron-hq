# coach-page-registrations — TDD report

Five of the eight sidebar tabs now tell the floating assistant what they are
showing, and a test derived from the nav itself fails on the next one that
forgets.

## The five questions

**Is it well built?** The registration is one hook, `usePageExplain`, already
used by four pages; nothing new was invented for these five. The one design
decision is the Draft hub's, and it exists because of a real collision rather
than a preference — see section 3.

**Is this based on stats, or is it made up?** Neither: nothing here computes a
number. Every value registered is a count or a flag the page already holds in
hand for its own rendering. That is the point of section 5 — a count with no
state beside it *would* be made up, because it would report "0 stories" for a
failed request.

**How do we know?** Fourteen mutations, each with the file's SHA-256 before and
after and the exact text of the edit, in section 4. Three controls that the
runner refused. Every one of the eight tests has a row that turns it red.

**Should this data be pointed anywhere else on the platform?** It already is —
these summaries are what `nfl-page-explain.js`'s tool loop targets a record
with. What this commit does *not* do is invent new surfaces for it; the
registrations feed the assistant that was already mounted at the App root.

**How does it unify?** By deriving the tab list from `client/src/navigation.ts`
and the route table in `App.tsx` instead of listing page files in the test. The
drift that put five tabs in this state is the same drift `navigation.ts`'s own
header comment describes: two hand-maintained lists of the same thing. There is
now one list, and the test reads it.

## 1. The defect

`PageExplainAssistant` answers "what am I looking at" from whatever the current
page registered through `usePageExplain()`. When nothing is registered it falls
back to `fallbackSection()`, which scrapes a section name out of the URL, and
answers from the route alone.

Five of the eight sidebar tabs registered nothing:

| Tab | Route | Page | What the assistant knew |
|---|---|---|---|
| League Hub | `/league` | `LeagueHub.tsx` | the word "league" |
| News | `/news` | `News.tsx` | the word "news" |
| X's & O's | `/teams` | `Teams.tsx` | the word "teams" |
| Settings | `/settings` | `Settings.tsx` | the word "settings" |
| Draft | `/draft` | `DraftHub.tsx` | the word "draft" |

The last one is the one nobody had counted. `LiveDraft.tsx` *does* register, so
a grep for `usePageExplain` in the pages directory finds a draft page and moves
on. But that registration only fires under `/live-draft/:id`; the sidebar's
Draft tab is `/draft`, which renders `DraftHub`, and the hub's mock, survival
and recap views registered nothing at all.

The concrete cost, on News: a team filter returning nothing and a failed request
both left the assistant with no summary, so it could not tell "this team has no
news" from "the news did not load", and neither could anyone asking it.

## 2. What each page registers

Counts and flags the page already holds, never the response object.

- **League Hub** — active league name, leagues connected, roster freshness,
  state; `{ league_id }` as the event context when a league is active.
- **News** — stories shown, team filter, date filter, state; `{ team_abbr }`
  when a team filter is on.
- **X's & O's** — teams listed, state. No event context: this is the index, and
  nothing specific is in view. The per-team page registers its own.
- **Settings** — which install this is, whether Google sign-in is configured,
  whether pairing is available, whether a sync is running. **Presence only,
  never a value**, which section 6 is about.
- **Draft hub** — which of the four modes is showing, and nothing else, because
  the rows belong to the child that holds them.

## 3. Two registrations in one tree fight each other

`usePageExplain` writes a single slot on a context at the App root. Two
components calling it in the same mounted tree is not "two summaries"; it is a
race. Both effects run, the later one wins, and on the next render the loser's
cleanup fires `setInfo({})` and clears the winner. The assistant can then be
asked what the page shows at exactly the moment the answer has been blanked —
which is the failure the hook's own header comment describes for a different
cause (the provider identity loop) and guards against there.

The Draft hub renders `LiveDraft` for its live view, and `LiveDraft` registers a
far richer summary than the hub could. So the hub's registration is a component,
`DraftHubExplain`, mounted only on the non-live branch:

```tsx
{view === 'live' ? <LiveDraft /> : <><DraftHubExplain view={view} />{view === 'survival' ? <DraftSurvival /> : <Drafts />}</>}
```

A hook cannot be called conditionally; a component can be mounted
conditionally, which is why the registration is one. On a live → mock switch
React flushes every destroy function in a commit before any create function, so
`LiveDraft`'s cleanup runs before `DraftHubExplain`'s registration, and the
order is safe rather than lucky.

**R6 pins this**, and mutation 11 is the bug written out: hoisting the
registration above the branch so it mounts alongside the live board.

## 4. The mutations

Run at `ee923ae` with the code and test changes of this commit in the working
tree. Every row records the file's SHA-256 before and after, the exact text of
the edit, and the test titles that went red. APPLIED is decided by
`count(old) == 1`; a row whose anchor matches any other number of times is
reported NOT APPLIED with that count and never mutated.

The runner and the mutation list are both in the repository, so this table can
be re-derived rather than taken on report:

```
python3 docs/tdd/sweeps/mutation-runner.py \
  docs/tdd/sweeps/coach-page-registrations.mutations.json /tmp/out.json
```

Re-run from the committed copy at `ee923ae` plus this commit's code and tests:
all 17 rows identical on name, applied, both hashes and the killing titles.

| # | Mutation | File | SHA-256 before → after | Aimed at | Fails | Killed by | Kind |
|---|---|---|---|---|---|---|---|
| 1 | M1 nav tab pointed at a page that registers nothing | `client/src/navigation.ts` | `3bca5e69272f` → `85046bc25869` | R1 | 1 | `R1: every sidebar tab registers what it is showing, derived from the nav and the route table` | mutation |
| 2 | M2 League Hub stops registering | `client/src/pages/LeagueHub.tsx` | `72770ac5e2e1` → `4abdc8ff9120` | R1 | 4 | `R1: every sidebar tab registers what it is showing, derived from the nav and the route table`<br>`R4: no page hands over a raw API payload`<br>`R5: a count arrives with the state it was counted in`<br>`R8: what is specific and in view goes to the event context, not the summary` | mutation |
| 3 | M3 X's & O's calls the hook without importing it | `client/src/pages/Teams.tsx` | `c908b375a50e` → `67eb0667943d` | R2 | 1 | `R2: each newly wired page uses the shared hook and does not grow its own` | mutation |
| 4 | M4 Settings shadows the shared hook with a local one | `client/src/pages/Settings.tsx` | `5703e33bb2cf` → `254bad84d169` | R2 | 1 | `R2: each newly wired page uses the shared hook and does not grow its own` | mutation |
| 5 | M5 Settings sends the origin instead of which install this is | `client/src/pages/Settings.tsx` | `5703e33bb2cf` → `73879a72441a` | R3 | 1 | `R3: Settings registers presence, never a value` | mutation |
| 6 | M6 Settings grows an unvetted key | `client/src/pages/Settings.tsx` | `5703e33bb2cf` → `a2c6fc013a9a` | R3 | 1 | `R3: Settings registers presence, never a value` | mutation |
| 7 | M7 Settings sends a string that is not one of the three install names | `client/src/pages/Settings.tsx` | `5703e33bb2cf` → `0a2fefd3f7c5` | R3 | 1 | `R3: Settings registers presence, never a value` | mutation |
| 8 | M8 News registers the whole story payload | `client/src/pages/News.tsx` | `9ec25b1860cc` → `d760ad81c60f` | R4 | 1 | `R4: no page hands over a raw API payload` | mutation |
| 9 | M9 League Hub reports a state it can always claim | `client/src/pages/LeagueHub.tsx` | `72770ac5e2e1` → `fcc45e04e8d4` | R5 | 1 | `R5: a count arrives with the state it was counted in` | mutation |
| 10 | M10 X's & O's drops its state entirely | `client/src/pages/Teams.tsx` | `c908b375a50e` → `2f173c7f29b5` | R5 | 1 | `R5: a count arrives with the state it was counted in` | mutation |
| 11 | M11 the Draft hub registers alongside the live board | `client/src/pages/DraftHub.tsx` | `4a3a4755f8f5` → `5e984252aedb` | R6 | 1 | `R6: the Draft hub stands aside for the live board rather than fighting it` | mutation |
| 12 | M12 the draft summary writes its own mode label | `client/src/pages/DraftHub.tsx` | `4a3a4755f8f5` → `b46e4f16b202` | R7 | 1 | `R7: the draft modes are declared once, and the registration names the mode from that list` | mutation |
| 13 | M13 the tab strip goes back to its own inline list | `client/src/pages/DraftHub.tsx` | `4a3a4755f8f5` → `99c45bda323a` | R7 | 1 | `R7: the draft modes are declared once, and the registration names the mode from that list` | mutation |
| 14 | M14 News puts a count in the event context | `client/src/pages/News.tsx` | `9ec25b1860cc` → `0a78b28e1eba` | R8 | 1 | `R8: what is specific and in view goes to the event context, not the summary` | mutation |
| 15 | CONTROL A (no-op): a pattern that is not in this file | `client/src/pages/Settings.tsx` | `5703e33bb2cf` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 16 | CONTROL B (no-op): a pattern from a different feature entirely | `client/src/pages/News.tsx` | `9ec25b1860cc` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 17 | CONTROL C (anchor x2): a pattern present twice, which the runner refuses | `client/src/pages/DraftHub.tsx` | `4a3a4755f8f5` → unchanged | none | — | **NOT APPLIED — anchor x2** | anchor control |

Restored to the before-hash after every row: yes, all 14 applied rows.

### The exact text of each edit

**1. M1 nav tab pointed at a page that registers nothing**

```diff
-{ to: '/teams', label: "X's & O's", icon: 'X' }
+{ to: '/pair', label: "X's & O's", icon: 'X' }
```

**2. M2 League Hub stops registering**

```diff
-  usePageExplain('league hub', view, {
+  noSuchRegistration('league hub', view, {
```

**3. M3 X's & O's calls the hook without importing it**

```diff
-import { usePageExplain } from '../components/PageExplainContext';
```

**4. M4 Settings shadows the shared hook with a local one**

```diff
-import { usePageExplain } from '../components/PageExplainContext';
+import { usePageExplain } from '../components/PageExplainContext';
+const usePageExplain2 = () => {};
+const usePageExplain = () => {};
```

**5. M5 Settings sends the origin instead of which install this is**

```diff
-    install: deployment ? (deployment.local ? 'local' : 'hosted') : 'unknown',
+    install: deployment?.origin ?? 'unknown',
```

**6. M6 Settings grows an unvetted key**

```diff
-    sync_running: syncing
-  });
+    sync_running: syncing,
+    pairing_code: pairingCode
+  });
```

**7. M7 Settings sends a string that is not one of the three install names**

```diff
-(deployment.local ? 'local' : 'hosted')
+(deployment.local ? 'local' : 'hosted on fly, signed in as the owner')
```

**8. M8 News registers the whole story payload**

```diff
-    stories_shown: items?.length ?? 0,
+    stories_shown: items,
```

**9. M9 League Hub reports a state it can always claim**

```diff
-    state: loading && !leagues.length ? 'loading' : error && !leagues.length ? 'failed' : 'ready'
+    state: 'ready'
```

**10. M10 X's & O's drops its state entirely**

```diff
-    teams_listed: teams?.length ?? 0,
-    state: loading && !teams ? 'loading' : error ? 'failed' : 'ready'
+    teams_listed: teams?.length ?? 0
```

**11. M11 the Draft hub registers alongside the live board**

```diff
-    {view === 'live' ? <LiveDraft /> : <><DraftHubExplain view={view} />{view === 'survival' ? <DraftSurvival /> : <Drafts />}</>}
+    {<><DraftHubExplain view={view} />{view === 'live' ? <LiveDraft /> : view === 'survival' ? <DraftSurvival /> : <Drafts />}</>}
```

**12. M12 the draft summary writes its own mode label**

```diff
-  usePageExplain('draft', modeLabel(view), { draft_mode: modeLabel(view) });
+  usePageExplain('draft', modeLabel(view), { draft_mode: 'Mock & boards' });
```

**13. M13 the tab strip goes back to its own inline list**

```diff
-      {DRAFT_MODES.map(([id,label]) =>
+      {([['mock','Mock & boards'],['survival','Who survives'],['live','Live'],['recap','Recaps']] as const).map(([id,label]) =>
```

**14. M14 News puts a count in the event context**

```diff
-  }, teamFilter ? { team_abbr: teamFilter } : null);
+  }, teamFilter ? { team_abbr: teamFilter, stories_shown: items?.length ?? 0 } : null);
```

**15. CONTROL A (no-op): a pattern that is not in this file**  — searched for, not found (anchor x0)

```diff
-usePageExplain('betting', null, {
+usePageExplain('nothing', null, {
```

**16. CONTROL B (no-op): a pattern from a different feature entirely**  — searched for, not found (anchor x0)

```diff
-export const FAIRNESS_TONE
+export const FAIRNESS_TONE_X
```

**17. CONTROL C (anchor x2): a pattern present twice, which the runner refuses**  — searched for, not found (anchor x2)

```diff
-modeLabel(view)
```

### The near-miss inside mutation 4

Mutation 4 injects two lines, not one. `const usePageExplain2 = () => {};` is
there to fail: R2's shadow ban is `/^(const|function) usePageExplain\b/m`, and
`_2` is a word character, so the boundary does not fall where a careless reading
says it does and that line does not match. The line below it does. The row is
red for the right reason, and the decoy is the reason the row can say so —
without it, a ban that fired on any identifier merely *starting* with the hook's
name would have looked identical from the outside.

The same reading error is the one section 6 records as having actually happened,
in the `\bcode\b` ban. It is worth writing down twice: word boundaries in this
codebase's identifiers almost never sit where the snake_case suggests.

### Why the runner was rewritten, and what the controls prove

The previous runner decided APPLIED with `old in src` and confirmed it with
`git diff --numstat`. Both are wrong in a way that produces false green rather
than a crash:

- `old in src` accepts an anchor that matches twice. The edit lands on whichever
  site comes first, which may not be the site the test watches, and the row is
  recorded as an applied mutation that no test killed — or worse, as an applied
  mutation that some *other* test killed, which reads as coverage.
- `git diff --numstat` is blind to untracked files. Earlier tonight it reported
  ten real mutations as no-ops, on a test file that had not been staged yet.

This runner decides APPLIED by `count(old) == 1`, records the file's SHA-256
before the edit, after the edit and after the restore, and asserts the hash
moved before running anything. A row cannot be recorded as killed without a hash
change proving the file differed while the suite ran.

A verification step whose green means anything has to be able to report red.
Three rows exercise that on purpose. **Controls A and B** are the required
no-op kind: patterns that are not in the file at all (`anchor x0`). **Control
C** is the new one — `modeLabel(view)` appears twice in `DraftHub.tsx`, so the
runner refuses it (`anchor x2`) rather than editing the first site. Under the
old runner that exact pattern would have been applied, would have edited the
mode-label helper's call rather than the registration, and would have been
recorded as a mutation of the registration.

## 5. A count with no state is a lie about the zero

R5 is the rule with the most behaviour behind it. "0 stories shown" is the same
three characters whether News is holding an empty result for this team or a
failed request, and the assistant has no other source for the difference. So the
three counting pages register a `state` that can say `loading`, `failed` and
`ready`, and the test asserts all three words are reachable — mutation 9
collapses League Hub's to a constant `'ready'`, which is the shape this goes
wrong in: still a state field, still a string, always the reassuring one.

## 6. Settings sends presence, never a value

This page carries ESPN cookies, an eight-digit pairing code and account
controls, and the summary it registers is sent to a model. CLAUDE.md's rule is
the whole of R3: read a value's presence, never its content.

The test holds three separate lines, because the ways this goes wrong are
different from each other:

1. **The key set is exact.** A new key is a new thing going to a model, and it
   fails until someone changes this test on purpose (mutation 6 adds
   `pairing_code`).
2. **A substring ban** on `espn`, `swid`, `s2`, `cookie`, `token`, `secret`,
   `api*key`, `email`, `origin` and `code` (mutation 5 swaps the install enum
   for `deployment?.origin`).
3. **Every string literal is one of three words** naming the install —
   `'local'`, `'hosted'`, `'unknown'` — so a value cannot arrive dressed as a
   label (mutation 7).

A note on the second line, because it was wrong first: the ban was written
`\bcode\b`, which does not fire on `pairing_code`, since `_` is a word
character and there is no boundary there. Mutation 6 was still killed, by the
key-set line — which is exactly what several independent assertions are for,
and also exactly how a weak guard survives unnoticed when it is the only one.
It is now a plain substring.

## 7. Every test has a killing row

| Test | Killed by |
|---|---|
| R1: every sidebar tab registers what it is showing | 1, 2 |
| R2: each newly wired page uses the shared hook | 3, 4 |
| R3: Settings registers presence, never a value | 5, 6, 7 |
| R4: no page hands over a raw API payload | 2, 8 |
| R5: a count arrives with the state it was counted in | 2, 9, 10 |
| R6: the Draft hub stands aside for the live board | 11 |
| R7: the draft modes are declared once | 12, 13 |
| R8: what is specific and in view goes to the event context | 2, 14 |

Eight of eight. No test is red for nothing, and no applied mutation survived.

## 8. What these tests cannot see

`node:test` has no build step and cannot import `.tsx`, so these read the call
as it is written, not as it runs. A page could register the right shape and
never mount it. What is checked is the contract at the call site; R1's coverage
derivation is what makes that worth something, because it checks every tab
rather than the ones someone remembered.

R6's ordering claim — that React flushes destroy functions before create
functions within a commit — is a property of React, asserted here from its
documented behaviour and not measured by any test in this file. What the test
pins is the weaker and more useful thing: that the two registrations are never
mounted together in the first place, so the ordering never has to be relied on.

## 9. Full check

`npm run check` measured at **12:25:56Z–12:31Z on the tree of `ee923ae` plus
the code and test changes of this commit**, with no documentation in it:

| Step | Result |
|---|---|
| typecheck | clean |
| lint | 907 JavaScript files syntax-checked |
| test | **3,196 tests, 3,155 pass, 0 fail, 41 skipped** |
| build | `✓ built in 2.50s` |
| start:smoke | passed on an isolated database (32 teams) |

Previous head `ee923ae` measured 3,188 / 3,147 / 0 / 41. The eight added tests
are the eight in `test/coach-page-registrations.test.js`; nothing else moved.

The two documentation files in this commit were written **after** that run and
cannot have affected it, which is a command rather than a claim:

```
git diff --name-only ee923ae HEAD | grep -E '^docs/design/design-system\.md$|^docs/CLAUDE-NEXT-STEPS\.md$'
```

Nothing printed. Those two paths are the only `docs/` files any part of
`npm run check` opens at runtime — `test/deep-dive.test.js:26`,
`test/stat-table.test.js:22`, `test/stat-block.test.js:23` and
`test/design-system-tokens.test.js:28` read the first,
`test/nfl-execution-integrity.test.js:258` reads the second — and
`scripts/lint.mjs:5` walks `['server', 'scripts', 'test']`. `docs/tdd/` is read
by nothing.

The source was restored after the mutation run and verified with `git status`
and the runner's own after-restore hash, not assumed clean because the runner
said so.
