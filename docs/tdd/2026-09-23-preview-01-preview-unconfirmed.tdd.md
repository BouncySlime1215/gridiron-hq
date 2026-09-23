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
| streaming-board.js:55, :209-216 D/ST swap suggestion | const `WV01_STREAMING_BOARD_ENABLED` / `enabled` arg | yes | built; the suggestion is computed and then blanked |
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
