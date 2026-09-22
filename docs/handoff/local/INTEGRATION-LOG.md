# Integration log

One entry per merged PR: what it touched, the intake verdict (upstream, downstream, reach, links, plan, follow-ups), and where each follow-up landed.
Rebuilt by `~/gridiron-local/bin/render-integration-log.py` from `integration/PR-*.md` and WORK-QUEUE section 7. Procedure: INTEGRATION-PROCEDURE.md.
Last rebuilt: 2026-09-22 23:46Z.

## #156: Hand-fed tables (roster snapshots, trending, correlations) name their own absence (S-18)

- Merged: 7:46 PM ET, Sep 22 as `443f33b7` (unit S-18)
- Intake: done: (filled by the integration intake agent) pending
- Follow-ups: none needed, or folded into existing units (see the card)

## #157: Add an always-visible data credit line; fix ffopportunity's licence (F-08)

- Merged: 7:36 PM ET, Sep 22 as `7a9d75f6` (unit F-08)
- Intake: done: (filled by the integration intake agent) pending
- Follow-ups: none needed, or folded into existing units (see the card)

## #154: Docs: 2025 holdout ledger and one statistics contract for every unit (S-00)

- Merged: 7:26 PM ET, Sep 22 as `dd7cec20` (unit S-00)
- Intake: done: (filled by the integration intake agent) pending
- Follow-ups: none needed, or folded into existing units (see the card)

## #155: Study: grade the weekly fantasy construction against 2025, before availability (S-02)

- Merged: 7:16 PM ET, Sep 22 as `51b64512` (unit S-02)
- Intake: done: (filled by the integration intake agent) pending
- Follow-ups: none needed, or folded into existing units (see the card)

## #153: Model governance stops seeding PR #128's deleted MLB models as live

- Merged: 7:07 PM ET, Sep 22 as `34aa3d0e` (unit INT-128-1)
- Intake: done: (filled by the integration intake agent) Coordinator intake (7:15 PM ET, from the verify-pr skeptics). Upstream: model-governance.js seeds; no second producer. Downstream: no reader of MLB governance rows (skeptic grep); existing DBs keep their 13 MLB rows by the no-delete rule, invisible to every page. Reach: none needed. Links: none. Plan: closes INT-128-1. Follow-ups: INT-153-1, stale seed-count comments in test/w…
- Follow-up **INT-153-1** (queued): Stale seed-count comments after #153: test/wiring-map-deferred-edges.test.js:11-12 says 32/11 rows and ~59 says 43; now 22/8 and 30

## #152: The disk check wakes the live app before it looks

