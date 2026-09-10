# Folder and documentation reorganization for Claude

This is the implementation specification referenced by **CLAUDE-NEXT-STEPS.md**, not a second work queue. Follow that plan's priorities. The user requested the reorganization as instructions for Claude; **no source files have been moved or deleted by this audit**.

**Current implementation direction:** Nick subsequently instructed Codex to work directly on the Claude-local main branch. That supersedes the isolated-source-branch suggestions below. Keep tests on temporary databases, preserve completed audit evidence, and follow the completion state in the main plan. Physical folder moves and document deletions remain pending this checked migration.

## Current strategy scope: NFL spreads only

**All new betting strategy repairs, modeling, calibration, experiments, and end-to-end operating-loop work in this milestone are limited to pregame, full-game, ordinary NFL spreads.** Shared football/platform dependencies may be repaired only where required by that spread journey, with compatibility checks for their other consumers. Props, totals, moneylines, teasers, parlays, in-game betting, MLB, and fantasy strategy work are outside this milestone.

The user’s full-repository organization request and one-active-plan cleanup remain authorized. Keep the complete 761-file ownership map and documentation disposition. Start physical ownership cleanup with the spread path and its shared dependencies; organize other domains through behavior-preserving moves and import/path fixes. **Do not delete nonspread features, historical results, or research merely because they are outside the active strategy scope. Do not expand the milestone into new prop, teaser, MLB, or fantasy functionality or evidence gates.** Their existing behavior must remain compatible after relocation; their missing integrations may remain explicitly documented and deferred.

This scope takes precedence over broad domain/interface destinations in `folder-map.csv`: those rows describe where existing files belong, not which strategies to improve or activate. The CSV is deliberately not given a filename-based strategy-scope label; shared and mixed dependencies must be verified from real consumers. The one required complete new betting journey is the ordinary spread journey. Existing nonspread pathways receive basic nonregression checks when touched, not a requirement to build a new lifecycle for them.

## Outcome and boundaries

Leave exactly one active work-order document: **`docs/CLAUDE-NEXT-STEPS.md`**, installed from the supplied plan. Keep this companion as a subordinate reference at `docs/reference/architecture/FOLDER-REORGANIZATION.md`. Keep the supplied audit evidence as dated evidence. Delete superseded planning documents from the working tree after preserving their unique scientific contracts, measurements, and operating references. Do not retain the old queues as competing “active,” “next session,” “master,” or “consolidated” plans. Git already preserves the original files and their history.

This includes retiring `PROFITABILITY_EXECUTION_PLAN.md`; do not update it as another current queue. The user's “keep only ours” instruction applies to competing planning documents, not to experiment manifests, measured failures, source documentation, install instructions, or reproducible audit artifacts.

The audited local source is commit **`969d501e5d318f8ff650d7e239d8647f8b75eb84`**, seven commits ahead of the pulled GitHub state. The attached **[folder-map.csv](folder-map.csv)** contains the **761 audited baseline files plus 12 implementation additions, 773 tracked files total** after the model repair commit. Baseline rows retain their original source commit; added rows identify `fcf7e1f` or `3f19e25`. Each path has one disposition/destination. Installed plan/evidence rows remain in place, while original document rows still describe the pending consolidation. This is a complete path inventory, not a claim that every proposed semantic split has already been implemented or independently tested. Rows marked `proposed_owner_verify_import_graph`, `mixed_module_requires_extraction`, or `path_sensitive` require the named review before moving. Reconcile source changes after this commit into the manifest before execution; do not discard new local work.

Inventory: 356 server files, 115 client files, 161 test files, 38 root-script files, 15 research files, 54 files under `docs/`, 6 extension files, 2 macOS launchers, 2 Windows launchers, 1 `.claude` launch configuration, and 11 root files. The documentation disposition below covers all **54 docs files plus all four root Markdown files**. Five are superseded planning-only deletions; 24 require extraction/merging then deletion of the old file; 19 are preserved evidence; 10 are preserved operating references. Preservation can involve relocation; no measured result is erased to make the history look better.

## Target ownership tree

Keep current public API URLs and command names stable during the migration. A folder is an ownership boundary, not permission to activate a model.

