# INTEGRATION AUDIT 09/23 (night): 17 cloud PRs (#230-#246) -> one system for league 4

Read-only audit. Sources: `gh pr diff` / `gh pr view` for #174 #216 #227 #230-#246 (heads as of 02:15Z 9/24), origin/main `12a6de93`, the local chat DB (read-only) and local DB `schema_migrations` (read-only). Nothing was merged, marked ready or pushed.

Coordinator ruling applied from INTEGRATION-CHECKS.md: #235's fallback reading (missing / stale >48 h / errored report forces BALANCED; SAFE is never raised).

---

## 0. The top integration defects (ranked)

| # | defect | evidence | effect on league 4 tonight |
|---|---|---|---|
| D1 | **Every rebuilt chat profile fails main's validator.** `counterparty-pricing.js#negotiationProfileErrors` rejects unknown keys and free-text enums. The 10 rows in `negotiation_profiles` (rebuilt 9/23) carry `deal_feelings`, `values_talk`, `behaviour_vs_words`, `changes_since_0918`, `as_of`, `messages_read`, `nick_override`, and some carry `slug`/`name`. Their enum slots hold sentences ("mostly yes: ...", "rarely (Jeanty is the exception)"). I ran main's validator on the stored rows: **10/10 INVALID** (12-20 errors each). | `negotiationProfilesFor` drops every one of them. So the counterparty layer's receptiveness and says-no terms, `selfRead` (ME), #233's negotiation labels and Nick's `nick_override` all read **nothing**. The profile rebuild is currently invisible to the app. |
| D2 | **The plans file has three shapes and nobody validates against #238.** #233 writes the prototype keys (`acq`, `flip`) and puts every War Room section under `entry.view.*` with its own names (`deck`, `suggestions`, `flips`, `brain_check`, `replies`, `partners`, `risk_modes`, `confirm`, `number_health`). It writes 7 statuses where the contract allows 3, and bare `{value, source, unit}` numbers where the contract wants typed fields. #231 reads only `acq`/`flip` and ignores `view`. #230 reads contract-ish names (`alternatives`, `stop_tradeoffs`, `flips`, `suggestions`, `brain_check`) from whatever object the dashboard passes it. #234 reads `cards[]` or `acq`. `validatePlans()` has no caller. | Everything #233 computes beyond the deck is dropped by the UI: destination, goal, risk mode, speed curve, catch-up, feasibility, attention, replies, walk-away and message all show "not computed yet". |
| D3 | **The UI deck drops the best plan.** #233 writes `acq.alternatives = deck.slice(1)`, meaning the deck without its head. #231 `deckPlans()` uses `acq.alternatives` alone whenever it is non-empty. | Card 1 in the War Room is the **second-best** move, and the actual next move never shows. |
| D4 | **War Room inputs never reach the producer.** #230 records every button and Coach change in the `warroom_requests` table (076) and says "the producer reads rows where consumed_at IS NULL". #233 reads `objectives.json`, `skips.jsonl` and `offers.jsonl` files and never opens the table. #231 keeps the skip log in React state only (its own comment says "WR-3 sends it to the request table"). "I sent it" has three stores: the `offer.sent` request, `offers.jsonl` and #239's `trade_outcomes.sent_at`. | Set goal, approve target, risk mode, add a stop, skip reasons and "I sent it" do nothing to the plan. The fatigue cap never sees a real sent offer. |
| D5 | **The War Room producer never runs locally, and it runs with the wrong flags when it does.** #233's refresh step checks `env.GRIDIRON_WARROOM_ENABLED === '1'` directly, not preview mode. `~/gridiron-local/refresh.sh` sets neither that variable nor `GRIDIRON_PREVIEW_UNCONFIRMED`; only `run.sh` (the web server) sets preview. The graders (#235) and number audit (#237) also run in the refresh process without preview. | Tonight the War Room shows "No plan has been run yet". Once it does run, the plans are priced with RL-16-1/RL-17-3/RL-19-3 **off**, while Trade Lab (web server, preview on) prices with them **on**. That is two different title-odds numbers for the same deal, which breaks the one-number rule. |
| D6 | **The brain report never reaches the plan or the screen.** #233 hard-codes `brain_check` to 'not_run' and `number_health` to "not built yet". It never calls `brainReportRule`. #231's BrainCheckCard and number-health dot read only those placeholders. #235's `/api/brain-report` and #237's `/api/number-audit` have no War Room consumer. | The ruled fallback (failing, stale or missing report -> BALANCED) is not enforced. Fuck-it mode runs even though E1 has not passed. |
| D7 | **Trade-off previews can never work.** Coach (#230) looks up `stop_tradeoffs[tradeoffKey(action)]`. #233 writes no `stop_tradeoffs`: it writes `itinerary.stop_previews[]` with other keys. #231's view passes neither. | Every "add a stop / change mode" preview says "not computed yet" (north-star row 10). |
| D8 | **Migration 081 is used twice.** #244 `081_league_waiver_runs` (assigned) and #245 `081_follow_ledger` (not assigned). | The runner keys on the full name, so both would run, but it breaks the numbering rule. Must renumber before merge. |
| D9 | **EVAL seams.** #235/#246 read `offer_log`, `title_odds_snapshots`, `campaign_steps` and `weekly_autopsy`, plus `outcome_json.followed` / `predicted_json.near_tie` on `rec_ledger`. None of the 17 PRs writes any of these. The writers write `trade_outcomes.sent_at` (#239), `served_numbers` (#243) and `follow_ledger` (#245). | E1/E2/E5/E6 stay "not enough data" for ever, even after the offers exist. |
| D10 | **Nick's ground truth is not read.** `manager_notes` (source 'nick-chat-2026-09-23') and `profile_json.nick_override` have zero readers on main or in any PR. | League 4 plans can route through [mgr] (unreachable) and Zach (not trading). |

---

## 1. MERGE ORDER

Repo merges are squash merges (#218 and #224 landed as single commits). That affects stacks: after a parent is squash-merged, the child still contains the parent's original commits, and they conflict add/add with the squash commit. **Rule for every stack:** merge the parent, then `git rebase --onto origin/main <parent-head-sha> <child-branch>`, force-push the child and let CI re-run. #245 is built on #174's branch (its base is set to main, but #174's head is an ancestor), so the same rule applies to it.

**Before any merge (blocking):** FIX-01 renumbers #245's migration 081 -> 082.

| step | PR | why here | conflicts expected at this step |
|---|---|---|---|
| 1 | #232 FIX-HOLD-01 | isolated (trade-proposals.js only) | none |
| 2 | #238 WARROOM-CONTRACT | the reference schema lands first so every later fix can import it | package.json (none yet) |
| 3 | #241 RL-17-3 | season-sim.js only + a preview-mode.js comment | none |
| 4 | #174 GR-01 rec ledger (071) | base of #245. Touches trades.js/scheduler.js/waiver-wire.js/trade-engine.js/index.js before the others do | none |
| 5 | #245 SELF-01a follow ledger (082 after FIX-01) | rebase --onto per the rule; afterwards its diff is follow-ledger only | rec-ledger.js / scheduler.js / trades.js add/add if not rebased: take #245 |
| 6 | #244 RL-16-2 waiver runs (081) | waiver-wire.js hunks sit 20+ lines below #174's | none expected (auto) |
| 7 | #243 serve-log (079) | trades.js `/find` + `/title-trades`, scheduler JOBS, index.js | trades.js `/find` vs #174 (see section 2) |
| 8 | #239 offer loop (080) | trades.js `/offers/sent`, TradeCard | trades.js import line (union) |
| 9 | #236 RL-16-1 | trade-engine.js imports + trade-horizon | preview-mode.js comment |
| 10 | #240 RL-19-3 | trade-engine.js return object after #174 | trade-engine.js (import line with #236, return object with #174), TradeCard.tsx with #239, preview-mode.js comment |
| 11 | #216 EA-00a spine (075) | parent of #242 | index.js, annotations.json |
| 12 | #242 EA-02 daemon | rebase --onto after #216 | refresh-live-data.mjs (lock wrapper), annotations.json |
| 13 | #235 EVAL-01 (078) | parent of #246 | refresh-live-data.mjs, index.js, .gitignore |
| 14 | #246 E1-FIX | rebase --onto after #235 | none beyond its parent |
| 15 | #237 BROKEN-01 (077) | refresh-live-data.mjs, index.js, App.tsx/Settings.tsx | refresh-live-data.mjs (tick signature + step list) |
| 16 | #227 ACQ-FLIP proto | parent of #233 (study code only) | none |
| 17 | #233 CAMPAIGN-01 | rebase --onto after #227 | refresh-live-data.mjs, test/refresh-loop-steps.test.js |
| 18 | #231 War Room UI | trades.js `/war-room`, preview-mode.js | trades.js imports (union) |
| 19 | #230 War Room requests + Coach (076) | index.js, annotations.json | index.js, annotations.json |
| 20 | #234 REASON-01 | offline only | package.json, annotations.json, .gitignore |

Why this order: the ledger / serve / offer PRs (4-10) all edit trades.js and trade-engine.js and are small, so they go first while the conflict surface is thin. The refresh loop is touched by five PRs (#242, #235, #237, #233, #243), so they go through it in one sequence with one ordering rule. The War Room group goes last because all of it is flagged off, all of it needs FIX units anyway, and merging it last means FIX-03..FIX-08 land on one integrated main instead of on five branches.

---

## 2. Files touched by 2+ PRs: risk and resolution rule

| file | PRs | risk | resolution rule |
|---|---|---|---|
| server/index.js | #174 #216 #230 #235 #237 #243 #245 | MED: adjacent import and `app.use` lines at ~38-81 and ~124-163 | Union: keep every import and every mount. One mount per route file: `/api/warroom` (#230), `/api/brain-report` (#235), `/api/number-audit` (#237), `/api/engine` (#216), grades (#174). The serve-log flusher start (#243) stays after the db open. #245's hunk is identical to #174's, so take it once. |
| server/routes/trades.js | #174 #231 #239 #243 #245 | **HIGH** at `/find` (#174 `out` + `recordRoute('find')` vs #243 `found` + `recordServed('trade_find')`) and `/title-trades` (#243) | One variable (`out`), both hooks, in the order `recordRoute(...)` then `recordServed(res, ...)` then `res.json(out)`. Imports: union. `/war-room` (#231) and `/offers/sent` (#239) are separate routes (no overlap). #245 = #174 here. |
| scripts/refresh-live-data.mjs | #233 #235 #237 #242 #243 | **HIGH**: three PRs each add "step 5" plus a `tick()` parameter. #242 wraps `main` in a lock. | Final tick order: jobs -> league_tx -> roster_snapshots -> league_chat -> manager_signals -> **number_audit** (#237) -> **brain_report** (#235) -> **warroom_plans** (#233, launched detached and last, so the producer reads this tick's audit and report). `tick()` takes `{ numberAudit, warRoomLaunch }`. The header comment lists steps 5-7. `main()` = #242's lock wrapper around `refresh()`, which holds all three steps. #243 adds `served_numbers_weekly` to FANTASY_LIVE_JOBS (no clash). |
| test/refresh-loop-steps.test.js | #233 #235 | MED | #235's expected order becomes the final order above, and #233's two tests stay. Update the "tick ends with" assertion to `produce-plans` launched after `run-graders`. |
| docs/wiring/annotations.json | #216 #230 #234 #238 #242 | MED: JSON commas at array/object ends | Union of keys, one JSON object, no duplicate keys. #234 re-adds `nflverse-pbp.js` (already on main after #218): keep one entry. Retire temporary entries when their consumer lands: `plans-schema.js` (#238) after FIX-03, the `warroom/coach/*` files (#230) after FIX-06, `reasoning/*` (#234) after FIX-08. Run `node scripts/wiring-map.mjs --check` after each merge. |
| server/services/trade-engine.js | #174 #236 #240 #245 | MED: import block ~98-120; findTrades return object ~2117 | Imports: union (`LOST_IDEAS`; `leagueShape`; `tradeImpact, tradeImpactWorld`; the title-mutual import). Return object: `const out = { ..., deals: shown, title_mutual: titleMutual, ... }` then #174's tail. |
| server/services/preview-mode.js | #231 #236 #240 #241 | LOW: comment list only | Union of the four converted-site lines (warroom-flag, trade-horizon, title-mutual, season-sim). Add #235's brain-report route and #237 after FIX-10. |
| server/services/scheduler.js | #174 #243 #245 | LOW | #245 supersedes #174's hunks. #243's `served_numbers_weekly` job is a separate hunk. |
| server/services/waiver-wire.js | #174 #244 #245 | LOW: hunks 20+ lines apart | Auto-merge. Re-run waiver tests. |
| client/src/components/TradeCard.tsx | #239 #240 | LOW | Keep both: the "I sent this" button (#239) and the title-mutual badge (#240). |
| package.json | #234 #238 | LOW | Keep both scripts (`reasoning:run`, `validate:warroom-plans`). |
| .gitignore | #234 #235 | LOW: same 3 trailing lines | Keep both ignore blocks. |
| server/services/eval/e1.js, e2.js, tests | #235 #246 | stacked | #246 wins (rebase --onto). |
| rec-ledger files, 071, grades.js, TDD | #174 #245 | stacked | #245 wins. Its rec-ledger.js adds 3 lines (the `logShown` call). |
| **Semantic, not textual:** `client/src/components/warroom/CoachDock.tsx` (#231) vs `.../warroom/coach/CoachDock.tsx` (#230) | #230 #231 | **HIGH**: two Coach docks, #231 mounts the placeholder | FIX-06: WarRoom.tsx mounts #230's dock; delete #231's placeholder. |
| **Semantic:** GRIDIRON_WARROOM_ENABLED read in #231 `warroom-flag.js`, #230 `store.js`, #233 `refresh-live-data.mjs` and `produce-plans.mjs` (plans path too) | #230 #231 #233 | MED: three readers of one flag | `warroom-flag.js` is the only reader (FIX-02). |

---

## 3. Migrations: used vs assigned

| number | assigned to | actually used | status |
|---|---|---|---|
| 071 | #174 | `071_rec_ledger` (#174, and the same file carried in #245) | OK (one file, stacked) |
| 072 | (#164/#166 per #230's header) | none of these PRs | reserved elsewhere |
| 074 | #218 | `074_nfl_play_participation_players` (merged) | OK |
| 075 | #216 | `075_engine_spine` | OK |
| 076 | #230 | `076_warroom_requests` (3 tables: requests, layouts, action_log) | OK |
| 077 | #237 | `077_number_audit` | OK |
| 078 | #235 | `078_brain_report` | OK |
| 079 | serve-log | `079_served_numbers` (#243) | OK |
| 080 | offer loop | `080_trade_outcomes_offer_loop` (#239; 3 columns + 2 indexes on trade_outcomes) | OK |
| 081 | waiver runs | `081_league_waiver_runs` (#244) | OK |
| **081** | (nothing) | **`081_follow_ledger` (#245)** | **CLASH -> renumber 082 (FIX-01)** |
| 083 | (proposed, coordinator to confirm) | none yet | FIX-09: `price_band` + `move_id` on trade_outcomes, `campaign_steps` table, `title_odds_snapshots` view |

Other checks: #242 creates `league_transactions_raw` inline, but only in `scripts/engine-daemon-bench.mjs` on a temp DB, so it is not a schema change. No PR creates tables outside `server/migrations/`. The local DB (`~/gridiron-local/data.sqlite`) has applied nothing past `073`, so renumbering is free (074 from #218 is pending there too and applies on the next server start).

---

## 4. CONTRACT: #233 writes vs #231/#230/#234 read (reference: #238 `plans-schema.js`, `warroom-plans/1`)

#238's `consumer-reads.js` already lists 35 #231 reads and 13 #230 reads with a one-line fix each. It was written before #233 existed, so this section adds the **producer side** and #234. **Ruling proposed: the contract wins everywhere. #233 writes it, the other three read it, nobody keeps the prototype keys.**

### 4a. Producer (#233 `server/services/campaign/view.js` + `produce-plans.mjs`) -> contract

| # | #233 writes | contract (#238) | one-line fix (#233, FIX-03) |
|---|---|---|---|
| P1 | no `schema` key; has `study`, `labels`, file-level `attention[]`, `pushes[]` | head = `{schema:'warroom-plans/1', generated_at, producer, producer_version}` | `plansFile()`: write `schema: SCHEMA_VERSION`; move labels, pushes and study into `producer_version`/log (not in the file) or extend the schema head in #238. |
| P2 | sections nested under `entry.view.*` | sections at league-entry top level | `toEntry()`: return `{ league, me, names, ...sections }` and drop `view`. |
| P3 | prototype keys `acq`, `flip`, `objective`, `next_step`, `trajectory`, `seed`, `confirm_seed`, `week`, `deadline_week`, `rescores`, `runtime_ms`, `phases_ms`, `changed`, `roster_key`, `inputs` | not in the contract (validator: "is not in the contract") | Drop `acq`/`flip` (the consumers move to contract keys). Keep run bookkeeping (`trajectory`, `seed`, `changed`, `inputs`, `phases_ms`) under one contract-listed `_run` object: add `_run: obj({}, {...})` to #238. |
| P4 | statuses `zero`, `thin`, `stale`, `fallback` | only ok / unknown / failed | Map: zero -> ok with an empty list; thin/stale/fallback -> ok plus `n`/`as_of`; `catch_up` 'zero' -> ok []. |
| P5 | field meta `producer`, `producer_version`, `preview`, `preview_reason`, `unit`, `guess`, `n` | FIELD_META = status, reason, source, se, clears_2se, as_of, n | Drop per-field producer/preview (they belong in the head and the view flag). **Extend #238 FIELD_META with `unit` and `guess`** (the UI shows "guess" badges from them). |
| P6 | SourceIds `plan.template`, `chat.labels`, `asset.ros` | 9 ids, none of those three | Add the three to #238 SOURCE_IDS (they are real sources). |
| P7 | numbers as `{value, source, unit, preview}` without `status` | every number is a typed field | `makeNum()` returns `{status:'ok', value, source, ...}`, and `unknown` with a reason when the value is not finite (never `null`). |
| P8 | `deck` (array of step cards) | `alternatives` = array of **moves** (`move_id, rank, target, target_owner, chained, steps[], p_complete, delta_final, expected, reasoning`), max 5 | Build `alternatives.value = res.deck.map((c,i) => move(c.plan, c.playbook, i+1))`. |
| P9 | `next_move` = one step card (`step_index, of_steps, partner, give, get, odds_effect, path_effect, why, ...`) | `next_move` = the deck head **move**, and `next_move.value.move_id === alternatives.value[0].move_id` | `next_move = field('ok', alternatives[0])`. |
| P10 | step keys `partner` (from `team`), `p_yes` (bare num), `odds_effect.{before,after,delta}`, `path_effect.*`, `message:{text,...}`, `opening:{give,p_yes}`, `walk_away:{text,max_give}`, `send_when` string | step = `partner, give, get, p_yes(field), title_odds_delta(field+se+clears_2se), title_after(field), message(field str), opening(field{give,get,text}), walk_away(field{text,max_give}), send_when(field str), reply_table(field{accept,decline,counter,silence})`, optional `reasoning` | Rename in `card()`: `odds_effect.delta` -> `title_odds_delta`, `odds_effect.after` -> `title_after`, wrap message/opening/walk_away/send_when as typed fields, add `opening.get`. |
| P11 | `replies` = its own section (array with `kind`) | per step `reply_table.value.{accept,decline,counter,silence}` each `{do, when?, message?, odds_after?, move_id?, counter_rules?}` | Fold `pb.replies` into `steps[i].reply_table`, keyed by kind. The decline row names the backup by `move_id`. |
| P12 | `suggestions` | `targets` (`player, owner, gain_if_landed, p_reach, mode_fit(field), why(field), approved, is_plan_target`) | Rename; `mode_fit`/`why` become typed fields; add `is_plan_target`; drop `expected`/`skipped` or add them to #238. |
| P13 | `flips` (+ `chat_hint`; `legs.p_both` bare) | `flip_map` (`legs.p_both` a typed field; no `chat_hint`) | Rename, wrap `p_both`, and move `chat_hint` to `reasoning.his_side` or add it to #238. |
| P14 | `brain_check` hard-coded 'not_run'; producer 'eval-01 not-built' | `brain_report` (`overall, checks[{id,name,bar,status,...}], blocks[], fell_back_to?`) | Read `latestReport()` + `brainReportRule()` (FIX-05); write `brain_report`. |
| P15 | `number_health` unknown "not built yet" | not in the contract | Add `number_health` to #238 SECTIONS (the UI already has a slot) and fill it from `readNumberAudit(league)` (FIX-05). |
| P16 | `risk_modes`, `partners`, `confirm` sections | not in the contract | Add all three to #238 (`risk_modes`: the three-mode comparison the UI needs for row 8; `partners`: needed by #234 and people; `confirm`: fresh-dice seeds), or fold `confirm` into `_run`. |
| P17 | `feasibility` value = the planner's object or `{kind:'outlook', season_mean, per_week[]}` | `{points_per_week, projected_points(field), p_hit(field), by_week(field), cost_text?}` | Write the contract shape for the points objective. For other goals write `unknown` with reason "points objective not set" (move the outlook to `_run`). |
| P18 | `destination.goal` bare `{kind, label, target, points_per_week}`; kind 'title'/'playoffs'/'points'/o.goal | `goal` = typed field `{kind in title/playoffs/get_player/points, label, player_id?, points_per_week?}` | Wrap it, map player goals to `get_player` + `player_id`. Also wrap `risk_mode` as `{mode, until_week?}`, and `tolerances`, `arrive_by`, `path` and `ground_lost` (typed, never `null`); add `eta_week`. Drop `metric_now`, `risk_label`, `catch_up`, `behind` and `deadline_week` (or add them to #238). |
| P19 | `itinerary` = `{...res.itinerary, stops[], stop_previews[]}` | `{version, stops[{id,order,kind,label,status,added_by,...}], stops_left, untouchables[], conflicts[{text}]}` | Emit exactly those keys; `stop_previews` moves to `stop_tradeoffs`. |
| P20 | **no `stop_tradeoffs`** | `stop_tradeoffs` = map `tradeoffKey(action) -> {stop_label, cost, extra_steps, gain, net, verdict, because, new_next_move_changes, gain_text?}` | For each stop preview (and each mode/tolerance/objective alternative the planner priced), key it with `plans-schema.js#tradeoffKey` and write the contract row. |
| P21 | `attention` file-level array | per league `attention` = `{rank, of, reason}` | Write the league's own row into its entry. |
| P22 | no `finder_best_expected` | required typed field | Write the Trade Lab finder's best expected gain from the adapter (the baseline the study had), or `unknown` + reason. |
| P23 | no call to `validatePlans` (own `validateEntry` with its own rules) | `validatePlans(doc)` must be empty before write | Replace `validateEntry` with `validateLeague` from #238. A failing league is written as `{league, me, names, error}` (the contract's failed-run shape). |
| P24 | step `partner` = `String(st.team)`; `me` is a roster id | ids are strings matching `ID_RE`; player ids must be keys of `names` | Already strings. Make sure every `give`/`get`/`target` id is in `names` (the validator enforces it). |
| P25 | no acceptance band on a step | #239 `recordSentOffer` refuses a deal without `acceptance` (band) | Add optional `p_yes_band: {low, high}` to #238's step and have #233 write the band `acceptanceBand` gave. Needed so a War Room "I sent it" can be graded (FIX-07). |

### 4b. UI (#231 `server/services/war-room-view.js`) -> contract

All 26 rows in #238 `consumer-reads.js` (the `pr: 231` entries with `fix`) apply unchanged. Their one-line fixes are in that file. Summary of the moves: `acq.alternatives`/`acq.best*`/`acq.fallback`/`acq.targets`/`acq.title_now`/`baseline.*`/`flip.*` -> `alternatives.value`, `next_move.value`, `steps[].reply_table.value.decline`, `targets.value`, `destination.value.title_now`, `finder_best_expected`, `flip_map.value`. Additional #231 defects not in that list:

| # | #231 behaviour | fix (FIX-04) |
|---|---|---|
| U1 | `deckPlans()` shows `acq.alternatives` alone when non-empty, so it **drops the best plan** with #233's current output | Read `alternatives.value` (the head is rank 1). The bug disappears with the contract read. |
| U2 | `destination()` hard-codes goal / risk_mode / arrive_by / eta / planned / path / ground_lost to `unknown "not built"` | Pass `destination` through from the contract. |
| U3 | `allHidden()` hard-codes speed_curve, catch_up, brain_check, number_health and attention to "not built" | Pass each section through from the league entry (typed fields already). Keep `unknown`/`failed` only when the entry is missing or errored. |
| U4 | view section names `suggestions`, `flips`, `next_move.value.cards[]` differ from the contract (`targets`, `flip_map`, `alternatives`) | The API view = the validated league entry + `{enabled, preview*, snapshot, sources, banner}`. Rename `client/src/components/warroom/types.ts` fields to the contract names so Coach (#230) and UI read one shape. |
| U5 | `card().reasoning` reads six bare strings on the plan | Read `move.reasoning.value[slot]` (one typed field). |
| U6 | skip log only in React state (`deck.ts`) | POST `deck.skip` / `offer.sent` / `offer.reply` / `target.approve` to `/api/warroom/:league/requests` (#230). |
| U7 | SOURCES map misses `plan.template`, `chat.labels`, `asset.ros` | Import SOURCE_IDS from `plans-schema.js` and keep labels in one place. |

### 4c. Coach (#230 `warroomCoach.ts`, `CoachDock.tsx`, `warroom-actions/schema.js`) -> contract

All 11 `pr: 230` rows in `consumer-reads.js` apply: `alternatives.value[].partner/give/get` -> `alternatives.value[].steps[0].*`; `destination.value.goal.label` -> `goal.value.label`; `arrive_by` -> `.value`; PLUG_IN_FIELDS `suggestions` -> `targets`, `flips` -> `flip_map`, `brain_check.checks` -> `brain_report.checks`, `title.odds_by_week` -> `destination.path`, and drop `roster.bye_holes` (no producer). Additional:

| # | defect | fix (FIX-06) |
|---|---|---|
| C1 | `SKIP_REASONS` = `dont_like_player, costs_too_much, dont_trust_manager, not_now`, but #231's deck and #233's `SKIP_WEIGHT` use `player, cost, manager, not_now` | Change #230 schema.js (and its client mirror) to `player, cost, manager, not_now`, which matches the two other parties. Add `SKIP_REASONS` to #238 as the shared list. |
| C2 | `DECLINE_REASONS` `wants_more, likes_his_player, not_interested, not_now, other` vs north-star row 21 "value / need / likes his guy / not now" | Keep #230's list (it covers row 21), export it from #238 so #233 and the E2 grader use the same ids. |
| C3 | the `PANELS` ids `flip_map, targets, brain_check` mix old and new names | Rename `brain_check` -> `brain_report` in PANELS (or keep the panel id and map it). Pin with the #238 test. |
| C4 | `warRoomEnabled()` in store.js is a second reader of GRIDIRON_WARROOM_ENABLED (its own comment says to switch) | Import `warRoomFlag` from #231's `warroom-flag.js`. |
| C5 | the dock is never mounted (#231 mounts its placeholder) | WarRoom.tsx uses `useWarRoomCoach` + `coach/CoachDock`, and #231's `CoachDock.tsx` is deleted. |

### 4d. REASON-01 (#234 `server/services/reasoning/cards.js`) -> contract

| # | #234 reads | contract | fix (FIX-08) |
|---|---|---|---|
| R1 | `league.cards[]` or `league.acq.{best, alternatives}`; `step.team`, `step.p`, `plan.delta_final ?? step.delta`, `step.se`, `step.clears` | `alternatives.value[]` moves; `steps[0].partner`, `p_yes.value`, `title_odds_delta.{value,se,clears_2se}`, `delta_final.value` | `cardsForLeague()`: read `alternatives.value` (head = rank 0). |
| R2 | card id from `plan.id ?? ${league.league_id}:${rank}`; the entry has `league`, not `league_id`, so ids come out `undefined:0` | `move_id` | Use `move.move_id` (stable across refreshes, so reuse works). |
| R3 | `league.partners[team].{roster_holes, paper_values, recent_moves, offers_logged, chat_labels}` (object keyed by team) | not in the contract; #233 writes `view.partners` as an array `{team, p_responds, basis, edge, chat{...}}` | Add `partners` to #238 as `field(arr(obj({team, p_responds, basis, ...}, {chat_labels: arr(str), roster_holes, recent_moves, offers_logged})))`; #233 writes it and #234 reads the array. |
| R4 | `league.calibration['clone.accept']`, `step.p_n`, `step.basis` | not written by anyone | Read `brain_report` E1 status for the calibration fact; `p_yes.n` for the count. |
| R5 | `plan.reply_table` / `plan.walk_away` (plan-level) | per step `reply_table.value.*`, `walk_away.value` | Read `steps[0].*`. |
| R6 | output `server/data/reasoning/panels.json`, keyed by league and card; **no reader** (the contract wants `reasoning` inside each move/flip/target) | `move.reasoning` = typed field `{case_for, his_side, devils_advocate, news_check, confidence, counter, cites[], check_first?}` | **One writer of the plans file:** `produce-plans.mjs` calls `produceReasoning()` after planning and before the atomic write, behind the REASON flag + `GRIDIRON_ALLOW_PAID_RUN`. Otherwise each `reasoning` is `unknown` "reasoning off / paid run not allowed". The panels file becomes the reuse cache only. |
| R7 | default plans path `server/data/campaign/plans.json` | `warroom-flag.js#warRoomPlansPath()` (`~/gridiron-local/warroom/plans.json`) | Import `warRoomPlansPath`. |

---

## 5. Seams: #235/#246 EVAL inputs vs what the writers actually write

| grader | #235/#246 reads (table: columns) | who writes what (17 PRs + main) | mismatch | resolution (FIX-09 unless noted) |
|---|---|---|---|---|
| E1 (#235) | `trade_outcomes` WHERE source='app_proposed' AND model_p_accept NOT NULL: league_id, counterparty_team_id, proposed_at, model_p_accept, status, idea_id; plus `offer_log` (same cols) | #239 writes `trade_outcomes.sent_at`, `matched_tx_id`, `settle_reason` (080) and settles status from ESPN. The slate writes `app_proposed` rows that were **never sent**. **No one writes `offer_log`.** | E1 grades suggestions nobody sent (they sit at 'proposed'; #246 excludes unanswered, so they are noise rather than wrong labels). `offer_log` is dead. | Drop `offer_log`. E1 reads `trade_outcomes WHERE source='app_proposed' AND sent_at IS NOT NULL` for the app arm. |
| E1 (#246 league-wide) | `trade_outcomes` (observed + app_proposed: league_id, season, source, proposer/counterparty, proposed_at, model_p_accept, status, espn_tx_id, idea_id, resolved_at), `league_transactions_raw`, `offer_log` | same as above; #239's `matched_tx_id` is the exact app<->ESPN link | #246 de-duplicates app vs observed by a 72 h window. An **unsent** app row with the same teams suppresses the real observed row, which loses a labelled offer. | Dedup on `matched_tx_id` first; only rows with `sent_at` take part in the 72 h fallback; drop the `offer_log` source. |
| E2 (#235/#246) | `offer_log`: league_id, counterparty_team_id, model_p_accept, **price_band**, status (+ proposed_at) | nobody. #233 knows the yes-point (`opening`, `walk_away`, `pResponds`) but writes JSON only. #239 has no price column. | Table and column do not exist. | Migration 083: `trade_outcomes.price_band TEXT CHECK (price_band IN ('below','at_point','above'))` + `move_id TEXT`. The War Room `offer.sent` path writes both from the card (FIX-07). E2 reads trade_outcomes with sent_at. |
| E3 (#235) | `title_odds_snapshots`: league_id, season, team_id, week, p_playoffs, p_title, made_playoffs, won_title (+ baseline_p_playoffs) | #243 writes `served_numbers` (surface 'title_odds', entity `team:<roster>`, fields `title_odds`, `playoff_odds`, lo/hi, trigger 'weekly', season, week) | Different table and shape; no outcome columns anywhere | Migration 083 adds VIEW `title_odds_snapshots` = pivot of `served_numbers` (surface='title_odds', trigger='weekly') LEFT JOIN season outcomes (made_playoffs / won_title from league_history / final standings). E3 unchanged. |
| E4 (#235) | JSON `GRIDIRON_E4_REPLAY_JSON` or `server/data/eval/e4-planner-replay.json` | nobody in these PRs | no writer | Later unit (planner replay on history). Leave not_enough_data with reason "planner replay not built". No FIX now. |
| E5 (#235) | `campaign_steps`: league_id, predicted_title_odds_gain, realized_title_odds_gain | nobody. #233 writes only plans.json + pushes.jsonl | no writer | Migration 083 `campaign_steps(id, league_id, move_id, step_index, sent_request_id, trade_outcome_id, predicted_title_odds_gain, predicted_se, realized_title_odds_gain, realized_at)`. The producer writes the predicted row when it consumes an `offer.sent` request, and fills realized on the next run after the step resolves accepted (rescore). |
| E6 (#235) | `rec_ledger`: season, week, disposition, predicted_json(.near_tie), outcome_json(.followed), score, graded_at | #174 writes rec_ledger (no followed / near_tie). #245 writes `follow_ledger.outcome` (follow/ignore/no_action) + `near_tie`, joined by `rec_ledger_hash` | E6 reads keys nobody writes | E6 reads `follow_ledger f JOIN rec_ledger r ON r.inputs_hash = f.rec_ledger_hash AND r.league_id = f.league_id`, `followed = f.outcome='follow'`, `near_tie = f.near_tie`, excludes `no_action`/NULL. No schema change. |
| E7 (#235) | `weekly_autopsy` | nobody (PROJ-04 later) | no writer | Later. Keep not_enough_data "autopsy not built". |
| SELF-01 War Room | follow_ledger `kind='next_move'` is allowed by 081/082 | nothing logs War Room next moves (#245 only hooks rec-ledger routes) | the War Room is invisible to SELF-01 | The `/war-room` route calls `logShown` for `next_move` (INSERT OR IGNORE, cheap, same pattern as rec-ledger's `recordRoute`) (FIX-07). |
| serve-log War Room | #243 extractors: trade_impact, title_odds, title_trades, trade_find | War Room numbers are served from plans.json | War Room numbers are not in `served_numbers` | Add surface `war_room` (next_move/alternatives p_yes, title_odds_delta, title_after; destination title_now) (FIX-07). |
| Fallback rule | `brainReportRule({requestedMode, report, now})` | #233 never calls it | not enforced | FIX-05. |

---

## 6. People profiles: who reads them, and how (PEOPLE-01 not built)

**First, D1 blocks every reader:** all 10 rebuilt `negotiation_profiles` rows fail `negotiationProfileErrors` on main (unknown keys + free-text enums), so `negotiationProfilesFor` returns `byRoster` empty. FIX-00 fixes this before anything else.

Direct reads to switch to `server/services/people/profile-reader.js` when PEOPLE-01 lands:

| # | where | reads | via | switch to |
|---|---|---|---|---|
| 1 | main `server/services/counterparty-pricing.js#negotiationProfilesFor` (+ `counterpartyLayer`, `selfRead`) | `negotiation_profiles.profile_json`, validated by its own schema | direct SQL on the chat DB | becomes the reader's thin wrapper (or is replaced by it) |
| 2 | main `server/services/manager-signals.js` (`openChatDb`, chat rates) | `manager_chat_profile`, chat rollups | direct | reader |
| 3 | main `server/services/coach/people/variables.js` + `grading.js` | profiles, notes | direct | reader |
| 4 | main `server/services/bluff-detector.js` | chat, live | direct | reader for profile traits; live chat stays |
| 5 | **#233 `scripts/campaign/chat-labels.mjs`** | `manager_chat_profile` (SELECT *), `manager_player_sentiment` by chat name, via `openChatDb`; `negotiation_profiles` via #1 | **direct SQL** + #1 | reader (typed profile incl. sentiment rollup) |
| 6 | **#233 `server/services/campaign/partners.js#chatLabels`** | parses `profile.says_no.does_his_no_hold`, `p_competitive/p_friendly/p_defensive`, `msgs` itself | parses profile fields | reader's typed fields (`no_holds`, `tone`, `engagement`) |
| 7 | #233 `scripts/campaign/league-adapter.mjs` | `counterpartyLayer` (receptiveness) | through #1 | unchanged once #1 routes through the reader |
| 8 | #234 `reasoning/cards.js` | `partners[team].chat_labels` from plans.json | indirect (plans file); labels only, and quote-shaped labels are dropped | no DB read; stays downstream of the producer. Needs the `partners` contract (R3). |
| 9 | #237 `number-audit.js` | calls counterparty-pricing producers | through #1 | unchanged |
| 10 | #246 `eval/e1-league.js` | none (states that the profile/receptiveness terms are not as-of, so they stay inert in replay) | none | needs PEOPLE-02 versioned profiles (`as_of`) before E1 can grade the people terms |

**Not read by anyone:** `manager_notes` (Nick's 8 notes, source 'nick-chat-2026-09-23') and `profile_json.nick_override` (7 managers). Their shape varies by person: `{active, difficulty}`, `{contactable:false}`, `{buyer:false, trades}`, `{fan_of, note}`, `{note}`. FIX-00 gives them one reader and FIX-02b applies them in the producer.

No PR reads the new fields (`deal_feelings`, `values_talk`, `behaviour_vs_words`, `changes_since_0918`). That is expected until PEOPLE-01 / CAMPAIGN-PEOPLE.

---

## 7. Flags: one per feature, all on under GRIDIRON_PREVIEW_UNCONFIRMED via preview-mode.js

| feature | PR | flag | read through preview-mode? | single reader? | verdict |
|---|---|---|---|---|---|
| War Room tab + view | #231 | GRIDIRON_WARROOM_ENABLED | yes (`warroom-flag.js`) | yes, in #231 | OK |
| War Room requests/Coach | #230 | same flag, own reader (`store.js#warRoomEnabled`) | yes | **no (second reader)** | FIX-02: import warroom-flag |
| War Room producer | #233 | `env.GRIDIRON_WARROOM_ENABLED === '1'` in refresh-live-data (step + banner); produce-plans reads GRIDIRON_WARROOM_PLANS / `_SOURCE` itself | **no** | **no (third reader, and a second plans-path reader)** | FIX-02: `warRoomFlag().enabled`, `warRoomPlansPath()`; drop GRIDIRON_WARROOM_SOURCE |
| Reasoning panels | #234 | none (paid-run gate only) | no | none | FIX-08: add GRIDIRON_REASONING_ENABLED via preview (paid gate stays separate and required) |
| Brain report | #235 | GRIDIRON_BRAIN_REPORT | yes (route) | yes | OK. The graders run unflagged in the loop (records only), which is fine. |
| E1-FIX | #246 | under #235's flag | yes | yes | OK |
| Number health card + dot | #237 | **none** (card on Settings + nav dot always shown) | no | none | FIX-10: GRIDIRON_NUMBER_HEALTH via preview (audit job may stay unflagged) |
| Offer loop "I sent this" | #239 | **none** (TradeCard button always on) | no | none | FIX-10: GRIDIRON_OFFER_LOOP via preview (a new tap on the main trade card) |
| Serve-log | #243 | none (records only, not user-visible) | n/a | n/a | OK (ruling: logging infra, no flag) |
| Follow ledger | #245 | none (records only) | n/a | n/a | OK (same ruling) |
| Rec ledger | #174 | none (records only) | n/a | n/a | OK |
| RL-16-1 playoff weight | #236 | GRIDIRON_RL16_1_ENABLED | yes | yes | OK |
| RL-19-3 title-mutual | #240 | GRIDIRON_TITLE_MUTUAL_ENABLED | yes | yes | OK |
| RL-17-3 sim on ROS | #241 | GRIDIRON_RL17_3_ENABLED (`=0` vetoes preview) | yes | yes | OK (veto documented) |
| RL-16-2 waiver runs | #244 | none | n/a | n/a | fix, not a feature; OK |
| FIX-HOLD-01 | #232 | none | n/a | n/a | fix; OK |
| Engine spine / daemon | #216 / #242 | process opt-in (`scripts/engine-daemon.mjs`, `start-all.mjs`); GRIDIRON_ENGINE_LOCK / GRIDIRON_REFRESH_LOCK are paths, not switches | n/a | n/a | OK (ruling: a separate process is its own switch) |

**Process-environment defect (D5), local ops, no PR:** `~/gridiron-local/refresh.sh` must export `GRIDIRON_PREVIEW_UNCONFIRMED=1`, as `run.sh` does. Otherwise the refresh loop, and the producer, graders and audit it launches, run every flagged model **off** while the web server runs them **on**. FIX-02 also makes the producer write `flags: {rl16_1, rl17_3, title_mutual, preview}` into `producer_version` so a mismatch is visible. The warroom_plans step then needs no flag of its own.

---

## 8. FIX UNITS (ordered; each paragraph is a cloud-ready prompt)

**FIX-01 (blocking, before merge): renumber follow ledger to 082.** On branch `claude/cloud-self-01a-07ofag` (PR #245), rename `server/migrations/081_follow_ledger.js` to `082_follow_ledger.js`, set `export const name = '082_follow_ledger'`, and update every reference in `docs/tdd/2026-09-24-follow-ledger.tdd.md`, `test/self-01a-follow-ledger.test.js` and comments. 081 belongs to #244 (`081_league_waiver_runs`). Then rebase the branch onto #174's head so its diff is the follow ledger only (it already contains #174's commits). Run the follow-ledger and rec-ledger tests. Do not change the table. Done when `ls server/migrations | cut -c1-3 | sort | uniq -d` prints nothing after both PRs are combined.

**FIX-00 (first after merge, high): profiles readable again + Nick's overrides.** On origin/main, `server/services/counterparty-pricing.js#negotiationProfileErrors` rejects all 10 rebuilt rows in the local chat DB's `negotiation_profiles`. They carry new top-level keys (`deal_feelings`, `values_talk`, `behaviour_vs_words`, `changes_since_0918`, `as_of`, `messages_read`, `nick_override`, sometimes `slug`/`name`/`aliases`/`league4_roster_id`/`league_roster`/`subject`), and their enum slots hold sentences (e.g. `does_his_no_hold: "rarely (Jeanty is the exception)"`, `techniques[].how_often: "often (8 ...)"`, `calibration.inflation: "moderate"`). So `negotiationProfilesFor` drops every one of them. Make the schema v2: (1) declare the new keys (typed where the shape is known, `object` otherwise); (2) for each enum slot accept free text and normalise it with a leading-token parser (yes/usually/rarely/unknown; often/sometimes/once, "twice" -> sometimes; none/mild/heavy, "moderate" -> mild; praise reading -> 'mixed' when unparseable), keeping the raw sentence as `<slot>_text`; (3) accept `nick_override` as an object with known optional keys `active`, `difficulty`, `contactable`, `buyer`, `trades`, `fan_of`, `note`; (4) also read `manager_notes` (league_chat.sqlite; columns name, note, source, noted_at) and expose, per roster, `nick: { contactable, active, difficulty, buyer, notes[] }`, with `nick_override` beating any chat-derived read. Add a test with a fixture copied from the live row SHAPES (keys, enum sentences, no chat text) that proves 10/10 valid, plus parser cases. No chat text leaves the chat DB. This is the seed of PEOPLE-01's reader: put the normaliser in `server/services/people/profile-reader.js` and have `negotiationProfilesFor` call it.

**FIX-02 (high): one War Room flag reader, producer on under preview, Nick's partner pool applied.** After #233/#231/#230 merge: (a) `scripts/refresh-live-data.mjs#warRoomPlans` and its banner call `warRoomFlag().enabled` from `server/services/warroom-flag.js` instead of reading `GRIDIRON_WARROOM_ENABLED`. `scripts/campaign/produce-plans.mjs#plansPath` and `warRoomFiles` use `warRoomPlansPath()`. Drop `GRIDIRON_WARROOM_SOURCE`. `server/services/warroom-actions/store.js#warRoomEnabled/warRoomPreview` import `warRoomFlag`. Add a grep test that only warroom-flag.js names the variable. (b) The producer records the effective model flags (RL-16-1, RL-17-3, title-mutual, preview) in `producer_version`. (c) Nick's ground truth for league 4 (high priority): `server/services/campaign/partners.js` and `scripts/campaign/chat-labels.mjs` read the per-roster `nick` block from FIX-00 (profile `nick_override` + `manager_notes` source 'nick-chat-2026-09-23'). Apply it with override precedence over every chat-derived read. `contactable:false` ([mgr]) -> partner excluded, `p_responds = 0`, `basis 'Nick: unreachable'`, and never a step, flip leg or target owner. `buyer:false` / `trades:'probably none'` (Zach) -> deprioritised (`p_responds` capped low, e.g. at CHECKED_OUT_RESPONDS, labelled a hand-set constant). `active:true` (Lars, [mgr], Rami, Raj) -> the active pool: `p_responds` floor at BASE_RESPONDS and first in partner order at equal edge. `difficulty:'hard to deal with'` (Rami, Raj) -> tougher pricing: open further from his yes-point and a lower walk-away, a hand-set shift shown in the reason chain as "Nick: hard to deal with". Add tests: [mgr] never appears in any deck, flip or target; Zach ranks below every active manager at equal edge; a hard manager's opening asks for less than a neutral one on the same deal; nick_override beats a contrary chat label. (d) Local ops (coordinator, not the cloud): add `GRIDIRON_PREVIEW_UNCONFIRMED=1` to `~/gridiron-local/refresh.sh`.

**FIX-03 (high): the producer writes the contract.** After #238 and #233 merge, change `server/services/campaign/view.js` and `scripts/campaign/produce-plans.mjs` so the plans file validates with `validatePlans()` from `server/services/campaign/plans-schema.js`. Rows P1-P24 of section 4a in `docs/handoff/local/INTEGRATION-AUDIT-0923.md` are the exact list: head `schema`; sections at the entry top level (no `view`); drop `acq`/`flip`; three statuses; typed fields everywhere; `alternatives` as moves with `move_id` and the deck head also in `next_move`; per-step `title_odds_delta` / `title_after` / `reply_table` / `walk_away` / `send_when` / `message` / `opening`; `targets`, `flip_map`, `brain_report`, per-league `attention`, `finder_best_expected`, `stop_tradeoffs` keyed by `tradeoffKey()`. Extend #238 in the same PR where the producer has real extra data: FIELD_META `unit` and `guess`; SOURCE_IDS `plan.template`, `chat.labels`, `asset.ros`; sections `number_health`, `risk_modes`, `partners`; a `_run` object for bookkeeping; step `p_yes_band {low, high}`; shared `SKIP_REASONS` and `DECLINE_REASONS`. Replace `validateEntry` with `validateLeague`; a league that fails is written as the contract's `{league, me, names, error}`. Replace `test/fixtures/warroom-contract/producer-plans.json` with a fixture produced by the real producer on `test/fixtures/campaign-league.mjs`, and keep #238's "producer writes every declared path" test green. Update `consumer-reads.js` only when FIX-04/06/08 land.

**FIX-04 (high, after FIX-03): the War Room view reads the contract, and the best plan shows.** In `server/services/war-room-view.js` (#231), apply every `pr: 231` fix in `test/fixtures/warroom-contract/consumer-reads.js` and rows U1-U7 of section 4b. The API view becomes the validated league entry plus `{enabled, preview, preview_reason, snapshot, sources, banner}`. Stop hard-coding destination, speed_curve, catch_up, brain_report, number_health and attention as "not built". The deck is `alternatives.value` (the head is rank 1), which fixes the dropped-best-plan bug. Rename `client/src/components/warroom/types.ts` and the components to the contract names (`targets`, `flip_map`, `alternatives`, `brain_report`). The deck's skip reasons, "Do it" / "I sent it", "log reply" and "approve target" POST to `/api/warroom/:leagueId/requests` (kinds `deck.skip`, `offer.sent`, `offer.reply`, `target.approve`). Delete the `fix` entries in consumer-reads.js as each read resolves (#238's test fails on a stale one). Tests: a producer fixture whose head differs from alternatives[1] shows the head as card 1; each section passes through; a skip POSTs one request.

**FIX-05 (high, after FIX-03): brain report and number health feed the plan.** In `scripts/campaign/produce-plans.mjs` / `server/services/campaign/planner.js` (#233): read the latest brain report (`server/services/eval/index.js#latestReport`) and apply `brain-rule.js#brainReportRule({ requestedMode, report, now })` before planning. A failing, stale (>48 h), missing or errored report forces BALANCED with testing-tier signals off, and SAFE is never raised (coordinator ruling). Write `destination.risk_mode` as the effective mode and `brain_report` (`overall`, `checks[]` with `needs_text` in `result`, `blocks[]`, `fell_back_to:'balanced'` when it fell back). Fill `number_health` from `server/services/number-audit.js#readNumberAudit(league)`. Tests: all_in + failing E1 -> balanced with fell_back_to; safe + failing -> safe; missing report -> balanced; not_enough_data alone -> requested mode kept.

**FIX-06 (high, after FIX-04): Coach docks in the War Room and reads the same keys.** In #230's files: apply every `pr: 230` fix in `consumer-reads.js` (deal from `move.steps[0]`; `goal.value.label`; `arrive_by.value`; PLUG_IN_FIELDS `targets`, `flip_map`, `brain_report.checks`, `destination.path`; drop `roster.bye_holes` and `title.odds_by_week`) in both `client/src/components/warroom/coach/warroomCoach.ts` and `server/services/warroom-actions/schema.js`. Set SKIP_REASONS to `player, cost, manager, not_now` and import SKIP/DECLINE lists from plans-schema.js. `store.js` uses `warroom-flag.js`. Mount `useWarRoomCoach` + `coach/CoachDock.tsx` in `client/src/components/warroom/WarRoom.tsx`, passing the War Room view as `plans`, and delete #231's placeholder `client/src/components/warroom/CoachDock.tsx`. Remove the `warroom/coach/*` wiring exemptions from `docs/wiring/annotations.json`. Test: a Coach add_stop on a fixture with `stop_tradeoffs['add:get:<id>']` renders the cost/gain/net preview, and the confirm writes one `stop.add` request with `confirmed=1`.

**FIX-07 (high, after FIX-03 and #239): War Room inputs reach the producer; one "I sent it" store.** (a) `scripts/campaign/produce-plans.mjs` reads pending `warroom_requests` (migration 076) for each league (`consumed_at IS NULL`, ignoring retracted ones and Coach rows without `confirmed=1`). It folds them into that league's objective state (latest objective.set / mode.set / tolerance.set / stop.add / stop.remove / target.approve) and skip weights (deck.skip, reasons player/cost/manager/not_now), plans, and stamps `consumed_at` in the same transaction as the plans write. Objective state persists as the fold of all non-retracted requests. `objectives.json` / `skips.jsonl` stay as CLI-only test inputs; `offers.jsonl` goes. (b) `offer.sent` in `server/services/warroom-actions/store.js#recordRequest` also calls `server/services/trade-outcomes.js#recordSentOffer` with the card's deal, its `p_yes_band` as the acceptance band, `move_id` and `price_band` (below / at_point / above the card's yes-point). The fatigue cap reads `trade_outcomes WHERE sent_at IS NOT NULL` (War Room and TradeCard taps alike). (c) `/api/trades/:id/war-room` logs the shown next move to `follow_ledger` (`kind 'next_move'`, via `engine/follow-ledger.js#logShown`, INSERT OR IGNORE) and queues a `war_room` surface in `serve-log.js` (p_yes, title_odds_delta, title_after, destination title_now). Needs migration 083 from FIX-09 for `price_band`/`move_id`, so land FIX-09's migration first. Tests: a mode.set request changes the next run's `destination.risk_mode` and is stamped consumed; a retracted request is ignored; a War Room "I sent it" produces exactly one trade_outcomes row with sent_at and band, and a second tap returns already_sent.

**FIX-08 (medium, after FIX-03): reasoning goes into the plan, one writer.** Change #234's `server/services/reasoning/cards.js` to read `alternatives.value` moves (`move_id` ids, `steps[0].partner/give/get`, `p_yes.value`, `p_yes.n`, `title_odds_delta.{value,se,clears_2se}`, `delta_final.value`, `steps[0].reply_table.value`, `steps[0].walk_away.value`), `partners.value[]` for his side, and `brain_report` E1 status for calibration. Add GRIDIRON_REASONING_ENABLED read only through preview-mode.js (a new `reasoning-flag.js`). `scripts/campaign/produce-plans.mjs` calls `produceReasoning()` after planning and before the atomic write, only when the flag is on and `GRIDIRON_ALLOW_PAID_RUN` is set, and writes each panel into `move.reasoning` (typed field). With either gate off it writes `reasoning` unknown with the reason. `panels.json` stays as the reuse cache next to the plans file (`warRoomPlansPath()` dir, not server/data). `scripts/reasoning/run.mjs` stays as a manual re-run that writes through the same function. Remove the `reasoning/*` wiring exemptions. Tests: 14 existing, retargeted to the contract fixture; unchanged move_id -> 0 calls; gate off -> 0 calls, unknown with reason.

**FIX-09 (medium): EVAL reads what the writers write.** Migration `083_eval_seams` (coordinator to confirm the number): `trade_outcomes` gains `price_band TEXT CHECK (price_band IN ('below','at_point','above'))` and `move_id TEXT`. New table `campaign_steps(id, league_id, move_id, step_index, trade_outcome_id, predicted_title_odds_gain, predicted_se, realized_title_odds_gain, realized_at, created_at)`. VIEW `title_odds_snapshots` pivots `served_numbers` (surface 'title_odds', trigger 'weekly'; fields title_odds -> p_title, playoff_odds -> p_playoffs; team_id from `team:<id>`) LEFT JOIN season outcomes (made_playoffs, won_title from the league history tables; NULL until the season ends). Graders (#235/#246): E1 app arm = `trade_outcomes WHERE source='app_proposed' AND sent_at IS NOT NULL`, and `offer_log` is dropped everywhere. E1-league dedup uses `matched_tx_id` first, and only sent app rows take part in the 72 h fallback. E2 reads trade_outcomes (sent_at, price_band). E5 reads `campaign_steps` (the producer writes predicted when it consumes an offer.sent and realized after the step settles accepted). E6 reads `follow_ledger` joined to `rec_ledger` on `inputs_hash = rec_ledger_hash` (followed = outcome 'follow'; near_tie from follow_ledger; no_action/NULL excluded). E4/E7 stay not_enough_data with reasons naming their future units. Tests per grader with the new sources, plus one proving an unsent app_proposed row no longer suppresses an observed ESPN row.

**FIX-10 (low): flags for the unflagged user-visible features.** Add GRIDIRON_NUMBER_HEALTH (#237 Settings card + nav dot; the audit job stays unflagged) and GRIDIRON_OFFER_LOOP (#239 TradeCard "I sent this" button + `/offers/sent`), each with a one-file reader that uses `previewUnconfirmed()`, and the preview label on the response. List both, plus brain-report (#235), in the converted-sites comment in `server/services/preview-mode.js`. Test: off -> the card/button is absent and the route answers `{enabled:false}`; preview -> on with `preview:true`.

**FIX-11 (low, after all merges): integration smoke, league 4.** On a local DB copy with `GRIDIRON_PREVIEW_UNCONFIRMED=1` in both processes: run the producer for league 4 only, and assert `validatePlans` is empty, `next_move.move_id === alternatives[0].move_id`, [mgr] appears nowhere, `brain_report` present and `number_health` present. Open `/api/trades/4/war-room` and confirm the same numbers reach the view (field-by-field equality on p_yes, title_odds_delta, title_now). POST one `mode.set`, re-run the producer, and see the mode change and the request consumed. Screenshot the War Room. Write results into `docs/handoff/local/INTEGRATION-LOG.md`. Read-only against production; local copy only.

Order: FIX-01 (before merge) -> merge train (section 1) -> FIX-00 -> FIX-02 -> FIX-03 -> FIX-05 -> FIX-09 (migration first) -> FIX-04 -> FIX-06 -> FIX-07 -> FIX-08 -> FIX-10 -> FIX-11. After FIX-03, FIX-04/05/09 can run in parallel (different files). FIX-06 needs FIX-04, and FIX-07 needs FIX-09's migration. Keep 3 or fewer build loops at once.
