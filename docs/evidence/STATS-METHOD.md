# Statistical method contract

Every statistical unit follows the eight rules below. A unit is statistical if
the work queue marks it PRE, or if it produces or changes a number a model
serves: a projection, availability, playoff odds, trade value, a usage share,
a decision threshold. A pull request for such a unit is not ready to merge until
each rule is answered in its evidence file. "Not applicable, because ..." is an
answer. Silence is not.

This file consolidates rules that were scattered across memory files, module
comments and handoffs. It adds two things that did not exist before: a ledger
of every look at 2025 (rule 2) and a false-discovery correction across that
ledger (rule 3). It also sets a forward rule on 2026 for every unit's ship
decision (rule 5). That rule is not the first code to gate on 2026. The
scheduled job `nfl_weekly_learning` already captures 2026 forecasts, and it is
built to fit and auto-promote weekly weights on them. The model registry's
sealed holdout also picks its own season. Rules 2 and 5 name both and say how
each relates to this contract. Where a rule already existed, its source is named
next to it.

Written 2026-09-22 by unit S-00 (plan item 18, Goodhart guards), on
`origin/main` at `d6d7bd5a`. Evidence file:
`docs/tdd/2026-09-22-stats-method-contract.tdd.md`.

**Why these rules.** Once a scorecard exists, work drifts toward whatever
raises the score. Holding out a season only protects against that if the season
stays unseen. The 2025 season has now been looked at no fewer than 153 times in this repo's
own evidence (`HOLDOUT-LEDGER.md`), and fit-1, the promoted weekly weights, was
trained on 2023-2025 (`scripts/fit-weekly-coverage.mjs:62,66`). So a new 2025
result is partly in-sample before it is run. These rules keep that visible and
price it in.

---

## Rule 1. Pre-register before any result exists

Commit a pre-registration to `docs/evidence/` or `docs/tdd/` **before** the
commit that contains any number from the test. The pre-registration's commit
must be an ancestor of the result's commit. It states:

- the hypothesis, in one sentence;
- the metric, and its **sign convention** (this repo uses candidate − incumbent,
  so a negative MAE change is an improvement, unless the file says otherwise);
- the split: fit seasons, the held-out season, weeks, and population;
- the incumbent, meaning the app as served, found by command, plus the dumb
  baseline (rule 6);
- the ship rule, including the forward-holdout check (rule 5);
- the minimum detectable effect the design can see at 80% power (rule 4);
- the replay configuration (rule 7);
- a literature grounding in 2-3 sentences.

If a result has to be re-run under a changed rule, the changed rule is committed
first and says so, as `docs/tdd/play-chance-gate-v2.md` did. There is no
quiet re-run.

*Consolidates:* work queue section 4 rule 2 (memory
`gridiron-auditor-charter-0714-2026-09-22`, submission format (a)-(d)); the house
harness in the work queue's section 3 header; `server/services/audit-registry.js`
(`preregister()` / `runAudit()` for tests registered in the app database).

## Rule 2. Every look at 2025 goes in the ledger

Any run that computes a metric, an interval, a p-value or a pass/fail verdict
with 2025 outcomes as evaluation data appends one row per hypothesis test to
`docs/evidence/HOLDOUT-LEDGER.md`, **in the same commit as the result**. That
includes re-runs, smoke runs that print a 2025 number, failed gates, diagnostics
and "report only" metrics. Rows are never edited or deleted. A correction is a
new row that names the row it corrects.

Pooled or multi-season results that include 2025 count as looks at 2025
(the Phase A walk-forwards over 2018-2025 are in the ledger for that reason).
Fitting or tuning on 2025 without reporting a 2025 metric is not a row, but the
evidence file must say so, because it spends the season too.

**The model registry seals a different season.** The registry's holdout code
does not follow "2025 is the held-out season". `createWalkForwardSplits`
(`server/modeling/walk-forward.js:35`) seals the **latest season in the pinned
dataset** (`holdoutSeason ?? seasons.at(-1)`, `:42`). For any other season it
throws `final holdout must be the latest season` (`:44`). The dataset is
whatever a caller posts to `POST /registry/datasets`
(`server/routes/model.js:157`, insert into table `model_dataset_versions` at
`:172`). So:

- An experiment whose dataset includes any 2026 week seals **2026** and refuses
  `holdout_season: 2025`. Its walk-forward folds then score every earlier
  period, 2025 included (`walk-forward.js:46-51`), and that fold run is a look at
  2025 like any pooled run.
- An experiment whose dataset ends at 2025 seals 2025. Opening it is a look at
  2025.
- `openFinalHoldout` (`walk-forward.js:112-118`) marks the holdout `opened_once`.
  The holdout route refuses a second opening **for the same experiment**
  (`server/routes/model.js:317`). It writes protocol `sealed_holdout` to table
  `model_backtests` (`:348-349`). Promotion requires that row
  (`server/routes/model.js:371-377`). Nothing counts openings **across**
  experiments: ten experiments can each open 2025 once. That is the gap this
  ledger fills.