```text
Gridiron-HQ/
├── README.md                         # install, run, orientation; links to our one plan
├── package.json / package-lock.json / tsconfig.json
├── .env.example / .gitignore
├── .claude/launch.json               # existing launch contract, no duplicate plan
├── .github/workflows/                # new bounded fixture CI; main plan section 16
├── install.sh / install.ps1          # stable install entrypoints
├── server/
│   ├── index.js                     # thin, stable bootstrap and router mounting
│   ├── platform/
│   │   ├── auth/ + http/             # shared auth, permissions, health, settings
│   │   ├── db/                      # SQLite owner, migration loader, seeds, schema
│   │   │   ├── migrations/          # original IDs/order/SQL semantics preserved
│   │   │   └── schema/ + seed/
│   │   ├── modeling/                # existing generic registry/contracts/governance
│   │   ├── jobs/                    # dispatch, workers, scheduling, report storage
│   │   ├── ai/                      # provider calls, budgets, generic explanation tools
│   │   ├── evidence/                # generic source metadata and provider transport
│   │   └── utils/                   # domain-neutral time/math/cache/path helpers
│   ├── football/
│   │   ├── identity/                # canonical players, teams, source crosswalks
│   │   ├── evidence/                # shared NFL facts, injuries, roster, PBP, news
│   │   ├── forecast/                # player/team event states and shared distributions
│   │   ├── evaluation/              # shared football calibration/evaluation adapters
│   │   └── http/                    # shared entity/data views
│   ├── fantasy/                     # preserve existing behavior; organization only
│   │   ├── draft/ + trades/ + lineup/
│   │   ├── forecast/                # fantasy points, season/league decisions
│   │   ├── evaluation/              # fantasy actuals, weekly replay and validation
│   │   ├── adapters/                # explicit market-context → fantasy crossings
│   │   └── http/
│   └── betting/
│       ├── nfl/
│       │   ├── evidence/            # quotes, contracts, cutoff/availability policy
│       │   ├── forecast/            # active spread repair; other heads preserved/staged
│       │   ├── strategy/            # ordinary spread policy/sizing active; others preserved
│       │   ├── execution/           # complete spread journey; other ticket paths preserved
│       │   ├── evaluation/          # spread CLV/audit active; other evidence retained
│       │   └── http/                # thin existing-URL adapters to these use cases
│       └── mlb/                     # first-party MLB/Diamond Signal; behavior-neutral moves
│           ├── evidence/ + forecast/ + strategy/ + execution/ + evaluation/ + http/
├── client/
│   ├── index.html / vite.config.ts / existing CSS/build configs
│   ├── public/draft-capture.js       # stable externally served capture URL
│   └── src/
│       ├── App.tsx / main.tsx / api.ts / navigation.ts / index.css
│       ├── shared/ui/               # common visual primitives, not betting logic
│       └── features/
│           ├── platform/            # data health, settings, pairing, model registry
│           ├── football/            # teams, player context, shared news
│           ├── fantasy/             # preserved draft/team/lineup/trade workflows
│           └── betting/
│               ├── shared/          # genuinely sport-neutral workspace primitives
│               ├── nfl/             # spread desk active; other NFL views preserved
│               └── mlb/             # preserved MLB pages + external props/slips
├── scripts/
│   ├── start.mjs / install.mjs / tunnel.mjs   # stable public wrappers
│   ├── platform/                    # packaging, smoke, lint, schema/DB commands
│   ├── football/                    # shared source imports and feature building
│   ├── fantasy/                     # fantasy fitting/audits
│   └── betting/nfl/ + betting/mlb/   # domain-specific audits and experiment runners
├── test/
│   ├── fixtures/                    # stable shared fixtures; explicit root resolution
│   ├── platform/ + football/ + fantasy/
│   ├── betting/nfl/ + betting/mlb/
│   └── integration/                 # journeys spanning multiple real boundaries
├── research/
│   ├── README.md / requirements.txt # independent offline Python environment
│   ├── common/                      # chronology, drift, model discipline
│   └── betting/nfl/                 # market/tree/book-lag/expert-selector experiments
├── assets/fantasy/                  # tracked analyst notes + draft audit signals
├── docs/
│   ├── CLAUDE-NEXT-STEPS.md          # THE ONLY ACTIVE WORK-ORDER PLAN
│   ├── reference/                   # current behavior/contracts/runbooks, no queues
│   │   └── architecture/            # ownership map, folder companion, interfaces
│   └── evidence/
│       ├── 2026-09-09/              # supplied audit evidence and dated scorecard
│       ├── historical/ + history/   # measured reports, failures and changes
│       ├── contracts/               # original frozen experiment/policy definitions
│       └── baselines/              # byte-preserved baseline manifests
├── runtime/                         # proposed UNTRACKED data root, later controlled migration
│   ├── db/ + backups/ + logs/ + cache/ + reports/ + experiments/
├── chrome-extension/                # retain deployable root and relative manifest assets
├── mac/                             # stable Install/Start launchers
└── windows/                         # stable Install/Start launchers
```

Some existing `server/platform` files should remain in place rather than move merely to fit an aesthetic tree. Keep thin `server/services/*` compatibility exports and the old DB import facade temporarily. The manifest records destination owners; a mixed service must be extracted before the wrapper is removed. Do not duplicate its business logic in old and new files.

## Concrete module-group moves and required crossings

