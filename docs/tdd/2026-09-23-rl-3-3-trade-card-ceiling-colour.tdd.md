# RL-3-3: trade card Ceiling colour follows the lineup Weekly ceiling, not summed p80

## Audit: what already exists (extend-or-build)

The trade card already prints TWO ceiling numbers on the same card and, before this
fix, coloured one of them wrong:

- **Package p80** (`PackageRisk.p80`, `RiskStrip.tsx` Ceiling cell text via `ceilingOf`) —
  this season's p80 of the preseason model, summed over the players in a package
  (`trade-engine.js` `packageRisk()`).
- **Lineup `ceiling_delta`** ("Weekly ceiling", `TradeCard.tsx:122-126`) — the change in
  the STARTING LINEUP's weekly p90 total, from `trade-engine.js:1183`
  `lazyField(out, 'ceiling_delta', () => spreadDelta('ceiling'))`, itself
  `lineupSpread(before)`/`lineupSpread(after)` (`trade-engine.js:1171-1183`).

Before this change, `RiskStrip.tsx`'s Ceiling cell text showed the package p80 pair
AND coloured itself from `ceilBetter = risk.in.p80 - risk.out.p80` — a diff of the
same package-level sums. That number mostly tracks who receives more players (more
players summed = higher p80), and the row's own count puts it in contradiction with
the Weekly-ceiling number on the same card on **37-62 of 122-180 card sides**
(WORK-QUEUE.md `RL-3-3`, R1 lead measured — not re-run in this unit; the queue row is
the citation for that count).

This is a display fix, not a new statistical claim: no new number is introduced.
`ceiling_delta` already exists and is already rendered on the card
(`TradeCard.tsx:125`); the only change is which of the two existing numbers drives
the Ceiling cell's colour. Statistical-discipline pre-registration (RD-HANDOFF
step 2) does not apply — no model number, projection, or held-out claim is added
or changed.

Extend, not build: added a small pure function (`ceilingBetter`) to the existing
`RiskStrip.tsx`, next to the existing `floorOf`/`ceilingOf` idiom, and a new
`ceilingDelta` prop threaded from the two existing `TradeCard.tsx` call sites.

## RED

Commit `ab8ec67e` — "test: RED — trade card Ceiling colour must follow
ceiling_delta, not summed p80 (RL-3-3)" — `test/trade-card-ceiling-colour.test.js`,
3 tests, run on `ab8ec67e`: **0 pass / 3 fail** (tap).

Failing assertion (extraction test, since `ceilingBetter` did not exist yet):

```
ceilingBetter could not be extracted — the Ceiling cell must be coloured
by a standalone function of ceiling_delta, not inlined off
risk.out.p80/risk.in.p80
```

Second and third failures on the same tree (both against `RiskStrip.tsx` and
`TradeCard.tsx` as they stood on `ab8ec67e`):

```
the Ceiling cell in the component body is driven by the ceilingDelta prop, not risk.*.p80
  AssertionError: RiskStrip does not declare a ceilingDelta prop — TradeCard has nothing lineup-level to pass it

TradeCard passes the lineup-level ceiling_delta into RiskStrip at both call sites
  AssertionError: SideBox's RiskStrip (TradeCard.tsx ~138) does not pass ceilingDelta={s.ceiling_delta}: got `<RiskStrip risk={s.risk} />`
```

## GREEN

Commit `4d88b85a` — "fix: trade card Ceiling colour follows the lineup Weekly
ceiling, not summed p80 (RL-3-3)".

Run on `4d88b85a`:
```
$ GRIDIRON_DB_PATH=$(mktemp -u ...).sqlite SCHEDULER_DISABLED=1 \
  node --experimental-test-module-mocks --test --test-reporter=tap \
  test/trade-card-ceiling-colour.test.js test/trade-risk-strip-unreadable.test.js \
  test/trade-manager-read.test.js
# tests 28
# pass 28
# fail 0
```