How the two relate: a registry opening of 2025 is a ledger row. A registry
opening of 2026 is a rule-5 forward look (an `F` row in `HOLDOUT-LEDGER.md`).
Neither gate replaces the other. A registry promotion needs the registry's
sealed-holdout row **and** this contract's rules. Today the path is unused. On a
local copy (not production, 2026-09-22), `model_experiments`,
`model_dataset_versions` and `model_backtests` each have 0 rows. Control:
`weekly_ensemble_fits` has 2 rows on the same copy. The commands are in section
6b of the evidence file.

*Consolidates:* Nick's statistical discipline (a), 2026-09-22; "validated on
2025 once" in the house ship rule (`server/services/matchups.js:33-35`); the
model registry's sealed holdout (`server/modeling/walk-forward.js:35-55` and
`openFinalHoldout` at `:112-118`). That holdout allows one opening per
experiment but does not count openings across experiments, and it seals the
latest season in the dataset, not 2025.

## Rule 3. False discovery control across the feature-lift family

A feature-lift result is a ledger row with family `FL`: "change X to a fantasy
model improves a 2025 accuracy metric against the incumbent". Every such result
is judged twice. First on its own pre-registered rule. Then with
Benjamini-Hochberg false-discovery control at **q = 0.10 across every `FL` row in
the ledger**, including the declined ones, because the declined tests are the
denominator that makes a single pass believable.

- **p-value per row.** Use the source's p-value if it printed one (two-sided).
  Otherwise derive p from the interval with the normal approximation of Altman
  and Bland (2011, *BMJ* 343:d2304): SE = (hi − lo) / (2z), with z = 1.645 for
  a 90% interval and 1.960 for 95%. Then z_obs = estimate / SE and
  p = 2(1 − Φ(|z_obs|)). If neither exists, the row is "not computable".
- **Primary.** Not-computable rows stay in the family with p = 1. They count in
  m and can never be discoveries. **Sensitivity.** The same run with those rows
  dropped.
- **Why BH and why q = 0.10.** Benjamini and Hochberg (1995, *JRSS B*
  57:289-300) bound the expected share of false discoveries among the results
  that pass, which is the error a feature pipeline actually makes. Benjamini and
  Yekutieli (2001, *Ann. Statist.* 29:1165-1188) show the bound holds under the
  positive dependence expected when many tests reuse the same 2025
  player-weeks. q = 0.10 is Nick's setting, and matches the one BH run already
  in the repo (`scripts/model-lab/mass_test_harness.py:16`).
- **One producer.** The arithmetic is `benjamini_hochberg` and `two_sided_p`
  from `scripts/model-lab/mass_test_harness.py:70,74`, not a new implementation.
  The command also runs the line-for-line identical copy at
  `scripts/model-lab/atom_drift.py:71` and stops if the two disagree.
- **The other correction in the repo.** `server/services/audit-registry.js:265`
  applies a Šidák family-wise correction at α = 0.05 to the sealed rows of table
  `audit_registry`. That is a different family and a stricter question. The
  command prints the Šidák verdict on the ledger family next to BH, so both can
  be read on one input. Making them one family and one correction is a
  follow-up, because it touches a server file this unit does not own.

### The command

Run from the repository root. It reads `docs/evidence/HOLDOUT-LEDGER.md` and
nothing else. The script is the block below, so the doc cannot drift from what
was run.

```
sed -n '/^```python holdout-ledger-bh$/,/^```$/p' docs/evidence/STATS-METHOD.md | sed '1d;$d' | python3 -
```

