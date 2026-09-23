# RL-10-2: ESPN zero-flip timing poller (2026-09-23)

Unit: `RL-10-2` — "W4-W5 Sunday timing test: append-only 10-min poller of ESPN
projections (JSONL, rnd/loop/), when do zeros appear vs inactives" (from R&D r10,
`WORK-QUEUE.md` section 3). Research tooling, not app code: no production file is
touched. Nothing in this PR is scheduled — the timing test itself runs by hand on
2026-09-27 and 2026-10-04.

## 0. Audit: what already exists (extend-or-build)

- `scripts/collect-roster-snapshots.mjs`'s live pass (`:92` `periodPoints`, source id
  1 = projection) already reads `leagues.payload` and already writes `projected_points`
  and `injury_status` into `league_roster_snapshots` (migration 058), tracked by
  `changed_at`. That table is a *production* history keyed to the app's scoring model
  and its own cadence (hourly `league_rosters` sync, `scheduler.js:1253`).
- Nothing existing appends a flat, append-only JSONL timeline of the raw ESPN feed at
  a tighter (10-minute) cadence, and nothing measures a flip's lag against
  kickoff-90m. `grep -rn "flip.*kickoff\|kickoff.*90" server scripts` on
  `ca64b2cc` (origin/main): 0 hits — known-nonzero control, the same-shaped grep for
  `scoringPeriodId` in the same tree: 380 hits.
- **Decision: build**, as new files only (`scripts/rnd/espn-projection-poller.mjs`,
  `scripts/rnd/espn-flip-timing-analysis.mjs`), reusing the same stored-payload read
  path as `collect-roster-snapshots.mjs` — no new fetch, no new external source.

## 1. Pre-registration (written and committed before any real number is captured)

Committed before the first Sunday run against real ESPN data. The unit tests and
fixture dry-runs below (section 2) exercise the *tool*, on synthetic data invented for
this PR — they are not the pre-registered measurement itself, so recording them here
first does not violate "no number before pre-registration."

- **Source claim under test:** `rnd/loop/r10-external-espn-zero-is-the-inactive-feed.md`
  section 6 ("How we'd know it works"), itself grounded in the same doc's section 2b
  (historical: ESPN's at-lock projection was 0 for 92.4% of Friday Q/none surprise
  gameday inactives, 2021-24, n=238) and section 2a (KILL of the teammate-bump layer).
- **Hypothesis:** ESPN's stored weekly projection (and/or `injuryStatus`) flips to a
  "scratch" reading (`projected_points < 1`, or `injury_status` in
  `{OUT, DOUBTFUL, INJURY_RESERVE}`) at or before kickoff-90 minutes for most rostered
  players who end up inactive that week.
- **Metric:** for each rostered player who ends the week inactive, `lag_minutes` =
  minutes(first observed flip timestamp) − minutes(kickoff − 90m). Negative = flipped
  before the T-90 mark (in time for a pre-lineup-lock "do not start" flag); positive =
  too late.
- **Population / "held-out" split:** two live Sundays, 2026-09-27 (week 3) and
  2026-10-04 (week 4), across Nick's 5 local ESPN leagues, restricted to players ESPN
  projected at 5+ the prior week (the same "fantasy-relevant" filter as the historical
  study). Nothing here is fit to any season, so there is no train/test split to record;
  the two Sundays are two independent forward looks at the same pre-registered rule.
- **Baseline:** today's app surfaces nothing from this feed for the Q/none slice (the
  SS-01 inactive hook is empty, `NO_LIVE_INACTIVES`, per the r10 doc section 3) — the
  comparison is "flip observed in time" vs "flip observed too late / not at all," not
  against another model.