## What it does

- `RiskStrip.tsx`: new pure function `ceilingBetter(delta)` — `null` when the delta
  is missing or within `1e-9` of zero, else `delta > 0`. `RiskStrip` takes a new
  `ceilingDelta` prop (default `null`); the Ceiling cell's colour argument is now
  `ceilingBetter(ceilingDelta)`. The old `ceilBetter` (`risk.in.p80 - risk.out.p80`)
  is deleted — nothing else read it.
- `TradeCard.tsx:138` — `<RiskStrip risk={s.risk} ceilingDelta={s.ceiling_delta} />`
  (per-side box, both "me" and "them").
- `TradeCard.tsx:280` — `<RiskStrip risk={deal.me.risk} ceilingDelta={deal.me.ceiling_delta} compact />`
  (compact card).
- ~~The Ceiling cell's title text now says explicitly that colour comes from the
  lineup's Weekly ceiling change, not the two p80 numbers shown in the cell.~~
  Superseded in the skeptic round (commit `04e024ff`), see below.

## Skeptic round (commits `bcd52a5e` test, `04e024ff` fix)

Two blocking findings, both correct:

1. **Test liveness.** Use-site mutants survived the source-read tests (M1
   `sign(risk.in.p80 - risk.out.p80)`, M2 `ceilingBetter(null)`, M3
   `ceilingBetter(-(ceilingDelta ?? 0))` all 3/3 pass on `f8ea8bd3`). Fix: the
   test file now compiles `RiskStrip.tsx` with the repo's TypeScript and renders it
   with React (idiom of `test/start-sit-gate-panel.test.js`), on fixtures where
   summed p80 and `ceiling_delta` disagree (the package's L4 435→418 / +21.1 and
   L1 329→470 / −0.4 shapes), and test 2 now pins the cell's argument to exactly
   `ceilingBetter(ceilingDelta)` with no `p80`.
2. **Two producers in one cell.** After `4d88b85a` the cell still printed the
   summed package p80 pair while colouring by `ceiling_delta`: 37/122 served sides
   disagreed with their own text. Fix: the Ceiling cell now prints
   `ceiling_delta` itself (`ceilingText`, signed, 1 dp, "pts"; `—` when absent)
   through a single-value cell (`single(...)`), and colours by the same number.
   `ceilingOf` (the p80 formatter) is deleted; nothing else read it. Title: "Change
   in your starting lineup's total in a good week (1 week in 10) — the same number
   as Weekly ceiling on this card".

RED for the skeptic round: new tests against `f8ea8bd3`'s `RiskStrip.tsx`
(`git show f8ea8bd3:client/src/components/trade/RiskStrip.tsx > <file>`, run, restore):
**2 pass / 4 fail** (tests 2, 4, 5, 6). Against origin/main's `RiskStrip.tsx`: 1 pass / 5 fail.
GREEN on `04e024ff`: `test/trade-card-ceiling-colour.test.js` 6/6; with
`test/trade-risk-strip-unreadable.test.js` and `test/trade-manager-read.test.js`:
**31/31 pass** (command: `GRIDIRON_DB_PATH=$(mktemp -u /tmp/rl33.XXXX).sqlite
SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap
<the three files>`). `node_modules/.bin/tsc --noEmit -p .` on the same working tree:
0 lines of output (no errors anywhere).

### Served-card rerun (the row's acceptance check) — local copy, not production

The script exists in the R&D package, outside the repo; the earlier "no script
found" claim in this file was wrong (only repo `scripts/` was searched).

```
sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"
cd <wt> && GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite NFL_SEASON=2026 SCHEDULER_DISABLED=1 \
  nice -n 10 node ~/gridiron-local/rnd/loop/scripts/r3i2_trade_ceiling.mjs > rl33_ceiling.json
cd <wt> && node docs/tdd/2026-09-23-rl-3-3-ceiling-served-count.mjs rl33_ceiling.json
```

