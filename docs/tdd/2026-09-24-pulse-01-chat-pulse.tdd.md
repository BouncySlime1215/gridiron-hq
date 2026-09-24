# PULSE-01: the chat pulse (PEOPLE-FLOW §2, M9)

RED `a79076bb` "test: PULSE-01 chat pulse labels, people events, replan trigger (RED)" · GREEN follows ·
`test/people-pulse.test.js`, 17 cases. Fixtures only: made-up speakers, players and messages.

## The gap

The PEOPLE-LAB labels (624 statements) were a one-off batch. Nothing labelled a league-mate's
message when it arrived, so a new "I want X" (the one proven signal: acquires that player within
7 days at 17x base) reached no plan, no event and no screen until someone re-ran the study.

## What this adds

- `server/services/people/pulse.js`: labeller (text rules + league-4 player lexicon + the Jev
  probabilities the league_chat step already writes + ownership at the message's time), weight =
  follow-through (CRED-01 when present, else the pooled PEOPLE-LAB prior; unproven types unknown),
  `pulseTick` (cursor, backfill-never-replans, labels only), `recentPulse` (ticker read).
- `scripts/people/pulse.mjs`: one pass + replan request (launches the War Room producer detached
  through the warroom_plans step's own launcher and lock, when GRIDIRON_WARROOM_ENABLED=1; every
  outcome recorded), and `--grade` against hand labels.
- Migration 098 (`people_pulse`, `people_pulse_runs`); engine adapter `people_pulse` ->
  `people.statement` events; refresh step `people_pulse` after `league_chat` (GRIDIRON_PULSE_ENABLED
  or preview); ticker route `GET /api/trades/:leagueId/people/pulse` + `PulseTicker` on Trade Brain.

## RED

At `a79076bb` the test imports `server/services/people/pulse.js`, which does not exist:
`ERR_MODULE_NOT_FOUND ... server/services/people/pulse.js` (1 test, 1 fail).

## GREEN

Main moved under this branch (#299 added the refresh loop's `warroom_plans` step, which launches
the producer detached under a lock). The GREEN commit therefore also changes the replan test: the
first design ran `produce-plans --leagues 4` synchronously, which would have run the producer twice
at once and rewritten plans.json with league 4 only. The test now pins "launch once, all leagues,
same lock and log; a live lock is never doubled; a stale lock does not block".

17/17. Neighbours: engine-spine, engine-daemon, refresh-loop-steps, preview-mode, chat-block-wiring
(93/93 with the new file); wiring tests + migration-027 (166/166); `check:wiring` clean after the
`pulse.js chat` receiver entry; lint + typecheck clean.

## Measured (DB copies, counts only)

Labeller vs PEOPLE-LAB hand labels, 3,264 league-mate messages since 2026-07-01, 330 labelled:
text rules alone micro F1 0.128 (P 0.22, R 0.09) -> shipped labeller 0.426 (P 0.406, R 0.447);
WANT_PLAYER P 0.556, R 0.779, player agreement 57/60.

Replay: chat cut at 2026-09-21T00:00Z (pass 1, backfill) then the full chat (pass 2, live):
pass 1 read 256 -> 22 statements, 4 credible, replan not_needed (backfill); pass 2 read 271 ->
47 statements from 6 rosters, 8 credible WANT_PLAYER, one replan request (warroom_disabled in the replay: the real producer was not launched);
69 people.statement events; ticker 20 items. Passes 206 ms and 85 ms.
