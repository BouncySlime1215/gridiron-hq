# TDD evidence: Coach catalog + tool for beat-reporter accuracy (2026-09-22)

**Item:** self-picked next unit under the coordinator's delegation ("pick your own next
unit from your remaining Phase A scope — grounded answers / negotiation reads"). Follows
directly from the injury_status slice just shipped
(`docs/tdd/beat-reporter-accuracy-injury-status.tdd.md`): that slice built a real,
real-data-validated resolver and trust score, but Coach — the only surface that answers a
grounded football question — had no catalog entry for either table it reads or writes, so
"which beat reporters actually predict outcomes" had no path to a cited answer at all.
**Files:** `server/services/coach/catalog.js` (two new entries: `nfl_news_events`,
`beat_reporter_claim_resolutions`), `server/services/coach/tools.js` (one new tool,
`source_trust`, plus a `nonEmptyString` input validator alongside the existing `int`/
`team` ones); tests `test/coach-catalog.test.js`, `test/coach-tools.test.js`.
**Reads only, never modified:** `server/services/beat-reporter-accuracy.js` (last unit's
file — `sourceTrustScore` is called, not re-implemented, per this file's own "NEVER
RE-IMPLEMENT" rule), `server/services/nfl-prospective-collection.js` (read to confirm its
own `RESTART_LIMITATION` constant, which is what the `by_hand` collection-mode claim below
rests on).
**LLM spend:** $0. No Anthropic calls — this is catalog metadata and one function-wrapping
tool, same shape as `who_plays`/`team_tendencies`.
**Environment:** cloud box, isolated temp SQLite per test file (`GRIDIRON_DB_PATH`), same
as every other Coach test. No production read needed or attempted; nothing here depends on
prod data.

## 1. What this slice does

Two additions, both mechanical extensions of existing Coach infrastructure, not new
architecture:

1. **Catalog entries** for `nfl_news_events` and `beat_reporter_claim_resolutions`
   (`catalog.js`). This alone makes both tables reachable through the existing
   `sql_select` tool — a raw claim, or a raw resolution row, is now something Coach can
   retrieve and cite.
2. **`source_trust` tool** (`tools.js`), wrapping `sourceTrustScore` from
   `beat-reporter-accuracy.js`. `sql_select` cannot answer "how much should I trust this
   reporter" on its own: `sourceTrustScore`'s pooled-shrinkage math (blending a thin
   sample toward the claim-type baseline so a lucky 2-for-2 doesn't read as measured 100%)
   is exactly the kind of number the tools.js header says has to go through a service
   wrapper rather than be reimplemented as SQL or, worse, computed in prose.

