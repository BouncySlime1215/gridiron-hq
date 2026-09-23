# RL-15-2: My Team self-scout stops telling teams to "chase variance"

Unit: RL-15-2 (UI revamp My Team tab, TeamScout / PostDraftPlan "What to fix"; GT-01
"variance as a choice"; C-18 measured `why`). Not a statistical unit: it removes advice,
it produces no model number, so no pre-registration of its own. The measurement that
motivates it was pre-registered by R&D r15 (cited in section 4, not re-run here). No
2025 held-out look was made by this unit (the R&D run filtered 2025 in SQL), so nothing
is appended to `docs/evidence/HOLDOUT-LEDGER.md`.

## 1. Audit: what already exists (tree origin/main 24fdf434)

- The advice: `server/services/trade-engine.js:2862-2868` (origin/main 24fdf434; the
  queue row's `:2647-2653` was cited on c1f17cee, the function has moved), the last
  `fixes.push` in `selfScout()` (`:2756`). Area "Roster shape". Rank buckets use this
  week's projected-lineup rank (`myRank`, `:2777`): rank <= 3 "contender" gets
  "You are ahead — trade ceiling for floor and consistency to protect the lead.";
  everyone else ("bubble" and "longshot") gets "You need variance — target boom-rate
  players over steady ones; a median week does not win you the league from here."
- Incumbent search, command `git grep -n -i 'Roster shape\|boom-rate\|need variance\|ceiling for floor\|You are ahead'`
  on 24fdf434: producers only at `trade-engine.js:2863,2866,2867`; one comment citing it
  at `server/services/ceiling-lineup.js:27`; no test. Control for the grep: the same
  command finds `league-brain.js:321` ("ahead of you are ahead"), so it does match text
  in server code.
- Consumers (verified on the consumer, not the producer): `GET /trades/:leagueId/scout`
  (`server/routes/trades.js:100`) returns `selfScout()`; My Team fetches it
  (`client/src/pages/MyTeam.tsx:58-59`) and renders every fix in
  `client/src/components/TeamScout.tsx:118-130` and the top 4 in
  `client/src/components/PostDraftPlan.tsx:59-61`. `league-brain.js:248` also calls
  `selfScout()` but reads positions, not `fixes`.
- The facts the entry repeated (weekly range and projected rank) are already shown on
  the TeamScout header (`TeamScout.tsx:40-55`, `s.spread.floor` / `s.spread.ceiling`
  and `s.rank of s.of`), so nothing factual is lost from the Scout tab.
- The one measured variance producer is `server/services/lineup-posture.js`
  (matchup-conditional, silent below a 23-point weekly edge), served on Start/Sit. This
  unit leaves it as the only place the app talks about variance.

**Extend or build: extend (delete).** Remove the whole "Roster shape" fixes entry. The
queue row names bubble/longshot; the contender half goes too, because (a) its R&D
estimate is null (section 4), and (b) it told a 0-2 team "You are ahead" on a one-week
projection rank (R&D §2b). Leaving only the contender branch would keep an unmeasured
imperative on the same card. No new number, table, column or field.

## 2. RED / GREEN

- RED: `test: RL-15-2 RED selfScout must not tell bubble/longshot teams to chase variance`
  sha `RED_SHA`. Failing assertion (bubble), verbatim from the run on the unfixed tree:
  `bubble team got variance advice: ["You need variance — target boom-rate players over steady ones; a median week does not win you the league from here."]`.
  Tests 5, pass 2 (both controls), fail 3.
- GREEN: `fix: RL-15-2 drop selfScout's unmeasured Roster shape advice` sha `GREEN_SHA`.
  Tests 5, pass 5, fail 0.

Command (both): `T=$(mktemp -d); SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$T/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/self-scout-variance-advice.test.js`

## 3. What it does

`selfScout()` no longer emits the "Roster shape" fix. Every other fix (position
weakness, depth, bye collisions, playoff byes) is unchanged; the returned `spread`,
`rank` and `of` are unchanged, so the TeamScout header range and rank still render.
Client files are unchanged; the card simply has one fewer row.

## 4. The numbers (why), with commands

Not re-run by this unit. Source: R&D r15,
`~/gridiron-local/rnd/loop/r15-internal-scout-tells-most-teams-chase-variance.md`
(local, not in the repo). Pre-registration `rnd/loop/scripts/r15i_variance_advice_prereg.md`
(sha256 in `rnd/loop/data/r15i/prereg.sha256`), run
`nice -n 10 python3 scripts/r15i_variance_advice.py`, output
`rnd/loop/data/r15i/variance_advice.out`, which reads (Sleeper 2021-2024, aggregates only,
1,999 league-seasons, 21,946 team-seasons; logit(outcome) ~ z_mean + z_sd within league;
95% league-cluster bootstrap, 1000 reps; sign: positive b_sd = more variance, more of the
outcome):

| group (old advice) | outcome | n | base | b_sd [95% CI] |
|---|---|---|---|---|
| bubble ("need variance") | title | 9,954 | 8.8% | -0.138 [-0.214, -0.067] |
| longshot ("need variance") | title | 5,995 | 4.9% | -0.079 [-0.202, +0.035] |
| longshot | playoffs | 5,995 | 34.0% | -0.142 [-0.213, -0.071] |
| contender ("ceiling for floor") | title | 5,997 | 13.7% | -0.040 [-0.125, +0.036] |

A validator re-derivation (`rnd/loop/data/r15i/variance_advice_rederive_validator.out`)
agrees and shows the bubble/title sign negative in each season 2021-2024 (CI below 0 in
2024 only). Limits (from R&D): realized SD is partly luck, and the week 1-3 points-for
rank is a proxy for the served projection rank; this tests the necessary condition (at
equal mean, did variance go with titles?) and it did not.

Decision grading (statistical discipline d/e): not applicable. This removes season-level
roster advice; it feeds no start/sit, waiver or trade call and produces no projection.

## 5. Mutation sweep

MUTATION_TABLE

## 6. Known defects / not covered

- `server/services/ceiling-lineup.js:26-28` comment still cites the deleted advice as the
  reason the Ceiling tab exists. Not in this unit's files (one editor per file); follow-up.
- GT-01's future season-level "variance as a choice" needs its own test on title odds
  (R&D §6 design: b_sd > 0 with CI above 0 for the group shown it).
- No live-server screenshot: the repo clone's server is not to be touched, and the client
  is unchanged.

## 7. Nick's five questions

1. Well built? A one-block deletion inside `selfScout()`'s fixes list, pinned by a
   fixture test with a range-modelled control (the branch's precondition holds) and a
   still-fires control (the weakness fix), plus a mutation sweep.
2. Stats or made up? The deleted advice was made up (hand-written, no test). The reason
   to delete is stats: R&D r15's pre-registered Sleeper 2021-2024 regression.
3. How we know: backtest, Sleeper 2021-2024, 21,946 team-seasons, bubble/title
   b_sd -0.138 [-0.214, -0.067] (about -1.0 pp on 8.8%); contender null.
4. Pointed anywhere else? `/trades/:leagueId/scout` feeds My Team's Scout tab and
   PostDraftPlan only; `league-brain.js` does not read `fixes`.
5. How it unifies: variance talk now has one producer, `lineup-posture.js` on Start/Sit
   (matchup-conditional, measured), instead of two that disagreed.