```python holdout-ledger-bh
# holdout-ledger-bh: run from the repo root. Reads docs/evidence/HOLDOUT-LEDGER.md only.
import re, sys
sys.path.insert(0, 'scripts/model-lab')
from mass_test_harness import benjamini_hochberg, two_sided_p  # canonical producer (:70, :74)
import atom_drift                                              # identical second copy (:71), cross-run

Q, ALPHA, Z80 = 0.10, 0.05, 0.8416212335729143
ZLEVEL = {'90': 1.6448536269514722, '95': 1.959963984540054}

# Literature control: the worked example in Benjamini & Hochberg (1995); q = 0.05 must reject 4.
BH95 = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459,
        0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1.000]
control = len(benjamini_hochberg(BH95, 0.05)[0])
print(f'control: BH 1995 example at q=0.05 rejects {control} (expected 4)')
assert control == 4

def num(s):
    s = s.replace('−', '-').replace('*', '').strip()
    return float(s) if s else None

rows = []
for line in open('docs/evidence/HOLDOUT-LEDGER.md', encoding='utf-8'):
    if not re.match(r'\| L\d{3} \|', line):
        continue
    c = [x.strip() for x in line.strip().split('|')[1:-1]]
    assert len(c) == 17, (len(c), line[:40])
    r = dict(id=c[0], dom=c[3], fam=c[4], hyp=c[5], est=num(c[8]), lo=num(c[9]), hi=num(c[10]),
             lvl=c[11], p_src=num(c[12]), better=c[13], ship=c[14], where=c[15], note=c[16])
    withdrawn = 'withdrawn' in r['note'] or 'not used for BH' in r['note']
    r['p'] = r['se'] = None
    mid = r['est'] if r['est'] is not None else (None if r['lo'] is None else (r['lo'] + r['hi']) / 2)
    r['mid'] = mid
    if withdrawn:
        r['why'] = 'withdrawn'
    elif r['p_src'] is not None:
        r['p'], r['why'] = r['p_src'], 'source p'
    elif r['lo'] is not None and r['hi'] is not None and r['lvl'] in ZLEVEL and r['hi'] > r['lo']:
        r['se'] = (r['hi'] - r['lo']) / (2 * ZLEVEL[r['lvl']])
        r['p'], r['why'] = two_sided_p(mid / r['se']), 'from interval'
    else:
        r['why'] = 'not computable'
    r['harmful'] = mid is not None and ((r['better'] == '-' and mid > 0) or (r['better'] == '+' and mid < 0))
    rows.append(r)

from collections import Counter
print(f'rows {len(rows)}; by domain/family {dict(Counter((r["dom"], r["fam"]) for r in rows))}')
fam = [r for r in rows if r['fam'] == 'FL']
comp = [r for r in fam if r['p'] is not None]
m = len(fam)
print(f'feature-lift family m = {m}; p computable {len(comp)}; not computable {m - len(comp)} '
      f'({dict(Counter(r["why"] for r in fam if r["p"] is None))})')

prim, crit = benjamini_hochberg([r['p'] if r['p'] is not None else 1.0 for r in fam], Q)
prim2, _ = atom_drift.benjamini_hochberg([r['p'] if r['p'] is not None else 1.0 for r in fam], Q)
assert prim == prim2, 'the two BH copies disagree'
sens, crit_s = benjamini_hochberg([r['p'] for r in comp], Q)
sidak = 1 - (1 - ALPHA) ** (1 / m)
bh_p = {fam[i]['id'] for i in prim}
bh_s = {comp[i]['id'] for i in sens}
print(f'BH q={Q}, primary (not computable enter as p=1, m={m}): critical p {crit:.4g}, discoveries {len(bh_p)}')
print(f'BH q={Q}, sensitivity (computable only, m={len(comp)}): critical p {crit_s:.4g}, discoveries {len(bh_s)}')
print(f'Sidak alpha 0.05 over m={m}: threshold {sidak:.3g}, discoveries {sum(1 for r in comp if r["p"] < sidak)}')

def fmt(p):
    return 'not computable' if p is None else ('<1e-12' if p < 1e-12 else f'{p:.2g}')

def verdict(r):
    if r['p'] is None:
        return 'not computable', 'not computable', 'not computable'
    a = 'survives' if r['id'] in bh_p else 'does not survive'
    b = 'survives' if r['id'] in bh_s else 'does not survive'
    s = 'survives' if r['p'] < sidak else 'does not survive'
    if r['harmful']:
        a, b, s = [x + ' (harmful direction)' if x == 'survives' else x for x in (a, b, s)]
    return a, b, s

print('\nPAST SHIPS (feature-lift rows whose shipped column starts with "yes")')
print('| id | hypothesis | p (two-sided) | BH primary | BH sensitivity | Sidak | direction |')
print('|---|---|---|---|---|---|---|')
for r in fam:
    if r['ship'].startswith('yes'):
        a, b, s = verdict(r)
        p = fmt(r['p'])
        d = 'n.a.' if r['mid'] is None else ('harmful' if r['harmful'] else 'favours candidate')
        print(f'| {r["id"]} | {r["hyp"]} | {p} | {a} | {b} | {s} | {d} |')

print('\nALL BH DISCOVERIES (primary)')
for r in fam:
    if r['id'] in bh_p:
        print(f'  {r["id"]} p={fmt(r["p"])} ship={r["ship"]} harmful={r["harmful"]} :: {r["hyp"]}')

print('\nMDE AT 80% POWER FOR DECLINED FEATURE-LIFT ROWS WITH AN INTERVAL (same units as est)')
print('| id | hypothesis | level | est | MDE80 | est / MDE80 |')
print('|---|---|---|---|---|---|')
for r in fam:
    if r['ship'].startswith('no') and r['se'] is not None:
        mde = (ZLEVEL[r['lvl']] + Z80) * r['se']
        print(f'| {r["id"]} | {r["hyp"]} | {r["lvl"]} | {r["mid"]:+.4g} | {mde:.3g} | {abs(r["mid"]) / mde:.2f} |')
```

### What it printed

Run on the ledger as committed (`HOLDOUT-LEDGER.md` at this commit; tree
recorded in the evidence file). Exit 0.

```
control: BH 1995 example at q=0.05 rejects 4 (expected 4)
rows 153; by domain/family {('fantasy', 'FL'): 76, ('fantasy', 'other'): 52, ('betting', 'other'): 25}
feature-lift family m = 76; p computable 57; not computable 19 ({'not computable': 19})
BH q=0.1, primary (not computable enter as p=1, m=76): critical p 0.01016, discoveries 11
BH q=0.1, sensitivity (computable only, m=57): critical p 0.01908, discoveries 12
Sidak alpha 0.05 over m=76: threshold 0.000675, discoveries 8
```