`orderByTrust` (the same file's list-reordering helper) is **not** wrapped as a tool: its
signature takes a `scoreOf` callback, which has no JSON representation, and its job is
display ordering for a list Coach already has in hand — not a new number to retrieve. If a
future answer needs a *list* of reporters ranked by trust, that is a `sql_select` plus
`compute`/prose-level sorting, or, if the shrinkage math turns out to matter for a ranked
list too, a second tool built then, not speculatively now.

## 2. Gate: the honesty check, not just "does it run"

The catalog's own header states the standard this has to clear: `collection` is "not
decoration" — a `by_hand` table has to show its age, an `auto` one does not. Before writing
either entry, both tables' actual refresh mechanism was checked, not assumed:

- `nfl_news_events` is written only by `runProspectiveCollection`
  (`server/services/nfl-prospective-collection.js:93`), whose own
  `RESTART_LIMITATION` constant (line 41) says: *"Manual, on-demand collection only — not
  a background daemon."* Grepped for any scheduler/job wiring calling it — none found.
- `beat_reporter_claim_resolutions` is written only by `resolveInjuryClaims`
  (`server/services/beat-reporter-accuracy.js:168`). Grepped the whole `server/` tree for
  any caller outside `beat-reporter-accuracy.js` itself and the test file — none found.

Marking either `'auto'` would have been exactly the silent-freshness bug the catalog's
header calls out by name ("Finding 7... every manager read in the app comes from rows a
person collected by hand and no surface said so"). Both are marked `'by_hand'`, and
`coach-catalog.test.js` now pins that claim so a future job wiring flips it on purpose,
not by drift.

## 3. Regression

Full targeted run before the wider suite, three files together (all green):

```
node --test test/coach-catalog.test.js test/coach-tools.test.js test/beat-reporter-accuracy.test.js
# tests 59
# pass 59
# fail 0
```

`npm run lint` — clean (915 files, syntax check).

**Full suite, 2x-verify per the project's suite-figure rule**, each pass in its own `git
worktree` with its own `npm ci` (never the main checkout — a concurrent checkout switch
there would silently invalidate the run), `git status --porcelain` empty AND `git
write-tree` identical before and after each run (the corrected form of the guard — a bare
tree-hash check only covers the INDEX and misses unstaged edits):

| pass | worktree | tree hash before | tree hash after | status before/after | node_modules mtime before/after | tests | lint | build | start:smoke |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `/tmp/claude-0/coach-verify-1` | `c68d139b` | `c68d139b` (unchanged) | empty/empty | `1790062787` → unchanged | 3139/3139 pass, 41 skipped, 0 fail | clean | ✓ | ✓ passed on isolated database (32 teams) |
| 2 | `/tmp/claude-0/coach-verify-2` | `c68d139b` | `c68d139b` (unchanged) | empty/empty | `1790062811` → `1790063225` (fresh `npm ci`, expected) | 3139/3139 pass, 41 skipped, 0 fail | clean | ✓ | ✓ passed on isolated database (32 teams) |

Both runs identical: same tree hash, same pass/fail/skip counts. Pushed to
`claude/coach-grounded-4l8hno` (`709ef80`) only after both passes cleared, per the
project's "2x work check min" rule.

## 4. Test specification

`test/coach-catalog.test.js`, one new test:

| test | asserts |
|---|---|
| the beat-reporter accuracy tables are readable and say honestly they are hand-run | `nfl_news_events` and `beat_reporter_claim_resolutions` are in `readableTables()`; both entries' `collection` is `'by_hand'`, not `'auto'` |

`test/coach-tools.test.js`, three new tests:

| test | asserts |
|---|---|
| source_trust wraps sourceTrustScore, the pooled-shrinkage math sql_select cannot do | seeding 6 resolved claims (5 confirmed, 1 contradicted) for one handle returns `state: 'measured'`, `sample_size: 6`, and the ledger entry's `tables` includes `beat_reporter_claim_resolutions` |
| source_trust reports "none" honestly for a handle with zero resolved claims, never a score | an unseen handle returns `state: 'none'`, `score: null` — never a fabricated 0 |
| source_trust refuses a blank handle rather than scoring an empty string | whitespace-only `handle` throws `CoachToolError` before reaching `sourceTrustScore` |

Every pre-existing test in both files still passes unchanged, including the ones that walk
`COACH_TOOLS` generically (`every tool declares a name...`, `every service tool names a
function that really exists...`) — the new tool needed no special-casing anywhere in that
machinery, which is itself a small piece of evidence the `service()` wrapper pattern is
doing its job.

## 5. File ownership

Both files touched (`catalog.js`, `tools.js`) are Coach's own, not shared with another
thread's lane. `beat-reporter-accuracy.js` (read, not written) is this thread's own file
from the prior unit. No route file, no client file, no other thread's table was touched.
Composer protocol: this is a strictly additive slice (two catalog entries, one tool
declaration, one validator) — nothing existing was restructured to make room for it.

## 6. Known limits

- **No end-to-end "ask Coach a beat-reporter question" test.** This wires the plumbing
  (catalog + tool); it does not exercise Coach's full answer loop (model call → tool call →
  cited answer) end to end, because that loop's own tests already cover the mechanism
  generically (`coach-tools.test.js`'s ledger/citation tests) and doing it again here would
  be re-testing `runCoachTool`, not this slice.
- **Both tables are honestly `by_hand`.** Nothing in this unit wires either
  `runProspectiveCollection` or `resolveInjuryClaims` into a scheduler job — that is a
  separate, larger decision (how often, what it costs, whether Nick wants it automatic at
  all) that this unit was not asked to make and did not make. A Coach answer built on
  either table today will carry a `by_hand` provenance flag and should say so.
- **`orderByTrust` is not exposed as a tool** — see §1 for why (no JSON-representable
  callback, and no concrete ranked-list question has asked for it yet).
