---
name: zero-is-not-missing-in-participation
description: In nflverse participation and FTN charting, 0 and FALSE mean "not a dropback" not "missing"; the two files also carry the SAME nominal column with different values, so a figure is meaningless without naming its file.
metadata:
  type: feedback
---

Measured 2026-09-22 on the real 2024/2025 files by two Gridiron HQ threads.
These columns are dense, not sparse, and the density is the trap: the rows
that look like data are run plays, kneels, punts and kicks.

**Gate everything on a real dropback, and the dropback flag is
`number_of_pass_rushers > 0`.**

| column | the trap | wrong | right |
|---|---|---:|---:|
| `number_of_pass_rushers` | 0 on non-pass plays, not NA (23,754 of 45,905 in 2024) | 2.0798 | 4.2548 |
| `was_pressure` | non-blank on nearly every row; 51.2% of non-blank rows on 2024 are non-dropbacks reading FALSE | 0.1539 | 0.3145 |
| `n_blitzers` (FTN) | 0 on runs, but also a real "nobody blitzed" | — | see trap 2 |
| `defenders_in_box` | 0 means NOT CHARTED, and box is charted on runs too | 4.8726 | 6.0970 |

**Box is not a dropback statistic.** Its right denominator is every charted
snap, which is exactly `NULLIF(defenders_in_box, 0)` = 6.0970 over 36,686 rows
(2024). A dropbacks-only mean (5.8460) is a different, also-valid statistic —
do not call it the truth for this column.

**Trap 1 — do NOT gate on `time_to_throw`.** 2,689 coverage-charted rows have
coverage and no `time_to_throw`, and **74% of them are pressured**, because
they are the sacks and scrambles. Gating on it deletes the signal exactly
where it is strongest.

**Trap 2 — `NULLIF(x, 0)` is right for `n_defense_box` and
`n_pass_rushers` and WRONG for `n_blitzers`.** 15,930 of `n_blitzers`'s zeros
are on genuine dropbacks, because rushing four and blitzing nobody is a
measurement, not a missing value. Dropping them roughly doubles the blitz
rate. The two fixes look identical in the code.

**Trap 3 — participation includes special teams.** Every punt and kick carries
its own `possession_team`. Folding every row gave an 11-personnel rate of 35%
and a mean box of 5.0. Restrict to scrimmage plays via play-by-play `play_type`
/ `posteam` first; 11 personnel then reads 0.58-0.63 and box 6.0-6.4.

**How to apply:** before publishing any rate derived from these files, check
the league aggregate against a value you know independently (11 personnel
~0.60, box ~6.0-6.5, pass rushers per dropback ~4.3, blitz rate ~0.26,
pressure rate ~0.30). Every one of the bugs above was caught that way and none
of them would have been caught by reading the code.

**Trap 4 — THE SAME COLUMN EXISTS IN BOTH FILES WITH DIFFERENT VALUES.**
Verified on 2024, joined on `(nflverse_game_id, play_id)`, 45,905 rows:

| | participation | FTN charting |
|---|---|---|
| pass rushers | `number_of_pass_rushers` | `n_pass_rushers` |
| | 23,754 zeros, **286** charted | 23,754 zeros, **298** charted |
| | identical on 45,876 rows, **differ on 29** | |
| box | `defenders_in_box` | `n_defense_box` |
| | **9,219** zeros | **9,475** zeros |
| | identical on 45,618 rows, **differ on 287** | |

Identical zero *totals* and near-identical values make them look like one
column, which is how a figure from one gets published under the other's name —
that is exactly how 286 and 298 both came to be quoted for the same thing, and
both were right for their own file. **Name the file with every number.**

Detail and the derivation: [[gridiron-v2-satellites-absent]],
[[gridiron-participation-not-dead-after-2023]].