**Past ships.** A past ship is an `FL` row whose `shipped` column starts with
"yes". Verdicts, as printed by the command:

| id | hypothesis | p (two-sided) | BH primary | BH sensitivity | Sidak | direction |
|---|---|---|---|---|---|---|
| L006 | Separate role memory (seasonDecay 0.05, weekHalfLife 5) improves the structural head | not computable | not computable | not computable | not computable | favours candidate |
| L007 | Position-aware ensemble beats the fixed 60/40 blend | 0.054 | does not survive | does not survive | does not survive | favours candidate |
| L043 | Preseason p20/p80 band variant kernel-18 beats the raw band (top 150) | 0.079 | does not survive | does not survive | does not survive | favours candidate |
| L044 | Kernel band beats the raw band (top 200) | 0.047 | does not survive | does not survive | does not survive | favours candidate |
| L048 | Live board model-nudge weight 0.2 beats weight 0 | not computable | not computable | not computable | not computable | n.a. |
| L065 | Matchup card spread C2 (DEFAULT_CV x 1.63) beats current spread B0 | 0.019 | does not survive | survives | does not survive | favours candidate |
| L073 | Weeks 2-4: structural-only head (b) beats live fit-1 (a) | 1.8e-07 | survives | survives | survives | favours candidate |
| L077 | Fake-floors fix improves the printed percentiles (D1) | 4.2e-08 | survives | survives | survives | favours candidate |
| L082 | Vegas game-script lift (lineup-brain.js:280) improves weekly points | 0.034 | does not survive | does not survive | does not survive | harmful |
| L084 | Rest-of-season model (d) beats the weekly blend (a) for ros_ppg | <1e-12 | survives | survives | survives | favours candidate |
| L100 | Published cascade opportunity_without beats base_opportunity on absence weeks (Test A) | 0.99 | does not survive | does not survive | does not survive | favours candidate |
| L101 | Own recent usage x multiplier beats own recent usage (Test B) | 0.049 | does not survive | does not survive | does not survive | harmful |
| L152 | Four red-zone tiers beat three for expected touchdowns | 0.0043 | survives | survives | does not survive | favours candidate |

**How to read that table.**

- **Four past ships survive BH** in both the primary and the sensitivity run:
  the weeks 2-4 structural head (L073, fit-2), the fake-floors fix (L077), the
  rest-of-season model (L084), and the four red-zone tiers (L152). L152 does not
  survive the stricter Šidák correction.
- **One survives only when not-computable rows are dropped:** the matchup card
  spread, `SPREAD_SCALE` 1.63 (L065).
- **Three do not survive:** the position-aware weekly ensemble against the fixed
  60/40 blend (L007, p 0.054) and the preseason kernel band (L043, L044). Each
  passed its own rule. None survives the family.
- **Two point the harmful way**, and neither is significant after correction:
  the Vegas game-script lift, live and never gated (L082), and the published
  cascade multiplier on Test B (L101).
- **Two are not computable**, because no interval was printed: the role memory
  (L006) and the preseason nudge weight 0.2 (L048).
- Outside the "yes" rows, the primary run's other seven discoveries are the
  held chance-to-play model (L079, L081), the per-position target-share prior
  that ships default-off (L145, L146), the role-scenario touches forecast (L052),
  and the two opponent terms that failed split-half replication (L119, L120).

Nothing is switched off by this contract. The rows that do not survive, or that
are not computable, are the first candidates for a forward re-test under
rule 5.

**Limits of this correction, stated so nobody over-reads it.** Intervals from
player-clustered bootstraps are often asymmetric, and the normal approximation
treats them as symmetric. Rows grade different rigs, so the p-values are
comparable only as evidence strength, not as effect sizes. The efficiency-grid
rows (L094-L099) take the best of a nine-point grid, so their p-values are
optimistic. The family has 76 rows only because the census stopped at
`docs/evidence` and `docs/tdd`. Rows found later can only make the correction
stricter.

## Rule 4. Every decline reports its minimum detectable effect

A result that fails its ship rule is a decline, and it reports the smallest
effect the design could have detected with 80% power. Otherwise "underpowered"
reads as "no effect".

For a paired-bootstrap difference with standard error SE, judged by whether a
two-sided interval at level L excludes zero:

MDE80 = (z_L + 0.8416) × SE, where SE = interval width / (2 z_L).

For the house rule (90% interval entirely on the good side, which is a
one-sided test at α = 0.05) that is **1.512 × the interval's half-width**. For a
95% interval it is 1.429 × the half-width (Cohen 1988). The power paragraph
at `docs/evidence/2026-09-11/RETURN-TO-CODEX.md:186` is the house precedent for
reading a null through its power. The MDE is declared in the pre-registration (rule 1) from the expected
SE, and re-stated in the result from the realised SE.

