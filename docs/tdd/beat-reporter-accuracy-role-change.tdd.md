# TDD evidence: beat reporter source map, role_change slice (2026-09-22)

**Item:** the second beat-reporter claim_type, following directly from the injury_status
slice (`docs/tdd/beat-reporter-accuracy-injury-status.tdd.md`) and its own Item note that
flagged `role_change` as the natural next one — same file, same `sourceTrustScore`/
Coach-catalog surface, a different ground truth. Picked under the coordinator's
self-direction delegation; reported before starting.
**Files:** `server/services/beat-reporter-accuracy.js` (extended — `classifyRoleDirection`,
`resolveRoleChangeClaim`, `resolveRoleChangeClaims`, and a `locateGameAndPlayer` +
`resolveAndStore` refactor shared with the injury_status resolver), test
`test/beat-reporter-accuracy.test.js` (extended).
**Reads only, never modified:** `server/services/nfl-news-signal.js` (`ROLE_RULES`,
imported and reused for direction classification — not copied), `server/services/
nfl-news-events.js` (read to confirm `role_change` is a real, general claim_type distinct
from the press-conference-only `role_change_unconfirmed` branch, and that neither stores a
`predicted_direction` column — that is this file's own derived field, same as
injury_status).
**LLM spend:** $0. `classifyRoleDirection` is a deterministic regex read (reusing
`ROLE_RULES`), not a model call.
**Environment:** cloud box, isolated temp SQLite per test file, same as the rest of this
suite. **Per the standing "find real data before guessing" rule, a real hand-check against
2025 nflverse snap-count data was run again** (§6) — this time it did not find a bug, which
is itself evidence worth recording (the first slice's hand-check found two; this one
validates the design held up without needing a third fix).

## 1. What this slice does

`role_change` is the second of the four remaining claim_types the injury_status evidence
file named as not-yet-attempted (`role_change`, `transaction`, `return_from_injury`,
`suspension`). It resolves a claim like "he will be the starting running back this week" or
"he has been benched" against the player's own snap-share history:

- **Direction** is read from the claim text with `classifyRoleDirection`, which reuses
  `ROLE_RULES` from `nfl-news-signal.js` rather than writing a second copy of the
  vocabulary — the same discipline `nfl-news-events.js`'s own `polarityOf()` follows for
  its contradiction detector. A starter-confirmed or expanded-role claim reads `role_up`;
  benched or reduced-role reads `role_down`.
- **Ground truth** is `offense_pct` (not `offense_snaps` — injury_status only needed to
  know played-or-not, role_change needs the actual share): the most recent week with data
  *before* the claim's game week, compared to the claim's own game week. A swing of at
  least 10 percentage points (`ROLE_CHANGE_THRESHOLD = 0.10`) in the predicted direction is
  `confirmed`; that large a swing the other way is `contradicted`; anything smaller is
  `unresolved` with a printed reason rather than forced either way — a flat week is not
  evidence for or against a role claim, and reporting it as one would be exactly the kind
  of overclaimed precision this whole feature exists to avoid.
- **`locateGameAndPlayer`** — team lookup, first game on/after the claim date, player
  resolution, offense-snap-position guard — was factored out of `resolveInjuryClaim` into a
  shared helper both resolvers call. This is real duplication once a second claim_type
  exists (both needed the identical four-step lookup), not speculative abstraction: with a
  third claim_type likely later (`transaction`/`return_from_injury`/`suspension`), the
  alternative was a third copy-paste. `resolveAndStore` (the upsert loop) is the same kind
  of factor for `resolveInjuryClaims`/`resolveRoleChangeClaims`.

**Design decision not otherwise written down:** the "before" week is the single most recent
prior week with a snap-share row, not a multi-week rolling average. A rolling baseline
would smooth out noise better but adds a window-size parameter with no principled default
yet and no real data pattern examined here to set it from. Single-prior-week is the
simplest defensible comparison and is named as a known limit (§7), not silently assumed.

