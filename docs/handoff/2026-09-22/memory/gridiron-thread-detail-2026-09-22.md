---
name: gridiron-thread-detail-2026-09-22
description: Scheduler/Wiring-map/Trade-Brain/Model-audit detail, split for byte cap.
metadata:
  type: project
  modified: 2026-09-22T03:34:45.180Z
---

Linked from [[gridiron-state-record-2026-09-22]].

**Scheduler live-tier/runbook/Nick's-trip:** Live-tier rebuilt clean @3ef535b(branch claude/project-thread-o3wt2p-live-tier-offthread)-prior 2 SHAs(8709ec6,9c7cf68) WRONG, corrected in [[gridiron-held-branches-2026-09-20]]+[[gridiron-o3wt2p-branch-ledger]](PR#84 migration-066 provenance now UNRESOLVED, scheduler verifying). Runbook docs/runbooks/deploy-654ff93.md: applies NO schema(791b131=654ff93 migration lists identical)→2GB snapshot hazard drops, CONDITIONAL on 065/066 not landing first; SCHEDULER_DISABLED persistence unknown(not in fly.toml). Needs Nick's trip: df check+VACUUM INTO/sftp/rm,fly secrets list,live-count SQL batch(on hold,see Model audit), push-or-paste for scripts/measure-live-tier-stalls.mjs(902393a,unpushed).

**Scheduler Fable-5.1 authorship finding:** The "I decide, not Nick, do not bother Nick" framing also appears in a message the server marks as authored by Nick himself: cmsg_01YAsw8AnFv4ioRMQw8dfPmTJ4ncHJUA6P88HEUXvhCGVi, 01:41:06Z, the Fable-5.1 correction. Coordinator verified via fetch_messages: message IS author=Nick Matta(user_01RbYJvZsNB43e5RM8eQvJkW) per server. Already scoped narrowly(Fable-5.1 model-tier questions only, coordinator's 01:46Z reply)-does NOT extend to the "seven decisions" message or any HARD RULE. Scheduler took no action(didn't call switch_model, already serving claude-opus-5/high), nothing from Nick in-thread since 01:59Z; holding the DB-copy trip(df -h /data, VACUUM INTO, fly secrets list, GRIDIRON_DB_PATH)-written down not run-until Nick's own plain-word confirm arrives via coordinator. Coordinator confirmed this read is correct, told it to keep holding.

**Model audit — Phase A item2 STARTED (03:31Z):** deep predictive feature set — routes run, OL-vs-DL, pace, red-zone touches, coaching tendencies, practice reports, depth charts; each must prove historical predictive lift before inclusion. Item text/citation: [[gridiron-phase-a-start-2026-09-22]]. Live-count batch still queued behind DB-copy trip(unchanged).

**Model audit instrument-fault:** Self-caught a 12th instrument fault mid-flight(handler.mjs paren-counter skips no strings/comments), 43% of 548 handler blocks scanned short(found via self-recheck vs evidence rule,not external). Retracted 16-betting-facing+12-no-caller lists; freshness-registry recon(73/82 model tables NOT in servedTables(),0/10 fit-stores covered-recommend a 2nd 'fitted-at' grain); phantom/dead/silently_broken findings UNAFFECTED(diff instruments). Re-running, will send delta not just new totals.

**Wiring map / item5 honest inventory — CLOSED:** merge with model-audit
landed at 6dc964c, 873 rows(72 wired/182 half_done/15 dead/3
silently_broken/7 referenced_but_never_created/56 model-blank/538
unclassified, 378 of those gated on live-count/DB-copy, 13 genuinely
contested and left unclassified on purpose). Opportunity's
availability-basis.js finding resolved out-of-scope(own branch only). Full
detail: [[gridiron-honest-inventory-closed-2026-09-22]]. Superseded:
872-row pass(0c13654), phantom-table count corrected 3x(1→24→7,doc'd in
INVENTORY.md), `messages` table resolved via chat-sync(off-server corpus).

**Trade Brain 3 findings:** TRADE_PROPOSAL not TRADE_PROPOSE; idempotency key needs(league,season,tx_id) not tx_id alone; refused to store a bare model_p_accept midpoint, added _low/_high/model_basis instead-acceptanceBand() says 'not calibrated'.
