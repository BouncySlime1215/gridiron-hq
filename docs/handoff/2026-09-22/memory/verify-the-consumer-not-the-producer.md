---
name: verify-the-consumer-not-the-producer
description: A field being served does not mean it is rendered — check the consumer, and check what can REACH a fallback before calling it live.
metadata:
  type: feedback
---

Five errors in one evening on the Gridiron HQ project, 2026-09-19, all the
same shape, all caught by peer sessions rather than by me.

1. Claimed `#21 already renders availability_basis on the waiver board`.
   `waiver-wire.js:332-333` serves `availability_basis` and
   `availability_note`; `client/src/components/lineup/WaiverWire.tsx` declares
   **neither** — not in its interface, not in its body. The server carrying a
   field does not mean a client reads it.
2. Claimed the `?? 0.9` fallback in `lineup-brain.js` was live for K/DEF. The
   `risky` filter (`:553`) coerces null to 1, which fails `< 0.75`, so nothing
   reaches it. A fallback expression is only live if something can REACH it.
3. Claimed a "% of weeks" string existed nowhere. It exists on `main`
   (`lineup-brain.js:452`). I had grepped only my own working tree and
   generalised to two other trees.
4. Claimed the K/DEF 0.92 reordered the Start/Sit headline swap recommendation
   via `trade-engine.js:2827`. **`bestLineup` filters its pool to SCORED at
   `:615` and `lineupSlots` filters slots at `:542`**, so a K or DEF is never
   in `optimalPlayers` and never reaches `:2827`'s `x.in`. I traced the site
   FORWARD into the sort and never traced its input BACKWARD to where the pool
   was built.

5. Claimed the deploy "inverts the K/DEF availability bias" (relatively
   over-valued by ~11 points on the constants path, under-valued by ~3 after
   the fit) — and, when that was challenged, retreated twice to narrower
   versions that were also wrong. **The 0.92 prices nothing at all:** `sched`
   is gated on `SCORED.has(p.position)` (`trade-engine.js:334`), K/DEF take a
   fallback whose `games` is `[]`, so `thisGame` is null and `currentWeekPpg`
   is **0** (`:359`). `decisionPpg = 0.25*0 + 0.75*rosPpg` and `rosPpg` has no
   availability term; `lineup-brain.js:279` uses `??` so a 0 does not fall
   through. Each retreat was one step less wrong and still wrong — **a
   narrowed claim is not a verified claim.**

**Why:** each was an inference one step past what was checked, stated with the
same confidence as the checked part. That is worse than an unchecked claim,
because the checked half lends credibility to the unchecked half.

**How to apply:**
- Producer verified is not consumer verified. Grep the consumer.
- Trace a site's inputs BACKWARD to where they are built, not only its outputs
  forward to where they are used. Error 4 was a correct forward trace onto an
  input that can never occur.
- When a claim is challenged, do not retreat to a narrower version of it —
  re-derive it, or drop it. Errors 4 and 5 were the same claim retreating
  twice; each retreat felt safer and was still unverified.
- A constant that multiplies a quantity is worth nothing until you check that
  quantity is non-zero on the path in question.
- State which tree you verified on. The K/DEF retraction was found on the old
  main, where the code differs cosmetically from the shipped tree; anyone
  re-checking the quoted snippet against the shipped tree would not find it
  and could wrongly dismiss a correct retraction.
- Before calling a fallback or default "live", read the filter, the query and
  the early returns that decide what can arrive there.
- A grep result is about the tree you grepped. Name that tree, or run it
  against the ones you are claiming about (`git show <ref>:<path>`).
- Do not check a *plan* branch for feature code — see
  [[gridiron-deployed-build-bracket]] for the release-train-branch trap that
  nearly produced a false regression alarm.

See [[gridiron-decision-routing]] for the related rule about relayed claims.