The command prints the MDE for every declined `FL` row that has an interval. A
ratio |estimate| / MDE80 below 1 means the test could not have told that effect
from zero. A decline with a small MDE is informative. A decline with a large
one is only "not shown".

<details><summary>Declined feature-lift rows: realised MDE at 80% power (44 rows, from the command)</summary>

| id | hypothesis | level | est | MDE80 | est / MDE80 |
|---|---|---|---|---|---|
| L001 | Fitted shrinkage k* beats hardcoded K | 90 | -0.078 | 1.76 | 0.04 |
| L015 | Offseason team-change factor improves early-season opportunity (2025 weeks 2-5) | 90 | -0.033 | 0.0478 | 0.69 |
| L016 | Same factor, movers only | 90 | -0.149 | 0.222 | 0.67 |
| L024 | Cross-source ADP disagreement improves the ranker (additive) | 90 | +0.32 | 1.15 | 0.28 |
| L025 | Cross-source ADP disagreement improves the ranker (multiplicative) | 90 | +0.44 | 1.32 | 0.33 |
| L027 | Residual ECR velocity improves the ranker (top 150) | 90 | +0.47 | 65.8 | 0.01 |
| L031 | Fitted inverse-variance consensus weights beat hand-set 2:1 | 90 | +0.049 | 0.246 | 0.20 |
| L038 | Draft-board abstention gate separates reliable picks | 90 | -3.77 | 10.5 | 0.36 |
| L039 | Preseason p20/p80 band variant pooled beats the raw band (top 150) | 90 | +3.24 | 4.44 | 0.73 |
| L041 | Preseason p20/p80 band variant shrink-10 beats the raw band (top 150) | 90 | -0.57 | 1.16 | 0.49 |
| L042 | Preseason p20/p80 band variant shrink-50 beats the raw band (top 150) | 90 | +0.4 | 2.62 | 0.15 |
| L052 | Role-scenario allocation (Package D) improves the touches forecast | 90 | -0.0457 | 0.0432 | 1.06 |
| L069 | Matchup multiplier (home/away as live, 1.02 / 0.98) improves the live weekly projection | 90 | +0.0004 | 0.0062 | 0.06 |
| L070 | Matchup multiplier (home/away fitted, one h) improves the live weekly projection | 90 | +0.0036 | 0.0129 | 0.28 |
| L071 | Matchup multiplier (home/away fitted per position) improves the live weekly projection | 90 | +0.0043 | 0.0132 | 0.33 |
| L072 | Matchup multiplier (DvP strictly prior, fitted K 200, recency 0.5) improves the live weekly projection | 90 | +0.0007 | 0.00423 | 0.17 |
| L094 | A grid k beats the shipped literal for yards per target (2024-2025 pooled) | 90 | +0.0161 | 0.0243 | 0.66 |
| L095 | A grid k beats the shipped literal for catch rate (2024-2025 pooled) | 90 | +0.0005 | 0.00121 | 0.41 |
| L097 | A grid k beats the shipped literal for yards per attempt (2024-2025 pooled) | 90 | +0.0295 | 0.0841 | 0.35 |
| L098 | A grid k beats the shipped literal for receiving TD rate (2024-2025 pooled) | 90 | +0.0003 | 0.000605 | 0.50 |
| L099 | A grid k beats the shipped literal for rushing TD rate (2024-2025 pooled) | 90 | +0.0001 | 0.000454 | 0.22 |
| L115 | Prior-weeks opponent pass defence improves the weekly projection | 95 | +0.0265 | 0.081 | 0.33 |
| L116 | Adding own protection alone improves the weekly projection | 95 | +0.0004 | 0.00179 | 0.22 |
| L117 | Adding matchup (opp rush − own protection) improves the weekly projection | 95 | +0.0006 | 0.00429 | 0.14 |
| L118 | Adding sack and hit matchups improves the weekly projection | 95 | +0.0003 | 0.00457 | 0.07 |
| L119 | Adding opponent pass-rush rate improves the weekly projection | 95 | +0.004 | 0.00436 | 0.92 |
| L120 | Adding opponent pass EPA allowed improves the weekly projection | 95 | +0.011 | 0.00529 | 2.08 |
| L121 | Pass-rush on top of pass EPA allowed | 95 | +0.0012 | 0.00207 | 0.58 |
| L124 | Adding practice status (dnp/limited/full) improves the weekly projection | 95 | +0.0007 | 0.00565 | 0.12 |
| L125 | Adding report status (questionable/doubtful) improves the weekly projection | 95 | +0.001 | 0.00436 | 0.23 |
| L126 | Adding both improves the weekly projection | 95 | +0.0006 | 0.00579 | 0.10 |
| L127 | Adding red-zone inside-20 touches improves TD prediction | 95 | +0.00025 | 0.000557 | 0.45 |
| L128 | Adding red-zone inside-10 touches improves TD prediction | 95 | +0.00015 | 0.000386 | 0.39 |
| L129 | Adding red-zone both zones touches improves TD prediction | 95 | +0.00018 | 0.000579 | 0.31 |
| L130 | Adding red-zone inside-20 touches improves PPR prediction | 95 | +0.01966 | 0.0466 | 0.42 |
| L131 | Adding red-zone inside-10 touches improves PPR prediction | 95 | -0.00426 | 0.0159 | 0.27 |
| L133 | Red-zone touches, interaction variant 1 | 95 | +4e-05 | 0.000622 | 0.06 |
| L134 | Red-zone touches interacted with position | 95 | +7e-05 | 0.000622 | 0.11 |
| L135 | Red-zone touches interacted with snap share | 95 | +0.00018 | 0.000486 | 0.37 |
| L136 | Route share and targets-per-route improve the weekly projection | 95 | -0.001 | 0.0025 | 0.40 |
| L137 | Route share on top of snap share | 95 | -0.0007 | 0.00164 | 0.43 |
| L145 | Per-position target-share prior beats the single 0.06 prior (pre-registered primary) | 90 | +0.1044 | 0.0572 | 1.82 |
| L146 | Same, pre-registered secondary: rows with 3-5 prior games | 90 | +0.174 | 0.102 | 1.70 |
| L147 | Same prior on the availability-inclusive metric | 90 | -0.0136 | 0.0547 | 0.25 |

