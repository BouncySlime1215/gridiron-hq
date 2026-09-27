# INTEGRATION CHECKS (Nick 9/23 ~9:25 PM: "how will you make sure what they do are wired properly and everything is well integrated")
Four layers; every merged unit passes all four.
1. **Contract (before merge):** one shared schema per seam, imported by BOTH sides, tested in CI.
   - plans.json (campaign producer -> War Room UI -> Coach actions): `server/services/campaign/plans-schema.js` (WARROOM-CONTRACT unit) with a contract test; producer output must validate; UI and Coach fixtures must validate. Keys like `alternatives[]`, `stop_tradeoffs{}`, `reasoning{}` defined once.
   - engine fields (spine producers): the engine_fields registry + one-writer trigger (EA-00).
   - migrations: numbers assigned by the coordinator (071 #174, 074 #218, 075 #216, 076 #230, 077 BROKEN-01, 078 EVAL, 079 serve-log, 080 offer loop, 081 waiver runs).
2. **Wiring (CI, every PR):** `node scripts/wiring-map.mjs --check` (no orphan module without a named, time-boxed reason); flags read only through preview-mode.js; no page recomputes (ratchet list).
3. **Integration audit (after each merge batch, at least every 3 h, and in Phase C):** an auditor agent reads the day's merged diffs together and checks: every new producer has a consumer on a page/Coach; no second producer for an existing number (one-number rule); contract keys produced == keys consumed; flags consistent (one flag per feature, all on under preview); temporary wiring exemptions removed when their consumer lands; BROKEN-NUMBERS rows moved. Findings -> fix units the same night.
4. **Live end-to-end (Phase C + daily):** local app updated, War Room opened per league in the browser, numbers on screen == plans.json == engine fields, Coach command smoke ('show flip map league 3', 'next', 'get me a TE' -> trade-off preview), screenshots.

## Open seams to reconcile (integration audit, first pass)
- EVAL graders (#235) PROPOSE input tables offer_log, title_odds_snapshots, campaign_steps, weekly_autopsy and read #174 rec_ledger. The offer loop (cloud CLONE-01b-b1), serve-log (cloud SERVE-LOG), SELF-01a and the campaign producer (#233) must WRITE exactly these names/columns, or #235 is adapted to theirs. One fix unit after those PRs exist.
- Coordinator ruling on #235's fallback reading: missing / stale (>48 h) / errored report forces BALANCED; SAFE is never raised to BALANCED. Confirmed.
- plans.json keys: producer (#233) keeps the prototype's keys; UI (#231) and Coach (#230) expect their own; WARROOM-CONTRACT (cloud) lists mismatches.
