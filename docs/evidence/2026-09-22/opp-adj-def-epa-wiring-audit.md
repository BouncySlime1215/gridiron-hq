# `opp_adj_def_epa` reaches the betting surface only, never the fantasy projection

Audited 2026-09-22 on the working tree over origin/main `654ff93`. This is the
wiring question from Phase 0 item 5, pointed at the model layer, and it
**corrects a claim I made earlier today** — see §4.

## The chain, end to end

```
nfl-features.js:228   declares  opp_adj_def_epa  "Defensive EPA allowed adjusted for offences faced"
nfl-features.js:445   computes  it, inside adjustedFeatures(season, week, team)
nfl-features.js:477   spreads   ...adjustedFeatures(...) into teamFeatureVector(season, week, team)  [:457]
```

`teamFeatureVector` has exactly three callers:

| caller | what it is |
|---|---|
| `nfl-reasoning.js:84-85` | betting pick reasoning → `pick-reasoning.js`, `routes/nfl-betting.js` |
| `nfl-ai-replay.js:112` | betting replay → `report-cache.js`, `routes/nfl-betting.js` |
| `routes/nfl-betting.js:130` | the betting route itself |

**Every consumer is betting-side.** And no client file requests
`/api/nfl-betting` — a grep across `client/src/` returns nothing.

## It is not written to the table either

`nfl_team_week_features` is written by `writeTeamWeeks` at `nfl-pbp.js:538`,
whose payload is:

```js
const f = { ...sideFeatures(t.off, 'off'), ...sideFeatures(t.def, 'def') };
```

`adjustedFeatures` is not in it, and `nfl-pbp.js` does not import
`nfl-features.js` at all. So the generic JSON-blob readers of that table
(`nfl-gbm.js:145`, `nfl-matchup-specialists.js:62`) cannot be picking it up
either — the key is not in the blob. The earlier "generic consumption is still
possible" caveat is now closed: it is not.

## Status

**`half_done`** — it exists, it is computed correctly, and it is reachable from a
route file whose handlers no reachable client file calls. For the fantasy
product, which is the whole product in scope, it is inert.

## What the fantasy projection actually uses for the opponent

Nothing from this feature family. Zero of `gridiron-model.js`,
`fantasy-coordinator.js`, `trade-engine.js`, `lineup-brain.js`,
`forecast-combination.js` and `player-week-engine.js` reference
`nfl-features.js`, `teamFeatureVector` or `opp_adj_def_epa`.

The fantasy weekly number gets its opponent effect from one place:
`lineup-brain.js:275` calls `vegasLift(p, season, week)`, imported from
`waiver-brain.js:40` — a betting-line game-script multiplier. That is a real
opponent signal, and it is the only one.

## 4. The correction this forces on my own work

In `docs/spec/projection-range.md` §7, and in what I reported to the
coordinator, I wrote that my research baseline "does not include the repo's own
opponent adjustment (`opp_adj_def_epa`)" and therefore that "the production
model has strictly more information than my baseline", concluding that the
declined features' nulls were conservative and that a better point model would
narrow the projection bands.

**The premise was wrong for the fantasy path.** The fantasy projection does not
have `opp_adj_def_epa` either. The correct statement of the difference is:

- the fantasy model has **`vegasLift`**, a betting-line game-script multiplier,
  which my baseline lacks;
- my baseline has prior-weeks volume, snap share and position, which it shares;
- **neither has an opponent-defence-quality feature.**

So "strictly more information" is not established. The two models have
overlapping but different information, and which is stronger is an open
question rather than a safe assumption. The projection-range widths still need
re-measuring against the production model before being shown to a user — that
part of the caveat stands and if anything matters more now.

## 5. What this does to the OL-vs-DL verdict

In `phase-a-ol-vs-dl-lift-proof.md` I declined the feature partly on the ground
that opponent defensive quality "is already built" in this repo. That is true
of the **betting** side and false of the **fantasy** side.

The measured position is therefore:

- Opponent pass-defence quality detected pooled at **+0.0110 PPR, CI [+0.0073,
  +0.0147]**, across four bootstrap seeds, with a correct coefficient sign and a
  passing shuffled control.
- It **failed split-half replication** (+0.0061 in 2018-2021, -0.0018 in
  2022-2025), which is why it was not claimed, and that remains the reason.
- But it is **not redundant with an existing fantasy feature**, because no such
  fantasy feature exists.

So the decline stands on the replication failure alone, which is the weaker of
the two reasons I originally gave. An opponent-defence term for the *fantasy*
projection is an open question, not a closed one, and it is the only candidate
from the whole deep-feature exercise that ever produced a detection.

## The five questions

- **Well built?** The feature is computed correctly. Its wiring is the defect.
- **Stats or made up?** Traced, not inferred: every caller enumerated, the
  writer's payload read, the client grep run.
- **How do we know?** `nfl-features.js:228/445/457/477`, the three callers
  above, `nfl-pbp.js:538`, and an empty grep for `/api/nfl-betting` under
  `client/src/`.
- **Pointed anywhere else on the platform?** Only at betting, which is out of
  scope, and which no client file calls.
- **How does it unify?** It does not today. Whether it should is now a live
  question for the fantasy model rather than a settled one.
