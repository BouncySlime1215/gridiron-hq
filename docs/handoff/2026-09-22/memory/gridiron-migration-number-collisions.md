---
name: gridiron-migration-number-collisions
description: Duplicate migration numbers in this repo are expected and must not be renumbered; PR #39 documents why and makes lint reject new ones.
metadata:
  type: project
  modified: 2026-09-19T21:30:00.000Z
---

Migration numbers are assigned by hand against what the author can see —
merged history plus their own branch, never the other branches in flight. In
September 2026 `main` sat at **052** while five branches numbered
independently into 053-062.

**It happened twice.** #14 and #19 both took 061; #14 renumbered to 062, which
two other branches had already claimed:

- `062_google_identity_and_invites.js` (#14) — merged
- `062_league_payload_season.js` (`5f9c3y-drafts`) — merged
- `062_roster_weekly_panel.js` (`f921do`) — **still in flight**

`main` now has 63 migrations and one duplicated number, zero duplicated names.

**Harmless, verified not assumed.** Distinct `name` exports (which is what the
runner keys on — see [[gridiron-migration-name-key]]), one `schema_migrations`
row each, disjoint schema (`users`/`user_identities`/`auth_invites`,
`leagues.payload_season`, `nfl_roster_weekly`), and none reads a table another
creates. The runner's `.sort()` is lexicographic and deterministic, so the
order is fixed — what is lost is the number's meaning, not correctness.

**Never renumber.** It is a re-roll against the same incomplete information
(that is how 062 got three claimants), and once a file has run live, renaming
it re-runs it.

## PR #39 — `claude/project-thread-o3wt2p-migration-docs`, based on main

`server/migrations/README.md` plus three assertions in `scripts/lint.mjs`:
`name` equals filename, no duplicate `name`, no duplicate number. A `name`
export the regex cannot parse fails rather than passes.

**`062` is exempt from the number check, by number rather than by filename**,
so `f921do`'s third 062 lands clean when it merges. A guard that turns main
red the day an in-flight branch merges is worse than no guard — the same trap
as a test written by the change that fixes the bug.

Verified by writing each failure into `server/migrations/` and watching lint
reject it: mismatched name, duplicate name, duplicate number, unparseable
name export — plus a third 062 that must still pass.

## The lint guard was tested against a deliberately broken tree

2026-09-19 22:15Z, on `origin/claude/project-thread-o3wt2p-migration-docs`
(`7bcce55`), five cases run one at a time, clean tree before and after:

| case | result |
|---|---|
| `name` export not matching the filename (the half-rename) | **exit 1**, names the file, the declared name and the README section |
| two files exporting the same `name` | **exit 1**, twice: the mismatch and "would be silently skipped" |
| two files sharing number `063` | **exit 1**, lists both filenames, says pick an unused number rather than renumbering |
| `export const name = stem;` (computed, unreadable) | **exit 1**, asks for the single-line literal form |
| a third `062_…` (the landed-duplicate exemption) | **exit 0** — the exemption is by NUMBER, so `f921do`'s in-flight `062_roster_weekly_panel.js` lands clean |

Clean tree: exit 0, "Checked 63 migrations". So the checker fails on the thing
it claims to catch, which is the bar this project sets — RAN is weaker than
PRODUCED.
