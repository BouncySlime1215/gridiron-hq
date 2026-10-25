---
name: anchored-probe-beats-a-fixed-poll
description: When a fixed-interval poll aliases against a periodic fault, anchor reads to the subject's own age instead - and read the SHAPE of the failure, because a cliff and a ramp have different causes.
metadata:
  type: feedback
---

Built 02:00Z 2026-09-20 on gridiron-hq, after the 60 s health poll produced a
confident wrong claim. Companion to [[overnight-restart-count-traps]] trap 3,
which is how the aliasing was spotted; this is what to do about it.

**Why:** the passive poll had run for three hours and could not answer the
question the whole plan turned on. The anchored probe answered it in four
minutes and falsified a claim we had been repeating all night.

## The technique
1. Take a read that yields the subject's own age (`uptime_s` here) AND the
   request's elapsed time. If age >= elapsed, the process that answered is the
   one that received the request, so `start = now - age` is sound.
2. From that start, time subsequent reads to land at CHOSEN ages - straight
   through whatever region the fixed poll never sampled.
3. Record the age each read was ISSUED at, not answered at.
4. Attribute a read to the anchor only if the answering subject is still the
   same one: `drift = expected_age - reported_age`, and anything past a few
   seconds means it changed underneath you. Mark it, re-anchor, do not use it.

Result: onset bracketed to (94, 110] on eight consecutive lives, where three
hours of 60 s polling had said only "never seen past 72 s", which was the
sampler's edge and not the app's. Script and header reasoning:
`/mnt/project-files/blind-window-probe.sh`.

## The discriminator worth more than the number
29 reads landed past age 78 and the slowest took **0.46 s**. Fully healthy, then
nothing, one step later. **A cliff means one synchronous operation seized the
loop. A ramp would mean memory pressure, connection exhaustion or gradual lock
contention** - each wanting a different fix. Measuring only "is it up" cannot
tell those apart; measuring latency across the approach can.

## How to apply
When something fails periodically, do not only count the failures. Sample
across one subject's lifetime and plot latency against age. Ask whether the
instrument can see the region the claim is about - and if the poll interval
divides the fault period near-evenly, it cannot.
