# FIX-02: one War Room flag reader, model flags in the plans head, Nick's partner pool (2026-09-24)

Spec: `docs/handoff/local/INTEGRATION-AUDIT-0923.md` (branch `claude/handoff-package-2026-09-22`),
sections 2, 6, 7 and FIX-02 in section 8. Defects D5 and D10.

Base: this branch is #233 (`6429dc2`, CAMPAIGN-01 producer, itself on #227), with #231
(`cce5005`, War Room UI + `warroom-flag.js`) and #230 (`d328590`, War Room requests + Coach)
merged in. None of the three is on main yet. FIX-00 has no PR, so the per-roster `nick`
block it should expose is built here as `server/services/people/nick-block.js`, for
FIX-00 to absorb into `profile-reader.js`.

## 0. Audit (extend or build)

- `warroom-flag.js#warRoomFlag` / `#warRoomPlansPath` (#231) already exist. They are
  reused. Three other readers are switched to them: `refresh-live-data.mjs#warRoomPlans`
  (flag, banner, `warRoomFiles`), `produce-plans.mjs#plansPath`, `warroom-actions/store.js#warRoomEnabled/#warRoomPreview`.
  `GRIDIRON_WARROOM_SOURCE` is dropped.
- The three model-flag readers live in unmerged PRs: `trade-horizon.js#playoffImportance`
  (#236), `season-sim.js#rosBasisFlag` (#241), `title-mutual.js#titleMutualMode` (#240).
  `campaign/model-flags.js` calls each one and does not read any flag variable itself. A
  reader that is not merged reads `absent`.
- Partner choice (`campaign/partners.js`), pricing (`campaign/playbook.js#priceLadder`),
  exclusion (`campaign/search.js`, `campaign/planner.js`) and chat labels are extended,
  not replaced. Nick's read is a new input `m.nick` on each manager.
- Decision: **extend** the existing files. Two new files are added: `nick-block.js` (the
  reader FIX-00 was meant to supply) and `model-flags.js`.

## 1. Tests (RED first)

`test/fix-02-warroom-flag-nick.test.js` (10 tests). `test/refresh-loop-steps.test.js`
is edited so its producer test pins the flag through the new `flag` argument.

RED: `4796cf9`, "test: FIX-02 RED one War Room flag reader, model flags in producer_version, Nick's partner pool".
It was run against the base tree before any implementation:

```
not ok 1 - test/fix-02-warroom-flag-nick.test.js
  error: 'test failed'        (ERR_MODULE_NOT_FOUND: server/services/people/nick-block.js, campaign/model-flags.js)
not ok 23 - CAMPAIGN-01: a running producer is not launched twice, and the last finished run is recorded (ok / partial / error)
  error: "Cannot read properties of undefined (reading 'job')"   (the base loop ignores the injected flag and reads its own env)
# pass 21
# fail 2
```

GREEN: `892d401` ("fix: FIX-02 GREEN warroom-flag.js is the one War Room flag reader, ..."). A follow-up, `9ee56da` ("refactor: FIX-02 drop the redundant planner target filter"), comes from mutant M5 (section 2). Guard results are in section 3.

The RED load failure proves only that the modules are absent. Section 2 carries the per-behaviour liveness proof.

## 2. Liveness: mutation sweep

A session-local script, not committed. Each mutant changes one line, runs
`test/fix-02-warroom-flag-nick.test.js`, `test/refresh-loop-steps.test.js` and
`test/campaign-producer.test.js`, then restores the file. M1-M16 and C1-C2 were measured on GREEN `892d401` (write-tree `073a4819`). M5b and M17 were measured on `9ee56da`.

```
M1 unit: pResponds ignores unreachable: KILLED (2 failing: not ok 30 - (c) an unreachable manager never appears in any deck, flip or target; not ok 33 - (c) nick_override beats a contrary chat label)
M2 unit: excluded() drops unreachable: KILLED (1 failing: not ok 30 - (c) an unreachable manager never appears in any deck, flip or target)
M3 call site: search partners filter back to blocked only: KILLED (1 failing: not ok 30 - (c) an unreachable manager never appears in any deck, flip or target)
M4 call site: flip pairs keep unreachable buyer: KILLED (1 failing: not ok 30 - (c) an unreachable manager never appears in any deck, flip or target)
M5 call site: targets keep unreachable owner (planner upgrades): SURVIVED (0 failing: )
M6 unit: deprioritised cap removed: KILLED (2 failing: not ok 31 - (c) a not-trading manager ranks below every active manager at equal edge, what; not ok 33 - (c) nick_override beats a contrary chat label)
M7 unit: active floor removed: KILLED (1 failing: not ok 31 - (c) a not-trading manager ranks below every active manager at equal edge, what)
M8 unit: tier tie-break removed: KILLED (1 failing: not ok 31 - (c) a not-trading manager ranks below every active manager at equal edge, what)
M9 unit: priceLadder ignores hard: KILLED (1 failing: not ok 32 - (c) a hard manager's opening asks for less than a neutral one on the same deal)
M10 call site: planner passes hard:false: KILLED (1 failing: not ok 32 - (c) a hard manager's opening asks for less than a neutral one on the same deal)
M11 unit: withNick ignores deprioritised: KILLED (1 failing: not ok 33 - (c) nick_override beats a contrary chat label)
M12 unit: nickBlock override loses to notes: KILLED (1 failing: not ok 28 - (c) nick block: nick_override beats a structured note; unreachable, not tradin)
M13 call site: refresh loop reads its own env: KILLED (2 failing: not ok 25 - (a) the refresh loop launches the producer under preview mode alone, and reads; not ok 55 - CAMPAIGN-01: a running producer is not launched twice, and the last finished r)
M14 call site: store preview via own read: KILLED (1 failing: not ok 26 - (a) the request store answers through warRoomFlag: off, on, and on-by-preview )
M15 unit: version omits flags: KILLED (1 failing: not ok 27 - (b) model flags come from each reader, a missing reader reads absent, and the )
M16 unit: missing-reader rule swallows any module error: KILLED (1 failing: not ok 27 - (b) model flags come from each reader, a missing reader reads absent, and the )
C1 control (should SURVIVE): comment edit: SURVIVED (0 failing: )
C2 control (NOT APPLIED): pattern absent: NOT APPLIED
M5b call site: targets keep unreachable owner (playerValues): KILLED (1 failing: not ok 30 - (c) an unreachable manager never appears in any deck, flip or target)
M17 call site: flip sellers keep unreachable (flipMap aId): KILLED (1 failing: not ok 30 - (c) an unreachable manager never appears in any deck, flip or target)
```

M5 **survived**. That line in `planner.js` (the upgrades filter) was redundant, because `search.js#playerValues`
already skips excluded owners, so their players never enter `addN`. Fix: the planner line goes back to its base form
(`9ee56da`). M5b shows the `playerValues` skip is the check that works. C1 is the designed surviving control
(a comment edit). C2 is the designed not-applied control (a pattern that is not in the file).

## 3. Guard run

Code head `9ee56da`, tree `8f472693`.

| step | command | exit | result |
|---|---|---|---|
| install | `npm ci` | 0 | fresh `node_modules` on this clone |
| tree | `git status --porcelain` / `git write-tree` | - | clean except this evidence file; `8f472693` before and after the run |
| typecheck | `npm run typecheck` | 0 | |
| lint | `npm run lint` | 0 | |
| wiring | `npm run check:wiring` | **1** | Also exits 1 on the base (#233 + #231 + #230), with 14 `module-reaches-no-surface` findings. This branch adds 1 receiver pair (`server/services/people/nick-block.js chat`: 2, the chat DB handle passed in from `chat-labels.mjs`) and 2 findings of the base's own class (`campaign/model-flags.js`, `people/nick-block.js`). Reported, not accepted: `docs/wiring/annotations.json` is not this PR's file. The accept lines are drafted below. |
| tests | `npm test` | 0 | 4903 tests, 4861 pass, 0 fail, 42 skipped |
| build | `npm run build` | 0 | |
| smoke | `npm run start:smoke` | 0 | |

`npm run check` stops at the wiring step. Each later step was run on its own, on the same tree.

Drafted accept lines for the owner of `docs/wiring/annotations.json`:
- `accepted_unresolved_receivers`: `"server/services/people/nick-block.js chat": 2`. Reason: the local chat DB handle that `chat-labels.mjs` opens with `openChatDb` and passes in, the same shape as `coach/people/variables.js chatDb`. RETIRES WHEN: FIX-00 folds nick-block.js into profile-reader.js.
- `accepted_orphan_modules`: `server/services/campaign/model-flags.js` and `server/services/people/nick-block.js`. They are reached only through `scripts/campaign/produce-plans.mjs`, which the refresh loop spawns, the same class as the base's `campaign/*.js`.

## 4. Nick's five questions

1. **Well built?** Nick's read (`nick-block.js`) is read once per league and then carried
   on each manager as `m.nick`. It has one meaning everywhere it is used:
   `partners.js#excluded`, `#pResponds`, `#nickTier` and `#withNick`, plus
   `playbook.js#priceLadder({ hard })`. The unreachable rule is applied at every place
   that picks a partner: target owners (`planner.js` upgrades, `search.js#playerValues`),
   flip pairs (`search.js#flipMap`, both sides), realised flip legs, and path steps
   (`search.js#searchTarget` partners).
2. **Stats or made up?** No statistics are involved. The rules come from Nick. Two
   numbers are hand-set constants: `HARD_SHIFT_PCT = 10` (points on his screen) and the
   existing `CHECKED_OUT_RESPONDS = 0.05` / `BASE_RESPONDS = 0.5`, which this change uses
   as the cap and the floor. Both are labelled "hand-set" in the reason chain.
3. **How we know:** hand-set constants. Nothing was backtested, and nothing measures how
   much a hard bargainer concedes. The 10-point shift is a **guess**.
4. **Pointed anywhere else?** It reaches only the campaign producer (War Room plans).
   Trade Lab's `counterparty-pricing.js` does not read the nick block yet. That belongs to
   PEOPLE-01/FIX-00.
5. **How it unifies:** one flag reader for the War Room (`warroom-flag.js`). One Nick
   read per roster, which FIX-00's `profile-reader.js` should absorb. `producer_version`
   names the model flags each run priced with, so a refresh process without preview mode
   shows up as `preview=off` next to the web server's preview-on numbers.

- **Defects fixed:** D5 (the producer read its own flag and missed preview mode:
  `scripts/refresh-live-data.mjs` `warRoomPlans` at #233 `6429dc2`) and D10
  (`nick_override` / `manager_notes` had no readers).
- **Incumbent:** before this change, `warRoomPlans` returned early unless `GRIDIRON_WARROOM_ENABLED=1`.
  Test 2 shows the change: preview mode alone now launches the producer.
- **Not covered:** Trade Lab / counterparty pricing (FIX-00 / PEOPLE-01). The real
  `manager_notes` schema is taken from the audit (`name, note, source, noted_at`) and
  has not been checked here. The PR body has a `LOCAL:` line that checks it. A
  `get_player` objective whose target is owned by an unreachable manager keeps the
  target, but no plan can reach it.
- **What would make it wrong:** a live `manager_notes` or `nick_override` shape that
  differs from the audit's description. That case reads `unknown` and is recorded on
  `entry.inputs.chat.nick`; it does not turn into a silent wrong read.
