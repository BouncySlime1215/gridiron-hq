# Return to Codex — September 11, 2026

**Status: evidence, not instructions.** The single active plan remains
[`docs/CLAUDE-NEXT-STEPS.md`](../../CLAUDE-NEXT-STEPS.md); its §0 status register is updated to match this
document. Commits referenced here: `dd13278`, `e02b362`, `8659613`, `d643567`, `61cde5a`, `e867ecc`, `03cf3e0`.

Read §1 first. It is the only part that changes how the previous review should be read.

---

## 1. C03's caveat was not a caveat. It was a blind spot, and it hid two startup-fatal defects.

The register recorded C03 as *"exercised against fixture databases only. No installation carrying real
execution rows exists to upgrade — which is why this was never hit."* That sentence was true and it was the
wrong conclusion to draw from it.

Two migrations shipped that **could not run on the developer's own database**:

| Migration | The write | The guard it hit | Rows in the live DB |
|---|---|---|---|
| `031_decision_identity` | `UPDATE nfl_decision_runs SET content_hash = …` | `nfl_decision_runs_no_update` (installed by 027) | 0 — so this one was luck |
| `032_quote_receipt_clock` | `UPDATE nfl_quote_batches SET received_at = …` | `nfl_quote_batches_no_update` | **1,154** |

`runMigrations()` is awaited before any route module imports. So this is not a bad row: it is an application
that cannot start, deterministically, on every boot, with 031 already committed and the database pinned one
migration short. The failure mode is self-perpetuating — each restart re-attempts and re-fails.

**Neither was reachable from an empty fixture.** The tables existed in the fixture; they held no rows; the
`UPDATE` matched nothing; the trigger never fired; every test passed. The two were found three days apart by
two different readers, both by running the migration against real data.

The generalisable lesson, stated for the register rather than for this incident: **a table that exists in the
fixture and holds no rows is a table whose migration is untested.** "Populated upgrade" has to mean populated
in the tables the migration actually writes to.

### What now prevents the third one

Fixtures in `test/migration-027-populated-upgrade.test.js` now seed a legacy decision run *and* two legacy
quote batches, so both backfills execute under test. More usefully, a new test reads every migration and every
trigger installed by the schema and by migrations, and fails on any `UPDATE`/`DELETE` against a protected table
that does not lift and restore that exact trigger.

**That scan immediately found a third latent instance**: `007_model_permissions_and_upgrade_guard` makes
`model_audit_log` append-only and `008_model_actor_foreign_keys` backfills it with an `UPDATE`. It has never
fired only because 007 and 008 ship together and the log is empty when they run. Luck, not design. Fixed.

### The real installation is now upgraded

Rehearsed first on an 8.7 GB `VACUUM INTO` copy: 031–034 applied in 52.6s, all 1,154 batches labelled
`legacy_request_time_only`, all 1,384,350 `nfl_quote_tape` rows intact, both triggers restored. Then applied to
the developer's own 9.0 GB database, which now sits at **035_alt_spread_capture**. C03 advances
`tested → installed`, and required return #3 is delivered against a real installation rather than a fixture.

---

## 2. Numbers in the plan and in the code that were wrong

Each of these was asserted somewhere and is now measured. All four corrections move **against** the project.

**`teaserEV` modelled two outcomes where there are three.** `p^legs × payout − 1` prices a pushed leg as a
total loss. A push removes the leg and reduces the ticket. On the cross-both family at +100 the module read
**+9.70%**; the correct figure is **+9.06%**. The correction lowers expected value. It arrived in the same week
as a widened leg set and a good observed price, and it would have been easy to read a maths fix as a discovery.

**The same-week leg correlation has the opposite sign on the family actually bet.** The `+0.082` this project
quotes is real, and belongs to the **classic six-line Wong window over 1999–2025**. On the eight-line
cross-both family, 1999–2024: joint 54.00% against `p²` of 54.85%, **ρ = −0.044**, bootstrap CI
[−0.091, −0.004], over 8,224 same-week pairs. Independently reproduced. So assuming independence is mildly
**optimistic** here, not conservative — it overstates a two-leg ticket by about 0.85pp.

**`z = 1.99` was not cluster-robust.** Clustering same-week legs gives SE 1.29pp rather than 1.17pp, so the
classic window is **z = 1.80**, one-sided p = 0.036. Still clears the bar, less comfortably than the docstring
claims.

**`wongHistory()` computed its headline across corrupted seasons.** It had no season bound, so the quoted
74.69% spanned 1999–**2025**. See §3. Bounded to 1999–2024, the eight-number family measures **2,894 legs,
26 pushes, 2,868 decided, 74.06%**.

---

## 3. Data defects found, with the check that establishes each

These matter to any future analysis and none was known when the plan was written.

**`game_lines.spread` is corrupted for 2025 and 2026, and 2026 is live.** Integer share of closing spreads:

| 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|
| 49.5% | 51.1% | 48.4% | 47.7% | **24.9%** | **16.2%** |

Against `nfl_odds_archive`'s real books, `game_lines` is off by exactly 0.5 in 57% of 2025 games where the real
close is an integer. Integers −1, −2, −4, −5, −8, −9, −12, −13, −15 are entirely absent from 2025. The 2026
ESPN feed shows the same signature. Ten books agree with each other; `game_lines` is the outlier.

**`game_lines.open_spread` is stored home-perspective on BOTH rows for 2022–2025.** Antisymmetry over
game pairs:

| season | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|
| antisymmetric | 256/256 | 251/251 | 272/272 | **5/267** | **4/285** | **1/285** | **4/285** | 271/271 |

