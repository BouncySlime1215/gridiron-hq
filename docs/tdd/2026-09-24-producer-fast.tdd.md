# PRODUCER-FAST: the target-league producer under 60 s (2026-09-24)

Source: `docs/handoff/local/BUILD-PLAN.md` row PRODUCER-FAST (branch
`claude/handoff-package-2026-09-22`): "producer < 60 s so it replans every
refresh/event", after FIX-03. Built on `claude/cloud-fix-03` (`d7736fe`).
Target league = `leagues.id` 4. Reported on the Mac: 151-173 s, phases_ms values
~33 s, flip ~47-62 s, search ~44-53 s.

## 0. Profile (why it was slow)

No real DB in the cloud, so the profile ran on a made-up ESPN league at producer
scale: `test/fixtures/producer-speed-league.mjs`, ten teams x 16 players, 14-week
season from week 4, 6-team bracket, **the real season simulator and the real
campaign adapter** (projections and outcome pools mocked, as in RL-19-2). Its
phases land where the Mac's do: values 32.9 s, flip 44.1 s.

`node --cpu-prof` over ten rescores (189 ms each):

| self time | function |
|---|---|
| 1319 ms | `season-sim.js#lineupPoints` |
|  304 ms | `playSeasons` |
|  170 ms | `teamPoints` |

Every phase that is slow (values, flip, search, confirm) is slow because it
rescores, and ~85% of a rescore is `lineupPoints`: it re-sorts and re-picks each
changed lineup once per run (1200 runs x every week, and twice per changed team,
once in the adapter and once inside `tradeImpact`). Who starts is decided from
`expected` only, never from the run's draws, so the lineup is the same in every
run of a week.

## 1. Tests (RED first)

`test/campaign-producer-speed.test.js` (9 tests) on a six-team version of the
fixture, so the suite stays fast.

RED (implementation absent):

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../scripts/campaign/rescore-cache.mjs' imported from .../test/campaign-producer-speed.test.js
not ok 1 - test/campaign-producer-speed.test.js
# pass 0
# fail 1
```

## 2. Change (GREEN)

Behind `GRIDIRON_PRODUCER_FAST=1`, on under preview mode
(`league-adapter.mjs#producerFastEnabled`, through `preview-mode.js`). Off, the
adapter runs exactly as before.

1. `season-sim.js#lineupStarters` / `#teamPointsFast`: each week's starters are
   picked once (same pool sort, same slot order as `lineupPoints`) and summed per
   run in that order, so every total is the same double. Opt-in per world:
   `tradeImpactWorld(lg, { fastLineups: true })` sets `w.teamPoints`, and
   `tradeImpact` uses a world's `teamPoints` when it has one. No other caller
   changes.
2. `scripts/campaign/rescore-cache.mjs`: the producer keeps last run's rescores in
   `rescore-cache.json` next to the plans file, keyed by a content hash of the
   world (league row payload and rules, rosters and positions, slots, schedule,
   every week's expected points and every run's draws) and an exact state key
   (roster order kept: lineup ties break on it). A replan with nothing new reads
   values and the flip map out of it; a new sync, seed, roster move or news
   event is another world and recomputes. Each run writes back only the worlds it
   used. Stats land on `_run.inputs.rescore_cache` (only when a cache is in use,
   so the FIX-03 contract fixture is unchanged).
3. `scripts/campaign/bench-producer.mjs`: plans one league off / cold / warm on
   the same state and seed; prints timings, counts, the next move key and whether
   the whole plan matches. Read-only, ids only.

## 3. Evidence

Ten-team fixture, 1200 runs, `planLeague` only (adapter ~1.2-1.6 s on top):

| run | plan ms | values | flip | search | confirm world | confirm rescore | rescores |
|---|---|---|---|---|---|---|---|
| off (today) | 85 587 | 32 908 | 44 112 | 5 216 | 1 486 | 1 474 | 408 |
| fast, cold cache | 18 269 | 6 600 | 8 817 | 995 | 1 266 | 314 | 408 |
| fast, warm cache | 1 617 | 2 | 4 | 8 | 1 427 | 1 | 408 (409 hits, 0 misses) |

The whole planner result (next move, deck, playbooks, flip map, confirm) was
byte-identical across the three (`cmp` of the serialised results).

Six-team test fixture (`campaign-producer-speed.test.js`): off 15.1 s, cold
3.1 s, warm 0.5 s; same plan in all three; `teamPointsFast` equals
`lineupPoints` with `Object.is` on every run of every week for 13 rosters.

## 4. Not done, and why

- **Parallel confirm rescoring.** After the lineup change the confirm rescore is
  ~0.3 s of 18 s. Worker threads would each have to rebuild or receive the
  confirm world (the draws are closures over the copula, not transferable), which
  costs more than the 0.3 s it would save.
- **One world per week (EA-07).** Not on `main` and not on this base. The
  planning world is still built once per run (~1.2 s) and the confirm world once
  (~1.3-1.5 s); they are the floor of a warm run.
- **Real league 4.** Not measured here: the DB is on the Mac. The PR carries
  `LOCAL:` lines that run the bench there.