| Current group | Target owner | What must happen beyond moving files |
|---|---|---|
| `server/db`, `server/migrations`, generic `server/modeling` | `server/platform/db`, `server/platform/modeling` | Preserve schema/migration identity and model artifact IDs; move the loader and its tests together; isolate league-specific context behind a fantasy adapter |
| `claude`, compute/report cache/worker, scheduler, source registry, generic math | `server/platform/{ai,jobs,evidence,utils}` | Generic scheduler dispatches the same use case as a manual button; domain jobs/report handlers register explicitly rather than fill the generic dispatcher with model logic |
| player/team IDs, nflverse/PBP/advanced data, roster state, shared news | `server/football/{identity,evidence}` | One chronology/identity contract for fantasy and NFL betting; source transport does not assign stake authority |
| `player-week-engine`, shared player heads, role changes, offseason player state and distributions | `server/football/forecast` | Football event distributions stay distinct from fantasy points and book-specific payoff probabilities; staged blend stays staged |
| draft/league/lineup/trade/waiver/season-sim and fantasy scoring | `server/fantasy` | Preserve ESPN/Sleeper and league-format behavior; put market-to-fantasy conversions behind named adapters |
| NFL quote tape, bitemporal, quote clock, exact contracts, provider feeds, pregame evidence | `server/betting/nfl/evidence` | Canonical contract and cutoff interfaces; wiring the bitemporal API is real work, not completed by its relocation |
| NFL ensemble, game/prop heads, calibrators, specialists/coordinator | `server/betting/nfl/forecast` | Each family has explicit active/staged/evaluation-only role; preserve artifact and training-cutoff identity; do not promote because it is now in a forecast folder |
| auto-pick selector, frozen policy, Kelly comparison/downsize, recommendation controls | `server/betting/nfl/strategy` | One authoritative server-side decision adapter; same policy for replay and serving; user-reported ticket entry remains independent of recommendation eligibility |
| lifecycle/pipeline/corridor/exposure, shopping, teaser execution, user-ticket adapters | `server/betting/nfl/execution` | Complete decision/contract/ticket lineage for ordinary spreads only; preserve other ticket paths and their behavior during moves. Cross-market ledger integration remains deferred. |
| CLV, forward/shadow ledgers, replay/audit, findings/model-growth, scorecards | `server/betting/nfl/evaluation` | Connect ordinary spread tickets to close, settlement and evaluation; preserve other markets’ historical evidence and current APIs without rebuilding their learning loops. |
| `server/routes/{nfl-betting,nfl-market,betting-hub,execution-slate}` | NFL `http` adapters, with actual logic in the owners above | Split mixed route files one endpoint family at a time; preserve URL/body/response compatibility until the UI is deliberately migrated |
| `mlb*.js`, routes `mlb`, `props`, `props-tickets` | `server/betting/mlb` | Generic `props` and saved slips refer to MLB Diamond Signal; never classify them as the missing NFL prop ticket loop |
| client NFL/MLB betting pages; fantasy pages; shared entity components | matching `client/src/features` owners | Keep `navigation.ts` as the existing shared sidebar/command-palette registry; stable URLs; verify hidden/deep links and responsive views |
| root/server scripts and Python labs | domain scripts; offline `research` | Keep npm commands stable via wrappers; update subprocess paths, Python imports and outputs; research must not start running inside serving imports |
| tracked `server/data/{analyst-notes-2026,draft-audit-signals-2026}.json` | `assets/fantasy` | Preserve source/date/hash and reader paths; these are tracked assets, unlike live SQLite, secret launcher keys and generated experiment output |

Statically proposed ownership in the CSV must be checked against actual imports, dynamic imports, route registrations, SQL ownership, job registrations and output consumers. Several files are intentionally shared despite an `nfl-` prefix. Do not decide ownership from prefixes alone. Conversely, `model-governance` and generic model registry should not be copied into both fantasy and betting. A common interface may live in platform while the domain-specific evaluator lives with its domain.

The line review corrected concrete ownership errors in the CSV: Trade Lab verification belongs to fantasy trades; draft capture belongs to fantasy HTTP; team tendencies and shared player availability belong to football evidence. `PickReasoning.tsx` describes NFL betting but has no current client importer; preserve that orphan classification without activating it. Split the generic metrics in `backtest.js` from its fantasy actuals/scoring, and the generic statistical primitives in `player-head-validation.js` from its fantasy replay/audit orchestration. Existing `weekly-backtest.js` belongs to fantasy evaluation. Keep compatibility exports and shared numerical behavior unchanged; these are organization corrections, not new fantasy/prop research tasks.

## One plan; exact disposition of the existing documents

Definitions:

- **Delete superseded planning:** remove the old work-order/specification file. Before removal, confirm there is no unique experiment contract or required behavior trapped only there; extract such content into evidence/reference, not another plan.
- **Migrate content then delete:** extract the specified valuable facts/contracts/reference material, verify completeness, then delete the old source document. Do not retain its active checklist or scheduling commands under an archive title.
- **Preserve evidence:** keep measured reports and manifests with date/version/provenance. Frozen manifests keep byte-identical contents and hashes. Mark historical recommendations as historical in the evidence index, not as instructions to execute today.
- **Preserve operating reference:** keep concise actual behavior, API, sources, installation, and runbooks. Correct obsolete path references; strip duplicate build queues. Reference documents never establish new spending, model promotion or task priority.

The table below includes every tracked file under `docs/` and every root Markdown file at the audited commit. Destination paths are repo-relative. Where several old files feed the same reference, merge facts by provenance and avoid creating several copies of the same rules. A document named `*-original` under evidence/contracts stores the immutable historical experiment contract, not a future task plan.

