# COACH-BRIEF: morning brief, weekly check-in, next-move push text

COACH-ANCHOR.md job 6 for the target league (leagues.id 4). Coach reads the War Room plans
contract (FIX-03) and last night's rows, and writes three things:

- **Morning brief:** what changed overnight (credible statements, replies to Nick's offers,
  injuries), the next move and why, and the brain's status.
- **Weekly check-in:** where the plan stands against its itinerary.
- **Push text:** a short text when the next move changes. PUSH-01 delivers it; nothing here
  sends anything.

No model call. Every line is a claim that must pass Coach's own `verify.js` against the rows it
cites, or it is dropped. The dropped claim is kept on the brief with the violation.

Branch base: `claude/cloud-fix-03` + `claude/cloud-fix-06`. FIX-06 already contains #230.

## Metric

Share of shipped claims that verify: target 100%. This is COACH-ANCHOR's "share of Coach claims
that verify".

## RED

Commit `test: COACH-BRIEF ... (RED)` adds only `test/coach-brief.test.js`. With the
implementation stashed:

```
node --test test/coach-brief.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/coach/brief.js'
```

## GREEN

```
node --test test/coach-brief.test.js      # 19 pass, 0 fail
```

What the tests pin:

- **Flag.** The feature is off unless `GRIDIRON_COACH_BRIEF_ENABLED=1` or preview mode is on;
  `=0` vetoes preview. When off, nothing is read or written. When it is on only because of
  preview mode, the brief is labelled "Preview (unconfirmed forward)".
- **Grounding.** On the real producer fixture, league 4 ships 13 claims and drops 0. An invented
  number in the planner's why-text is dropped, and the drop records its reason.
- **The "strict" rule.** A cited string quoted word for word counts as its own evidence. It does
  not count inside a strict claim (the planner's why-text).
- **Overnight inputs.** Credible SHOP statements need his credibility to be at least 0.5; noise
  labels are counted, never reported as news. Below-bar signals, untrusted identities and rows
  outside the window are ignored. Retracted and duplicate replies are ignored. Injuries are
  limited to Nick's roster and the players in the next move.
- **Privacy.** No chat name and no message text reaches the stored brief.
- **Missing inputs.** A missing source reads "not read: <reason>". A quiet night reads "no
  replies". A failed plan run or a missing league is stated plainly.
- **Cache.** The same plan and the same night is a lookup. A new plan version or a new overnight
  row builds a fresh brief. A re-read the same morning keeps the same window start. The next
  morning starts where the last brief ended.
- **Push.** The first sighting is a baseline. A change drafts one text of at most 280
  characters, cut at whole claims, and is announced once. A failed next move is not a change.
- **Script.** Argument parsing, the "off" line, and an end-to-end `--migrate --json` run on a
  temp DB, then a cache hit on the second run.

## Measured (fixture, all five leagues, in-memory DB)

`node <scratch>/bench.mjs`: morning + weekly + push for every league in
`test/fixtures/warroom-contract/producer-plans.json`.

| | value |
|---|---|
| claims shipped | 111 |
| claims dropped by the check | 0 |
| verify share | 100.0% |
| build time, median / max | 0.8 ms / 25.8 ms (the max is the first call, cold) |
| model spend | $0 |

The first draft dropped one claim. The planner's move-level why ("gain 37.1 pts ... completes 3%")
cited only step-level cells. The fix cites `delta_final`, `p_complete` and `expected`. The check
did its job: the number was real but uncited, and it was not shipped until it was cited.

## Not confirmed

- **League 4's real plan.** Only the fixture was run here; the cloud cannot reach the Mac's DB,
  chat DB or plans file. The PR's `LOCAL:` lines run the script on a DB copy.
- **Statements.** They come from the chat classifier's labels today (`open_to_trade` -> SHOP,
  `own_roster.argmax:untouchable` / `:complaining` -> noise). There is no WANT_PLAYER question in
  that classifier, and PULSE-01 is not built, so the proven label never appears yet. The
  counterpart model's per-manager shop credibility (COUNTERPART-01, not on this base) is an
  optional input. Without it, no SHOP statement counts as credible.
- **Injuries.** `league_roster_snapshots.changed_at` moves when any column of the row changes.
  A listed injury therefore means "listed with this status, row updated overnight", not "newly
  injured".
- **Push delivery.** PUSH-01 (open PR) sends its own text. Wiring it to use `nextMovePush` is a
  follow-up on whichever lands second.
