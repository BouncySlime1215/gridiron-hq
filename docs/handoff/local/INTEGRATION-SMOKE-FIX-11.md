# FIX-11 integration smoke, league 4 (2026-09-24)

Spec: INTEGRATION-AUDIT-0923.md section 8, FIX-11. Code: origin/main `36e3b94b` (tree `ddb95186e831799154cf92ab03b6e38c9dd8afc9`), detached worktree `~/gridiron-local/wt/fix-11`.
Prereqs: #231, #230 and #238 merged; #233 landed through integration #299 (`63ed648c`, closed because its branch was stacked).
Setup: `sqlite3 .backup` copies of the app DB and chat DB in a scratch dir; plans file in scratch; `GRIDIRON_PREVIEW_UNCONFIRMED=1` + `GRIDIRON_WARROOM_ENABLED=1` in both the producer and the server; paid keys blank, no `GRIDIRON_ALLOW_PAID_RUN`. The server ran on a copy-only session token (port 5237; 5199 is taken by the local launcher). Live DBs were not written.
Evidence (local only, holds names): `~/gridiron-local/evidence/fix-11/` (run1.log, run2.log, warroom-1.png, warroom-2.png).

## Results

| # | Check | Result |
|---|---|---|
| 1 | Producer, league 4 only (`--leagues 4`) | PASS: ok, 0 failed, 221 s, 481 rescores. Model flags `rl16_1/rl17_3/title_mutual = preview`, preview on |
| 2 | `validatePlans(file).errors` empty | PASS: 0 errors (run 1 and run 2) |
| 3 | `next_move.move_id === alternatives[0].move_id` | PASS: `L4-1v774ct` both (run 1). Run 2 (safe): both empty (`next_move` unknown "none of 116 paths clears...", `alternatives` []) |
| 4 | [mgr] (the contactable:false roster) appears nowhere | PASS: 0 hits in next_move, alternatives, itinerary, flip_map, targets, stop_tradeoffs, attention. Present only in `partners` as `blocked:true, p_responds 0, basis 'Nick: unreachable'` (the FIX-02 rule). The chat-DB "nick" blocks resolved 8 rosters |
| 5 | `brain_report` present | PASS: status ok, overall `not_enough_data` (E3 passing, the rest not enough data), so the requested mode is kept (no fallback) |
| 6 | `number_health` present | PASS in the plan: status ok, overall **broken** (2 broken, 9 ok). **UI FAIL, see G1** |
| 7 | `/api/trades/4/war-room` equals the plans file | PASS: field-by-field EQUAL on move_id, p_yes (0.581), title_odds_delta (0.0017), title_now (0), risk_mode, deck head, brain_report, number_health |
| 8 | POST `mode.set` {mode: safe} -> re-run -> mode changes, request consumed | PASS: 201, request id 1 (source nick, confirmed 0). Re-run (301 s): "requests consumed 1", `consumed_at` stamped, `destination.risk_mode` balanced -> safe, and the view says safe |
| 9 | Screenshot of the War Room | DONE: headless Chrome via CDP, before and after (local only). Before: the next-move card, 2 stops, flip map, 3 targets, brain grid. After: "None of the 116 paths searched clears the sliders..." and 0 stops |

## Gaps found

- **G1 (medium, UI): number health shows "not computed yet" while the audit says broken.** `client/src/components/warroom/BrainCheckCard.tsx#HealthDot` reads `number_health.value.status` and `.value.open`. The producer writes `value.overall`, `value.broken`, `value.warn`, `value.ok` and `value.checks[]`. So a broken audit renders as a grey dot, both in the brain card and in the top strip. Fix: read `overall`, and count `checks` for warnings. `consumer-reads.js` did not catch it.
- **G2 (check): `title_now` = 0 and `title_planned_now` = 0** (sim.title, status ok). The card shows "0.0% -> 0.2%". This may be a real 0 for this roster, but it is worth a look: a 0 with status ok and no se is easy to misread.
- **G3 (low): after the safe re-run, the top strip still says "rank 1 of 1: best move worth 0.0 pts, next move changed"**, although there is no next move.
- **G4 (ops):** the reasoning panels are all "not computed yet" (unpaid run, by design). Port 5199 is the launcher's, so smoke servers need a different port.