| Current file | Disposition | Destination / content to preserve |
|---|---|---|
| `CLAUDE_FEEDBACK.md` | Migrate content then delete | `docs/evidence/history/platform-audit-implementation-2026-09-08.md`. Keep completed fixes, verification and rollback facts; remove not-started queue; older plan authority deleted. |
| `CODEX_SUGGESTIONS.md` | Migrate content then delete | `docs/evidence/historical/platform-audit-2026-08-24-findings.md`. Keep dated observed defects and scope, linked to corrected/completed status; remove proposed backlog, phase plans and instructions; no duplicate product roadmap. |
| `MODEL_OPERATIONS.md` | Preserve operating reference | `docs/reference/model-governance.md`. Merge actual protocol/endpoints/registry rules with extracted manual invariants; not an active work queue; dated frozen gates remain separately versioned contracts. |
| `README.md` | Preserve operating reference | `README.md`. Keep install/run/product orientation; point only to CLAUDE-NEXT-STEPS as work plan and to evidence/reference index; remove links that confer authority on deleted queues. |
| `docs/ADP_DISAGREEMENT.md` | Preserve evidence | `docs/evidence/historical/ADP_DISAGREEMENT.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/ADP_REPRICE_LATENCY.md` | Preserve evidence | `docs/evidence/historical/ADP_REPRICE_LATENCY.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/AI_MODEL_OPERATING_MANUAL.md` | Migrate content then delete | `docs/reference/model-governance.md`; `docs/evidence/historical/ai-manual-measurements.md`. Extract still-valid operating invariants and dated measurements, preserve frozen contracts; remove entire old active queue and duplicate mission/next-step authority. |
| `docs/ANALYST_CONSENSUS_2026_09_06.md` | Preserve evidence | `docs/evidence/historical/ANALYST_CONSENSUS_2026_09_06.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/ARCHITECTURE_MODEL_VS_FANTASY.md` | Migrate content then delete | `docs/reference/architecture/domain-ownership.md`. Revalidate importer-based classifications into current ownership map; remove old prohibition on physical moves; original stays recoverable in Git. |
| `docs/BEAT_THE_CLOSE_PLAN.md` | Migrate content then delete | `docs/evidence/contracts/beat-the-close-original.md`. Preserve original preregistered hypothesis, data cutoff, metrics and gates tied to experiments; delete old execution phases and checklist; future experiment governed only by ours. |
| `docs/BETTING_CAPABILITY_AUDIT.md` | Migrate content then delete | `docs/evidence/historical/BETTING_CAPABILITY_AUDIT-evidence.md`. Extract dated feasibility, verified inventory/results and limits; remove speculative build queues and present-day authority claims from old file. |
| `docs/BETTING_EXECUTION_REASONING.md` | Migrate content then delete | `docs/reference/betting/execution-slate.md`; `docs/evidence/historical/execution-slate-measurements.md`. Preserve actual interfaces and latency/test evidence; correct proven-edge claims; remove implied authority to stake from source type. |
| `docs/BETTING_PLAYER_ENGINES.md` | Preserve evidence | `docs/evidence/historical/BETTING_PLAYER_ENGINES.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/BUILD_ORDER.md` | Migrate content then delete | `docs/evidence/historical/build-order-measurements.md`. Retain unique measured stage outcomes not already in STAGE results; remove all stage queue/order instructions; our plan is sole order. |
| `docs/CONSENSUS_WEIGHTS.md` | Preserve evidence | `docs/evidence/historical/CONSENSUS_WEIGHTS.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/DIAGNOSTIC_2026_09_02.md` | Preserve evidence | `docs/evidence/historical/DIAGNOSTIC_2026_09_02.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/DRAFT_ADVICE_VERIFY_LOOP.md` | Preserve operating reference | `docs/reference/fantasy/DRAFT_ADVICE_VERIFY_LOOP.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/DRAFT_AUDIT_2021_2025.md` | Preserve evidence | `docs/evidence/historical/DRAFT_AUDIT_2021_2025.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/DRAFT_BOARD_ABSTENTION.md` | Preserve evidence | `docs/evidence/historical/DRAFT_BOARD_ABSTENTION.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/DRAFT_CAPTURE.md` | Preserve operating reference | `docs/reference/fantasy/DRAFT_CAPTURE.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/DRAFT_CAPTURE_EXTENSION.md` | Preserve operating reference | `docs/reference/fantasy/DRAFT_CAPTURE_EXTENSION.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/DRAFT_LOOKAHEAD_VARIANCE.md` | Preserve evidence | `docs/evidence/historical/DRAFT_LOOKAHEAD_VARIANCE.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/DRAFT_ON_PHONE.md` | Migrate content then delete | `docs/reference/fantasy/draft-device-runbook.md`. Retain reusable laptop/phone/recovery instructions; delete expired September 7 agenda and time-specific task plan. |
| `docs/DRAFT_RANKER_THEORY_REVIEW_2026_09_06.md` | Preserve evidence | `docs/evidence/historical/DRAFT_RANKER_THEORY_REVIEW_2026_09_06.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/LIVE_BETTING_FEASIBILITY.md` | Migrate content then delete | `docs/evidence/historical/LIVE_BETTING_FEASIBILITY-evidence.md`. Extract dated feasibility, verified inventory/results and limits; remove speculative build queues and present-day authority claims from old file. |
| `docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md` | Migrate content then delete | `docs/evidence/historical/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08-evidence.md`. Extract dated feasibility, verified inventory/results and limits; remove speculative build queues and present-day authority claims from old file. |
| `docs/MODEL_AUDIT_RUN_7.md` | Preserve evidence | `docs/evidence/historical/MODEL_AUDIT_RUN_7.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/MODEL_ROADMAP.md` | Migrate content then delete | `docs/evidence/historical/model-diagnostic-2026-08-26.md`; `docs/reference/architecture/forecast-contracts.md`. Extract baseline measurements and valid implemented contracts; discard old target/priority roadmap. |
| `docs/NEXT_SESSION_PLAN.md` | Delete superseded planning | Superseded ordered work queue; preserve any unique frozen experiment contract via the linked experiment registry before deletion, never preserve as another active plan. |
| `docs/NFL_AUDIT_RUN_8_MANIFEST.json` | Preserve evidence | `docs/evidence/NFL_AUDIT_RUN_8_MANIFEST.json`. Preserve bytes and content hash; scientific evidence/artifact, not a planning document. |
| `docs/NFL_MODEL_STATUS.md` | Migrate content then delete | `docs/evidence/historical/nfl-model-status-through-2026-08-30.md`. Preserve dated baseline/test results; current status is generated from actual evidence; remove strategy predictions and stale authority. |
| `docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md` | Migrate content then delete | `docs/evidence/contracts/research-packages-2026-09-08.md`; `docs/evidence/historical/research-packages-initial-results.md`. Extract original package test contracts and actual results; remove all agent assignments/queues; update runtime plan reader to our plan before deleting old file. |
| `docs/OFFSEASON_DATA.md` | Preserve operating reference | `docs/reference/fantasy/OFFSEASON_DATA.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/OFFSEASON_MODEL.md` | Preserve operating reference | `docs/reference/fantasy/OFFSEASON_MODEL.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/PATH_TO_PROFIT.md` | Migrate content then delete | `docs/evidence/historical/path-to-profit-measurements.md`. Keep uniquely measured spreads/teasers/shopping facts with corrected scope; discard prediction-dead-end/proven-profit conclusions and phased queue. |
| `docs/PHASE_3_5_BETTING_HUB.md` | Delete superseded planning | Superseded feature/build specification and work order; implemented behavioral constraints already belong in code/tests or current reference docs, not an old phase plan. |
| `docs/PHASE_4_PREDICTION_ENGINE.md` | Delete superseded planning | Superseded feature/build specification and work order; implemented behavioral constraints already belong in code/tests or current reference docs, not an old phase plan. |
| `docs/PLAN_2026_09_07.md` | Migrate content then delete | `docs/evidence/historical/session-results-2026-09-07.md`. Keep dated completed changes, results and declines; delete expired draft-night agenda and next-action instructions. |
| `docs/PRESEASON_BAND_CALIBRATION.md` | Preserve evidence | `docs/evidence/historical/PRESEASON_BAND_CALIBRATION.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/PRESEASON_MODEL.md` | Preserve operating reference | `docs/reference/fantasy/PRESEASON_MODEL.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/PROFITABILITY_EXECUTION_PLAN.md` | Migrate content then delete | `docs/evidence/historical/execution-work-through-2026-09-08.md`. Keep verified commit/result/coverage/spend history with correction notes; DELETE active queue, stale scheduler assumptions and nothing-further instructions. Do not keep this as current plan. |
| `docs/PROFITABILITY_PLAN.md` | Migrate content then delete | `docs/evidence/contracts/profitability-policy-v1.3.md`; `docs/evidence/historical/profitability-baselines.md`. Freeze original experiment/gate definitions with version and hash; preserve measurement facts; delete 1101-line duplicate roadmap. Update runtime source pointers without changing frozen historical policy IDs. |
| `docs/PROFIT_ROADMAP.md` | Delete superseded planning | Superseded consolidated queue and timing promises; substantive experiment contracts preserved from original specifications; retain no duplicate roadmap. |
| `docs/PROPS_PLAYER_ENGINES.md` | Preserve evidence | `docs/evidence/historical/PROPS_PLAYER_ENGINES.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/PROPS_PLAYER_ENGINES_WEEKLY.md` | Preserve evidence | `docs/evidence/historical/PROPS_PLAYER_ENGINES_WEEKLY.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/RESEARCH_ADOPTABLE_CODE.md` | Migrate content then delete | `docs/reference/research/RESEARCH_ADOPTABLE_CODE.md`. Keep source URLs, retrieval dates, protocol findings and license caveats; delete ranked future-action lists; no implied approval to ingest or vendor. |
| `docs/RESEARCH_OPEN_SOURCE_FANTASY.md` | Migrate content then delete | `docs/reference/research/RESEARCH_OPEN_SOURCE_FANTASY.md`. Keep source URLs, retrieval dates, protocol findings and license caveats; delete ranked future-action lists; no implied approval to ingest or vendor. |
| `docs/RESEARCH_PLATFORM_INTEGRATIONS.md` | Migrate content then delete | `docs/reference/research/RESEARCH_PLATFORM_INTEGRATIONS.md`. Keep source URLs, retrieval dates, protocol findings and license caveats; delete ranked future-action lists; no implied approval to ingest or vendor. |
| `docs/RESEARCH_UI_PATTERNS.md` | Migrate content then delete | `docs/reference/research/RESEARCH_UI_PATTERNS.md`. Keep source URLs, retrieval dates, protocol findings and license caveats; delete ranked future-action lists; no implied approval to ingest or vendor. |
| `docs/STAGE_1_RESULTS.md` | Preserve evidence | `docs/evidence/historical/STAGE_1_RESULTS.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/STAGE_2_RESULTS.md` | Preserve evidence | `docs/evidence/historical/STAGE_2_RESULTS.md`. Keep dated measured results, failures, limitations and original provenance; embedded next steps are historical, not authority. |
| `docs/TRADE_LAB_VERIFY_LOOP.md` | Preserve operating reference | `docs/reference/fantasy/TRADE_LAB_VERIFY_LOOP.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/UI_REVAMP.md` | Delete superseded planning | Superseded feature/build specification and work order; implemented behavioral constraints already belong in code/tests or current reference docs, not an old phase plan. |
| `docs/WEEKLY_DATA_AND_2022_2025_REBUILD.md` | Preserve operating reference | `docs/reference/football/WEEKLY_DATA_AND_2022_2025_REBUILD.md`. Keep implemented behavior, APIs, source contracts and reproduction instructions; date empirical claims; remove stale work-order instructions. |
| `docs/WHERE_WE_ARE.md` | Migrate content then delete | `docs/evidence/historical/status-narrative-2026-09-02-facts.md`. Extract unique dated measurements only; remove stale present-tense claims and path-to-profit work order; user summary becomes generated current state. |
| `docs/WORK_LOG.md` | Migrate content then delete | `docs/evidence/history/WORK_LOG.md`. Preserve dated changes/results as history; remove active next-session queues and old rules retaining multiple plans; log is a record, not authority. |
| `docs/baselines/2025-baseline-pre-stage1.json` | Preserve evidence | `docs/evidence/baselines/2025-baseline-pre-stage1.json`. Preserve bytes and content hash; scientific evidence/artifact, not a planning document. |
| `docs/baselines/2025-baseline.json` | Preserve evidence | `docs/evidence/baselines/2025-baseline.json`. Preserve bytes and content hash; scientific evidence/artifact, not a planning document. |