Server code on this branch is origin/main's (this unit touches only the client),
so the script's served rows are the tree's own (its `tree` field is a hardcoded
label `1a9eff9e`, ignore it). 61 deals, leagues 1-5: 6/13/20/20/2 = 122 sides.
The count script renders the shipped `RiskStrip.tsx` (tree `04e024ff`) per side and
reads the Ceiling cell's colour and text back, so it measures the component, not a
re-implementation.

| metric (122 sides, all with both numbers) | old rule (summed p80) | shipped cell `04e024ff` |
|---|---|---|
| cell colour opposite to Weekly ceiling | **37** | **0** (target 0) |
| cell text is the Weekly ceiling value | 0 | 122 |
| cell text prints the summed p80 pair | 122 | 0 |
| uneven sides where colour = side receiving more players | **50 / 50** | **28 / 50** |

28/50 is the rate at which `ceiling_delta` itself favours the side receiving more
players (the package asked for it reported, not assumed). Known-nonzero control:
the same script on the package's own rows (`rnd/loop/data/r3i2_trade_ceiling.json`,
tree `1a9eff9e`) reproduces the package's baseline exactly — old rule 37 and 50/50 —
and gives 0 and 28/50 for the shipped cell.

### Mutation sweep, skeptic round (tree `04e024ff`, applied with sed, tested, restored)

| mutant | result |
|---|---|
| M1 cell colour `sign(risk.in.p80 - risk.out.p80)` (the original bug) | killed, 2 pass / 4 fail |
| M2 `ceilingBetter(null)` | killed, 3 / 3 fail |
| M3 `ceilingBetter(-(ceilingDelta ?? 0))` | killed, 3 / 3 fail |
| M4 cell text back to the p80 pair | killed, 2 pass / 4 fail |
| M5 sign flip inside `ceilingText` (`delta > 0` → `delta < 0`) | killed, 5 pass / 1 fail |

Restored file: 6/6 pass.

## The numbers, with commands

- RED: `git -C /Users/nick_matta/gridiron-local/wt/RL-3-3 show --stat ab8ec67e` →
  1 file changed, `test/trade-card-ceiling-colour.test.js`, 106 insertions.
- GREEN: `git -C /Users/nick_matta/gridiron-local/wt/RL-3-3 show --stat 4d88b85a` →
  2 files changed, `TradeCard.tsx` (+2/-2), `RiskStrip.tsx` (+22/-3).
- `git -C /Users/nick_matta/gridiron-local/wt/RL-3-3 write-tree` after GREEN and
  after the mutation sweep restore: identical (mutants were applied, tested, and
  reverted in the working tree only — never committed).
- `tsc --noEmit -p .` on `4d88b85a`: no errors reported for `RiskStrip.tsx` or
  `TradeCard.tsx` (checked by `grep -i "RiskStrip\|TradeCard"` on the full output;
  a known-nonzero control for the grep was not separately run because the file
  list is the direct output of `tsc`, not a bespoke filter — if `tsc` reported any
  error anywhere those two filenames would appear verbatim).

## Mutation sweep (manual, tree `4d88b85a`, applied/tested/reverted, never committed)

1. **Unit mutant** — sign flip in `ceilingBetter`: `delta > 0` → `delta < 0`.
   Result: **killed**, 1/3 fail (`trade-card-ceiling-colour.test.js`).
2. **Call-site mutant** — `TradeCard.tsx:138` reverted to
   `<RiskStrip risk={s.risk} />` (drop `ceilingDelta`). Result: **killed**, 1/3 fail.
3. **Not-applicable control** — mutated the unrelated `floorOf` empty-package
   branch (`'—'` → `'ZZZ'`). Result: **survived, as designed** — this suite stays
   3/3 pass, since it does not touch Floor. Confirms the two RED assertions above
   are targeted at the Ceiling-colour defect, not incidental source drift.
