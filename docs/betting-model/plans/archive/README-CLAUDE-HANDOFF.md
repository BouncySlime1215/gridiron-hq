# Start here — Gridiron Claude implementation handoff

1. Read `GRIDIRON-MASTER-PLAN.md`. It contains the entire plan, current-state caveats, research map, source strategy, weekly training/news workflow, work packages, operating rules and prompts.
2. Use `CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md` as the execution outline.
3. Use `AGENT-PLAYBOOK.md` for research mistakes to avoid, current code findings, output/review standards and copyable prompts.
4. Assign only packages whose dependencies are ready. Individual prompts are in `agent-prompts/`; `WORK-PACKAGE-INDEX.json` maps verified existing code/test paths and proposed additions.
5. Keep the recovered research and verification reports under `recovered-evidence/`. Read the relevant bundle, not the entire corpus before every change.

This handoff was prepared in a planning task. It did not launch implementation workers or change the application. Source findings were inspected at HEAD `21789a9` with ongoing edits; earlier database counts remain dated historical observations. Reconcile current code and data first.

The isolated code checks are in `PLAN-CODE-CHECKS.json` and `code-checks/`. Fourteen existing packet-contract tests passed while seven malformed-packet probes still passed validation. Fixing the known cases and checking the real consumer is part of the acceptance criteria.

## Individual prompts

- [WP01: Reconcile implementation and preserve baseline](../agent-prompts/WP01.md)
- [WP02: Repair defects and gate responsibilities](../agent-prompts/WP02.md)
- [WP03: Historical identities and exact clocks](../agent-prompts/WP03.md)
- [WP04: Immutable records and validated contracts](../agent-prompts/WP04.md)
- [WP05: Coverage and source admission](../agent-prompts/WP05.md)
- [WP06: Shared football features and strength priors](../agent-prompts/WP06.md)
- [WP07: Exact-horizon quote and betting datasets](../agent-prompts/WP07.md)
- [WP08: Historical news source pilot](../agent-prompts/WP08.md)
- [WP09: Typed events and historical injury timelines](../agent-prompts/WP09.md)
- [WP10: Availability and replacement learning](../agent-prompts/WP10.md)
- [WP11: Registered experiments and bounded model selection](../agent-prompts/WP11.md)
- [WP12: Weekly nested training and OOF lineage](../agent-prompts/WP12.md)
- [WP13: Probability, calibration and pushes](../agent-prompts/WP13.md)
- [WP14: Measurement and actionable error analysis](../agent-prompts/WP14.md)
- [WP15: Trained-artifact serving and frozen recovery](../agent-prompts/WP15.md)
- [WP16: Betting policy and related exposure](../agent-prompts/WP16.md)
- [WP17: Independent settlement and CLV grading](../agent-prompts/WP17.md)
- [WP18: Reliable jobs, migrations and resource limits](../agent-prompts/WP18.md)
- [WP19: Challenge the complete system independently](../agent-prompts/WP19.md)
- [WP20: Prospective ledger and evidence-driven expansion](../agent-prompts/WP20.md)
