# EA-06: drift monitor, fallback to the last healthy snapshot, HEALTH-01 card rows

Row: ENGINE-SPECS "EA-05 monitor + fallback", dispatched as cloud unit EA-06
(ENGINE-ARCHITECTURE §7.4; ENGINE-00b-b RED (2)-(5)).
Stacked on #259 (`claude/cloud-ea-05-pqpurf`, head `b8b65e38`).

## RED → GREEN

| # | commit | subject | on its parent |
|---|---|---|---|
| RED 1 | `3c639008` | test: RED - drift monitor, fallback reader and HEALTH-01 card rows (EA-06) | 0 pass / 13 fail on `b8b65e38` |
| GREEN 1 | `037eeb70` | feat: drift monitor, fallback to the last healthy snapshot, HEALTH-01 card rows (EA-06) | 13 / 13 pass; engine suites 69 / 69 |
| test | `4c38fc55` | test: close mutation survivors and add the null simulation script (EA-06) | kills 5 survivors and adds N1 |
| RED 2 | `4b9e6f37` | test: RED - the engine route serves the snapshot fallback; the grader writes weekly vs_fallback (EA-06) | W fails on `4c38fc55` |
| GREEN 2 | `a363e182` | feat: GET /api/engine/state serves the monitor's fallback through readServed (EA-06) | 16 / 16 pass |

**The RED 1 failing assertion,** quoted: `'producers/monitor.js does not exist: the drift monitor is not built'`.
This was the error in 10 of the 13 tests. Two failed on `stats/confseq.js does not exist`, and one on
`grader.pairedVsFallback does not exist`.

**Liveness of the final test file.** It was re-run on a clean `b8b65e38` worktree: 0 pass / 14 fail,
before W was added. After W was added, it was run on `4c38fc55`: 15 pass / 1 fail. The failure is
W, which gets `status: unknown`, not `fallback`.

## Mutation sweep (final head)

Suites run: engine-monitor, engine-daemon and engine-spine. Result: 22 mutants, 22 killed. The
designed survivor survived, and the designed not-applied control did not apply.

| mutant | killed by |
|---|---|
| bound: ln term alpha² → alpha | N1, N2 (closed form) |
| week floor dropped | 2, 5, R |
| entity floor dropped | 2 |
| fresh window = all weeks | 5, R |
| recover on the lower bound | 5 |
| flip on the mean, not the bound | N1, 2 |
| no system budget (alpha fixed 0.1) | N |
| stale shown as broken | F, R |
| monitor never acts | 3, S, W, F, R, X |
| recovery keeps the fallback | R |
| monitor monitors itself | D |
| failed rows ignored | X |
| reader ignores the fallback | 3, S, W |
| snapshot cut ignored | S, W |
| entities counted per pair | G |
| cross-week variance dropped | N1 |
| healthy snapshot = newest always | X |
| served: fallback in force before it began | W |
| call site: ctx.monitor gate closed (context.js) | M1, 3, S, W, F, R, X |
| call site: monitor not in the daemon (producers/index.js) | D, daemon RED (9) |
| call site: grader stops writing weekly vs_fallback | G2 |
| CONTROL: comment edit (designed survivor) | survived |
| CONTROL: anchor absent (designed not-applied) | not applied |

History of the sweep:

- **First sweep, on `037eeb70`:** 5 survivors. They were the closed-form bound, recovery on the
  lower bound, self-monitoring (the assert ran before `engine_fields` held `health.monitor`), the
  distinct-entity count, and the pinned healthy snapshot. A sixth, the cross-week variance, survived
  until N1 was added.
- **N1 is backed by the ablation** in `docs/evidence/2026-09-24/monitor-preregistration.md`. Without
  the term, the null simulation breaks the false-flip budget.
- **The call-site mutant on the grader survived** until G2 was added. The monitor tests inject grade
  rows, so without G2 nothing checked that the grader writes them.

## Nick's five questions

1. **Well built?** 16 tests: 13 RED→GREEN, then W as a second RED→GREEN, then 2 more. 22 of 22
   mutants are killed, call sites included. No new table and no migration.
2. **Stats or made up?**
   - Standard: the anytime-valid normal-mixture confidence sequence.
   - Hand-set:
     - the floor of 4 weeks and 20 players (§7.2);
     - `alphaMax` 0.10;
     - one false flip per season;
     - `RHO_WEEKS` 6;
     - prior weight 2;
     - within-variance inflation 2.
3. **How we know:** by simulation (the pre-registration). No backtest: no grade rows exist yet.
4. **Pointed anywhere else?**
   - `GET /api/engine/state` now serves the snapshot fallback, which `server/routes/engine.js`
     previously answered `unknown`.
   - The Number health card (#237) reads the `engine:<field>` rows once that PR's table exists.
5. **How it unifies:** one monitor for every engine field. It reads the one grader's rows, writes
   the one `engine_fallback` table the reader already honours, and puts rows in the one broken-numbers
   card (BROKEN-01c).

## PR sweep fixes (FIX-281-1..3, 2026-09-24)

The branch now carries `origin/main` (`4615b06`) and #250's head `44f4b13`, which itself
carries #257 (merge `3a9347b`). **This PR lands with or after #257 and #250.**

| Fix | Commits | Result |
|---|---|---|
| FIX-281-1 check:wiring sees the daemon | none needed on this branch: main's `a9a597f` (FIX-279-1, RULINGS 9) taught `wiring-map.mjs` that the daemon is a surface | on `a4d6dfa`: exit 1, 8 blocking findings (`table-hand-fed engine_snapshots`, 7 `module-reaches-no-surface` under `engine/`). After merging main: exit 0, 0 findings. No `accepted_orphan_modules` entry added. |
| FIX-281-2 served.js folds into the one reader | RED `e47c1ca`, GREEN `1bacf02` | RED 4 fail (3, S, W, FIX-281-2) / 13 pass; GREEN 17 / 17 |
| FIX-281-3 one writer of number_audit | RED `46a4c97`, GREEN the `fix:` after it | RED 1 fail (second INSERT in monitor-access.js) / 17 pass; GREEN 18 / 18 |

- FIX-281-2: `views.js#monitorServe` is the monitor's stand-in rule, called by the as-of
  `readServed` (/state, Coach) and by the snapshot `resolveRow` (/view). Order: the fallback
  field's row, else the field as of `health.monitor.healthy_snapshot_id`, else `unknown`,
  never the drifted value. The chain's first contribution is `health_monitor`,
  "fell back: <reason>". `served.js` is deleted. `fallback.kind` stays `field` / `snapshot`
  / `none`, plus `by: 'monitor'`.
- FIX-281-3: `monitor-access.js#writeCard` calls `number-audit.js#writeAuditRows` (#237);
  its own `INSERT ... ON CONFLICT` is gone. The test pins one INSERT into `number_audit`
  across `server/`.
- Merge interaction, fixed in `ef94b8e`: engine-grader A2 asserted that `rec_ledger` is
  absent, but #174 (migration 071) is now on main. The test drops the table first, so the
  absent case is still covered, then recreates it with 071's columns.
