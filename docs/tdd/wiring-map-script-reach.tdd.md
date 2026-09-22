# Script reach is an entry-point question, not a proximity one

`docs/wiring/wiring-map.json` recorded **no script reach at all** for
`server/services/nfl-features.js`, although `npm run audit:nfl` runs it. Reported
against this map's own output; this file is the derivation, the fix and the
measurement.

## The chain, pinned

    package.json:28   "audit:nfl": "node scripts/nfl-blind-audit.mjs"
      scripts/nfl-blind-audit.mjs:3       -> server/services/nfl-blind-audit.js
      server/services/nfl-blind-audit.js:22 -> server/services/pick-reasoning.js
      server/services/pick-reasoning.js:40  -> server/services/nfl-reasoning.js
      server/services/nfl-reasoning.js:22   -> server/services/nfl-features.js

Four hops. Every edge was already in the map. Script reach propagated cleanly at
hops 1, 2 and 3 — `nfl-blind-audit.js`, `pick-reasoning.js` and `nfl-reasoning.js`
all carried `scripts/nfl-blind-audit.mjs` — and then stopped.

## Cause

`surfaceFamilies` (`scripts/wiring-map.mjs:2383`) cut **every** bucket at the same
`hops` argument, and every caller passes `CLOSE_HOPS`, which is 3
(`:2363`). `close()` then cut the same buckets a second time at the same
constant. `nfl-features.js` sits at hop 4, so both cuts removed it.

The cap is right for routes and wrong for scripts, and the comment on it says why
without noticing the split:

> in a monolith this size almost everything is eventually reachable from almost
> everything, so a family at 1-2 hops is a real dependency and one at 9 is two
> modules sharing a library

That is a **proximity** heuristic, and proximity is the right question for a
route: a module nine hops from a handler is probably not serving it. A script
asks a different question. Everything in a script's import closure is *executed*
when the script runs, however far down it sits — and "does `package.json` name a
script that runs this file" is exactly what `CONTRACT.md`'s `wired` test asks.
Hop count answers nothing there.

This is the same defect class as `MAX_HOPS`, the 3-hop `CLOSE_HOPS` filter in the
`--blast` output and the fixed windows removed elsewhere on this branch: a
constant chosen for one question, applied to a second question it does not fit,
producing a confident negative.

## Fix

`scripts/wiring-map.mjs`: the `script:` names are bounded by `MAX_HOPS` instead of
the caller's `hops` (`Math.max(hops, MAX_HOPS)`, so an explicit `--hops 20` is
never shrunk), and `close()` passes `wiring.scripts` through untouched. Routes,
jobs and pages keep the cap exactly as before.

## Measurement — same tree, old code vs new

Generated twice on tree `1bce026…` + this branch's two commits, with only
`scripts/wiring-map.mjs` differing:

| | before | after |
|---|---|---|
| files gaining a script reach | — | **16** |
| files losing one | — | **0** |
| new (module, script) pairs | — | **6,665** |
| findings | 2449 | **2449** |
| inventory row status changes | — | **0** |

Saturation: 15 files gain at a cap of 4, 16 at a cap of 5, and the number does
not move again through 12. So this is not the everything-reaches-everything case
the cap exists for — the tail is short and real.

The 16: `nfl-features.js`, `nfl-sharp.js`, `historical-adp.js`,
`mlb-shrinkage-fit.js`, `nfl-data-consistency.js`, `parlay-api.js`,
`source-registry.js`, the seven `server/modeling/*` modules, and the two
`server/betting/nfl/contracts/*` modules.

**No graded inventory row moved.** `nfl-features.js` is `unclassified`, not
`wired`, so the map was wrong without the inventory being wrong because of it.
The 881-row tally is identical either side except `half_done` 183→184, which is
`scripts/lib/evidence-report.mjs` appearing as a new module, not this change.

A separate caveat on the regenerated artifact: the committed map predated this
branch's earlier commits, so the checked-in diff also carries +14/−10 findings of
ordinary drift (`evidence-report.mjs`, the `inventory.mjs` exports, `CONTRACT.md`
citations). None of it is from this change; the table above is the isolated
comparison.

## Tests — `test/wiring-map-script-reach.test.js`

Seven cases, two of which were the RED (`9de1b17`):

1. `package.json` really does run `scripts/nfl-blind-audit.mjs` — if the script is
   renamed the test says so instead of silently pinning nothing.
2. every import edge in the five-file chain is in the map.
3. the chain is 4 hops, which is `> CLOSE_HOPS` — the premise of the case.
4. **RED:** `nfl-features.js` records the script, at hops 4 exactly.
5. **RED:** `close()` keeps a script reach past `CLOSE_HOPS`.
6. the cap still binds on routes, jobs and pages, over every non-test module, with
   an assertion that the loop actually saw >100 capped entries — a "nothing
   violated it" pass over an empty set proves nothing.
7. script reach stays bounded by `MAX_HOPS` over every non-test module.

Cases 6 and 7 exist because the obvious fix — raise `CLOSE_HOPS` — passes 4 and 5
and is wrong.

## The five questions

- **Well built?** The change is four lines and one comment, in the one function
  that computes the buckets; it narrows to `script:` names only, keeps a real
  bound, and respects an explicit `--hops`. The guard against over-fixing (cases
  6 and 7) is in the test file, not in review.
- **Stats or made up?** Measured. 16 / 0 / 6,665 / 2449→2449 / 0 status changes
  are read off two generated artifacts on one tree with one file differing.
- **How do we know?** The chain is pinned edge by edge from the map's own
  `imports`, not from reading source; the saturation sweep (caps 4,5,6,7,8,12) was
  run before the fix, so the number was known before the code changed.
- **Pointed anywhere else on the platform?** Yes. Every fixed constant in this
  generator is now suspect for the same reason: `MAX_HOPS = 12` (does not bind —
  graph diameter is 8), and `--hops` defaulting to `CLOSE_HOPS` in `--blast`,
  which under-reports a blast radius the same way.
- **How does it unify?** A reachability answer is only as good as the question the
  constant was chosen for. `boot:server/index.js` made one question answer "yes"
  always; `CLOSE_HOPS` made this one answer "no" at the tail. Same generator, same
  week, opposite direction.