## 2. Gate

Same honesty gate as the injury_status slice's catalog work: `sourceTrustScore` and
`orderByTrust` are unchanged and already generic over `claim_type` (no code touched there),
so `role_change` claims pool separately from `injury_status` ones when a caller passes
`claimType: 'role_change'`, and together when it does not — this was true before this slice
and is exercised by the existing `sourceTrustScore: claimType filter scopes the sample`
test, not a new behavior.

## 3. Regression

Targeted run (all green):

```
node --test test/beat-reporter-accuracy.test.js test/coach-catalog.test.js test/coach-tools.test.js
# tests 71
# pass 71
# fail 0
```

`npm run lint` — clean (915 files).

**Full suite, 2x-verify, corrected guard form** (per the coordinator's correction after the
prior unit: no `set -e` wrapping the check so a real failure doesn't kill the shell before
the guard can read it, `rc=0; npm run check || rc=$?` to capture the real exit code, no
`| tee` in the pipeline, the log written outside the repo, and a
`find . -path ./.git -prune -o -newermt "@$t0" -type f -print` pass afterward to catch
anything the run touched outside git's own view):

| pass | worktree | exit | tree hash before/after | status before/after | tests | files touched outside `client/dist/` |
|---|---|---|---|---|---|---|
| 1 | `/tmp/claude-0/role-verify-1` | 0 | `60ca9843` / `60ca9843` (unchanged) | empty/empty | 3151/3151 pass, 41 skipped, 0 fail | none — `find -newermt` listed only the 25 files `vite build` regenerates under `client/dist/` (gitignored, expected) |
| 2 | `/tmp/claude-0/role-verify-2` | 0 | `60ca9843` / `60ca9843` (unchanged) | empty/empty | 3151/3151 pass, 41 skipped, 0 fail | none (checked with `client/dist` pruned from the `find`, output empty) |

Both passes identical. Pushed to `claude/coach-grounded-4l8hno` (`74c5eff`) only after both
cleared.

## 4. Test specification

`test/beat-reporter-accuracy.test.js`, new tests (plus a `setSnapsPct` fixture helper and a
`claimType` parameter added to the existing `makeEvent` helper, default unchanged):

| test | asserts |
|---|---|
| classifyRoleDirection reads a confirmed-starter or expanded-role claim as role_up | two phrasings from `ROLE_RULES`'s `role_up`-shaped rules both map to `'role_up'` |
| classifyRoleDirection reads a benched or reduced-role claim as role_down | two phrasings from the `role_down`-shaped rules both map to `'role_down'` |
| classifyRoleDirection returns null when the text carries no role-change signal | no match → `null`, never a guess |
| resolveRoleChangeClaim: role_up confirmed by a real snap-share jump | 0.30→0.55 (delta ≥ threshold) with a role_up claim → `confirmed` |
| resolveRoleChangeClaim: role_up contradicted when the share actually fell | 0.50→0.20 with a role_up claim → `contradicted` |
| resolveRoleChangeClaim: role_down confirmed by a real snap-share drop | 0.65→0.25 with a role_down claim → `confirmed` |
| resolveRoleChangeClaim: unresolved when the share barely moved | 0.40→0.45 (delta below threshold) → `unresolved`, reason names the move and says it's too small to grade |
| resolveRoleChangeClaim: unresolved when there is no prior-week snap share | claim's game is the player's first dated snap-share row → `unresolved`, "no prior-week..." |
| resolveRoleChangeClaim: unresolved for a defensive position | same `OFFENSE_SNAP_POSITIONS` guard as injury_status, reused via `locateGameAndPlayer` |
| resolveRoleChangeClaim: unresolved when the game has not been played yet | same guard as injury_status, reused |
| resolveRoleChangeClaim: unresolved when no role direction classifies | claim text has no role-change language → `predicted_direction: null`, `unresolved` |
| resolveRoleChangeClaims writes one upserted row per role_change event, and leaves injury_status alone | batch resolver only reads `claim_type='role_change'` events; an injury_status event in the same run gets no row; re-running does not duplicate |

Every pre-existing injury_status test still passes unchanged against the refactored
`resolveInjuryClaim`/`resolveInjuryClaims` — the shared-helper extraction did not change
any of their observable behavior or reason strings.

**A note on test fixture dates:** the game-lookup query (`date >= claimDate ORDER BY date
ASC LIMIT 1`) reads across *all* of the fixture team's scheduled games, not scoped to a
season/week, and fixtures accumulate across the whole file as tests run in file order. The
new tests' dates are deliberately pushed out to 2027 (distinct from every 2026 date already
in use and from each other) so an earlier or later test's game can never answer this one's
query — this was caught by an actual `UNIQUE(season, team_id, week)` constraint violation
and a wrong-game pick during development, both fixed before RED was declared clean.

