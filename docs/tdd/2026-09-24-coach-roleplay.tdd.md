# COACH-ROLEPLAY: "what would he say?" and how Nick comes across

2026-09-24. COACH-ANCHOR.md job 3 (the PEOPLE READER), Phase 2 of the Coach
build units. Branch `claude/cloud-coach-roleplay`, off `claude/cloud-fix-03`
with `claude/cloud-fix-06` merged in (#230 is already inside FIX-06).

## What it does

- `server/services/coach/roleplay.js` (pure):
  - `simulateReply` samples a manager's likely reply to a drafted message:
    a style (ignore / counter / decline / accept) plus a template line built
    from labels only, labelled `Simulation: ...` on every result;
  - `replyMix` builds the mix: ignore = 1 - the plan's `partners[].p_responds`;
    accept = the engine's `p_yes` when the draft is a plan step, or else the
    M6 prior moved by COUNTERPART-01's features; counter and decline split the
    rest in prior proportions;
  - `comesAcross` gives the SELF-01 warnings: offers to him in 7 days ("third
    offer to him in 7 days"), no-streak, an offer still open, the draft's tone,
    and the face cost of asking for a player he called untouchable.
- `server/services/coach/roleplay-tool.js`: the only IO. It reads league 4's
  plans section, `leagues.season` and `trade_outcomes`.
- `tools.js`: a `roleplay` tool, War Room surface only, behind
  `GRIDIRON_COACH_ROLEPLAY=1` or preview mode. Its result goes into the
  ledger, so verify.js can ground the numbers Coach says about it.

## RED

`ca09dc4b` adds `test/coach-roleplay.test.js` with no module behind it:

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/coach/roleplay.js'
```

## GREEN

- `node --test test/coach-roleplay.test.js`: 32 pass, 0 fail, 1 skipped.
  The skipped test is the M6 / COUNTERPART-01 constant parity check, which
  skips while `server/services/people/counterpart.js` (#254) is not in the
  tree.
- With #254's `counterpart.js` copied in temporarily, the same file gives
  33 of 33 pass, 0 skipped, and the parity check holds.
- One test changed between RED and GREEN. The prior-only mix now uses a
  `1e-9` tolerance instead of `deepEqual`, because `0.55 * (0.05 / 0.55)` is
  `0.05000000000000001` in floating point. The test was wrong about exact
  equality; the implementation was not.
- Neighbouring suites (`test/coach*`, `test/warroom*`, `preview-mode`,
  `fix-03*`, `wiring-map`): 355 pass, 0 fail, 1 skipped.
- `npm run lint`: exit 0.
- `npm run check:wiring`: 14 blocking findings on the base and 14 after this
  change, all `server/services/campaign/*` (FIX-03). roleplay.js adds none,
  because the Coach tool reaches it.

## Not fitted

- The M6 reply prior and the COUNTERPART-01 constants (untouchable exclude
  0.5, shop log-lift 0.5, deprioritize 0.5) are mirrored from #254.
- The tone lexicon is hand-set.
- No counterpart model is passed from the Coach tool yet, because #254 does
  not persist one per manager. Until it does, the mix is the plan's
  P(responds) and P(yes) over the M6 prior, and the basis says so.
