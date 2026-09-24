# COUNTERPART-02: War Room opponent model (M8), declined

Written 2026-09-24. Study record only: nothing served changes. The built code is kept here as
`counterpart-02-impl.patch` so a later unit that can touch the planner can pick it up.

## What was built (in the patch, not merged)
- `server/services/campaign/opponent-model.js`: a reply model per target-league manager.
  - Reply mix over ignore / counter / decline / accept. It starts from the M6 prior (.45 / .33 / .17 / .05), updates on the league's own offers, then per manager on his own offers. Only replies known before the as-of time count.
  - Offer classes follow the E1-league offer set (`rnd/eval/e1l_offers.py`, reproduced exactly: 82 decided, 15 yes; target league 40 decided, 13 yes). A no followed within 2 days by the manager's own offer back to the proposer counts as a counter.
  - Step P(yes) = clone P(yes) x (his deal rate / the league's deal rate), where deal rate = accept + 0.5 x counter.
  - nick_override: exclude (unreachable) blocks the manager; "not doing trades" halves P; "hard to deal with" halves the odds; outside the active pool halves P.
  - wants_player tilts only the search's shortlist order (x1.5 at full lift). It carries 0 weight in P(yes) (PEOPLE-03).
- `search.js`: the shortlist order uses the wants tilt when the model is on.
- `produce-plans.mjs`: wraps the adapter under `GRIDIRON_OPPONENT_MODEL=1` or preview mode.
- Tests: `test/campaign-opponent-model.test.js`, 10 tests, all pass. With the model off, the planner is unchanged.
- Base: `origin/claude/cloud-fix-03` with `origin/claude/cloud-counterpart-01` merged in (conflicts resolved to the fix-03 contract).

## Measured (local copy of the DB, target league = leagues.id 4, 2026 only; 2025 not opened)
| metric | before (tree bf990c22, flat clone P(yes)) | after (tree b46bfba3, model on) | target |
|---|---|---|---|
| (a) top-5 moves whose first partner is in the active pool | 1 of 2 moves (50%) | 0 of 1 move (0%) | >= 80% |
| (a) all steps of those moves in the active pool | 1 of 3 (33%) | 0 of 1 (0%) | - |
| (a) moves with the unreachable manager | 0 | 0 | 0 |
| (b) best plan's expected title-odds gain | +0.73 pts (p 0.167, +2.09 if it lands) | +0.11 pts (p 0.143, +0.75 if it lands) | - |
| validatePlans | ok | ok | ok |

Producer command (same for both runs; about 12 to 20 minutes each at machine load 20 to 50):
`SCHEDULER_DISABLED=1 GRIDIRON_PREVIEW_UNCONFIRMED=1 GRIDIRON_WARROOM_ENABLED=1 GRIDIRON_DB_PATH=<copy> GRIDIRON_CHAT_DB_PATH=<chat copy> GRIDIRON_WARROOM_PLANS=<tmp>/plans.json GRIDIRON_WARROOM_PUSHES=<tmp>/p.jsonl node scripts/campaign/produce-plans.mjs --leagues 4`,
then `node docs/evidence/2026-09-24/counterpart-02/measure.mjs <tmp>/plans.json <copy> <chat copy>`.

(c) Log loss of the simulated P(yes | decided) on the decided offers. Each offer is graded using only replies known before it was sent. The 90% CI comes from a bootstrap clustered by the receiving manager (4000 draws). Command: `CP02_TREE=<patched tree> node docs/evidence/2026-09-24/counterpart-02/grade.mjs <copy> 4` (or `0` for every league).
| set | n (yes) | model | flat M6 prior | walk-forward league rate | league-only posterior |
|---|---|---|---|---|---|
| target league | 40 (13), 8 managers | 0.712 | 0.844 | 0.677 | 0.699 |
| all 5 leagues | 82 (15), 24 managers | 0.464 | 0.517 | 0.500 | 0.454 |

Model minus flat prior: target league -0.132 [-0.349, +0.011], all leagues -0.053 [-0.147, +0.036]. It is no worse than the flat prior on the point estimate, but the CI touches 0.
Model minus walk-forward league rate: target league +0.035 [-0.083, +0.137]. Model minus league-only posterior: +0.013 [-0.049, +0.050].
So the per-manager update adds nothing measurable over the league level yet (about 40 offers).

## Why declined
1. (a) is out of reach from the listed files. The deck's last step must go to the target's owner, and the planner picks targets by gain alone (`planner.js`, the `upgrades` sort). On the target league, two of the top three targets belong to pool managers that Nick marked hard to deal with, and the third belongs to a manager outside the pool. Changing P(yes) alone cannot move the final leg. The deck also held only 1 or 2 moves, not 5.
2. (b) dropped from +0.73 to +0.11 pts. The lower P(yes) comes from hand-set Nick-override multipliers and from a per-manager update that (c) does not support over the league level.
3. The incumbent (flat clone P(yes)) stays.

## What a follow-up needs (planner.js in scope)
- A target sort that multiplies the gain by the owner's simulated reach, so targets owned by pool managers are picked. This is COUNTERPART-01's `targetTilt` hook, fed by this model.
- A larger deck (the confirm pass drops most candidates on this league), so the top-5 share can be measured on 5 moves.
- `profile-reader.js` should expose `profile_json.nick_override`. Today it reads overrides only from `manager_notes` (no `nick_override` rows there), so the patch reads that one JSON key itself.