## 5. Real-data hand-check (2025, nflverse) — no bug found this time

Same methodology as the injury_status slice (§6 there): free public 2025 data from
nflverse's GitHub releases (`snap_counts_2025.csv`, `games.csv`, already downloaded this
session), scanned for real week-over-week `offense_pct` swings, then real claim text
written in reporter style asserting the direction those real swings actually show (same
"what's real and what isn't" boundary as before: the swings and the ground truth are fully
real; the claim TEXT is constructed, since no free source of historical beat-reporter tweet
text at claim-level granularity exists — see the injury_status evidence file §1 for why).

Four real 2025 cases:

| player | team/pos | weeks | real offense_pct swing | claim | resolver verdict |
|---|---|---|---|---|---|
| Dont'e Thornton | LV/WR | 6→7 | 0.03 → 0.86 (+0.83) | "expanded role in the passing game" (role_up) | **confirmed** |
| David Moore | CAR/WR | 3→4 | 0.97 → 0.01 (−0.96) | "demoted... backup role" (role_down) | **confirmed** |
| Juwan Johnson | NO/TE | 15→16 | 0.61 → 0.65 (+0.04) | "remains the starting tight end" (role_up) | **unresolved** — "not a big enough move (0.04) to grade either way" |
| David Moore (same real drop, mis-worded claim) | CAR/WR | 3→4 | 0.97 → 0.01 (−0.96) | "expanded role in the passing game" (role_up, wrong direction on purpose) | **contradicted** |

All four verdicts are exactly the ones the real numbers call for. Unlike the injury_status
hand-check, this one did not surface a bug — recorded as a real result, not omitted because
it was uneventful: the design (single-prior-week baseline, 10-point threshold,
`locateGameAndPlayer` reuse) held up against real, previously-unseen swings on the first
pass.

## 6. File ownership

`beat-reporter-accuracy.js` and its test file are this thread's own from the prior unit —
no shared file touched. `nfl-news-signal.js`'s `ROLE_RULES` is read/imported, not modified.

## 7. Known limits

- **Single-prior-week baseline, not a rolling average.** A player who is genuinely
  trending (three weeks of steady share growth, say) is graded only on the single most
  recent prior week vs. the claim's week — a real but smaller trend could land inside the
  10-point neutral band and read as `unresolved` even where a smoother read might have
  called it. No real data pattern was examined to justify a specific window size beyond
  one week, so one week is what shipped; widening this is a candidate follow-up, not
  silently assumed here.
- **10-percentage-point threshold is a stated choice, not a fitted one.** It was picked to
  be clearly larger than ordinary week-to-week noise (both real hand-check "flat" and
  "moved" examples in §5 sit well clear of it, at 0.04 and 0.83+/-0.96 respectively) but has
  not been validated against a distribution of real week-to-week swings at scale.
- **Same claim-text limitation as injury_status**: no free source of historical
  beat-reporter tweet text exists, so the real hand-check's claim text is constructed
  reporter-style language over real ground truth, not sampled real claims. The ground truth
  side (`offense_pct` swings) is fully real.
