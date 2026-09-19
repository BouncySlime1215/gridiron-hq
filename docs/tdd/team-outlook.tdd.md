# Team Outlook — the rule, written before it was fitted

O4 in `docs/FANTASY-ENGINE-MASTER-PLAN.md`. This document states what the outlook
model is, what it is scored against, and what happens if it fails, and it is
committed **before** the model is fitted. A threshold chosen after seeing which
threshold looked good is not a threshold. The same order was used for
`play-chance-gate-v2.md` and for the same reason.

Read `docs/tdd/sleeper-history.tdd.md` for where the data comes from and
`server/services/league-history.js` for the only code that reads it.

---

## 1. What is being predicted, and from what

**Outcome:** `made_playoffs`, for one team-season, evaluated at the end of week `w`.
Nothing that happens after week `w` is an input. The outcome is never an input.

**Population:** completed public Sleeper redraft league-seasons, 2021-2025. Fit on
2021-2023, scored on 2024 and 2025 **separately**, each once.

**Features, all of them known at the end of week `w`:**

| feature | why it is in |
|---|---|
| `all_play` | the luck-free record; measured best single signal at every week 1-13 |
| `points_shrunk` | the posterior mean under `k` from the variance decomposition — the plan's `k(w)`, applied |
| `win_share` | the actual record. Not a duplicate of `all_play`: seeding is decided by it, so a team can be luck-rich and still in |
| `games_back` | distance to the playoff line in wins, which `win_share` alone does not give |
| `weeks_left` | how much time there is to move |
| `playoff_share` | the league's format. 6 of 8 making the playoffs is a different question from 6 of 14 |

`playoff_share` is a conditioning variable throughout, in the baselines as well, so
no model is credited for learning the league format.

### What is deliberately NOT a feature, and the measurement that decided it

The plan (D2) says "Sleeper rosters carry player ids that map to ours
(`players.sleeper_id`), so every real team gets **our** projected strength week by
week." **That is not available.** Measured on the app database, `players.sleeper_id`
is populated for **751 of 8,556 players (8.8%)**. The plan's own blocker list (E5.7)
says 0 of 8,640, which is also wrong in the other direction; the number is 751.

Either way a roster cannot be priced from an 8.8% crosswalk — a team whose two best
players happen to be unmapped would be scored as a bad team, and the error would
correlate with player profile rather than being noise. So:

- **Projected lineup strength is not a feature of the validated model.** Every number
  this document gates is produced without it.
- Where our own projections do exist — Nick's five leagues, which are ESPN-keyed — the
  service may report projected strength and its rank **alongside** the validated
  probability, labelled as unvalidated at population scale, and it may never move the
  probability or the verdict. A number that cannot be held out cannot be allowed to
  decide anything.
- Building the crosswalk is real, separable work. It is not a prerequisite for the
  rest of this item and is not done here.

---

## 2. The model

Per week `w`, L2-regularised logistic regression on the six features above,
standardised using **fit-set** means and standard deviations only.

One model per week rather than one model with week interactions: a per-week fit
cannot borrow strength across weeks, which is the conservative choice, and it makes
each week's coefficients readable on their own.

**Sign check, pre-registered.** After fitting, the coefficients on `all_play`,
`points_shrunk` and `win_share` must be `>= 0` and the coefficient on `games_back`
must be `<= 0`. A fitted sign that disagrees with the direction of the world is a
defect in the fit, not a discovery, and it fails the gate rather than being shipped
with an explanation.

**Calibration layer.** None by default. Expected calibration error is measured and
reported. Isotonic regression fitted on the fit seasons is applied **only** if the
raw model's ECE exceeds 0.03 on the **fit** seasons — never in response to a test
season's ECE, which would be fitting on held-out data.

---

## 3. The gate

Baselines, every one of them binned or fitted on the same fit seasons:

1. `base_rate` — the league's playoff share. Knows nothing about the team.
2. `all_play` only.
3. `points_shrunk` only.
4. `win_share` only — the naive "win rate so far", which is what a person reads.

**Ships only if all four hold:**

