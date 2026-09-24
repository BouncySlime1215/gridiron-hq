# PULSE-02: the live chat labeller, graded and gated

RED `188addc4` "test: PULSE-02 labeller gate, Jev pulse path, ownership fixes (RED)" · GREEN follows ·
`test/people-pulse.test.js`, 25 cases (17 from PULSE-01, 2 of them changed, 6 new). Fixtures only:
made-up speakers, players and messages.

## The gap

PULSE-01's labeller scored micro F1 0.426 against the PEOPLE-LAB hand labels (PULSE-01 on this
tree: 0.426 reproduced). Its WANT_PLAYER label, the one that asks for a replan, was 0.556 precise.
Nothing stopped a weak label from replanning.

## What this adds

- **Replan gate** (`pulse.js#replanGate`, `LABEL_QUALITY`, `REPLAN_MIN_F1 = 0.7`). A statement asks
  for a replan only when its type is proven: F1 at least 0.7 on the held-out half of the labels, for
  the path that labelled it (`jev` or `rules`). A gated statement is still stored with its weight.
  `pulseTick` returns it in `gated`, never in `liveCredible`.
- **The pulse's own Jev reading** (`pulse-jev.js`, `scripts/people/jev-pulse.mjs`). It asks four
  boolean questions per message (want_player, shop, urgency, refusal). Jev sees the thread's last 4
  lines and whose team each named player is on at that moment (SPEAKER / NICK / another team /
  none). League-mates' names are never sent. Answers go in the private chat DB
  (`jev_pulse_signals`, `jev_pulse_done`), next to `jev_chat_signals`. No app migration is needed.
  The daily spend cap is $0.50 (`GRIDIRON_PULSE_JEV_USD_DAY`), and each call in flight reserves the
  day's average cost. The step is opt-in: `GRIDIRON_PULSE_JEV=1`.
- **Rules + Jev together** (`PULSE_CUTS`). A rule hit counts when Jev's probability is at least
  `lo`. Jev alone counts at `hi` or above. The cuts were chosen on the train half only
  (`pulse.mjs --grade <dir> --tune`).
- **Ownership at the message's time**, two bugs:
  - `chatTime`: the chat's `ts_utc` is UTC with no zone suffix. `new Date` read it as local time,
    which put every message 4 hours late on the Mac, after trades that had not happened yet.
  - Trades the ESPN feed logged only as a proposal now count when a weekly roster snapshot shows the
    player on the receiving team.
- **Lexicon**: dotless full names ("aj brown"), hyphenated first names run together ("amonra"), the
  last two words of 3-word names ("st brown"), all-caps first names ("dk"), and lower-case
  initialisms of the form vowel-then-consonants ("ajb", "cmc"), minus a chat-shorthand stoplist.

## RED

At `188addc4` the test imports `server/services/people/pulse-jev.js`, which does not exist:
`ERR_MODULE_NOT_FOUND` (1 test, 1 fail).

## GREEN

25/25. Neighbours: people-*, refresh-*, coach-brain-tools, engine-people-publish,
data-credit-line: 144/144. Wiring, chat, league-chat, paid-run-opt-in, offline-guard and
llm-plumbing: 254/254. `check:wiring` exits 0 after the `pulse-jev.js chat` receiver entry.
`tsc --noEmit` is clean.

## Measured (counts only; `pulse.mjs --grade`, DB copies, pulse-jev-3)

Slice: 3,264 league-mate messages since 2026-07-01, 330 with L4 hand labels. The split is by time.
Train is before 2026-09-17 (2,455 messages). Test is 2026-09-17 on (809 messages), and no cut was
chosen on it.

| type (test) | rules only P / R / F1 | rules + Jev P / R / F1 | gate |
|---|---|---|---|
| WANT_PLAYER (36 pos) | 0.560 / 0.778 / 0.651 | 0.711 / 0.750 / **0.730** | replans (jev path only) |
| SHOP (43) | 0.759 / 0.512 / 0.611 | 0.733 / 0.512 / 0.603 | gated |
| URGENCY (4) | 0 / 0 / 0 | 0 / 0 / 0 | gated |
| REFUSAL (16) | 0.600 / 0.188 / 0.286 | 0.467 / 0.438 / 0.452 | gated |

Bootstrap on the WANT_PLAYER test F1 (2,000 resamples): 90% CI 0.62–0.80. 28% of resamples fall
below 0.7. Micro F1 over all types, whole slice: 0.449 (rules) -> 0.508.
