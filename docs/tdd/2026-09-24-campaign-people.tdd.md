# CAMPAIGN-PEOPLE: the counterpart model in the campaign producer (2026-09-24)

Spec: `docs/handoff/local/PEOPLE-WIRING.md`, section CAMPAIGN-PEOPLE (branch
`claude/handoff-package-2026-09-22`). Base: PR #233 (`claude/cloud-campaign-producer`).
The task also named sections "The 10 counterpart modules" and "Nick's ground truth";
neither exists in that file or anywhere under `docs/handoff/` on that branch
(`git grep` checked). The 10 steps are the numbered list under CAMPAIGN-PEOPLE; the
ground-truth keys (`contactable`, `buyer`, `hard to deal with`, `nick_override`) come
from the task text.

## 0. Audit (extend or build)

- PEOPLE-01 (`server/services/people/profile-reader.js`) has not landed: no
  `claude/cloud-people-01*` branch on origin. Built a thin adapter with the interface
  PEOPLE-01 is expected to keep: `server/services/people/profile-adapter.js`
  (`readProfile`, `readLeagueProfiles`). When PEOPLE-01 lands, `counterpart.js` and
  `league-adapter.mjs` switch one import each.
- The profile shape extends the stored negotiation profile
  (`counterparty-pricing.js` NEGOTIATION_PROFILE_SCHEMA: `says_no`, `techniques`,
  `roster_read`, `what_shuts_him_down`, `how_to_approach`, `best_bait`) with the
  PEOPLE fields (`values_talk`, `deal_feelings`, `changes_since_0918`) and the
  ground-truth keys.
- Decision: **build** `counterpart.js` (pure) and extend the planner, partners,
  replan, view, adapter and producer. The existing partner-ranking and ladder code paths are unchanged
  when the flag is off (test "flag").

## 1. Tests (RED first)

`test/campaign-people.test.js`, 12 tests: one per CAMPAIGN-PEOPLE step (1-10),
`nick_override` precedence, the flag. Made-up fixture league, invented profiles.

RED (commit `9c81760`, implementation absent):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/people/profile-adapter.js'
# pass 0
# fail 1
```

Two test-data bugs were found on the first GREEN run and fixed in the test (not
the code): test 1 used P21, which the fixture never suggests (P11 is); test 9
built a profile from a key the adapter does not read (`urgency` at top level), so it
read as `unknown`.

GREEN (commit `a370e50`): `campaign-people.test.js` 12/12, `campaign-producer.test.js` 23/23,
`preview-mode.test.js` + `campaign-producer.test.js` 26/26 (both combined).

## 1b. Mutation sweep (liveness)

`campaign-people.test.js` against one mutant at a time (script kept out of the repo):

| mutant | where | result |
|---|---|---|
| contactable exclusion dropped | unit `counterpart.js#respondsWeight` | killed |
| planner ignores exclusion | call site `planner.js#withPeople` | killed (after tightening: survived first, because the opponent model already priced him at 0; test now also checks his players are not suggested) |
| override precedence dropped | unit `profile-adapter.js#readProfile` | killed |
| untouchable not skipped | unit `counterpart.js#targetWeight` | killed |
| planner ignores target skip | call site `planner.js` upgrades filter | killed (after tightening: survived first, because weight 0 ranked it out of a full top-5; test now uses a one-team league) |
| opponent model not wired | call site `planner.js#withPeople` | killed |
| face-safe filter off | unit `counterpart.js#frameMessage` | killed |
| timing not applied | call site `planner.js` send_when | killed |
| hard walk-away margin off | unit `counterpart.js#strictBatna` | killed |
| profile_changed dropped | `replan.js#diffNextMove` | killed |
| preview path off | `people-flag.js#campaignPeople` | killed |
| people lines out of `why` | `view.js#card` | killed |
| CONTROL: `shift_to_p` 0.03 -> 0.031 | designed to survive (no test pins the exact slope) | survived |
| CONTROL: absent string | designed not-applied | not applied |

| step | what the test pins |
|---|---|
| 1 targets | untouchable never suggested / targeted; frustrated + urgent + wants-what-Nick-has raise the weight |
| 2 partners | contactable:false excluded from every plan and ranked last at score 0; buyer:false < hard < neutral |
| 3 price | yes-point shift by values_talk (both sides); curve keeps `his_pct_market`; hard: P(accept) x0.8 and walk-away +15% over BATNA |
| 4 package | wants raise P(accept), talked-down lower it, untouchable prices at 0 |
| 5 message | opener from approach style, bait line, face-safe filter drops unsafe lines, no profile text leaks |
| 6 reply tree | "no rarely holds" note, haggler counter note, shutdown labels, patient clock 48 h / 96 h |
| 7 timing | urgency window -> now; attached / just won -> wait; overrides the playbook send_when |
| 8 simulation | every best-plan step p equals the opponent-model price; accept + counter + decline = 1 |
| 9 replanning | changed version -> `profile_changed` (also when the move holds); reason names the team |
| 10 reasoning | his-side trait labels; people lines in the card's `why` with source `people.profile`; validateEntry empty; no chat text in output |
| nick_override | wins key by key, `sources` says so, can re-open a partner the profile shut |
| flag | 1 on / 0 off / unset follows preview; off = identical best plan |

## 2. Hand-set constants (not fitted)

All in `counterpart.js#WEIGHTS`, each emitted with the label
"hand-set people weight; ungraded (EVAL E1/E2/C7 pending)". A trait that fails
grading fades by editing that table only.