`client/src/pages/betting/TERMINOLOGY.md`, `research/README.md`, `server/db/schema/README.md`, and `server/modeling/ARCHITECTURE.md` also appear in the full manifest. Keep their operating/reference purpose and update their final paths; they are not independent work queues. The MLB terminology split must reflect the actual content, not force generic betting terms into one sport.

## Execution sequence

### 1. Install our plan and retire competing planning documents first

Copy the provided main plan into `docs/CLAUDE-NEXT-STEPS.md`; place its evidence and this companion in the target locations above. Link them from README. Use the documentation disposition table as a checked migration list. Each extraction should record old source path, source commit/blob hash, retained section identifiers, destination, and reviewer verification. Prefer a few coherent references/evidence indexes over one new file for every old paragraph.

Install `folder-map.csv` beside this companion under `docs/reference/architecture/`, and install `AUDIT-EVIDENCE.md` and `AUDIT-VERIFICATION.zip` under `docs/evidence/2026-09-09/`. Rewrite the supplied output-folder links to the correct repository-relative links when installing them. The current Codex output paths are delivery locations, not permanent runtime dependencies. Include these newly installed files in the reconciled migration manifest. Follow main-plan sections 12.2–12.4 for the deliberately small GitHub dependency shortlist and section 16 for branch ancestry, isolated development, and CI. New workflow and generated-test files must also be added to the manifest; the baseline 761 rows describe the audited source, not files proposed later.

