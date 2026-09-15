from pathlib import Path
import re
root=Path('outputs')
plan=(root/'BETTING-MODEL-BUILD-PLAN.md').read_text()
supp=(root/'DATA-RESEARCH-AND-OVERFITTING.md').read_text()
assessment=(root/'gridiron-betting-continuation.md').read_text()
ai=(root/'gridiron-ml-ai-audit.md').read_text()

def section(text,start,end):
    return text.split(start,1)[1].split(end,1)[0].strip()

intro='''# Gridiron HQ — master betting model plan

September 14, 2026 · Consolidated implementation plan and evidence register

**Scope:** NFL betting: data, numerical forecasting, ML, AI news use, prices, evaluation, gates and monitoring. This is the main plan to work from. Research adoption and the process for choosing future improvements are included here.

**Status:** research recovery, selected current-system checks and planning are complete. Application repairs, expanded data ingestion, new training and shadow integration have not started in this task. Findings below reflect the September 14 inspection of repository commit `43af933` and the database at that time; reconfirm affected state when implementing each slice.

## Plain-English decision

The app has real ML experiments and useful infrastructure, but it does not yet have a coherent trained betting pipeline. In the recorded production decisions inspected, its forecast matched the market. There are also concrete data and numerical defects, disconnected training/serving paths, and overlapping gates. Historical models that did make independent predictions did not establish an edge either.

Keep the useful infrastructure, repair the foundations, train a small first candidate on trustworthy history, and connect the exact same model to reproducible shadow predictions. Build the error report alongside it so future additions address measured weaknesses. Improved prediction and profitable betting require separate evidence. Overfitting can be reduced and detected; it cannot be guaranteed absent.

## Contents

1. [Implementation stages and first delivery](#implementation-stages-and-first-delivery)
2. [Data sources, research and GitHub adoption](#data-sources-research-and-github-adoption)
3. [Overfitting controls and acceptance requirements](#overfitting-controls-and-acceptance-requirements)
4. [Current system findings and problem register](#current-system-findings-and-problem-register)
5. [ML and AI evidence](#ml-and-ai-evidence)
6. [Recovered Claude research and audits](#recovered-claude-research-and-audits)

## Implementation stages and first delivery

'''
planbody=plan.split('## Decision\n',1)[1]
planbody=re.sub(r'\nThis plan builds on .*?\n\n', '\n', planbody, count=1)
planbody=re.sub(r'\n\*\*September 14 additions:\*\*.*?\n\n','\n',planbody,count=1)
planbody=planbody.replace('[detailed adoption map](DATA-RESEARCH-AND-OVERFITTING.md)','[detailed adoption map below](#data-sources-research-and-github-adoption)')
# Nest implementation headings under this master section.
planbody=re.sub(r'^(#{2,}) ',r'#\1 ',planbody,flags=re.M)
data=section(supp,'## 1. What to obtain or improve','## 4. Overfitting control contract')
data='### What to obtain or improve\n\n'+data
data=data.replace('## 2. Put the recovered statistics into the build','### Put the recovered statistics into the build').replace('## 3. What to reuse from GitHub','### What to reuse from GitHub').replace('### Three source traps the plan must handle','#### Three source traps the plan must handle')
controls=supp.split('## 4. Overfitting control contract',1)[1].strip()
controls=controls.replace('## 5. Acceptance criteria added to the build','### Acceptance criteria').replace('[build plan](BETTING-MODEL-BUILD-PLAN.md)','implementation stages above')
findings=section(assessment,'## Findings verified against today\'s code or database','## Decisions for the continuation')
findings='### Verified findings\n\n'+findings
findings=findings.replace('## Remaining problem register','### Remaining problem register').replace('### Learning and model construction','#### Learning and model construction').replace('### Data and time integrity','#### Data and time integrity').replace('### Serving, evaluation, and betting','#### Serving, evaluation, and betting')
ai_map=section(ai,'## Usage map','## The gates: distinguish three failures')
ai_extra=section(ai,'## Additional AI-specific weaknesses','## Recommended division of work')
recovery='''## Recovered Claude research and audits

The recovered collection is substantial. Much was in Claude's temporary session folders rather than the repository's docs directory; the preserved originals and source manifest remain available.

- **Research2:** 56 main topic reports, two architecture/code catalogs and 12 scoring-note documents, totaling 70 Markdown files. Topics include point-in-time data, forecast combination, Bayesian ratings, shrinkage, conformal calibration, multiple testing, sequential inference, NFL margins, copulas, injury/news effects and deeper ML architectures.
- **September 14 methods sweep:** 14 reports and 13 verification reviews. The open-source survey has no completed verification result.
- **System audit:** 59 Markdown documents, including the large full-system synthesis and detailed code-group reviews.
- **Audit-system review:** 41 Markdown documents covering historical evaluation, timing, evidence and deployment consistency.
- **Plans and references:** the Giant Plan, What Next, master-plan versions and 81 source/reference files. Some are PDF/text duplicates; this is not 81 unique papers.

The final learned-model redesign produced four inventories, but the design, critique and revised specification failed at the usage limit. A completion notification did not mean the final design was delivered. The broader scale sweep had no finished reports in its journal. The original audit also has a completeness critique documenting coverage gaps; do not describe it as verified line-by-line coverage of everything.

Read relevant reports together with verification corrections when implementing their slice. Historical reports contain superseded findings; the problem register distinguishes reproduced checks from items still requiring confirmation. The current plan incorporates selected research methods with explicit jobs and validation requirements, rather than assuming advanced terminology proves correctness.

Original evidence entry points:

- [Research and audit index](START-HERE-research-and-audits.md)
- [Complete preserved inventory](recovered-evidence/INDEX.md)
- [Full system audit](recovered-evidence/audit/SYSTEM_AUDIT_2026_09_11.md)
- [Audit completeness critique](recovered-evidence/audit/COMPLETENESS-CRITIC.md)
- [Audit-system review](recovered-evidence/audit-system/AUDIT_SYSTEM_REVIEW.md)
- [Recovered research architecture](recovered-evidence/research2/FIX_AND_ADD_ARCHITECTURE.md)
- [Recovered GitHub catalog](recovered-evidence/research2/GITHUB_BUILD_CATALOG.md)
- [Claude's Giant Plan](recovered-evidence/plans/GRIDIRON_GIANT_PLAN.md)
- [Claude's What Next](recovered-evidence/plans/WHAT_NEXT.md)

The implementation, data/research choices, improvement-selection process and acceptance requirements are consolidated in this master document. The linked originals preserve supporting evidence and historical context.
'''
master=intro+planbody.strip()+'\n\n## Data sources, research and GitHub adoption\n\n'+data+'\n\n## Overfitting controls and acceptance requirements\n\n'+controls+'\n\n## Current system findings and problem register\n\n'+findings+'\n\n## ML and AI evidence\n\n### Usage map\n\n'+ai_map.replace('## What the usage records show','### What the usage records show')+'\n\n### AI-specific weaknesses\n\n'+ai_extra+'\n\n'+recovery
out=root/'GRIDIRON-MASTER-PLAN.md'
out.write_text(master)
broken=[]
for link in re.findall(r'\]\(([^)]+)\)',master):
    if '://' not in link and not link.startswith('#') and not (out.parent/link.split('#')[0]).exists():broken.append(link)
assert not broken,broken
assert all(x in master for x in ['Required improvement process','Treat error-driven additions as another search','MAPIE','Harvey','Current system findings','GitHub'])
print({'file':str(out),'words':len(master.split()),'broken_local_links':broken})
