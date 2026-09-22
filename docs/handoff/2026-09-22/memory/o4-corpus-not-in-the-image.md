---
name: o4-corpus-not-in-the-image
description: The Sleeper history corpus the O4 Team Outlook model fits on is never copied into the Fly image; the fix is the stored fit on migration 065, and a consumer still needs an owner.
metadata:
  type: project
  modified: 2026-09-20T02:55:00.000Z
---

**Verified 2026-09-20 by reading both files.** The O4 / Team Outlook model cannot
run on the live app by construction — packaging, not a bug.

- `history-corpus.js:48` opens `process.cwd()/data/derived/sleeper_history.sqlite`
  **read-only and returns `null` rather than throwing** when absent.
- `Dockerfile`'s runtime stage copies exactly `client/dist`, `server`, `scripts`.
  **`data/` is never in the image.** On Fly `process.cwd()` is `/app`.

So `fitOutlook`, `fitThresholds`, `verdictFor`, `varianceComponents`'s k and the
`no_results_yet` decomposition all resolve to nothing in production while working
on a dev checkout. **That is why `team-outlook.js` had no consumer** — a module
that cannot answer where it would be asked. An `accepted_orphan_modules` line
would have recorded the symptom and buried the cause.

## Solved: the fit is now storable (branch, not yet a PR)

`claude/project-thread-f921do-outlook-fit-hold`, head `e76357b`, held by the
01:58Z GitHub freeze. **Migration `065_outlook_fit_store.js`** —
`outlook_fits` + `outlook_fit_weeks`, partial unique index so two active fits are
impossible. `server/services/outlook-fit-store.js` returns `fitOutlook`'s own
shape so `predictOutlook`/`decompose`/`signCheck` take it unchanged.
`scripts/fit-team-outlook.mjs` fits where the corpus is (`--write` opt-in, dry run
by default, refuses a sign-check failure or a k at its cap).

**Two traps it guards, both silent:** the coefficient vectors are POSITIONAL, so
the stored feature list is compared with `OUTLOOK_FEATURES` on every read and a
disagreement refuses the fit; and a lost `k` makes `shrinkToLeague` NaN, every
probability NaN, and **`verdictFor(NaN, …)` returns `'fine'`** — a whole league
told it is fine with no error. See [[gridiron-failure-modes]].

**065 is the first unused migration number** (062 has three claimants, 063 is
#48's, 064 is #47's) and `server/migrations/README.md` on PR #39 forbids
renumbering an applied file. Do not take 065 for anything else.

## This container HAS the corpus

Measured live 2026-09-20: **2,500 leagues, 27,586 team-seasons, seasons 2021-2025,
k = 7.2** (the `7.5` in `history-corpus.js`'s header is a different season set),
weeks 2-8 all sign-clean, thresholds `watch 0.4121 / act_candidate 0.1986`.
186,678 panel rows priced from memory and from storage: **0 mismatches**.
The older "~1,913 leagues" figure is stale.

**Still open:** whether Nick's own clone has the corpus built, so whether the
audit's published O4 figures were measured on this population or on his twelve
league-seasons. Confirm before quoting them to him.

**Still needed:** a consumer. Nothing reads `activeOutlookFit()` yet, and
`outlookFitStatus()` exists so whoever wires it can print "not fitted on this
deployment" instead of an empty chip. No route file for it belongs to the fantasy
plan thread, so it needs allocating.