Do **not** copy entire old queues into an “archive of plans.” The user specifically wants those competing plans gone. Preserve original scientific contracts and measured results; Git retains the complete original text if historical reconstruction is needed. Historic results must retain the policy/version they actually used, not be retroactively assigned today's plan.

Update these concrete consumers in the same change:

- `server/services/nfl-research-lab.js:272` currently reads **`docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md`** to serve the research plan. Change the reader to our plan's stable configured path. Keep its existing route/API compatible. Test the endpoint from the normal start command and a packaged install; it must return the installed current plan after the old file is removed.
- `server/services/nfl-policy.js:34` currently cites **`PROFITABILITY_PLAN.md §2 Market-edge gates`** as source metadata. Preserve that versioned historical gate contract under evidence/contracts, update the reference, and retain the frozen policy values/IDs used by historical runs. A path cleanup must not silently change the 200/75 thresholds or claim old experiments used new gates.
- Search runtime readers, package/release copy lists, tests and docs for old planning paths. Fix executable readers/tests and current navigational links. Historical quote/citation references may resolve through a migration index containing the original Git source path/blob, instead of recreating deleted planning files.
- Replace hardcoded Research Lab package status strings and dated counts with the shared status read model described in the main plan. The plan endpoint is not the live status database.

Acceptance: one plan endpoint, one README work-plan link, no deleted-plan filesystem read, no current “follow these phases first” instruction outside our plan. Grep results alone are insufficient: exercise the actual reader. Audit manifests and dataset hashes remain intact.

### 2. Inventory the runtime and define path resolution before moving executable files

Extend `folder-map.csv` for any commits/new files since the audited snapshot. Record **tracked source** separately from **ignored live state** and **untracked user material**. The manifest covers tracked files only; it does not authorize deletion of scratchpad experiments, personal data, `.env`, logs, keys, live databases, generated reports, downloaded feeds, or worktrees.

Create one tested application path resolver for project root, database, assets, report/artifact directories, model outputs and current plan. Avoid deriving the project root by assuming a fixed number of `../` segments from every moved module. Support an explicit configured data root and preserve legacy defaults until the runtime migration is complete. Directory changes must not accidentally open a new empty SQLite file and appear to lose the user's data.

Capture a read-consistent database backup and inventory runtime outputs **without modifying the active app**. A running blind audit has frozen source and data scopes; use an isolated working branch/checkouts and database snapshot. Do not edit files watched by its live server or rebaseline its manifest midway through a run. Treat future code layout as a new code version; prior completed evidence keeps the original manifest.