</details>

*Consolidates:* Nick's statistical discipline (c), 2026-09-22; the power
declaration in `docs/evidence/2026-09-22/coupled-prior-and-availability-preregistration.md`,
which the unit before it had missed.

## Rule 5. A result ships ON only if it also holds forward, on 2026

2025 is partly spent (rule 2), and fit-1, the promoted weekly weights, was
trained on 2023-2025 (`scripts/fit-weekly-coverage.mjs:62,66`). **No promoted
fit has been trained on 2026 yet.** On a local copy (not production,
2026-09-22), table `weekly_ensemble_fits` has 2 rows, both trained through 2025
week 18. That will change once the job described below fits on 2026. So a model
result ships ON only if it passes its pre-registered rule on 2025 **and** holds
on the 2026 weeks already played. Otherwise it ships default-off, behind a named
flag, labelled **"unconfirmed forward"** wherever it appears.

- **Weeks already played** means the distinct 2026 regular-season weeks in table
  `player_week_usage`, written by `syncWeeklyUsage`
  (`server/services/nflverse.js:245`, insert at `:260`), inside the unit's own
  week window. Today, on a local copy of the app database (local copy, not
  production, 2026-09-22), that is **weeks 1-2, 1,052 rows**. Control: the same
  query returns 18 weeks and 8,857 rows for 2025. The query is in the evidence
  file.
- **Holds** means three things. The frozen candidate and incumbent are scored on
  those weeks with the same metric, population and sign as the 2025 test. The
  forward point estimate has the same sign as the 2025 estimate. The forward
  interval does not exclude zero in the harmful direction. The unit reports the
  forward n and the forward MDE80 next to it, because two weeks can confirm a
  direction and almost never a size. This definition of "holds" is this
  contract's proposal. Nick can tighten it.
- **No forward weeks in the window** (for example, a weeks 5-18 model on
  2026-09-22) means default-off, "unconfirmed forward". It is re-checked once
  those weeks exist.
- Every forward check is itself a look at 2026. It goes in the
  "2026 forward looks" section of `HOLDOUT-LEDGER.md`, so 2026 does not get spent
  silently the way 2025 did.

### The job that already fits and gates on 2026

Rule 5 is not the only forward gate. The scheduled job `nfl_weekly_learning`
(`server/services/scheduler.js:1395`, runner `refreshWeeklyLearning` at `:547`,
which calls `runWeeklyLearningCycle` at `server/services/weekly-learning.js:401`)
does four things each run:

| step | function (file:line) | table and write |
|---|---|---|
| capture | `captureWeeklyPredictions`, `weekly-learning.js:49` | `weekly_prediction_snapshots`, `INSERT OR IGNORE` at `:63` (pregame, first write wins) |
| settle | `settleWeeklyPredictions`, `:155` | same table, `UPDATE ... SET actual` at `:157`, with the actual read from `player_week_usage` |
| fit and gate | `retrainWeeklyWeights`, `:224` | fits on the older 80% of settled rows (`:255`) and gates on the newest 20%: player-clustered paired bootstrap (`:304`), rank and coverage. `promoted` at `:310` |
| promote | `saveWeeklyFit`, `server/services/weekly-weight-store.js:140` | `weekly_ensemble_fits`, insert at `:147`. A promoted row becomes the served weekly vector |

The fit needs 250 settled rows outside the stored early window
(`minSettled`, `:224`, checked at `:243`; early-window filter at `:237`). The
job's gate is fixed in code, but it has no pre-registration under rule 1, and
it writes nothing to `HOLDOUT-LEDGER.md`. It is on the heavy tier, which runs on the timer only when
`AUTO_HEAVY_SYNC=1` (`scheduler.js:2116`). Table `sync_log` on the local copy
shows it has run twice, last at 2026-09-19 02:00 UTC, status ok. What
triggered those runs was not determined.

