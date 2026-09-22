# TDD evidence: namespace imports read as no import at all

**Item:** `scripts/wiring-map.mjs` recorded the file edge for a namespace binding and
none of the names read off it, so every export only ever reached that way was reported
as `export-imported-by-nothing` — "exported and never imported".

**Files owned and changed:** `scripts/wiring-map.mjs`, `test/wiring-map.test.js`,
`docs/wiring/WIRING-MAP.md`, `docs/wiring/wiring-map.json`, this document.

**Origin:** running the map against the scheduler's PR #63 as part of the standing
audit, on 2026-09-20. It reported `server/services/scheduler.js#reapAbandonedRuns` as
exported and never imported, while `test/abandoned-run-backoff.test.js` calls it five
times. The sibling exports on the same branch — `BOOT_JOBS`, `bootOffThread`,
`MAIN_THREAD_ONLY`, `resolveOffThread` — were reported correctly, which is what made it
worth chasing rather than dismissing: the same file, the same audit, two different
answers.

The difference was the import form. `boot-path-off-thread.test.js` destructures;
`abandoned-run-backoff.test.js` binds the whole module:

```js
const scheduler = await import('../server/services/scheduler.js');
scheduler.reapAbandonedRuns();
```

---

## RED

`test/wiring-map.test.js`, four cases added, three failing at HEAD:

```
not ok 23 - an export reached through a namespace binding is imported, not dead
not ok 24 - a static namespace import is read the same way
not ok 25 - a namespace binding does not claim members of an unrelated object
# tests 40
# pass 37
# fail 3
```

Case 26 — the destructured dynamic form — passes in both states by design. It is the
guard against the failure the fix could plausibly introduce: the two forms sit in the
same regex, and widening one must not start over-claiming the other.

Commit `1614438`.

## The gap, exactly

`moduleEdges` understood two dynamic forms, `const { x } = await import('./y.js')` and
`import('./y.js').then(m => m.fn())`, the second by literally matching the identifier
`m`. It understood neither namespace form:

| Form | Sites | What was recorded |
|---|---|---|
| `const ns = await import('./y.js')` | 195 | the file edge, no names |
| `import * as ns from './y.js'` | 8 | the file edge; `* as ns` failed the identifier check and was dropped |

128 files use one or the other. The module-level rules were never affected — the edge
itself was always there — so this was contained to the two export-level rules.

Same family as `docs/tdd/wiring-map-template-literal-uses.tdd.md`: the tokenizer sees
the specifier, loses what was read from it, and every rule built on that view is
silently capped. That is now twice, which is itself the finding: **when a rule counts
uses of a name, ask which syntactic forms of "use" the extractor can see before
trusting the count.**

## GREEN

`namespaceMembers(codeView, binding)` collects `binding.member` reads; the dynamic
branch calls it for a non-destructured binding, and `* as ns` is expanded in place
inside `add()` so the static form stays one import record rather than a nameless one
beside a second entry.

Two things that were wrong on the first attempt and are worth keeping in the record:

1. **It scans the code view, not the text view.** `moduleEdges` is handed the `text`
   view, which still carries string bodies, so `'./scheduler.js'` contributed `js` as a
   member of every binding named `scheduler`. Caught by case 23's exact-set assertion —
   a `.includes()` assertion would have passed.
2. **The static form was added as a second import record**, leaving the original
   nameless one first, so a consumer doing `imports.find(...)` still saw no names.
   Caught by case 24.

The member scan is deliberately blunt and one-directional. It matches the binding's
name followed by a dot anywhere in the file, so a same-named local object would
contribute its properties too. That over-claims a name as imported, which can only
suppress an orphan finding; it cannot invent a missing feed or fail a build. The
opposite error is the one being repaired, and it called live code dead.

## Blast radius, measured

Against `origin/main` at `791b131`, same script, before and after:

| | before | after |
|---|---|---|
| findings | 2242 | 2196 |
| `export-imported-by-nothing` | — | **212 removed** |
| `export-only-tested` | — | 10 removed, 176 added |

The net of 46 understates it. **212 exports were labelled "exported and never
imported".** 176 of them are imported by tests only — the correct, weaker finding, now
reported as such. The other 36 are imported by production code and are not findings at
all. Three spot-checks against the source, none of them tests:

- `server/services/nfl-sim-policy.js#gameScriptPassRate` — `nfl-drive-sim.js:293`, `P.gameScriptPassRate(...)`. Server to server.
- `server/services/contingency.js#buildAvailabilityLookup` — `scripts/availability-decision-calibration.mjs:223`, `C.buildAvailabilityLookup(...)`.
- `server/services/lineup-posture.js#SPREAD_SCALE` — `scripts/fit-posture-calibration.mjs:430`.

Neither rule gates: `export-imported-by-nothing` is not in `NEW_ORPHAN`, so no build
ever failed on this. What it did was worse in a quieter way — "exported and never
imported" reads as *delete this*, and it said so about 212 live exports, including a
constant another thread is actively re-fitting.

## Verified on the branches the audit was run against

| | before | after |
|---|---|---|
| `origin/main` 791b131 | 2242 | 2196 |
| #62 `25d911c2` | 2242 | 2196 |
| #63 `01b7a2fc` | 2247 | 2201 |

#62 adds no finding of its own — its only delta against main is line numbers moving in
`waiver-brain.js`. #63's five are all `export-only-tested` on the scheduler stack's new
exports, none gating, and `reapAbandonedRuns` is no longer among them.