### 3. Move platform foundations with compatibility exports

Move neutral helpers and the generic platform boundary in small coherent changes. Keep `server/index.js` and public launcher/script commands stable. Introduce compatibility exports only where needed, with named owners and a removal condition. Do not maintain two SQLite connection instances, two scheduler loops, two model registries or duplicate ingestion jobs under the old and new paths.

Database/schema specifics:

- Move the migration loader and its discovery paths with tests. Preserve migration names, order, up/down SQL behavior, seed values and existing `schema_migrations` history. Permit only reviewed import-path relocation edits where necessary, recording original/new source hashes and proving equivalent schema behavior; never change historical SQL to implement a new feature. After moving `000_legacy_schema.js` under `platform/db/migrations`, its four schema imports must resolve to `../schema/...`, not `../db/schema/...`. Update loader discovery and the baseline import in the DB owner together. Preserve the original source in Git and historical evidence; do not rewrite old audit hashes.
- Update schema-file manifests and `scripts/schema-files.txt`, schema-snapshot tooling, seeds and worker imports. Compare pre/post schema on a fresh database and a copy of an existing migrated database.
- Existing service imports currently resolve through `server/db/index.js`. Keep a single re-export facade until every path is updated; do not let compatibility create another connection or run migrations twice.
- Maintain isolated `GRIDIRON_DB_PATH` behavior. Tests and offline research must never fall back to the live default because a relative path changed.

Acceptance: normal app boot, isolated test DB, migration on fresh and copied existing DB, matching migration names/counts and schema fingerprints, no double migration, and health/report reads. No extra scheduler starts or unexpected API spend on import.

### 4. Establish shared football boundaries; preserve fantasy behavior

Move one shared event/identity/evidence group, then its consumers. Preserve the single player-week engine and explicit fantasy scoring adapters. The existing model-versus-fantasy reference is useful source material, but it predates several additions; revalidate consumers rather than treating its 202-file classification as current truth.

Keep drafts, trades, league formats, start/sit, capture, and external platform integrations functioning. A service used by both fantasy and betting belongs in shared football or a deliberately neutral platform layer, not copied into two trees. A source used to inform both products is shared data; each product's eligibility and decision policy remain separate.

Acceptance: spread-dependent shared identity/data/distribution checks pass. For touched fantasy consumers, fixed-input output and basic draft/trade/forecast compatibility remain unchanged by pure moves. This is a nonregression check, not a new fantasy-model evaluation or improvement project.

### 5. Move NFL betting around the ordinary spread journey

Follow the main plan’s integrity fixes and interfaces while moving the pregame, full-game, ordinary NFL spread journey from evidence through evaluation. Its routes call the new owners but retain external URLs. Extract the mixed giant routers incrementally; a temporary thin router aggregator is acceptable. Existing prop, total, moneyline, teaser, in-game, and other paths may move to their ownership folders with behavior-preserving compatibility adapters. Do not add missing integrations, change their models/policies, or require new complete journeys for those paths in this milestone.

The all-file manifest is an eventual destination proposal. Do not move hundreds of model files in one unreviewable commit or declare every domain integrated because its folder exists. Model families may remain evaluation-only or staged. The new staging folders must not import Python search jobs or heavy training into request startup.

Acceptance: the ordinary NFL spread candidate fixture traces through quote refresh, paper/user-recorded classification, exact settlement, separate compatible-close evaluation and scorecard with stable IDs. The abstention fixture ends at its persisted decision; both survive restart. Real captures accumulate under the main plan’s research/paper classifications; a real selected candidate or finished game is not required to verify the software, and synthetic records never become prospective evidence. A valid ticket settles even when its closing quote is missing. An already-placed off-policy spread ticket remains recordable without recommendation authority. Manual and scheduled spread adapters use the same implementation. Existing nonspread routes still load and retain their prior behavior; no new prop/teaser/MLB lifecycle is required. NFL spread metrics exclude all other markets.

### 6. Move client features without breaking navigation or capture

The sidebar and command palette already share `client/src/navigation.ts`; preserve that solution. Move feature pages/components by domain and update static and lazy/dynamic imports in `App.tsx` and related files. Preserve route URLs, deep links, browser-history behavior, saved IDs, and page-state semantics. Split generic `props` pages into explicit MLB ownership, while NFL props stay under NFL.

Keep `client/public/draft-capture.js` at its public URL unless a compatibility route is deliberately provided. Check `chrome-extension/manifest.json`, background/content/injected scripts, popup assets, localhost ports, CORS/auth handshakes, and bookmarklet-generated URLs. The extension root can remain where it is; moving it adds deployment risk without repairing model ownership.

Acceptance: build/typecheck, open every registry route, load deep links directly, exercise command palette and phone layout, verify source/status/positions views, and run the draft-capture handshake fixture without opening a real draft or sending production actions.

### 7. Update scripts, workers, Python packages and test discovery together

The current test command is `node ... --test --test-concurrency=1 test/*.test.js`. Moving tests into subdirectories without changing this command **silently drops coverage**. Introduce deterministic recursive discovery or explicitly enumerated suite globs. Compare the complete test-file list before/after; fixture moves must not cause skipped or missing tests. The audited test tree contains 146 Node test files and 15 fixture assets, not 161 runnable tests; reconcile later additions separately. Keep performance/paid-API tests excluded or isolated by the same explicit rules.

