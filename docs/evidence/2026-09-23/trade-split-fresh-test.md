# trade-split-fresh-test: BLOCKED before any number (RL-8-2b, Trade Machine gate)

> **Resolved 2026-09-23:** Nick took option 1 (ruling NICK-2025). The section 5 draft became
> `trade-split-2025-preregistration.md` (committed first, `eea0a3bd`); the one 2025 run declined both arms.
> Results: `docs/tdd/2026-09-23-rl-8-2b-trade-split-2025.tdd.md`. Sections below are the original blocked audit.

**Status: BLOCKED. No outcome number was run.** The unit asks for a fresh test of RL-8-2's post-hoc split
(1-for-1 consensus edge; 2-for-1 reversal) "on data not yet used for this question: Sleeper 2021-22 trades".
The audit below shows 2021-22 **was already used for this exact question** by RL-8-2 itself, and it is also the
fit period of the consensus curve. A test there cannot be fresh. The only unused data are the 2025 held-out season
and the 2026 forward trades. Opening 2025 needs Nick's word; 2026 is too small today. Nick picks one option in
section 4; the pre-registration for it is drafted in section 5 so it can be committed before any number.

Unit RL-8-2b, 2026-09-23. Tree: origin/main `ca64b2cc`; RL-8-2 read at `53634d3f`
(branch `claude/local-rl-8-2-consensus-vs-humans-lineup`, PR #196).

## 1. Audit: what already exists (extend or build)

- **Extend, not build.** RL-8-2's script `scripts/rnd/consensus_vs_humans_lineup.py` (at `53634d3f`) already builds
  the sample, orientation, consensus value `x_con`, season-to-date `x_std`, and the lineup outcome
  `y_L = trade_sides.net_started_pts / sides_ext.n_h_weeks`. Producers it reuses:
  - `trade_sides.net_started_pts`: table `trade_sides` in `rnd/skill/team_seasons.sqlite`, writer
    `rnd/skill/build_03_leagues.py:386-398`.
  - `sides_ext.n_h_weeks`, `L_frozen`: table `sides_ext` in `rnd/skill/trades/trades_ext.sqlite`, writer
    `rnd/skill/trades/tr_01_sides.py:150-196`.
  - The frozen-roster projected lineup gain (the existing "lineup value that charges the roster spot" candidate for
    part (b)) is the skill study's `E_L`, same writer file.
- Any fresh test should import those functions and producers unchanged, adding only the roster-spot value for
  2-for-1 / 2-for-2 and the new strata. No server file, table or column is involved; "one number, one producer" is
  not applicable (a gate decision, not a served value).

## 2. Why 2021-22 is not fresh for this question

Command (read-only, committed output of RL-8-2):

```
git show 53634d3f:docs/evidence/2026-09-23/consensus-vs-humans-lineup-output.txt | grep -n -E '2021|2-for-1|1-for-1'
```

Relevant lines of that output (RL-8-2 already printed these outcomes on 2021-22):

| output line | what RL-8-2 already measured on 2021-22 |
|---|---|
| 23 | 2021-22 pooled 1-for-1 + 2-for-1, lineup points: disagreement n=342 of 1,048 |
| 43 | 2021-22 2-for-1 direction split: consensus favours the 2-player side in 25 of 174; wins 0.458 there vs 0.422 on the 1-player side (n=149) |
| 44 | 2021-22 1-for-1, lineup points: disagreement n=168 of 617 (evidence file: 0.540 [0.478, 0.600]) |
| 47 | 2021-22 2-for-1, lineup points: disagreement n=174 of 431 (evidence file: 0.427 [0.367, 0.488]) |

- So both halves of the split were already observed on 2021-22, in the same metric (starting-lineup points), on the
  same sample definition. The 2-for-1 direction finding that motivates part (b) (the side receiving two startable
  players wins) was also seen there. A "fresh" run would reproduce these numbers.
- Second contamination: the consensus curve behind `x_con` is fit on 2021-22 only (RL-8-2 pre-registration line 22,
  `R6[R6.s <= 2022]` in the script). Grading `x_con` on 2021-22 is in-sample for the value model.
- 2-for-2 trades were not in RL-8-2's board (1-for-1 and 2-for-1 only), so 2-for-2 on 2021-22 is technically
  unused. But part (b)'s model was designed from the 2-for-1 pattern in the same seasons; a 2-for-2-only test
  would be a narrower question than the unit asks, and running it anyway would route around the failure.

HOLDOUT-LEDGER check: `git show origin/main:docs/evidence/HOLDOUT-LEDGER.md | grep -n -i -E 'trade|2021|2022|consensus'`
returns no trade-question row (hits are betting/projection rows only). RL-8-2 logged "Holdout looks: none" because
it never opened 2025. The ledger tracks 2025 looks, so it could not flag 2021-22 reuse; RL-8-2's own output does.

## 3. What data exists (known-nonzero control first)

```
sqlite3 "file:data/derived/sleeper_history.sqlite?immutable=1" "select l.season, count(*) from sh_transactions t join sh_leagues l on l.league_id=t.league_id where t.type='trade' and t.status='complete' and l.season<=2024 group by 1"
-> 2021|1533  2022|1829  2023|1889  2024|1388
sqlite3 "file:rnd/skill/team_seasons.sqlite?immutable=1" "select season,count(*) from trade_sides where season<=2024 group by 1"
-> 2021|3082  2022|3674  2023|3792  2024|2787
```

The Sleeper corpus and the skill-study tables start in 2021. Every season 2021-24 was used by RL-8-2 for this
question (2023-24 primary, 2021-22 secondary and post-hoc). The seasons not yet used are:

- **2025**: held out. Not opened here (every query above filters `season <= 2024`).
- **2026 forward**: Nick's leagues, about 9 accepted trades so far (RL-8-2 evidence section 5.3). The
  RL-8-2 MDE for 1-for-1 at n=204 was 0.089, so about 9 trades cannot decide anything.

## 4. What Nick decides (one question)

1. **Open 2025 once for this question** (recommended). One pre-registered, ledgered look at Sleeper 2025 trades,
   with the section 5 pre-registration committed first. That is the only fresh, adequately sized data.
2. **Run on 2021-22 anyway, labelled "replication on used data, not confirmatory".** It cannot ship the gate; it
   would restate RL-8-2's numbers. Not recommended.
3. **Wait for 2026 forward.** Gate stays default-off, labelled "unconfirmed forward", until roughly 200 disagreement
   trades exist (a guess from RL-8-2's MDEs; not achievable this season from Nick's leagues alone).

Until then the Trade Machine keeps RL-8-2's ruling: no lineup-points consensus edge may be claimed; anything built
on it ships default-off.

## 5. Pre-registration draft (inactive until Nick picks option 1)

To be committed as its own file, unchanged except the data line, **before** any 2025 number is run.

- **Data:** Sleeper 2025 regular-season trades from `sh_transactions`, `n_partners = 1`, no picks; opened once;
  one row appended to `docs/evidence/HOLDOUT-LEDGER.md` (unit, date, hypothesis, metric, result).
- **Outcome (sign convention):** `y_L` = rest-of-season starting-lineup points per week gained by the side named
  by the model, from `trade_sides.net_started_pts / sides_ext.n_h_weeks`; positive = model's side gained. Win = the
  named side's `y_L` > the other side's; ties dropped and counted.
- **(a) 1-for-1:** among trades where consensus `x_con` and season-to-date `x_std` disagree in sign, the
  consensus-favoured side wins > 0.55 **and** the chain-clustered 90% bootstrap CI lower bound > 0.50.
- **(b) 2-for-1 and 2-for-2 (reported separately and pooled):** the lineup-value model (receiving team's lineup
  value after the trade minus before, with the freed or filled roster spot charged at that team's replacement-level
  starter at the slot, from the frozen-roster `E_L` producer) names the `y_L` winner > 0.55 **and** summed consensus
  `x_con` names it <= 0.50 on the same trades. CI rule as in (a) on the pooled rate.
- **Baseline and decision win rate:** summed consensus (b) and season-to-date (a); report decision win rate of each
  arm against those baselines, plus mean `y_L` difference.
- **Power:** MDE at 80% power from the clustered SE (`mde80` in RL-8-2's script) for every arm, so a miss is never
  read as "no effect".
- **Placebo:** RL-8-2's P1 (random same-position traded player in the same season-week) and P2b (outcome
  permuted within season; must centre within [0.47, 0.53] or the run is void).
- **Ship rule:** the gate ships ON only if (a) or (b) passes here **and** holds directionally on the 2026 forward
  trades; otherwise it ships default-off, labelled "unconfirmed forward".
- **Literature:** trade acceptance between rational parties implies little residual edge on average (the no-trade
  theorem, Milgrom and Stokey 1982), so a consensus edge should appear only where humans systematically misprice;
  lineup-points grading follows the replacement-level logic of value over replacement (Tango, Lichtman and
  Dolphin, *The Book*, 2007). Post-hoc splits need out-of-sample confirmation before use (Simmons, Nelson and
  Simonsohn 2011, "False-positive psychology").

## Holdout looks

None. 2025 was not opened. No outcome of any season was computed in this unit. Unit RL-8-2b, 2026-09-23.

## Nick's five questions

1. **Well built?** Nothing was built: the unit stopped at the audit because its data premise failed. No script, no
   tests, so no RED/GREEN or mutation sweep (not applicable).
2. **Stats or made up?** No new stats. Every number above is a row count or a quote of RL-8-2's committed output,
   with the command. "About 200 trades needed" is a guess from RL-8-2's MDEs.
3. **How we know?** RL-8-2's output lines 23, 43, 44 and 47 print 2021-22 results for both halves of the split.
4. **Pointed elsewhere?** No served value, route or table changes; the Trade Machine's current default-off ruling
   from RL-8-2 stands.
5. **How it unifies?** The fresh test, when allowed, reuses RL-8-2's script and the skill study's producers
   (`trade_sides`, `sides_ext`, `E_L`) rather than a second value model.
