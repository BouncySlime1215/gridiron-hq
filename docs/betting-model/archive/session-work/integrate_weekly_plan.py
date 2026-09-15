from pathlib import Path
import re
root=Path('outputs')
p=root/'GRIDIRON-MASTER-PLAN.md'
s=p.read_text()
old='**Status:** research recovery, selected current-system checks and planning are complete. Application repairs, expanded data ingestion, new training and shadow integration have not started in this task. Findings below reflect the September 14 inspection of repository commit `43af933` and the database at that time; reconfirm affected state when implementing each slice.'
new='**Status:** this task has recovered research, inspected selected code/data and produced the plan. A later inspection found HEAD `21789a9` and ongoing edits to the dataset builders/labs; foundation work elsewhere has progressed. The new weekly-training execution section records that update. The earlier findings and counts remain a dated `43af933` inspection snapshot, not a fresh open-defect list. Reconcile current implementation and data before each slice; this planning pass did not run training, backfill collectors or live database changes.'
assert old in s
s=s.replace(old,new)
s=s.replace('4. [Current system findings and problem register](#current-system-findings-and-problem-register)\n5. [ML and AI evidence](#ml-and-ai-evidence)\n6. [Recovered Claude research and audits](#recovered-claude-research-and-audits)', '4. [Weekly training, news backfill and Claude execution instructions](#weekly-training-news-backfill-and-claude-execution-instructions)\n5. [Current system findings and problem register](#current-system-findings-and-problem-register)\n6. [ML and AI evidence](#ml-and-ai-evidence)\n7. [Recovered Claude research and audits](#recovered-claude-research-and-audits)')
section=Path('work/weekly-training-instructions.md').read_text()
s=s.replace('## Current system findings and problem register\n',section+'\n## Current system findings and problem register\n\n**Historical inspection snapshot:** the findings below were checked at `43af933` or reported in recovered inventories. Consult the later execution-section reconciliation at `21789a9` before treating any as still open. Database counts have not been refreshed in this planning pass.\n',1)
s=s.replace('## ML and AI evidence\n','## ML and AI evidence\n\nThe following usage map and counts are from the earlier September 14 inspection. They remain evidence of that state, not a new measurement after subsequent commits.\n',1)
p.write_text(s)
header='''# Instructions for Claude — implement the Gridiron betting model plan

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`, confirming the active checkout first. Scope is NFL betting only.

Read the [consolidated master plan](/Users/nick_matta/Documents/Codex/2026-09-14/saved-2-memories-ran-a-command/outputs/GRIDIRON-MASTER-PLAN.md). It includes the recovered research, research-to-code mapping, GitHub sources, full build stages, overfitting controls, current-system evidence and improvement protocol. These instructions translate it into execution order; do not substitute another broad research project for implementation.

Start by reconciling the latest code and in-progress changes. Continue from the first unfinished step. Preserve existing work and historical evidence. Deliver runnable, verified slices and state what remains unproven. Do not equate implemented, tested, connected, observed and qualified.

'''
(root/'CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md').write_text(header+section)
for name in ['BETTING-MODEL-BUILD-PLAN.md','DATA-RESEARCH-AND-OVERFITTING.md']:
    q=root/name
    t=q.read_text()
    at=t.index('\n')+1
    t=t[:at]+'\n**Current execution detail:** see the [master plan](GRIDIRON-MASTER-PLAN.md#weekly-training-news-backfill-and-claude-execution-instructions) for the later code reconciliation, weekly training and news/injury backfill procedure, and [Claude instructions](CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md) for the ordered handoff.\n'+t[at:]
    q.write_text(t)
for q in [p,root/'CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md',root/'BETTING-MODEL-BUILD-PLAN.md',root/'DATA-RESEARCH-AND-OVERFITTING.md']:
    t=q.read_text()
    broken=[]
    for link in re.findall(r'\]\(([^)]+)\)',t):
        if '://' in link or link.startswith('#'):continue
        target=link.split('#')[0]
        if not (q.parent/target).exists():broken.append(link)
    assert not broken,(q,broken)
    print({'file':q.name,'words':len(t.split()),'broken_local_links':broken})
assert section in p.read_text()
assert section in (root/'CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md').read_text()