**Forward sources, same copy** (local copy, not production, 2026-09-22;
commands in section 6b of the evidence file):

| table (writer) | what it holds for 2026 | count |
|---|---|---|
| `player_week_usage` (`syncWeeklyUsage`, `nflverse.js:245`) | actuals | weeks 1-2, 1,052 rows (527 + 525) |
| `weekly_prediction_snapshots` (`captureWeeklyPredictions`, `weekly-learning.js:63`) | pregame snapshots | week 2 only: 1,183 captured, 0 settled. 351 of them already have an actual in `player_week_usage` and are waiting for the next settle run |
| `weekly_ensemble_fits` (`saveWeeklyFit`, `weekly-weight-store.js:147`) | fits | 2 rows, both through 2025 week 18, both promoted. None trained on 2026 |

The two forward records also grade different numbers. The snapshot's
`prediction` is the ensemble `ppg` in PPR (`weekly-learning.js:86`, default
scoring at `:49`), without coordinator, availability or lift. A rule-5 replay
over `player_week_usage` grades the number the unit serves. Work queue S-12 adds
the served number to the snapshot row.

**Which governs.**

- **A unit's ship decision:** rule 5 governs. It is graded on
  `player_week_usage` actuals through a replay of the number the unit serves.
  The snapshot table can stand in only when that number is the ensemble `ppg`
  itself.
- **The job's own promotions:** each one is a model result shipping ON without a
  pre-registration or a ledger row. Under this contract, every job fit that
  trains or gates on a 2026 week is a 2026 forward look, and it must appear as
  an `F` row in `HOLDOUT-LEDGER.md`. That applies whether or not the fit was
  promoted. The job cannot write that row itself. So every statistical unit
  runs
  `SELECT id, through_season, through_week, promoted FROM weekly_ensemble_fits WHERE through_season >= 2026`
  on its own DB copy, and logs any row not yet in the ledger as an `F` row.
  Follow-up (needs a file grant for `server/services/weekly-learning.js`):
  make the job write that record itself, or hold its promotion default-off
  until a pre-registered gate exists.
- **Once the job fits on a 2026 week, that week is in-sample for the served
  weights.** A unit's rule-5 check names the incumbent fit id it froze at
  pre-registration. It states whether a job fit used any week in its forward
  window, using the same query. If one did, the incumbent's forward error on
  those weeks is flattered, and the evidence says so.
