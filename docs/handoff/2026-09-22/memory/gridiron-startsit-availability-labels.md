---
name: gridiron-startsit-availability-labels
description: How Gridiron HQ labels chance-to-play across Start/Sit and the waiver board — the "% of weeks" confusion, corrected twice, and the third unlabelled surface.
metadata:
  type: project
---

Part of [[gridiron-fantasy-audit-findings]]. Pinned to `origin/main`
**791b131**.

## The "% of weeks" reading — CORRECTED TWICE

**The string DOES exist on the old main**, `lineup-brain.js:452`:
`only plays about ${...}% of weeks`. This session claimed it existed nowhere,
having grepped only the train branch (where the base already fixed it) and then
generalised to main and to the deployed build without checking either. It ships
fixed.

**And the juxtaposition claim was also wrong.** `availabilityDegradation`
(`contingency.js:611`) branches on basis. The "actually plays about 95% of
weeks" wording is ONLY in the **pooled** effect string. The **constants**
string — which is what was live — reads "every chance to play below is a
hand-set constant and a career durability prior, not a measured rate", with no
"% of weeks" in it. So the this-week-beside-%-of-weeks juxtaposition is real on
the **pooled** path, not on the constants one.

**Both errors are the same shape:** grepping one tree and asserting about
another, and reading one branch of a conditional as if it were the only one.
See [[verify-the-consumer-not-the-producer]].

## The two quantities, and which one is which

- **`active_probability`** — THIS week's chance, injury report and role folded
  in. Not a season frequency.
- **`durability_prior`** (`contingency.js:911`) — the base prior from
  `availability()` (`:40`), games with recorded usage over tenure x 17. **This
  is the "% of weeks" quantity.** It already exists per player on
  `weeklyAvailability` and is simply not forwarded to Start/Sit. Forwarding it
  is a forward, not a computation.

Neither is the fitted rate; the fit is what turns prior + report + role into
`active_probability`.

## The waiver board is a THIRD unlabelled surface

`waiver-wire.js` serves `availability_basis` **and** `availability_note`;
`client/src/components/lineup/WaiverWire.tsx` declares **neither**, in its
interface or its body. #21's only hunk there is the one-line wording change.
So the two-state treatment exists on Start/Sit only. (This session claimed #21
rendered it — wrong.) `season-sim.js` has no basis at all, which matters most,
since the fit moves the odds furthest.

`ClaimRow` renders a per-player chip, "about N% to play this week", **only
below 0.6**. Agreed with the UI-rebuild thread that it converges on the "suit
up and see the ball" wording. Its population also changes at the fit: healthy
starters move up (0.805 -> ~0.952) and stay silent, while the designated band
is the one place the fit moves numbers DOWN — so **more warning chips appear
after the fit. That is the threshold working better, not a regression**, and
someone will report it as one.

## The `?? 0.9` fallback is unreachable

`risky` filters `(active_probability ?? 1) < 0.75 || bye === week`
(`lineup-brain.js`), so a null coerces to 1, fails the threshold, and can only
enter via the bye branch — which returns early. Dead code, a landmine if that
threshold moves. The related K/DEF `?? 0.92` claims were **retracted in full**:
see [[gridiron-availability-fit-what-the-rate-means]].
