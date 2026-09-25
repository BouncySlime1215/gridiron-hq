# COACH-BRIEF: morning brief and weekly check-in

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
node --test test/coach-brief.test.js      # 24 pass, 0 fail (19 + 5 from the diff review)
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

## Diff review (one reviewer agent, read the diff)

The reviewer found seven defects, all fixed with a test each:

1. **Strict "Why" cited id and count cells.** `verify.js` also accepts a value ×100 or ÷100, so
   a planner number equal to a team id, a player id or the step count got through. The claim now
   cites only result cells. Team and player names are removed as labels and never used as
   evidence.
2. **"What changed" had the quote allowance but is planner prose.** It is now strict, like
   "Why".
3. **Rows can arrive after the brief but carry an earlier timestamp.** Example: an ESPN sync
   writes a 6:55 AM decline at 7:30 AM. The next window now reaches `LATE_ROWS_HOURS` (6) back
   past the last brief's end and skips rows that brief already reported (keys carried in the
   body).
4. **A logged reply on a move that has left the plan repeated its outcome.** It is now removed
   as a duplicate when an outcome with the same reply exists.
5. **Push with no previous file and no cache table read as "unchanged".** It is now `unknown`,
   with the reason.
6. **The script opened, and could migrate, the DB before checking the flag.** The flag is now
   checked first; off touches nothing.
7. **A `--since` read was saved and became the next window.** It is now a one-off read and is
   not saved.

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

## FIXER-3 on main (2026-09-24)

Merged `origin/main` 36e3b94b (merge commit). The FIX-03/FIX-06 stack under this branch is on
main, so every stack file takes main's version, including the regenerated producer fixture
`test/fixtures/warroom-contract/producer-plans.json`.

- **Tests on main's fixture.** Before: 20 of 24 pass (4 fail: the next move is now Team 3,
  P4 + P6 for P21, one step, one itinerary stop). After: the tests read the new plan; the
  weekly test adds its own finished stop because main's fixture has one.
- **Migration 088 -> 101.** 088 is reserved for FLIP-01 (#265); 101 is registered in
  MIGRATIONS.md.
- **Statements and credibility through their producers.** The brief had its own chat labeller
  (`jev_chat_signals` questions -> SHOP/UNTOUCHABLE/FRUSTRATED) and its own SHOP credibility bar
  (0.5). Those are PULSE-01's (#316, people_pulse) and CRED-01's (#321, people_credibility)
  numbers. Neither is on main, so `readStatements` / `readCredibility` query nothing and return
  typed unknown with that reason, and the brief says "Statements not read" / "Follow-through not
  read". The brief no longer opens the chat DB. This also removes the check:wiring finding (an
  unresolved `chat` receiver in brief-inputs.js).
- **No push text.** The next-move push (change detection, text, delivery) is PUSH-01's (#293).
  `nextMovePush`, the `push` kind (script, claims, migration CHECK) and its four tests are gone;
  one test pins that there is no push here.
- **Wired to a surface.** With the receiver finding gone, check:wiring reported brief.js,
  brief-claims.js and brief-inputs.js as reaching no surface (only the CLI script imported
  them). `GET /api/coach/brief/:leagueId?kind=morning|weekly` now serves the brief: signed-in
  league member only, flag off -> `{ status: 'off' }` and nothing read, no plans file ->
  `unknown`, bad JSON -> `failed`. Three route tests in `test/coach-route.test.js`.
- **Liveness.** Mutants killed: no league-member check (403 test), `push` kind accepted (400
  test), statements reason without the producer (typed-unknown test), an `ok` statements
  section silently dropped (no-renderer throw test).