- **When this starts:** weeks 2-4 are excluded while the stored early window is
  `[2,4]` (fit 2's `early.weeks` on the local copy), and there are no week-1
  snapshots. So the first fit on 2026 needs 250 settled rows from week 5 or
  later. Week 2 has 351 settleable rows, all with `season_to_date` set (the
  retrain's other filter), so one settled week is probably enough. The first fit would then come on the first job run after week 5's
  usage rows land. That timing is a guess from the week-2 counts, not a query.

*Consolidates:* Nick's statistical discipline (b), 2026-09-22; the forward loop
in `server/services/weekly-learning.js` (above); the "2026 FORWARD"
row of the sealed-season plan in
`docs/evidence/historical/model-diagnostic-2026-08-26.md:758-759`; "the
genuinely untouched promotion set is the frozen 2026 forward ledger"
(`docs/evidence/historical/STAGE_2_RESULTS.md:122-124`).

## Rule 6. Grade decisions, not just error

Where the unit feeds a start/sit, waiver or trade call, the evidence reports the
**decision win rate against the dumb baseline** next to MAE. A model can have
worse point error and better calls, or the reverse (plan item 18). When the two
disagree, both are reported. The decision metric governs a decision surface.
MAE governs a displayed number.

| call | dumb baseline (Nick, 2026-09-22) | producer to reuse | status |
|---|---|---|---|
| projection change feeding start/sit | the incumbent projection, and the player's season-to-date average, on one common pair set | `startSitPairAccuracy`, `scripts/promote-early-week-weights.mjs:153` | exists and is canonical; reuse it, do not re-implement |
| same concept, second producer | the old arm | `decisionRanking`, `scripts/promote-volume-shrinkage.mjs:118` (check 4 of that promotion gate, used at `:221`) | exists, and gives a **different** value on the same input (below). Do not use it for new work. Follow-up: route it through `startSitPairAccuracy` |
| start/sit call | start the highest projection | none yet | work queue C-01 |
| waiver call | add the highest-projected free agent | none yet | work queue C-02 |
| trade call | offer fair value (the market price) | none yet | work queue C-03 |

**Two pair-accuracy producers disagree.** Both judge pairs within week and
position and score ties 0.5. They keep different pairs.
`startSitPairAccuracy` keeps a pair only when **every** model projects both
players at 4 or more (`promote-early-week-weights.mjs:156`). `decisionRanking`
keeps it when the **old** arm alone does (`promote-volume-shrinkage.mjs:122`).
So when the new arm drops a player below 4, `decisionRanking` still judges that
pair. Same input, both functions taken from `origin/main` at `d6d7bd5a`: 3 WRs
in week 5, old arm 10 / 8 / 5, new arm 10 / 8 / 3, actuals 5 / 12 / 9.

| producer | pairs | old | new |
|---|---|---|---|
| `decisionRanking` | 3 | 0.3333 | 0.3333 |
| `startSitPairAccuracy` | 1 | 0 | 0 |

Control: with the new arm at 6 instead of 3 (both arms at 4 or more), both
return 3 pairs and 0.3333. The script is in section 13 of the evidence file.
So a check-4 value printed by the volume-shrinkage gate is not comparable with
a `startSitPairAccuracy` value. `startSitPairAccuracy` is canonical because it
grades every model on one common pair set, it is exported, and it has a test
(`test/weekly-early-week-blend.test.js`). Moving `decisionRanking` onto it is a
follow-up. It needs a file grant for `scripts/promote-volume-shrinkage.mjs`,
which this docs-only unit does not have.

Until C-01 to C-03 exist, a unit writes "no producer yet (C-0x)" in that cell.
It never writes a hand-made rate. `DECISION_CURVE`
(`server/services/lineup-brain.js:268`) is a static curve measured on a research
baseline, not on production's own decisions, and its own comment says so. Do
not quote it as the live win rate.

*Consolidates:* Nick's statistical discipline (d), 2026-09-22; plan item 18
("optimize decision win rate, not projection MAE"); the start/sit pair accuracy
already reported by `docs/tdd/early-week-blend.tdd.md:62`.

## Rule 7. Replays run in configuration B

Any replay grade:

- passes `roleRecency: WEEKLY_ROLE_RECENCY` explicitly
  (`server/services/weekly-ensemble.js:71`);
- omits `kOverride`, so `server/services/projections.js:520` routes through
  `activeKVectorFor` (`server/services/shrinkage-fit.js:535`);
- runs a k control that stops if it reads `K.share = 6`, the hardcoded constant,
  which would mean the fitted vector was withheld.

The reference shape is `production()` in `scripts/fit-weekly-coverage.mjs:72-75`.
The evidence names the role recency, the k override and where the fitted k
comes from, the prediction head and its fit id, the held-out season, the
interval, and the sign convention. Magnitudes do not carry between rigs, and
directions may (Independent Auditor, condition A). Rig magnitudes and lineup
rates never reach Nick. Direction only.

*Consolidates:* work queue section 4 rule 3 (memory
`gridiron-replay-rolerecency-trap`; handoff/auditor sections 4-5); merge gate v2
section 3.

## Rule 8. Claim hygiene

- Every number names the command that produced it and the tree it ran on.
- A projection change's ship rule is the house rule unless the pre-registration
  says why not: MAE improves with the player-clustered 90% interval entirely
  below zero, Spearman no worse than −0.002, and DNP-included MAE no worse
  (`server/services/matchups.js:33-35`).
- Quote the observed difference, never a bootstrap `mean_diff`
  (`server/services/backtest-significance.js:114` returns the mean of the
  resampled differences).
- Where the rig can move a number more than its interval does, cite the bracket,
  not the interval (Independent Auditor B.5). The weekly-ceiling headroom in
  `docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md:189` is
  the worked example.
- A zero, an empty result or an "all pass" from a home-built check needs one
  known-nonzero case first (memory `gridiron-contradiction-test-rule`).
- Name the table **and** the writer function with file:line (memory
  `gridiron-name-the-table-rule`).
- Never quote a withdrawn number. Say "not reproducible by command"
  (handoff/auditor section 5).
- An absence says which absence: unknown vs fresh, not measured vs zero.
- Say "guess" where it is one, and answer Nick's five questions (memory
  `gridiron-five-questions-rule`).
- Missing data: a free source first, then a labelled, held-out-validated
  estimate, and log the gap (memory `gridiron-missing-data-workaround-rule`).
- The general evidence rules still apply to a statistical unit: one guard run
  per tree, merged with current main (memory
  `gridiron-verify-once-and-model-by-weight`); cite RED and GREEN as `#N` +
  subject + sha with the failing assertion inline (memory
  `gridiron-evidence-citation-rule`); mutation sweeps include call-site mutants,
  a designed survivor and a not-applied control (memory
  `gridiron-predicate-injection-test-rule`); and a licence check comes before
  measuring any external data (memory `gridiron-licence-before-measurement-rule`).

---

## Checklist for a statistical unit's evidence file

1. Pre-registration commit sha, an ancestor of the result commit (rule 1).
2. Ledger rows added in the result commit, with their ids (rule 2).
3. For an `FL` result, the command's verdict for the new row: BH primary,
   sensitivity, Šidák (rule 3).
4. For a decline, the MDE at 80% power (rule 4).
5. The forward check on 2026, or "unconfirmed forward" and the flag name,
   plus the `weekly_ensemble_fits` query for job fits on 2026, with any new
   `F` rows (rule 5).
6. Decision win rate against the dumb baseline, or "no producer yet (C-0x)"
   (rule 6).
7. The replay configuration, with the k control's output (rule 7).
8. Command and tree beside every number (rule 8).
