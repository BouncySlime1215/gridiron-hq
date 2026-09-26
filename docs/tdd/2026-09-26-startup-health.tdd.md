# STARTUP HEALTH: trade cards refused while the rules, values or ledger fail to load

2026-09-26. Batch D plan item 56. Off `main` `3ac1016`. Flag `GRIDIRON_STARTUP_HEALTH` (off by default).

Nick's rules stand on three things: the rules module (`campaign/never-give.js`), the FantasyCalc value
reader (`fc-value.js`) and this season's trade ledger (`campaign/trade-memory.js` over
`league_transactions_raw`). Today each request's `ruleGate` fails closed on bad inputs by dropping every
idea, so a broken input shows as an empty or thin screen with no reason. With the flag on, the app probes
all three at startup and the trade-card routes answer 503 with a plain banner until they load.

## Pre-registration (written before the GREEN commit)

This is a safety gate, not a served number: it changes no value, only whether card routes answer.

- **B1 (flag off is inert).** Flag unset: every route passes through and no probe runs, even with a broken
  module. **Pass bar:** 0 probes, 100 % pass-through. **Fails it:** any 503 or any loader call.
- **B2 (fail closed).** Flag on, each of 9 faults (rules import throws, rules lost a pin, fc import throws,
  fc export missing, fc rows empty, fc read throws, ledger import throws, ledger table absent, executed
  trades none of which read): the probe fails the right check, and every one of 20 card routes answers
  503 `fail_closed` before the router runs. **Pass bar:** 9/9 faults, 20/20 routes. **Fails it:** any card
  body served while a check is failing.
- **B3 (healthy passes).** Flag on, healthy fixture: every card route passes through; the probe runs once.
- **B4 (no collateral).** 12 non-card routes (lineup, waivers, player, rosters, layout, action log, ...)
  are never blocked. **Pass bar:** 12/12.
- **B5 (no dev text).** The public view carries no path, module, table, env name or raw error; checks
  expose only `name` and `ok`. The raw reason goes to the server log.
- **B6 (cheap).** Probe < 200 ms on the fixture.
- **B7 (recovers).** A fixed input serves again after `RETRY_MS` (60 s) without a restart, not before.
- **B8 (wired).** `server/index.js` mounts `tradeSafety.gate` once, ahead of every trade-card router, so the existing auth mounts stay byte-identical (two tests pin them).

The rules self-test is behaviour, not presence: `ruleVerdict` on made-up ids must still refuse gives of
160, 80 and 277 (no pick), a get of 290, a sold player, a sub-83 get, an unscored get, an unpriced player
and an overpay, and must pass one clean even swap.

## RED

`test/startup-health.test.js` committed first; run on the RED commit:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/startup-health.js'
# tests 1
# pass 0
```

## GREEN

```
node --test test/startup-health.test.js
# tests 24
# pass 24
# fail 0
```

Server boot with the flag on and a fresh database (no FantasyCalc rows yet) logs
`[startup-health] fc_value failed: values empty (...)`, and `npm run start:smoke` passes with the flag on
and off.

## Not covered

- A syntax error inside `never-give.js` stops the whole server from booting (routes import it statically),
  which is already fail closed but shows no banner. The probe covers load failures of its own dynamic
  imports, missing exports, wrong rule behaviour and unreadable data.
- The banner itself is not drawn: `GET /api/trade-safety` serves it and the client wiring is left to the
  coordinator (Trades client files are off limits to cloud threads).
- The gate runs ahead of the routers' auth, so with the flag on and a check failing, an unauthenticated
  request to a card path gets the 503 banner (fixed text, no data) instead of a 401. B8 was reworded after
  the first full run: pinning the gate inside each auth mount broke two existing tests that pin those
  lines, so it moved to one mount ahead of them; the bars themselves did not change.
