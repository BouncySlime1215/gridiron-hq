# PREVIEW-01: one local switch for every default-off, unconfirmed-forward feature

Nick (2026-09-23): "turn it on rn whats live in the app why cant i test it".

Local testing only. Production defaults do not change: `fly.toml` does not set the
variable and every site keeps its own ship switch.

## 1. Audit (before the first test): extend or build

Command (tree: origin/main `dc4532c6`):

```
grep -rniE "unconfirmed.forward|default.?off|ACTIVITY_OFF_WHY" server client/src --include='*.js' --include='*.jsx'
grep -rnE "(const [A-Z_]*(ENABLED|_ON|SHIP[A-Z_]*|APPLY[A-Z_]*) = (false|true))|enabled = false|enabled: false|process\.env\.GRIDIRON_[A-Z_]*" --include='*.js' server
```

No switch existed that turns several default-off features on together; each has its
own. `grep -rn PREVIEW server` found no preview mode (the only hit is an unrelated
`preview_note` string in nfl-execution-pipeline.js:261). Verdict: **build** one small
module, `server/services/preview-mode.js`, and **extend** each site's existing switch
with it (the site's own flag stays the real ship switch; preview is an OR).

| Site (origin/main) | Existing switch | Converted? | Why |
|---|---|---|---|
| counterparty-pricing.js:141, :280, :486 activity + checked-out receptiveness | env `GRIDIRON_RECEPTIVENESS_ACTIVITY` / `activity` arg | yes | built, computed on every manager, withheld only by the flag |
| espn-zero-inactive.js:50-54, :74; lineup-brain.js:459 ESPN-projects-0 inactive | env `GRIDIRON_ESPN_ZERO_INACTIVE` / `enabled` arg | yes | built; lineupCall and the dead-starter card read the one hook |
| streaming-board.js:55, :209-216 D/ST swap suggestion | const `WV01_STREAMING_BOARD_ENABLED` / `enabled` arg | yes | built; the suggestion is computed and then blanked. Dormant since #208 (NICK-WV01 turned the constant on): preview never switches it, and the board carries no preview field |
| waiver-wire.js:395-402, :146 snap-share order for same-team replacements | `sameTeamOrder` arg | yes | built; one option away |
| hype.js:24-45, waiver-brain.js:450-473 (sellHigh), routes/players.js analyze | none: `verdict` is hard-coded `null` | **no** | there is no ON output to turn on. No SELL/BUY threshold was ever pre-registered (docs/tdd/2026-09-23-tm-09-market-prices.prereg.md has none), so a preview verdict would be a made-up rule; and the TM-09 table covers seasons 2021-2024 only (`python3 -c ...meta.seasons` printed `[2021, 2022, 2023, 2024]`, 2054 player_weeks), so every 2026 player reads `available: false` whatever the switch |
| trade-market.js:22, :115; routes/trades.js:47, :1025 TM-09 market route | none | **no** | the route already serves its whole payload (history, premium, hype_decay) labelled `status: 'unconfirmed forward'`; nothing is withheld. "No trade card reads it yet" is a missing reader, not a switch: a follow-up UI unit, not this one |
| matchups.js:66-67 DvP / home-field multipliers | code constants | **no** | these are declines, not unconfirmed-forward: both failed the weekly walk-forward test on a season they were not fitted on (matchups.js:55-65); the file says they are code constants on purpose so nothing can flip them without a re-run |
| nfl-player-context.js:537 graded availability | code constant | **no** | ungraded (the as-of refit is still owed), and test/nfl-player-context-graded-availability.test.js fails the build if any caller passes the override |
| gates/baseline-gate.js:196 `beats_dumb_unconfirmed_forward` | none | **no** | a verdict label, not a withheld feature |
| nfl-ensemble.js:481 `DEFAULT_OFF_PLAYS` | n/a | **no** | "offensive plays" default, a name collision |

No page hides a converted value entirely: StreamingBoard.tsx:39 already prints the
"unconfirmed forward" line when `unconfirmed_forward` is true; WaiverWire.tsx:414 prints
`ranked_by` (which says "unconfirmed" for snap share); the dead-starter card prints the
ESPN source label (which says "unconfirmed forward"); ManagerRead.tsx:278 lists the
receptiveness factors. So the UI is unchanged.

One number, one producer: the flag has one reader (preview-mode.js); each feature keeps
its one producer. No new number, table or column.

Statistical unit? No. It turns on already-built, already-graded features for local
testing; it produces no model number, so no pre-registration and no holdout look.

## 2. RED / GREEN

Tests: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`

- **RED** `69b20d8e` "test: PREVIEW-01 RED, one local switch turns on default-off unconfirmed-forward features".
  preview-mode.js is in this commit (so failures are assertions, not import errors); the
  sites are unconverted. Results: preview-mode 3/3 pass (the grep test passes at RED
  because nothing else names the variable yet), and one failing test per site:
  - espn-zero-inactive.test.js:274 `assert.equal(hook.covered, true)`: `false !== true`
  - streaming-board.test.js:258 `assert.equal(b.suggestion.action, 'swap')`: `null !== 'swap'`
  - waiver-injury-alerts.test.js:248 `assert.equal(r.order, 'snap_share')`: actual `'projection'`
  - receptiveness-activity.test.js `assert.ok(layer.get('2').receptiveness > layer.get('3').receptiveness, 'preview turns it on')`: `false`
  The flag-unset pins ("PREVIEW-01 off") and the explicit-argument-wins tests pass at RED,
  as they must: they pin today's output.
- **GREEN** `9b76b0df` "feat: PREVIEW-01 GRIDIRON_PREVIEW_UNCONFIRMED turns on four default-off features locally, labelled preview".
  preview-mode 3/3, espn-zero-inactive 11/11, streaming-board 18/18, waiver-injury-alerts 11/11,
  receptiveness-activity 15/15, dead-starter-guard 9/9.
- `71c7bf04` "test: PREVIEW-01 route call site for the streams board with preview on (M12 survivor)":
  streaming-board 19/19.
- Skeptic round (route call sites, mutants MB and MD survived on `f59cdeb6`):
  - `c0bab209` managers/signals route (ManagerRead) with preview on and unset: receptiveness-activity 17/17.
  - `d2557db4` valuation panel route (`/player/:id`) receptiveness on vs unset: valuation-panel 4/4.
  - `ab72658a` waivers route (WaiverWire) snap-share order with preview on and unset: waiver-injury-alerts 13/13.
  Command per file: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`.

Neighbouring tests that import a touched module, all pass on `9b76b0df` (pass counts):
availability-honest-degradation 8, decision-leftovers-lineup 10, decision-leftovers-waivers 7,
lineup-surfaces-agree 2, manager-data-pipeline 27, hand-fed-table-states 10, hype-vocabulary 4,
lineup-error-no-leak 3, manager-signals-api 27, trade-lineup-value 10, trade-outcomes 36,
waiver-namesake-cut 7, valuation-panel 3, trade-acceptance 22, trade-manager-read 20,
trade-tactics 39, valuation-map 47. (The full suite and `npm run check` are the Gate phase's.)

## 3. Mutation sweep (liveness)

Script: scratchpad `mut.py` (apply one string replacement, run the site's test file, restore).
Tree: `9b76b0df` (+ `71c7bf04` for the M12 re-run).

| Mutant | Test file | Result |
|---|---|---|
| M1 switch on for any value (`!= null`) | preview-mode | killed (1 fail) |
| M2 **designed survivor**: counterparty drops the `activity == null &&` guard | receptiveness-activity | survived, as designed: an explicit `activity:false` makes `activityOn` false, and `offUnless` labels only applied terms, so the guard is belt-and-braces (equivalent mutant) |
| M3 counterparty `offUnless` drops the preview label | receptiveness-activity | killed |
| M4 counterparty ignores preview | receptiveness-activity | killed |
| M5 espn-zero ignores preview | espn-zero-inactive | killed |
| M6 call site lineup-brain.js:459 passes `enabled:false` | espn-zero-inactive | killed (3 fail) |
| M7 dead-starters drops the preview passthrough | espn-zero-inactive | killed |
| M8 streaming drops the "Preview (unconfirmed forward)" prefix | streaming-board | killed |
| M9 streaming preview ignores explicit `enabled` | streaming-board | killed |
| M10 waiver preview ignores explicit order | waiver-injury-alerts | killed |
| M11 call site waiverBoard -> injuryReplacementAlerts drops `preview` | waiver-injury-alerts | killed |
| M12 call site routes/trades.js:699 passes `enabled:false` | streaming-board | **survived on `9b76b0df`** (no route test with preview on); fixed by `71c7bf04`, re-run: killed |
| MB (skeptic) call site routes/trades.js:682 waivers passes `sameTeamOrder:'projection'` | waiver-injury-alerts | survived 11/11 on `f59cdeb6`; killed on `ab72658a` (12 pass, 1 fail: the route preview test) |
| MD (skeptic) call site routes/trades.js:397 signals passes `activity:false` | receptiveness-activity | survived 15/15 on `f59cdeb6`; killed on `c0bab209` (16 pass, 1 fail) |
| MD (skeptic) call site routes/trades.js:965 valuation panel passes `activity:false` | valuation-panel | survived on `f59cdeb6`; killed on `d2557db4` (3 pass, 1 fail: "off 1, on 1") |
| M13 **not-applied control** (pattern absent, file unchanged) | streaming-board | not applied, survived (19/19) |

## 4. What it does

`GRIDIRON_PREVIEW_UNCONFIRMED=1` in the local server's environment turns on, together:

1. **Trade finder, manager read**: the activity and checked-out receptiveness terms move the
   receptiveness score. Each applied factor carries `preview: true`,
   `preview_reason: 'default-off: 2024 held-out AUC 0.644 missed its 0.645 bar; unconfirmed forward'`,
   and its `why` starts "Preview (unconfirmed forward): ".
2. **Start/Sit**: the ESPN-projects-0 inactive hook. The dead-starter card flags the player and
   the solver benches him (one hook, one number). `dead_starters.inactive_source` carries
   `preview: true` and the default-off reason; the card's source label already says
   "unconfirmed forward".
3. **Stream a defense**: the swap suggestion comes back; `unconfirmed_forward: true` makes the
   page print its existing "unconfirmed forward" line; the board carries `preview: true`,
   and the suggestion's `why` starts "Preview (unconfirmed forward): ".
4. **Waiver injury alerts**: same-team replacements in snap-share order; `replacements`
   carries `preview: true`; `ranked_by` (printed by the page) already says "unconfirmed".

Each site's own switch still works alone and is not labelled preview; an explicit argument
(`activity`, `enabled`, `sameTeamOrder`) still wins over the preview switch. Unset, every
response is the same as before (pinned by the "PREVIEW-01 off" tests, which assert the absence
of `preview` keys and today's values).

**Suggestion for `~/gridiron-local/run.sh` (not edited by this unit):** add
`export GRIDIRON_PREVIEW_UNCONFIRMED=1` before the server start line, then restart the local
server. Remove it to go back to production behaviour.

## 5. Numbers

None produced. This unit adds no model number; the two figures quoted (AUC 0.644 vs 0.645,
TM-09 seasons 2021-2024 / 2054 player_weeks) are read from existing code / the committed
table on `dc4532c6`. Holdout looks: none.

## 6. Known defects and follow-ups

- Not smoke-tested against a local DB copy (disk is tight); the route test drives the real
  `/api/trades/:leagueId/streams` handler, and the lineup/waiver/counterparty paths are driven
  through their real producers with fixtures. Nick's check: restart the local server with the
  variable set.
- Hype SELL/BUY and the TM-09 market route are not converted (section 1): no ON output exists.
  Follow-ups, not this unit: pre-register a hype verdict rule; a trade-card reader for TM-09.
- DvP / home-field multipliers and graded availability are deliberately not in preview mode
  (declined / ungraded, section 1).
- The ESPN-zero hook's other readers (TradeCard, WaiverWire, Model availability) still do not
  read it; that is RL-10-1's named follow-up, unchanged here.

## 7. Nick's five questions

1. **Well built?** One reader of the variable (grep test), four sites extended with an OR on
   their own switch, explicit arguments still win, off-path pinned. Mutation: 10 of 11 real
   mutants killed on first pass, the 11th (route call site) fixed with a route test.
2. **Stats or made up?** No new stats. The features it turns on are the already-built ones,
   with their existing graded results and labels. The preview label copy is new text.
3. **How we know?** Per-site RED/GREEN tests with the switch unset and set, plus the mutation
   table above.
4. **Pointed elsewhere?** Each site keeps its one producer; the switch only changes whether it
   is applied. Nothing reads a second copy of any number.
5. **How it unifies?** It replaces "which of four env vars / code constants do I flip" with one
   local switch, and every page that shows a previewed value already carries an
   "unconfirmed forward" label.
