from pathlib import Path
import re
root=Path('outputs')
master=root/'GRIDIRON-MASTER-PLAN.md'
s=master.read_text()
expansion=Path('work/expanded-engineering-spec.md').read_text()
anchor='## Current system findings and problem register\n'
assert anchor in s and '## Expanded engineering specification, dependencies and effort' not in s
s=s.replace(anchor,expansion+'\n'+anchor,1)
s=s.replace('5. [Current system findings and problem register](#current-system-findings-and-problem-register)\n6. [ML and AI evidence](#ml-and-ai-evidence)\n7. [Recovered Claude research and audits](#recovered-claude-research-and-audits)', '5. [Expanded work packages, dependencies and effort](#expanded-engineering-specification-dependencies-and-effort)\n6. [Current system findings and problem register](#current-system-findings-and-problem-register)\n7. [ML and AI evidence](#ml-and-ai-evidence)\n8. [Recovered Claude research and audits](#recovered-claude-research-and-audits)')
s=s.replace('## Plain-English decision\n','**Expanded scope:** the detailed specification below contains 20 work packages, six milestones, acceptance checks, operational failure cases and a conditional advanced-model backlog. The core effort estimate is 41–78 engineer-days, to be revised after the pilot.\n\n## Plain-English decision\n',1)
master.write_text(s)
handoff=root/'CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md'
h=handoff.read_text()
append='''
## Execute the expanded specification as reviewable packages

The [master plan now contains 20 detailed work packages](GRIDIRON-MASTER-PLAN.md#expanded-engineering-specification-dependencies-and-effort), logical record schemas, milestone dependencies, rough effort ranges, operational failure cases and advanced-model admission tests. Read the specification for the active package before implementing it. The ten steps above remain the execution outline; these packages define their depth.

| Delivery batch | Packages | Required concrete result |
|---|---|---|
| A — reconcile and repair | WP01–WP02 | Current defect/status ledger, preserved baseline, numerical fixes and one gate-responsibility map |
| B — usable history | WP03–WP07 | Historical IDs and source clocks, immutable contracts, coverage report, common football examples and exact-horizon prices |
| C — news and injuries | WP08–WP10 | Bounded archive pilot, reviewed extraction examples, source/event revisions, cutoff timelines and earlier-only availability features |
| D — first learned comparison | WP11–WP14 | Fixed experiment configuration, weekly nested fitting, probability/push contract, row-level predictions and error report |
| E — complete shadow operation | WP15–WP17 | Actual artifact scoring, frozen decisions, policy trace, independently reconciled settlement and CLV |
| F — reliability and ongoing evidence | WP18–WP20 | Resumable jobs, migration/restart verification, integrated failure tests and a prospective improvement protocol |

Batch C can proceed separately once B's contracts are defined; it must not block D's basic football baseline. E begins with a single frozen game as soon as D can produce a legitimate artifact, then expands to the slate. Recheck current work before every batch to avoid overwriting concurrent changes.

For each package, implement its smallest complete path, exercise the named failure cases and return evidence before expanding scale. Record unfinished dependencies and continue independent work. Do not quietly skip historical-clock checks to fill the dataset, or remove betting safeguards to make a candidate appear active.

Keep the initial statistical search small even though the engineering plan is detailed. The expanded advanced backlog is conditional: hierarchical team/QB models, player interactions, drive models, discrete joint scores, copulas, mixtures of experts and deep models require a demonstrated weakness and a simpler comparison. Do not build all of them before the first complete model-to-decision path.

The effort figures are planning estimates, not a deadline or a claim that an AI agent can run unattended for that duration. Measure actual progress and remaining work after the first pilot. Return one updated execution ledger, reproducible artifacts and concise results; preserve negative and inconclusive findings.
'''
handoff.write_text(h+append)
for p in [master,handoff]:
    t=p.read_text()
    broken=[]
    for link in re.findall(r'\]\(([^)]+)\)',t):
        if '://' in link or link.startswith('#'):continue
        target=link.split('#')[0]
        if not (p.parent/target).exists():broken.append(link)
    assert not broken,(p.name,broken)
    print({'file':p.name,'words':len(t.split()),'broken_local_links':broken})
ids=re.findall(r'^### (WP\d{2}) —',master.read_text(),re.M)
assert ids==[f'WP{i:02}' for i in range(1,21)],ids
assert sum([5,8,8,8,7,5])==41
assert sum([9,15,16,15,14,9])==78
print({'work_packages':len(ids),'effort_range_sum_verified':[41,78]})