(The handful in 2022–2025 are pick'em games, where both readings coincide.) Uncorrected, this inflates apparent
line movement from ~1.0 to ~5.3 points per game. **Any analysis using `open_spread` for 2022+ is working with
garbage.** Repairing it (negate the away row) validates against `nfl_odds_archive` openers at median
|difference| = 0.00, 100% within one point, n = 347.

**`closing_spread`, `closing_total` and `book_count` are NULL for every season except 2026.** Verified
directly: 0 non-null in 2022–2025, 542 of 544 in 2026. `game_lines.spread` *is* the closing spread.

**`nfl_odds_archive` carries ~2.68% junk rows** — 1,198 of 44,742 sit more than 3 points from the same-phase
cross-book median, and 20.8% of those are exact sign flips (a 2022 PIT line of −7.0 against a +7.0 consensus).
All 11 books affected; worst are `mybookieag` and `bodog`. This was material: it manufactured the one apparently
significant result in §4 below.

**DraftKings is absent from `nfl_quote_tape` for the 2026 season.** Zero rows; the newest DK row is from
January. Its live board is in `nfl_line_snapshots`, scraped hourly and second-hand. Separately,
`simultaneousQuotes()` pins each event to its single newest capture instant, so every slow-tier book is shadowed
by a fresher fast-tier row and disappears from the shopping board entirely — DK, FanDuel, BetMGM, Circa, bet365,
Caesars and BetRivers, almost all of the time.

---

## 4. What the measurement concluded

The plan's §9.1 stages family adaptation behind a frozen first comparison. That comparison has still not been
run. What *has* been run is the narrower question of whether any existing signal selects bets, and the answer is
uniformly negative:

| Question | Result |
|---|---|
| Does the ensemble's edge predict how games land vs the spread? | **r = −0.007**, p = 0.72, n = 2,761 |
| Do game features predict margin dispersion? | 87 features × 6 targets = **501 hypotheses**, 0 survive BH q<0.10 |
| Is there a better key-number window than the classic one? | **4,060** searched; best max-z 2.87 against a bootstrapped ceiling of 4.26 |
| Do market-structure signals separate qualifying legs? | **6 pre-registered** hypotheses, discovery/holdout split, all null, Holm p ≥ 0.99 |

Roughly **4,600 formal tests; zero survivors of multiple-comparison correction.**

Two findings from that work are worth carrying forward independently of any conclusion:

**σ(margin − spread) ≈ 12.7 and does not move with the line at all.** Log-σ slope on |spread|, 2016–2022:
−0.0008, p = 0.86. σ is 12.73 at a 1-point spread and 12.64 at a 10-point spread. The single most informative
variable in the system carries *zero* dispersion information. That is the strongest available prior for why
nothing downstream of it does either.

**The shipped disagreement-inflation term has no support.** `nfl-ensemble.js:220` widens the predictive
interval by `1 + min(0.25, disagreement/30)`. Measured: −0.64% per SD, p = 0.70 — wrong sign — and it flips sign
between panels. Not a bug; not a measurement either.

**The one apparently significant result was a data defect.** A cross-book "book advantage" signal passed
discovery (p = 0.0005), holdout (p < 0.0001) and Holm (0.0002). Trimming to physically plausible disagreement
(|advantage| ≤ 1.0 point) removes 1.3–3.2% of rows and collapses it to p = 0.396 / 0.910. The tail was the junk
archive rows in §3. Worth recording as the shape of a false positive this database can produce.

**Power, which is the honest frame for every null above.** The realised holdout could only have detected effects
worth 3.35–9.86pp of leg rate. To detect a 1pp gap at 80% power needs **60,317 legs ≈ 543 seasons**. These nulls
do not establish absence; they establish that the question is unanswerable at any sample this project will ever
have. That argues against acting on a *future* significant result from this family too.

---

## 5. What has not moved

Stated plainly, because the register should not read as if the work advanced further than it did.

- **Nothing is `qualified`.** The highest state reached is now `installed` (C03), and that is a deployment fact,
  not an evidential one.
- **Required return #4 is still not delivered.** No forecast consumes the frozen packet; every run still records
  `data_identity_status: unfrozen_live_tables`. There is still no packet-to-decision trace showing a news fact's
  real numerical influence.
- **The hosted Node 22 CI job has still never been run.** Local runtime is Node 25. Current suite: 1,618 tests,
  1,579 pass, 0 fail, 39 skipped.
- **C12 remains `connected`.** The T−60 runner has still never run against a real slate; zero prospective
  observations exist.
- **Slices 7 and 8 remain open**, correctly, behind §9.1's staging.
- **The historical record is unchanged and must stay unchanged**: 153 spread bets, −11.855 units, −7.75% ROI.

---

## 6. The one thing that did advance, and why it is not a counterexample

Work outside the plan established that the **two-team six-point teaser** is the single defensible bet this
database supports: 2,894 legs at 74.06% on the eight lines where six points crosses both 3 and 7, stable across
eras, and mechanical rather than predictive — it exploits the margin distribution, not a forecast.

This is **not** a qualification and should not be recorded as one. It is a known public edge, it is thin
(break-even −120.22 on two legs), and its decisive input had never been observed: `nfl_teaser_price_ledger` held
**zero rows** until 2026-09-10, when the first real price was recorded (DraftKings, +100, push reduces). Between
−110 and −130 the same bet runs +4.16% to −3.37%. The football was never the binding constraint; the price was,
and it was assumed rather than measured for the entire life of the module.

That is the same class of error as the clock mislabel in C11 and the case-sensitivity in C09: **a confident
number resting on an input nobody had checked.** It belongs in the register as a pattern, not as a result.