- **Ship rule (CONFIRM/KILL, as pre-registered in the r10 doc, restated here verbatim
  as this unit's own ship rule):**
  - **CONFIRM** when at least 80% of rostered Q/none-slice inactives flip to 0/OUT by
    T-30 (30 minutes before kickoff), with 0 wrong flips on Nick's own starters. Ship
    the SS-01 arm-2b hook default-on, labelled "confirmed on W4-W5, n = …".
  - **KILL** when the median flip lands at or after the player's own kickoff. ESPN's
    zero is then too late to act on; the Bluesky arm (#184) stays the only live source.
  - Expected sample is small (~4-13 players across the two Sundays, per the r10 doc's
    coverage arithmetic) — this is a directional forward check, not a powered study;
    the evidence file states the observed n and reports the result as descriptive if
    n stays under ~10.
- **Sign convention:** `lag_minutes` is positive when the flip is late (bad),
  negative when early/on-time (good). `isFlipped` returns a boolean, not a magnitude.
- **Method, briefly grounded:** treating a vendor projection's collapse to near-zero as
  a proxy for a live status change is the same idea as "early warning from a leading
  indicator" in event-detection literature — using a monitored series' level shift to
  infer an unobserved discrete state change (cf. change-point detection framing,
  Basseville & Nikiforov, *Detection of Abrupt Changes*, 1993; and, for treating a
  single vendor feed's own internal consistency as ground truth for a latency
  measurement, the general "instrument lag" approach used in market-microstructure
  latency studies). No new statistical technique is introduced here: this unit reuses
  a fixed-threshold detector (`projected_points < 1`) already implicit in how ESPN's
  own app treats a 0 projection, so the interesting question is purely timing, not
  detector design.
- **What this does NOT do:** it does not decide anything about the "teammate bump"
  layer (killed in the r10 doc section 2a, out of scope here); it does not build the
  SS-01 hook itself (that is r10 doc section 4 item 1, a separate unit); it does not
  join to `game_lines` for real kickoff times (see section 6 below — documented gap).

## 2. RED

Commit `740c930c` "test: RED for RL-10-2 ESPN flip-timing poller/analysis" adds
`test/espn-flip-timing-poller.test.js` alone (implementation not yet added). Run:

```
node --experimental-test-module-mocks --test --test-reporter=tap test/espn-flip-timing-poller.test.js
```

Failing assertion (module does not exist yet):

```
Cannot find module '.../scripts/rnd/espn-projection-poller.mjs'
```

(9 of 9 tests fail; full run recorded in section 5, first line of output.)

## 3. GREEN

Commit `9ef73524` "feat: RL-10-2 ESPN flip-timing poller + analysis script" adds
`scripts/rnd/espn-projection-poller.mjs` and `scripts/rnd/espn-flip-timing-analysis.mjs`.
Same command, 9 of 9 pass (section 5).

## 4. What it does

- `scripts/rnd/espn-projection-poller.mjs`: reads `leagues.payload` (`SELECT id,
  payload FROM leagues WHERE platform = 'espn'` — never `espn_s2`/`swid`, standing
  rule 12), the same JSON `collect-roster-snapshots.mjs:92`'s live pass already reads.
  No network call of its own. Appends one JSONL row per rostered player —
  `{ts, league, player_id, projected_points, injury_status}` — to
  `~/gridiron-local/rnd/loop/data/espn-flip-timing/<YYYY-MM-DD>.jsonl`. Two calls in
  the same minute append, never overwrite (test: "poll(): appends... never
  overwrites").
- `scripts/rnd/espn-flip-timing-analysis.mjs`: reads that JSONL plus a
  `{player_id: kickoff_iso}` map, finds each player's first flipped row
  (`isFlipped`: `projected_points < 1` OR `injury_status` in
  `{OUT, DOUBTFUL, INJURY_RESERVE}`), and reports `lag_minutes` against kickoff−90m.
  Prints a summary (`players_flipped`, `flipped_at_or_before_t90`); it does not itself
  render a CONFIRM/KILL verdict — that is read by hand against section 1's rule and
  written into this file's addendum after the real Sunday runs.

## 5. Numbers, with commands

Tree: worktree `RL-10-2`, base `origin/main` `ca64b2cc30930eccc44e4666be3b638012027a2d`
(before this PR's own commits; `git merge-base HEAD origin/main`).

- RED: `node --experimental-test-module-mocks --test --test-reporter=tap
  test/espn-flip-timing-poller.test.js` → `# pass 0` / `# fail 9` (module not found).
- GREEN: same command → `# pass 9` / `# fail 0`.
- **Liveness proof** (mutation sweep, unit + call site):
  1. Threshold mutant `row.projected_points < 1` → `< 0` in `isFlipped` (the unit
     itself): 2 tests die (`isFlipped: fires on sub-1...`, `flipLags: reproduces a
     hand-computed fixture exactly`). **Killed.**
  2. Call-site mutant in `poll()`: `WHERE platform = 'espn'` → `WHERE 1=1`: 9/9 still
     pass. **Not-applied control, survived as expected** — no test fixture seeds a
     non-ESPN league, so this predicate is untested; recorded as a known gap, not a
     false pass (no test claims to cover it).
  3. **Designed survivor:** `main()`'s console.log wording (`wrote ${n} rows` →
     `put ${n} rows`) — CLI text is not part of the data contract and is
     intentionally untested. 9/9 pass, as designed.
- **Dry run against a fixture** (acceptance criterion 1): seeded a temp sqlite with
  one ESPN league (`payload` = 2 rostered players, one healthy at 12.5, one `OUT` at
  0), ran `GRIDIRON_DB_PATH=<fixture> node scripts/rnd/espn-projection-poller.mjs
  --out-dir <tmp> --now 2026-09-27T15:10:00.000Z`. Output file:
  ```
  {"ts":"2026-09-27T15:10:00.000Z","league":1,"player_id":100,"projected_points":12.5,"injury_status":"ACTIVE"}
  {"ts":"2026-09-27T15:10:00.000Z","league":1,"player_id":200,"projected_points":0,"injury_status":"OUT"}
  ```
  Well-formed JSONL, no `espn_s2`/`swid` substring anywhere in the file (also asserted
  in the unit test with a seeded league carrying fake secret values).
- **Analysis reproduces a fixture's timing** (acceptance criterion 2): a
  hand-computed 2-player fixture (kickoff 18:00Z, so T-90 = 16:30Z) — player 100
  flips at 16:20Z (10 minutes before T-90, `lag_minutes: -10`), player 200 flips at
  16:55Z (25 minutes after T-90, `lag_minutes: +25`) — run through
  `node scripts/rnd/espn-flip-timing-analysis.mjs <fixture>.jsonl --kickoffs
  <fixture>.json` reproduces both lags exactly (also asserted in
  `flipLags: reproduces a hand-computed fixture exactly`).

## 6. Known defects / gaps

- The analysis script takes kickoff times as an injected `{player_id: iso}` map. It
  does **not** yet join to `game_lines.gameday`/`gametime` by the player's
  `pro_team_id` for a real run — that join needs a `PRO_TEAM` (proTeamId → abbr,
  `espn-draft.js:70`) → `game_lines.team` lookup plus season/week, which this unit
  did not build (out of scope: "an analysis script that measures," not "a fully
  automated pipeline"). For the real 9/27 and 10/4 runs, the kickoff map must be
  built by hand or in a short follow-up script before `flipLags` is run on the real
  JSONL.
- `isFlipped`'s `< 1` threshold and status set are carried over from the r10 doc's
  descriptive study; they are not refit here.
- The poller's cadence, and which 10-minute ticks actually ran, are the operator's
  responsibility (see "Command to run" below) — nothing in this PR schedules it.
- No forward-holdout claim is made here: this unit produces no served number and
  feeds no start/sit, waiver or trade decision. It is a measurement instrument for a
  later ship/kill decision on the SS-01 hook.

## 7. Command to run (not scheduled — Nick or the coordinator runs this by hand)

Sunday 2026-09-27 (week 3) and Sunday 2026-10-04 (week 4), across the app's usual
Sunday kickoff windows (documented in the r10 doc: 11:20-13:00, 14:35-16:25,
18:50-20:20 ET), from the worktree/repo checkout with the real `data.sqlite`:

```
for i in $(seq 1 60); do
  node scripts/rnd/espn-projection-poller.mjs
  sleep 600
done
```

(60 iterations × 10 minutes covers a full Sunday from 11:00 to 21:00 ET; stop early
or restart per window as convenient — every call is idempotent-append, never
destructive.) Output lands in
`~/gridiron-local/rnd/loop/data/espn-flip-timing/<date>.jsonl` on this Mac, read-only
against the already-hourly-synced `leagues.payload`.

After each Sunday, build a `kickoffs.json` for that week's rostered relevant players
(by hand or a short follow-up script joining `players.espn_id` → `pro_team_id` →
`game_lines.gameday`/`gametime`), then:

```
node scripts/rnd/espn-flip-timing-analysis.mjs \
  ~/gridiron-local/rnd/loop/data/espn-flip-timing/2026-09-27.jsonl \
  --kickoffs kickoffs-2026-w3.json
```

Record the resulting `lag_minutes` distribution and the CONFIRM/KILL read against
section 1's rule as an addendum to this file (or a new dated evidence file), and log
the holdout look to `docs/evidence/HOLDOUT-LEDGER.md` per standing rule (a) if that
run touches any 2025 data — it does not; this is a 2026 in-season forward look only.

## 8. Nick's five questions

1. **Well built?** Yes for what it is: an append-only instrument with tests and a
   liveness-proven mutation sweep. It has one documented real gap (section 6): the
   kickoff join is not automated.
2. **Stats or made up?** The detector threshold (`< 1`) and status set are taken
   from the r10 doc's already-measured historical study (92.4% recall, 0.895
   precision on 2021-24 data), not invented here. The *timing* claim (does the flip
   land before kickoff-90m) is unmeasured until the real Sunday runs — that is the
   whole point of this unit.
3. **How we know:** nothing shipped yet. The pre-registered rule in section 1 says
   exactly what "confirm" or "kill" will look like on the 2026 W3/W4 forward data.
4. **Pointed anywhere else on the platform?** No. This is standalone R&D tooling
   under `scripts/rnd/`, reachable only by hand from the command line; it writes no
   app table and has no route or job consumer. That is by design for this unit — the
   SS-01 hook that would consume a CONFIRM verdict is a separate, not-yet-built unit
   (r10 doc section 5, "where it lands").
5. **How it unifies:** (corrected in the skeptic round, section 10) the first version
   claimed reuse of `periodPoints` but carried its own copy that disagreed on rounding
   (12.345 vs 12.35). Now `periodPoints`/`round2` live in
   `scripts/lib/espn-period-points.mjs`, imported by both `collect-roster-snapshots.mjs`
   and the poller, and the "is he out" set comes from `server/services/espn-status.js`
   (`ESPN_AVAILABLE`, imported by `player-availability.js`).

## 9. One number, one producer

`grep -n "projected_points" server scripts` producers on `origin/main`: only
`scripts/collect-roster-snapshots.mjs:92` (writes it into `league_roster_snapshots`).
This unit adds a second *reader* of the same source field (`leagues.payload`'s
`stats[].appliedTotal` where `statSourceId === 1`), not a second producer — it writes
to a brand-new JSONL sink that nothing else reads, so there is no contradiction to
reconcile. No existing "timing lag" or "flip detector" concept exists elsewhere to
unify with (confirmed by the grep in section 0).

## 10. Skeptic round 1 (2026-09-23): fixes and one pushback

RED `028562e1` (8/14 fail), GREEN `d5c52091` (14/14 pass), same command as section 2.
Also re-run on `d5c52091`: `test/roster-snapshots.test.js` + this file 28/28 pass,
`test/player-availability.test.js` 15/15 pass (both files touched by the extraction).

**1. Flip timing was poll time, but the payload only changes on the hourly sync. Fixed.**
- The poller now runs `SELECT id, payload, fetched_at FROM leagues WHERE platform = ?`
  (no `espn_s2`/`swid`) and emits `source_fetched_at` (ISO UTC from `leagues.fetched_at`,
  writer `server/routes/leagues.js` `syncEspnLeague` on the hourly `league_rosters` job,
  `scheduler.js:1253`).
- The analysis times each flip by `source_fetched_at` and brackets it as
  `[last_unflipped_ts, flip_ts]`, with `lag_lower_minutes` and `lag_minutes` (the
  upper bound). **Resolution is the sync cadence (up to 60 minutes), not 10 minutes.**
  `lag_minutes` is late-biased by up to one sync interval, so it is conservative for
  CONFIRM (a flip that passes on the upper bound really passed). The 10-minute poll
  only makes sure no hourly payload is overwritten before it is captured.
- Test `flipLags: flip time is the payload fetch time` covers this: six polls of a 16:00
  payload plus a 17:00 OUT payload give `flip_ts` 17:00, lag +30, lower bound -30.
  Mutation `observedAt = r => r.ts` (flip timed by poll): that test dies (13/14).
- Not done: triggering a fresh ESPN fetch every 10 minutes. The fetch path
  (`syncEspnLeague` → `fetchEspn(lg, …)`, `server/routes/leagues.js:121-137`) needs the
  league's cookies, and this unit may not select `leagues.espn_s2`/`swid`. For a
  finer read on 9/27 and 10/4, the operator can trigger the app's own league sync more
  often. That is an operator choice, not code in this unit.
- **Pushback: `league_roster_snapshots.changed_at` cannot stand in for this timeline.**
  The table has one row per `(league_id, season, scoring_period_id, team_id,
  espn_player_id)` (`server/migrations/058_league_roster_snapshots.js:50` PRIMARY KEY).
  `writePeriod` updates that row in place (`collect-roster-snapshots.mjs:109`
  `UPDATE … SET <TRACKED> = ?, changed_at = ?`, run at `:130`), and `TRACKED` includes
  `actual_points` (`:42`). So the first in-game stat change overwrites the flip's
  `changed_at`, and an earlier projection or status value is lost. The first flip time
  therefore can't be recovered from the table after kickoff. The JSONL keeps every sync's
  reading and has no other reader. It is R&D output under `~/gridiron-local/rnd/`, not
  an app table or column.

**2. The poller claimed to reuse `periodPoints` but carried its own copy. Fixed.**
- Both writers now import `scripts/lib/espn-period-points.mjs`.
- Test `projected_points uses the shared periodPoints (round2) contract`: an input of
  12.345 now gives 12.35 from the poller, the same as `league_roster_snapshots`.
- `roster-snapshots.test.js` still passes (28/28, combined run above).

**3. The producers disagree on DOUBTFUL. Pre-registered and reported both ways.**
- Values on the same input (DOUBTFUL, projection 8):
  - `player-availability.js` `ESPN_AVAILABLE`: available.
  - `manager-signals.js:312` dead set: out.
  - r10 set: out.
- **Pre-registration amendment (2026-09-23, before any real Sunday row exists):**
  - The PRIMARY metric uses the canonical definition: a flip is a projection under 1,
    or a status outside `ESPN_AVAILABLE` (`server/services/espn-status.js`, now shared
    with `player-availability.js`). Under it, DOUBTFUL is not a flip.
  - SS-01 must use this same definition.
  - The r10 definition (with DOUBTFUL) is reported alongside as SECONDARY.
  - The CLI prints both (`{canonical: …, r10: …}`), and the CONFIRM/KILL rule in
    section 1 is read on `canonical`.
- Tests: `isFlipped (canonical, default)` and `flipLags: DOUBTFUL-only flip counts
  under r10 but not under the canonical definition`. Mutation: canonical set replaced
  with the r10 set → 2 tests die (12/14).
- **Follow-up (named, not done here):** `manager-signals.js:312` still counts DOUBTFUL
  as dead, which disagrees with `player-availability.js`. The fix is to point it at
  `espn-status.js` in a separate unit, because it changes a served manager signal.

**Files added:** `scripts/lib/espn-period-points.mjs`, `server/services/espn-status.js`
(both dependency-free). **Moved, not changed:** `periodPoints`/`round2` out of
`collect-roster-snapshots.mjs`, `ESPN_AVAILABLE` out of `player-availability.js`.
No migration, no table, no column.
