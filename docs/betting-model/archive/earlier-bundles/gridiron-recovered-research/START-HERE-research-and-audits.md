# Gridiron: recovered research and line-by-line audits

The research and audit files were found. Much of the material was in Claude's temporary session scratchpad, outside the repository's `docs/` folder. It is now preserved in `recovered-evidence/` beside this index and in the recovery ZIP.

This is the evidence base for continuing the **betting model**. Old fantasy-first priorities in these documents are superseded by the user's current betting-only scope. Original findings describe their audit date; they are not automatically still-open defects.

## The exact audits you asked for

- [Full System Audit](recovered-evidence/audit/SYSTEM_AUDIT_2026_09_11.md): the large synthesis, roughly 118 KB. Despite its filename, its opening states an audit date of September 12. It describes 20 code groups plus six history groups, with detailed file/line references.
- [Audit Completeness Critique](recovered-evidence/audit/COMPLETENESS-CRITIC.md): essential companion. It flags partial reads and missing/overwritten primary notes behind some claims of complete line-by-line coverage. Preserve the audit's evidence, but do not repeat its universal coverage claim as established fact.
- [Audit-System Review](recovered-evidence/audit-system/AUDIT_SYSTEM_REVIEW.md): roughly 85 KB specifically examining backtests, blind audits, decision ledgers, timing, and the distinction between the model evaluated and the model served. Its September 12 verification reports 22 confirmed and nine refuted findings among G01–G31; G32–G37 were unverified. Those are historical verdicts, not today's open-bug count.

There are **59 Markdown documents in the full-audit folder** and **41 in the audit-system folder**. The detailed notes and rebuttals survive, not just the summaries.

## Betting/ML sections to read first

| Topic | Primary audit notes |
|---|---|
| Main NFL model | [G05 core model](recovered-evidence/audit/G05-nfl-core-model.md) and its `-verify` companion |
| Council, learners and research | [G06 council/research](recovered-evidence/audit/G06-nfl-council-research.md) and verification notes |
| Python ML labs | [G18 Python research](recovered-evidence/audit/G18-research-python.md), roughly 76 KB, plus its verification |
| Simulators/strategies | [G07 simulation](recovered-evidence/audit/G07-nfl-sim-strategy.md); coverage caveats apply |
| Betting execution | [G08 execution](recovered-evidence/audit/G08-nfl-execution.md) |
| Quotes and market data | [G09 market data](recovered-evidence/audit/G09-market-data.md) |
| Evidence and backtests | [G10a audit evidence](recovered-evidence/audit/G10a-audit-evidence.md), [G10b replay/learning](recovered-evidence/audit/G10b-replay-learning.md) |
| News and AI facts | [G12 news](recovered-evidence/audit/G12-news.md) |
| Data coverage | [H06 data layer](recovered-evidence/audit/H06-data-layer.md) |
| Betting display versus actual behavior | [G16 betting client](recovered-evidence/audit/G16-client-betting.md) |
| Plans versus implementation | [G19 plan/code comparison](recovered-evidence/audit/G19-docs-plan-vs-code.md) |

## The research collection

The **70-document research2 collection** includes 56 main topic reports, two architecture/code catalogs, and 12 scoring-note documents:

- **F01–F18:** forecast combination, point-in-time data, multiple testing, sequential inference, Bayesian ratings, shrinkage, conformal calibration, margin distributions, copulas, news causality, and related foundations.
- **GF01–GF10:** simulation, ratings, Bayesian Stan/PyMC, backtesting, Kelly/de-vigging, dependence, entity resolution, conformal and trial-registry code catalogs.
- **N01–N18:** foundation models, graph networks, play-sequence transformers, LLM forecasting, reinforcement learning, synthetic data, mixture-density models, AutoML, expert councils, injury networks, weather and sentiment.
- **GN01–GN10:** adoptable code for those newer capabilities.
- [Fix and Add Architecture](recovered-evidence/research2/FIX_AND_ADD_ARCHITECTURE.md), roughly 60 KB.
- [GitHub Build Catalog](recovered-evidence/research2/GITHUB_BUILD_CATALOG.md), roughly 47 KB.

The separate September 14 learned-model sweep adds **14 research reports and 13 verification reviews**, including explicit corrections to unsupported claims. Its open-source-model survey lacks a completed verification result. The broader scale sweep never returned completed reports in its journal.

An earlier script titled “35-agent PhD-level research sweep” was also found. Its expected `research/` report directory contains no completed Markdown reports, and its workflow journal contains no completed results. That planned sweep should not be counted as 35 delivered reports. Its later research2 replacement is substantial and survives.

**81 source-paper/reference files** were preserved from the paper directories. This count includes PDF and extracted-text versions of some of the same papers; it is not 81 unique papers. Cloned code repositories remain at their original paths and were not copied into the archive.

## Combined plans and later reviews

- [The Giant Plan](recovered-evidence/plans/GRIDIRON_GIANT_PLAN.md), roughly 182 KB: merged research, defects and implementation plan.
- [What Next](recovered-evidence/plans/WHAT_NEXT.md), roughly 90 KB: later reconciliation and remaining work, including betting architecture, news timing and execution.
- Both September 12 master-plan versions are preserved in `recovered-evidence/plans/`.
- Six later sweep notes cover models, news, research, audits, GitHub and editing.
- Completed workflow results were also recovered: 119 full-audit outputs, 122 research-and-add outputs, 45 audit-system outputs, and the two smaller “why not improving / why worse than market” investigations. These counts include verification, judging and synthesis stages, not that many independent topic studies.

The smaller investigations contain superseded or contradictory statements. For example, one calls raw historical replay the live path, while current code and decision records establish market-residual production; another describes the exponential weighting implementation that has since been replaced. Keep them as history and check the current code before acting.

## Current assessment and continuation

- [ML and AI Usage Audit](gridiron-ml-ai-audit.md): what actually trains, what reaches decisions, what Claude does, and which gates are problematic.
- [Betting Continuation Plan](gridiron-betting-continuation.md): current verified defects, corrected data counts, architecture and ordered implementation slices.
- [Complete document inventory](recovered-evidence/INDEX.md): every recovered document with a link.

The original session location was `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/`. The preservation manifest records source paths and hashes. The workflow result files record their source journals. No paid research was restarted and no application code was changed during this recovery.

I have read the relevant summaries, selected primary notes, verification corrections and current model code; I have **not** reread every page of the whole collection. The efficient next step is to use this index and validate relevant historical findings as each betting-model slice is implemented.
