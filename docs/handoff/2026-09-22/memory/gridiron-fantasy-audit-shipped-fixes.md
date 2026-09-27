---
name: gridiron-fantasy-audit-shipped-fixes
description: What #21, #27 and #30 fixed on Gridiron HQ's fantasy side — all three shipped in the 2026-09-19 release train.
metadata:
  type: project
---

Part of [[gridiron-fantasy-audit-findings]].

**All three SHIPPED.** They were draft PRs stacked on
`claude/project-thread-3ldl77-docs`; the release train merged to `main` at
**791b131** on 2026-09-19 (tree `1b2341aa…`). Verified by ancestry, not by
anyone's summary: all three branch heads are ancestors of main, and the content
is present (`suit up and see the ball` in `lineup-brain.js` and
`WaiverWire.tsx`, the fitted-basis line in `Lineup.tsx`, migration
`062_league_payload_season.js`). GitHub may still list them as `draft` — main
moved by a direct push rather than the merge button, so the auto-close lags.

**#21 — stop the fantasy surfaces stating things they do not know.**
League-analysis unpriced-guard; waiver name normalisation and coverage; the
"good sign about the roster" all-clear; `refreshLeagueRosters` recording ok with
zero synced; three jobs returning a skip as a string; the ESPN matchup-period
read after the pre-draft fallback; the D/ST join. Plus migration 062.

**#27 — Start/Sit and the matchup card: stop narrating zeros as findings.**
"Only option" vs "no projection"; the 0-vs-0 matchup verdict; unfilled lineup
slots; and **the chance-to-play basis stated in BOTH states** — the degraded
panel already existed, but the fitted path rendered nothing, so a measured
percentage and a hand-set constant looked identical on screen.

**#30 — the draft board refuses to rank when there is no market.** It was
serving SQL row order when `computeConsensus()` came back empty (which is why
it recommended the Arizona Cardinals depth chart in roster order). Plus the
`board_rank` off-by-two and the advisor's fabricated negatives.

**#16 was closed** as a duplicate of the scheduler thread's #17.

## The wording that #21 and #27 settled

"likely to play" -> **"likely to suit up and see the ball"**, because the
fitted event is **recorded usage** — a target, a carry or an attempt — not
dressing. See [[gridiron-availability-fit-what-the-rate-means]]. The long
comment block in `lineup-brain.js` is the argument; keep it, do not paraphrase
it, and do not let a rewrite lose the distinction.

**#27 also added a structured `availability_basis`** per warning and on the
payload (`lineup-brain.js:585`), `role` | `pooled` | `constants`.

Full write-up: `/mnt/project-files/fantasy-audit-2026-09-19.md`.
