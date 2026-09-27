---
name: overnight-restart-count-traps
description: Three ways a sampled health log silently lies about restarts - two that miscount, and one where a fixed poll aliases against the cycle and caps the observed lifetime.
metadata:
  type: feedback
---

Companion to [[overnight-restart-log]], which says where the files are.

**Why:** both traps produce a confident-looking wrong number rather than an
error, which is the failure shape this project keeps finding in its own code.
Neither was found by reasoning about the reducer; both came from building a
fixture with known answers and trying to break it.

## 1. Naive distinct `derived_start` values OVERCOUNT
`uptime_s` is whole seconds, so two reads of ONE process derive starts 1-2s
apart, and at a 60s cadence against a ~90s serving window most processes get
read more than once. On a fixture with known answers: naive count 5, truth 3.

Fix: cluster starts — any two within 5s are the same process. 5s is above
`uptime_s` rounding plus clock skew and far below the ~160s cycle, so it cannot
merge two real restarts. Verified load-bearing: `TOL=200` gives 4 where the
answer is 5.

## 2. A SIGNED difference UNDERCOUNTS
Derived starts are **not monotonic**: a crossed read derives a start slightly
ahead of a clean one, and a slow read can land out of order. A signed test
(`t - last > tol`) reads a backwards jump as "same process" and silently merges
two real restarts. Fixture reads 4 where the answer is 5.

Fix: absolute difference.

## 3. A FIXED poll ALIASES against a fixed cycle, capping observed lifetime
Found 01:50Z 2026-09-20, and it had already produced a wrong claim in the
release plan. The poll ran every 60s; the restart cycle measured 180s, mean and
median both, gaps 171-196s. 180 is exactly 3 x 60, so the reads were
**phase-locked**: every cycle got sampled at the same three points in a
process's life and never anywhere else. 41 of 54 clean reads caught an age of
55-58s, and **not one read all night saw an age between 73 and 170s**.

The wrong claim that came out of it: "the app has never been seen answering more
than 72 seconds into any life". True, and empty — 72s was the edge of where the
sampler looks, not the edge of what the app does. A thread sampling on a
different cadence saw 88-97s on the same app in the same window.

Fix: before quoting a max, min or "never seen past X" from a sampled log, divide
the cycle by the poll interval. A near-integer ratio means the extremes are
properties of the sampler. Jitter the interval, or read the distribution of
observed ages: a tight cluster with hard empty regions on both sides is
aliasing, not behaviour. Counts survive this (a start is either in a gap or not);
extremes do not.

## How to apply
When reducing a sampled log to a count, build a fixture whose answer you know
INCLUDING the adversarial rows — repeated reads of one subject, and out-of-order
timestamps — and confirm the naive method gets it wrong. A reducer that agrees
with the naive method on clean data tells you nothing.

## Live confirmation that clustering works on real rows
22:53:06Z crossed (`uptime_s` 13 after 17.4s) and 22:54:06Z clean (`uptime_s` 57
after 0.35s) derived the SAME start, 22:53:10Z, to the second. Two reads, one
process, counted once — and it confirms on live data the claim that a crossed
read's timestamp is sound even though its content is not.