The current package scripts reference root `scripts/*.mjs`, `server/scripts/sync-history.js`, `client/vite.config.ts`, and `server/index.js`. Update implementation paths or retain stable wrapper entrypoints. Update lint scanning, build input/outputs, TypeScript includes, schema tools, background worker URLs, child-process working directories, release packaging, install scripts, macOS/Windows launchers and `.claude/launch.json` together. A source filename mentioned only in a comment is a different problem from a runtime `readFile` or `new Worker(new URL(...))`.

Update the release packager's explicit exclusions or use an allowlisted source manifest. `scripts/package-release.mjs` currently has a non-Git filesystem-walk fallback; `.gitignore` does not protect that fallback, and its exclusions do not include the proposed `runtime/`. Exclude configured/default runtime roots, SQLite/WAL/SHM/backups, credentials, logs, caches and downloaded user data in both Git and non-Git packaging paths. Test both with dummy secret/database/report sentinels and inspect archive entries. Preserve the installed plan, approved evidence/references, required static model assets and public draft-capture script; do not bundle live audit/user data.

Python labs currently live at `research/*.py`. If moving to `research/common` and `research/betting/nfl`, add explicit package/import handling and update Python test discovery and CLI entrypoints. Keep the existing environment/requirements and content-hashed data/report interchange. Verify the app's Research Lab readers still find market/tree/book-lag/expert/news reports under the configured runtime root. Do not rerun expensive experiments merely to test a move; use small frozen fixtures and compare result-schema readers.

Acceptance: before/after discovered test-file counts agree, all relevant tests pass, typecheck/lint/build/start-smoke pass, a representative worker and each Python CLI start on fixtures, report readers work, and packaged launch commands resolve paths on both platform layouts. Git and non-Git release archives contain required installed files and exclude every dummy runtime/private-data sentinel. Source-only import graph tests must not accidentally execute network/paid services.

### 8. Migrate ignored runtime state separately, only after compatibility works

The proposed `runtime/` tree is not permission to move the live DB with a file copy. Existing ignored state includes `server/data.sqlite` and WAL/SHM/backups, launcher secrets/logs under `server/data`, generated model-lab/evidence/report folders, Python virtual environments/caches, `.env`, scratchpad and worktrees. Preserve this state and keep it untracked.

For an eventual controlled data-root migration: stop or safely coordinate writers, use SQLite's supported consistent backup mechanism, verify integrity and schema/row counts, preserve all related artifacts, point one configured runtime root at the verified copy, and boot against that explicit copy. The old root stays recoverable until successful verification; no destructive cleanup is part of the source folder move. Refuse ambiguous roots or unexpected empty DBs. Preserve dataset/report hashes and allow old artifact paths to resolve through a manifest/adapter. Update `.gitignore` before generating any new runtime files so credentials and user data cannot enter Git.

### 9. Remove compatibility shims and obsolete plans only after checks

Use an explicit checked allowlist from the manifest for tracked-file removals. Inspect the current Git diff and uncommitted contents before deletion. If a listed planning document gained unique results or an active experiment contract, extract them first and record where they went. Do not wildcard-delete `docs/`, remove untracked files, run a blanket clean, or reset user work.

For each small change, inspect the staged diff: expected renames/extractions/deletions only, no secrets, runtime data, lost evidence or accidental model changes. Git history provides the original planning text; a rollback can restore a specific file/commit without resurrecting it as today's authority. Remove a compatibility shim only when static and dynamic consumers, package scripts, jobs, UI, tests and report readers have moved. Keep an explicit final migration report showing what remains temporarily and why.

## Definition of done

1. Only our main document is an active work-order plan. Old active queues are deleted, not maintained in parallel. Valuable measured evidence, original experiment contracts and operating references remain discoverable.
2. The plan API/UI reads our plan after the old master-plan file is gone. Runtime references and tests no longer depend on deleted queue paths.
3. All 761 baseline tracked files have a disposition, and every later tracked addition is reconciled. Ambiguous mixed modules have a concrete owner and extraction result, not an unexplained “misc” destination.
4. A component's location, consumers, evidence state and money authority are explicit. An evaluation-only or staged component is deliberately isolated, not silently activated to make the graph look connected.
5. Source relocation has not changed frozen predictions or settlement arithmetic unintentionally. Deliberate model/bug fixes have their own before/after evidence in the main plan's work packages.
6. Every required test remains discovered. Imports, dynamic paths, scripts, worker starts, migrations, schemas, packaging and both desktop launchers resolve correctly.
7. The pregame full-game ordinary NFL spread journey and spread user-bookkeeping journey reconcile across quotes, decisions, tickets, exposure, close, settlement and evaluation. Touched nonspread, fantasy and MLB surfaces pass basic compatibility/nonregression checks; building their missing integrations is not a completion condition.
8. No live database, user data, credential, report history or failed experiment was erased or committed by the reorganization. The current running audit's source/data freeze was preserved.

Deliver the final folder manifest, documentation migration ledger, concise dependency/ownership diagram, compatibility list and validation results alongside the implementation. The result must be easier to navigate **and** correctly wired; moving names around without establishing these boundaries is incomplete.