- **G1.** Held-out Brier of the combined model is lower than all four baselines, at
  **every** week 2-8, in **both** 2024 and 2025.
- **G2.** The advantage over the **strongest** baseline at each of those weeks has a
  90% interval excluding zero, by paired bootstrap **clustered by league**
  (`pairedBootstrapDiff`, 2000 draws, seed 20260919, groups = league id). Clustering
  by league is required: team-seasons inside one league share opponents, so treating
  them as independent would shrink every interval by roughly the square root of the
  league size and manufacture significance.
- **G3.** Expected calibration error at most **0.03** by decile, at every week 2-8,
  in both test seasons.
- **G4.** Signs as stated in section 2, at every week 2-8.

**If the gate fails, that is the answer.** No feature is added, no week is dropped
from the range, no threshold is loosened, and there is no v2 of this document. The
model that ships instead is the best **single** validated signal — which on the
measurement already taken is `all_play` — as the outlook probability, labelled as a
single signal and not as the combined model. The failure is reported as a failed
gate, which is what D2 item 7 requires.

Stated in advance because it is the part that is tempting to move later: **weeks 2-8,
both seasons, all four baselines, no exceptions.** Week 1 is excluded because the
plan's own acceptance range is weeks 2-6/2-8; it is still measured and reported.

---

## 4. The decomposition — luck, noise, real

The plan wants the change since preseason split three ways. A decomposition whose
parts do not sum to the whole is a set of three unrelated numbers, so this one is
defined sequentially on the model's own probability, which makes it sum exactly by
construction:

```
p0 = model at week w with the preseason state
p1 = model at week w with the actual record replaced by the all-play record
p2 = model at week w with points_shrunk at its shrunk value
p3 = model at week w with the real state

luck  = p1 - p0     what the record did beyond what the scoring earned
noise = p2 - p1     the part of the scoring the posterior does not believe yet
real  = p3 - p2     what is left: the roster and the schedule
```

`luck + noise + real == p3 - p0` identically. This is an ordering choice, not a
unique attribution, and the service reports it as such: with a different order the
individual parts differ. Stating that is part of the pre-registration.

The `noise` term is the one the plan cares about and is where `k` does its work: at
week 2 the posterior keeps 21% of what has happened, so 79% of an unusual start is
assigned to noise, and by week 8 that is 48%.

---

## 5. The verdict — and the half of it that cannot be validated yet

D2 defines Act as two conditions: **(a)** odds below a fitted threshold, **AND**
**(b)** the best available move raises title odds by at least a fitted amount.

**(a) is fitted and validated here.** The threshold is chosen on the fit seasons as
the playoff probability below which teams finish materially worse, and validated on
held-out seasons by the separation it actually produces.

**(b) cannot be computed on this population.** It needs each team's roster priced by
our projections and a counterfactual for the best available waiver or trade — the
crosswalk measured in section 1 rules out the first, and the replay counterfactuals
are a separate dataset. So:

- The service emits **`fine`**, **`watch`** and **`act_candidate`**.
- **`act` is never emitted by this service.** A caller that can supply condition (b)
  — the Coach, with the Trade Brain's best move — promotes `act_candidate` to `act`.
  Until such a caller exists, no surface shows Act.
- This is the plan's own rule ("the verdict may never say Act on noise alone") taken
  literally: telling a team to act when we have not shown that acting helps them is
  exactly the thing it forbids.

**Validated here:** that `act_candidate` teams finish materially worse than `watch`
teams and `watch` worse than `fine`, held out, with the separation reported in
playoff rate and in final rank.

**Not validated here, and labelled so:** that acting beats not acting. That needs the
replay leagues and is not claimed.

---

## 6. Verification required before this is called done

- The full suite, lint and typecheck clean.
- Tests covering: the sequential decomposition summing to the total exactly; the sign
  check failing a fit with a wrong sign; the gate failing when a baseline wins;
  `act` never being returned; a league with a playoff share the fit never saw;
  week 1 and week 13 boundaries; and a team with zero games played.
- The gate's own verdict printed per week and per season, so a reader sees which
  baseline was strongest and by how much, rather than being told it passed.
