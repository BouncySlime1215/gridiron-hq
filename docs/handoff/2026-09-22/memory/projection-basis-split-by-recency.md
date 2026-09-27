---
name: projection-basis-split-by-recency
description: The fitted shrinkage reaches only the weekly projection path, by design — activeKVectorFor withholds the volume k from season-long callers because they accumulate evidence under a different recency, so playoff odds keep the hand-picked constants and only the odds surfaces are affected.
metadata:
  type: project
---

Settled 2026-09-19 ~21:40Z between the opportunity thread (who measured it) and
the UI-rebuild thread (who checked it in source and was wrong first). Verified
on merged main **791b131**. Supersedes the cache hypothesis in
[[projection-cache-survives-the-fit]], which is retracted as an explanation.

## The mechanism

`projections.js:461`:

```js
const k = kOverride === undefined ? activeKVectorFor(rr, { predictingSeason }) : kOverride;
```

`shrinkage-fit.js:515-521` strips every `VOLUME_METRIC_NAMES` entry unless
`isWeeklyRoleRecency(rr)`, returning null when nothing survives. The production
fit contains **only** volume metrics, so every season-long caller resolves to
null and keeps the hand-picked constants.

**The reason, in the code's own words** (`shrinkage-fit.js:500-513`) — quote it
rather than paraphrase: the volume specs are trained under `WEEKLY_ROLE_RECENCY`
(seasonDecay 0.05, week half-life 5), while season-long callers use `RECENCY`
(seasonDecay 0.35), where a season-old game counts seven times more. Applying a k
fitted for one weighting under the other is a units error. *"They are not claimed
to be right, only untested with the fitted k."*

So "0 of 1,130 season-long projections changed" is a **prediction of the code**,
not a surprising measurement. Say it that way: far stronger evidence.

**None of this exists on ffe4e72.** `activeKVectorFor`, `isWeeklyRoleRecency`
and `cutoffSafeKVector` arrived with #15. Four wrong-tree handoffs happened in
one evening; two were this thread's.

## Which SCREENS this actually reaches — checked, not inferred

The step from "these callers keep the constants" to "these screens show it" is
where two relayed framings broke. On 791b131:

| surface | basis | why |
|---|---|---|
| Start/Sit, Trade Lab values, League Hub, **waiver ROS list** | **fitted** | all read the asset universe, built on `buildPlayerWeekEngine` |
| playoff and title odds (My Team, Model) | **constants** | `/model/:id/simulate` → `season-sim.js` |
| Trade Lab championship ranking | **constants** | `season-sim.js#tradeImpact` |
| **draft board** | mostly **ESPN's** | see below |

**The draft board is not on our basis at all.** `draft-assist.js:430-435`:
`projected = espnPts * (1 + MODEL_BLEND_WEIGHT * modelRel)`, with
`MODEL_BLEND_WEIGHT` 0.3, `modelRel` clipped to ±0.35 and normalised by
`modelScale` (the league-wide mean of ours/ESPN over the top 150). Our model
enters only as a ratio-normalised **relative** disagreement, so a uniform shift
— which is what a different k produces — largely cancels. Do not label it "the
older projection basis".

**So the only honest label is on the odds**, and its magnitude is a mean of
−0.41 (max 7.94) from the opportunity thread's counterfactual — **never** the
+4.71 startable lift, which is a different quantity. Say "a different projection
window", never "these pages are five points low".

## Two caches that would bite if the guard were lifted

Neither matters while the guard holds; both are real otherwise.
`routes/model.js:107-111` memoises `proj:${through}:${scoring}` in an unbounded
Map with no TTL and no fit id in the key. `draft-assist.js:81-86` memoises
`buildProjections` in a module-level `modelProjections` built once per process.
A promotion by a separate process (`fly ssh console -C`) reaches neither. The
durable fix is putting `activeFitMeta().id` in both keys — that accessor already
exists at `shrinkage-fit.js:537`.

See [[basis-fields-served-never-rendered]].