4. **Designed survivor**: none recorded — both applicable mutants above were
   killed on first application; no surviving mutant needed a follow-up fix.

## Known defects / not covered

- ~~No script found for the contradiction count~~ — wrong; rerun done, see
  "Served-card rerun" above (37 → 0 of 122, local copy).
- **Remaining producer of a summed package band (named follow-up, not this
  unit):** `server/services/trade-engine.js:1025` `packageRisk` still emits
  summed `points/p20/p80`, and `:1047` `packageNumbers` prints it on the verdict
  "Evidence" line as "2026 band a-b" (`TradeCard.tsx` `deal.verdict_evidence`).
  That line is no longer next to a colour, but it is still a sum of quantiles
  presented as a package range. Follow-up: package step 1
  (`rnd/loop/r3-internal-trade-card-ceiling-counts-players.md` §4) — stop emitting
  the summed band and print `ceiling_delta` or nothing on the Evidence line.
  `RiskStrip`'s `anyRecord` still reads `p80 != null` as a presence gate only.
- Not done: the package's optional |Δ| ≥ 1.0 colour threshold. The row asks for
  the sign of `ceiling_delta`; the cell colours any non-zero delta.
- This does not touch the Floor or Consistency cells, which already colour off
  package-level sums (`floorBetter`, `swingBetter`) — those are not lineup-level
  numbers on this card and are out of this unit's scope per the row.
- Render: the skeptic-round tests render `RiskStrip` for real
  (TypeScript-compiled, React `renderToStaticMarkup`); `TradeCard.tsx` call sites
  are still pinned by source-read (test 3).

## Nick's five questions

1. **Well built?** Yes for the scope of the row: one pure function, one prop,
   two call sites, 28/28 targeted tests green, mutation sweep kills both the
   unit and call-site mutants.
2. **Stats or made up?** Neither — no statistic changed. This rewires which of
   two EXISTING numbers a colour comes from; `ceiling_delta` was already
   computed and displayed (`trade-engine.js:1183`, `TradeCard.tsx:125`).
3. **How we know:** source-read/extraction tests run against this tree
   (see RED/GREEN above); not a backtest — there is no model claim to backtest.
4. **Pointed anywhere else on the platform?** `ceiling_delta` is also used in
   the trade-explain prompt string (`server/routes/trades.js:1080`); this unit
   does not touch that surface. No other client reads `RiskStrip`.
5. **How it unifies:** one number (`ceiling_delta`, `trade-engine.js:1183`) is
   now the Weekly ceiling value, the Ceiling cell's value, and the Ceiling cell's
   colour. The summed package p80 is no longer printed in the cell (the earlier
   claim here that it could stay as text was wrong: it disagreed with the new
   colour on 37/122 sides). It survives only on the Evidence line — named
   follow-up above.

## Defect/gap fixed, incumbent, coverage

- Defect: `RiskStrip.tsx` (pre-fix, commit `89f69b3b`..`ab8ec67e` tree)
  `ceilBetter = risk.out.p80 != null && risk.in.p80 != null ? risk.in.p80 - risk.out.p80 : null`
  coloured the Ceiling cell from summed package p80.
- Incumbent: `git show 89f69b3b:client/src/components/trade/RiskStrip.tsx` (the
  pre-fix source, same as origin/main at the time this unit started).
- Covers: served-card rerun, 37 → 0 of 122 contradictions (local copy).
- Does NOT cover: the server's summed band on the Evidence line (follow-up above).

## Holdout looks

- RL-3-3, 2026-09-23: none. No model is fitted or graded; the rerun counts sign
  agreement between two displayed numbers on 2026 W3 served cards (local copy).
- Would make it wrong: if `ceiling_delta`'s sign convention on `trade-engine.js`
  ever flips (positive stops meaning "that side's lineup ceiling improved") the
  `ceilingBetter` mapping in `RiskStrip.tsx` would need to flip with it — same
  risk the deleted `ceilBetter` carried, unchanged by this fix.
