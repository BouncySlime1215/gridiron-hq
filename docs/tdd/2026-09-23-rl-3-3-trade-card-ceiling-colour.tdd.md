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
- The Ceiling cell's title text now says explicitly that colour comes from the
  lineup's Weekly ceiling change, not the two p80 numbers shown in the cell.

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

- The 37-62/122-180 contradiction count is the queue row's own measurement
  (R1 lead, WORK-QUEUE.md `RL-3-3`), not re-run in this unit — no script to
  reproduce it was named in the row or found under `scripts/`. If Nick wants
  that count re-verified post-fix, it needs a script that renders (or
  simulates) both numbers across live trade offers and counts sign
  disagreement; none exists yet.
- This does not touch the Floor or Consistency cells, which already colour off
  package-level sums (`floorBetter`, `swingBetter`) — those are not lineup-level
  numbers on this card and are out of this unit's scope per the row.
- No render harness exists for this client (documented at
  `test/trade-manager-read.test.js:42`), so GREEN is proven by source-read /
  extraction + eval, the existing idiom, not a rendered DOM assertion.

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
5. **How it unifies:** one number (`ceiling_delta`) now drives both the printed
   "Weekly ceiling" value and the Ceiling cell's colour — the "one number, one
   producer" rule applied within this card. `PackageRisk.p80` remains displayed
   as text (it answers a different question — the packages' own preseason
   band) but no longer drives a colour that can disagree with the lineup number
   next to it.

## Defect/gap fixed, incumbent, coverage

- Defect: `RiskStrip.tsx` (pre-fix, commit `89f69b3b`..`ab8ec67e` tree)
  `ceilBetter = risk.out.p80 != null && risk.in.p80 != null ? risk.in.p80 - risk.out.p80 : null`
  coloured the Ceiling cell from summed package p80.
- Incumbent: `git show 89f69b3b:client/src/components/trade/RiskStrip.tsx` (the
  pre-fix source, same as origin/main at the time this unit started).
- Does NOT cover: re-measuring the 37-62/122-180 contradiction count after the
  fix (no script found); does not change what the two numbers ARE, only which
  one colours the cell.
- Would make it wrong: if `ceiling_delta`'s sign convention on `trade-engine.js`
  ever flips (positive stops meaning "that side's lineup ceiling improved") the
  `ceilingBetter` mapping in `RiskStrip.tsx` would need to flip with it — same
  risk the deleted `ceilBetter` carried, unchanged by this fix.
