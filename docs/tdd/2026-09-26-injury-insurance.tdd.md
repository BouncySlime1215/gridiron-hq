# INJURY INSURANCE: a handcuff for each Blue chip, priced beside the served trade

Batch D item 27 (Nick 2026-09-25): "price handcuffs/backups for Nick's Blue chips as an explicit
option vs a trade." Flag `GRIDIRON_INJURY_INSURANCE` ('1' on; the preview switch never turns it
on). Shadow: `_run.inputs.injury_insurance` only, read after planning, nothing served reads it.

## Why the planner cannot see it today

The planner prices trades on the season sim. The sim draws each player's weeks on his own, so it
does not know that when a starter sits his backup inherits the work. `contingency.js#cascades`
measures that handoff from games the starter actually missed, and `handcuffValue` already turns it
into per-backup paths, but nothing prices a backup for a specific starter on Nick's roster.

## Change

- `contingency.js#handcuffValue`: each path also carries `points_without` (without-starter
  opportunity x the same points-per-opportunity the path already uses). Additive; no other field moves.
- `campaign/injury-insurance.js` (pure): for every Blue chip (board 83+) who starts, at risk =
  weeks left x P(miss) x lineup loss; each workload-passing free-agent handcuff's insured points =
  weeks left x [P(miss) x points won back - (1 - P(miss)) x the drop's healthy-week cost]; the served
  move on the same yardstick (lineup points a week x P(complete) x weeks left). Lineups come from
  `trade-engine.js#bestLineup` on `ros_ppg` (the solver roster-risk.js uses), passed in.
- Rules, all fail closed: rostered handcuffs refused (a trade get below the Blue chip floor);
  pinned never-get, untouchables and players sold this season refused (no buy-backs); drop via
  SEARCH-WIDE's `makeDropOk` + `pickDrop` (never 160 / 80 / 277, untouchable, Blue chip, unscored;
  never worth more than the handcuff on FantasyCalc value). No board -> `no_board`, no chips.
- `campaign/injury-insurance-inputs.js`: handcuffs turned round per starter (workload test on that
  starter's path alone), Nick's net side of the served move, held-out grade games.
- Adapter reader and producer block behind the flag; `scripts/rnd/injury-insurance-grade.mjs`.

## RED (commit 30a43137, implementation absent)

`node --test test/injury-insurance.test.js` -> `ERR_MODULE_NOT_FOUND ... injury-insurance.js`,
1 test file, 0 pass, 1 fail.

## GREEN

`node --test test/injury-insurance.test.js` -> 16 pass, 0 fail. Full-suite and check numbers in the PR.

The first GREEN run failed 3 tests, all wrong in the test, not the code: the RED fixture's
hand arithmetic for the lineup without the RB Blue chip said 63 (it is 73, so 14 lost, not 24;
10 won back, not 20; 28 insured, not 56, which also flips the trade comparison to 'trade'), and one
assertion read `over.valueOf` off a plain object (Object.prototype.valueOf). Corrected in the GREEN
commit; no implementation line was changed to make a test pass.

## Pre-registered pass bar (before any real-data run)

Grade = held-out handoff calibration (fit through S-1, judged on S = 2023-25 starter-missed games):
B1 >= 30 games with a workload-passing handcuff; B2 realized / predicted in [0.75, 1.25];
B3 95% bootstrap interval of that ratio inside [0.6, 1.5]; B4 passers score >= 1.5x failers
(unmeasured under 10 failer games). Until it passes the block stays shadow and moves no number.