- Merged: 6:30 PM ET, Sep 22 as `d3dca8b6` (unit INT-149-1)
- Intake: done: (filled by the integration intake agent) CI only (coordinator intake, 6:31 PM ET). Upstream: same /api/health endpoint deploy.yml checks. Downstream: fly-preflight.yml now wakes the app before ssh (up to 6 tries). Reach: run before every migrating deploy. Links: SY review notes the 2 GiB threshold is copied from server/db/index.js:144, not read, so the two could drift apart; not queued (low value while they're equal)…
- Follow-ups: none needed, or folded into existing units (see the card)

## #151: Symbol-reach docs: namespace imports are no longer a blind spot

- Merged: 6:19 PM ET, Sep 22 as `ec336a2b` (unit INT-116-1)
- Intake: done: (filled by the integration intake agent) Docs only (coordinator intake, 6:31 PM ET). Upstream: n/a. Downstream: the evidence file symbol-reach.tdd.md now carries an addendum matching 116; the original paragraph is kept. Reach: read by whoever triages unused-in-code rows (kill list, D25). Links: none. Plan: closes INT-116-1. Follow-ups: none.
- Follow-ups: none needed, or folded into existing units (see the card)

## #150: Formations: stop calling this season's unpublished data a failure; add one-command backfill for finished seasons

- Merged: 5:47 PM ET, Sep 22 as `02a2475f` (unit R-02)
- Intake: done: (filled by the integration intake agent) 1. Upstream: Yes. ingestFormations / scripts/backfill-formations.mjs load nflplayformations through the existing writer, no new store (docs/tdd/2026-09-22-formations-404-skip.tdd.md §3: "Extend, no new store"). 2. Downstream: the in-season-404-is-a-skip fix is correct and covered (cycleOutcome, nfl-model-growth.js:168, TDD §2/§10.1). But one consumer was left on old behaviour,…
- Follow-up **INT-150-1** (queued): Run `scripts/backfill-formations.mjs` by hand — confirmed wired into no scheduler job or npm script (`git grep backfill-formations -- server/services/scheduler.js` and `package.json` both empty)
- Follow-up **INT-150-2** (queued): Team-vector re-freeze for formations: bump `WEEKLY_FEATURE_STORE_VERSION`, then re-freeze completed-season vectors only, per the exact 3-step command already written in `docs/tdd/2026-09-22-formations

## #94: The trade outcome ledger: what we predicted, stored next to what happened

- Merged: 5:37 PM ET, Sep 22 as `088bd652` (unit F-05)
- Intake: done: (filled by the integration intake agent) 1. Upstream: Yes. recordProposalSlate (server/services/trade-outcomes.js:321) is the only production writer and it stores what counterparty-pricing.js/manager-signals.js already compute at read time rather than a second copy (migration 067 header: git show origin/main:server/migrations/067outcomeledgers.js). 2. Downstream: correct and safe. recordProposalSlate's one caller (se…
- Follow-up **INT-94-1** (queued): Commit a local-copy end-to-end check for the proposals route + ledger, adapted from the uncommitted `scratchpad/f05-fix/e2e-proposer.test.mjs` (per §9a of `docs/tdd/2026-09-22-trade-outcomes-landing.t

## #149: A read-only check that the live disk has room for the migration snapshot before we deploy

- Merged: 5:26 PM ET, Sep 22 as `18650f23`
- Intake: done: (filled by the integration intake agent) 1. Upstream: n/a — CI workflow only, no app-code producer. 2. Downstream: n/a. 3. Reach: n/a — a GitHub Actions workflow, not a page. 4. Links: n/a. 5. Plan: supports F-16's deploy-delta checklist / N2 (next deploy + brake). 6. Follow-ups: confirmed the reported root cause and that it's still unfixed. gh run list --workflow=fly-preflight.yml: run 35786657095 (2026-09-22T21:26:…
- Follow-up **INT-149-1** (queued): Wake the Fly app before ssh: the workflow fails whenever the machine has auto-stopped

## #116: fix: symbol-reach misses namespace imports, so a reached symbol reads as dead

- Merged: 3:47 PM ET, Sep 22 as `d6d7bd5a`
- Intake: done: (filled by the integration intake agent) 1. Upstream: N/A — this is the producer. importersOfSymbol in scripts/symbol-reach.mjs now resolves import as ns, const ns = await import(...), and the .catch()-wrapped dynamic form, in addition to the named/destructured imports it already read (git show d6d7bd5a -- scripts/symbol-reach.mjs). 2. Downstream: clean. Every caller of importersOfSymbol is internal to scripts/symbol…
- Follow-up **INT-116-1** (queued): Fix the stale "namespace import" blind-spot claim for `importersOfSymbol` now that #116 resolves `import * as ns` / dynamic namespace imports

## #128: Remove MLB from the product, keeping every mlb_ table on disk

- Merged: 3:36 PM ET, Sep 22 as `bd56319b`
- Intake: done: (filled by the integration intake agent) 1. Upstream: N/A — pure removal. Confirmed dead symbols are fully gone, not just unwired: git grep -n "MLBPROPMARKETS\|PROPSCOST" -- '.js' → 0 hits anywhere on origin/main (matches test/mlb-removed.test.js's intent). 2. Downstream: clean everywhere the card flags, with one caveat resolved by inspection. - ONREQUESTTHREAD (card: 1 ref, "callers: none found") is not dead — it ne…
- Follow-up **INT-128-1** (queued): Remove or explicitly annotate the 13 stale `'MLB'` seed rows in `model-governance.js` for markets (`nrfi`, `pitcher_strikeouts`, `batter_total_bases`) whose model code #128 deleted

## #146: Ratchet the census the map's blind spot is reported in

- Merged: 3:26 PM ET, Sep 22 as `b74e3dc4`
- Intake: done: (filled by the integration intake agent) 1. Upstream: N/A — this is the producer (a ratchet over unresolvedReceivers, itself unchanged by this PR). 2. Downstream: wired correctly, including the part that could have broken CI. A ratchet needs a seeded baseline or every existing unresolved receiver reads as "new" and fails the build; this PR ships both the mechanism (receiverRatchet, receiverBaseline, preRegisteredEntr…
- Follow-ups: none needed, or folded into existing units (see the card)

## #118: A quarterback has no target share, and the page should not blame the data file for it

- Merged: 3:15 PM ET, Sep 22 as `35a61fe3`
- Intake: done: (filled by the integration intake agent) 1. Upstream: canonical producer, unchanged — still reads playerweekusage.targetshare for the one number this file owns (server/services/player-advanced-stats.js:219 area). No new copy of an existing number was computed; the change adds a second axis (unavailablekind: notapplicable | notmeasured) alongside the existing value/reason shape (git show 35a61fe3 -- server/services/pl…
- Follow-ups: none needed, or folded into existing units (see the card)

