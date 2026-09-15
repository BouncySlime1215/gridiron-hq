"""Build a documented, deduplicated snapshot; never modify the source checkout."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile

session = Path(__file__).resolve().parents[1]
source_repo = Path('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard')
checkout = session / 'gridiron-hq-organized'
library = checkout / 'docs/betting-model'
library.mkdir(parents=True, exist_ok=True)
records, by_hash, source_map = [], {}, {}
origins = {}

def ingest(source, destination, label=None, data=None):
    data = source.read_bytes() if data is None else data
    digest = hashlib.sha256(data).hexdigest()
    target = by_hash.get(digest)
    duplicate = target is not None
    if target is None:
        target = library / destination
        if target.exists() and target.read_bytes() != data:
            target = target.with_name(target.stem + '-' + digest[:10] + target.suffix)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        by_hash[digest] = target
        origins[target] = source
    if source is not None:
        source_map[str(source.resolve())] = target
    records.append({'source':label or str(source.relative_to(session)),
                    'path':target.relative_to(library).as_posix(),
                    'source_sha256':digest,'source_bytes':len(data),'duplicate':duplicate})

def tree(source, destination, prefix):
    for p in sorted(source.rglob('*')):
        if p.is_file() and p.name != '.DS_Store' and '__pycache__' not in p.parts:
            rel=p.relative_to(source)
            ingest(p,Path(destination)/rel,f'{prefix}/{rel.as_posix()}')

recovered = session/'outputs/recovered-evidence'
categories = {
 'research2':'research/advanced-methods-and-github',
 'sept14':'research/september-14-sweeps',
 'source-papers':'research/source-papers',
 'sweep':'research/cross-system-sweep',
 'workflow-results':'research/workflow-results',
 'audit':'audits/recovered-line-by-line',
 'audit-system':'audits/recovered-audit-system',
 'current-checks':'audits/recovered-current-checks',
 'plans':'plans/archive/claude-september-12'
}
for name,destination in categories.items():
    tree(recovered/name,destination,f'workspace/outputs/recovered-evidence/{name}')
for p in sorted(recovered.iterdir()):
    if p.is_file():
        ingest(p,Path('archive/recovery-indexes')/p.name)

plan_files={'GRIDIRON-MASTER-PLAN.md':'plans/archive/MASTER-PLAN-2026-09-14.md',
 'CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md':'plans/CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md',
 'AGENT-PLAYBOOK.md':'plans/AGENT-PLAYBOOK.md',
 'WORK-PACKAGE-INDEX.json':'plans/WORK-PACKAGE-INDEX.json',
 'DATA-RESEARCH-AND-OVERFITTING.md':'plans/DATA-RESEARCH-AND-OVERFITTING.md',
 'BETTING-MODEL-BUILD-PLAN.md':'plans/archive/BETTING-MODEL-BUILD-PLAN.md',
 'README-CLAUDE-HANDOFF.md':'plans/archive/README-CLAUDE-HANDOFF.md',
 'CLAUDE-WORK-REVIEW-2026-09-15.md':'audits/CLAUDE-WORK-REVIEW-2026-09-15.md',
 'START-HERE-research-and-audits.md':'archive/recovery-indexes/START-HERE-research-and-audits.md',
 'PLAN-CODE-CHECKS.json':'audits/plan-code-checks/PLAN-CODE-CHECKS.json',
 'gridiron-betting-continuation.md':'audits/initial-betting-continuation.md',
 'gridiron-ml-ai-audit.md':'audits/initial-ml-ai-audit.md',
 'HANDOFF-MANIFEST.json':'archive/recovery-indexes/ORIGINAL-HANDOFF-MANIFEST.json'}
for name,destination in plan_files.items():
    ingest(session/'outputs'/name,destination)
tree(session/'outputs/agent-prompts','plans/agent-prompts','workspace/outputs/agent-prompts')
tree(session/'outputs/claude-review','audits/claude-review-evidence','workspace/outputs/claude-review')
tree(session/'outputs/code-checks','audits/plan-code-checks','workspace/outputs/code-checks')
tree(session/'work','archive/session-work','workspace/work')

# Preserve every distinct earlier handoff version, but not repeated ZIP containers.
tree(session/'outputs/GRIDIRON-CLAUDE-HANDOFF','archive/earlier-handoff','workspace/outputs/GRIDIRON-CLAUDE-HANDOFF')
for zpath in sorted((session/'outputs').glob('*.zip')):
    with zipfile.ZipFile(zpath) as z:
        for item in z.infolist():
            if item.is_dir() or Path(item.filename).name == '.DS_Store':continue
            rel=Path(item.filename)
            if rel.is_absolute() or '..' in rel.parts:raise ValueError('unsafe archive member')
            ingest(None,Path('archive/earlier-bundles')/zpath.stem/rel,
                   f'workspace/outputs/{zpath.name}!/{item.filename}',z.read(item))

# Include repository research/reference/evidence without relocating live code's docs.
for p in sorted((checkout/'docs').rglob('*')):
    if not p.is_file() or library in p.parents:continue
    rel=p.relative_to(checkout/'docs')
    if rel.as_posix()=='CLAUDE-NEXT-STEPS.md':dest=Path('plans/archive/CLAUDE-WORK-QUEUE-at-ffe4e72.md')
    elif rel.parts[:2]==('reference','research'):dest=Path('research/repository-catalogs')/Path(*rel.parts[2:])
    elif rel.parts[0]=='evidence':dest=Path('audits/repository-evidence')/Path(*rel.parts[1:])
    else:dest=Path('archive/repository-reference')/rel
    ingest(p,dest,f'repository/docs/{rel.as_posix()}')
    source_map[str(source_repo/'docs'/rel)]=source_map[str(p.resolve())]
for dirname in ['stage3_reports','tree_lab_reports']:
    src=source_repo/'research/betting/nfl'/dirname
    if src.exists():tree(src,Path('research/experiment-results')/dirname,f'repository/research/betting/nfl/{dirname}')

# Keep Markdown file links usable on GitHub. Original source hashes remain in inventory.
def rewrite(target, source, text):
    def link(match):
        token=match.group(1)
        raw=token.strip('<>')
        if raw.startswith(('https:','http:','mailto:','#','data:','app:')):return match.group(0)
        raw_path,sep,anchor=raw.partition('#')
        clean=re.sub(r':\d+$','',raw_path)
        p=Path(clean)
        if not p.is_absolute() and source is not None:p=source.parent/p
        mapped=source_map.get(str(p.resolve())) if source is not None or p.is_absolute() else None
        if mapped is None and p.is_absolute():
            try:
                candidate=checkout/p.relative_to(source_repo)
                if candidate.exists():mapped=candidate
            except ValueError:pass
        if mapped is None:return match.group(0)
        relative=os.path.relpath(mapped,target.parent).replace(os.sep,'/')
        if sep:relative+='#'+anchor
        return '](<' + relative + '>)' if ' ' in relative else ']('+relative+')'
    return re.sub(r'\]\(([^\n)]+)\)',link,text)
for target,source in origins.items():
    if target.suffix.lower()=='.md':
        target.write_text(rewrite(target,source,target.read_text()),encoding='utf-8')

master=(session/'outputs/GRIDIRON-MASTER-PLAN.md').read_text()
latest=library/'plans/LATEST-PLAN.md'
master=rewrite(latest,session/'outputs/GRIDIRON-MASTER-PLAN.md',master)
update='''# Gridiron HQ — latest betting-model plan

**Current consolidated edition: September 15, 2026.** This is the starting point for the betting-model work on this branch. It preserves the full detailed master specification below and adds the latest implementation/review priorities here. Historical findings in the original specification remain dated observations, not automatically open defects.

## Current execution order

1. Reconcile the latest code against the [September 15 review](../audits/CLAUDE-WORK-REVIEW-2026-09-15.md). Reproduce each finding before changing code. Fix the news timestamp comparison, immutable article/claim history, and frozen-decision recovery first.
2. Correct artifact identity to include actual training-data contents and dependency versions. Preserve probability precision through the forecast adapters. Review the injury-cutoff implementation against historical identity as well as timestamps.
3. Complete the common frozen input and trained-artifact boundary shared by replay and live forecasts. Keep research predictions separate from qualified recommendations.
4. Run the specified earlier-only weekly training and replay. Save every game's prediction, failure or abstention, plus all feature, model, quote and calibration identities.
5. Produce all-game error/calibration reports and exact-price betting evaluation wherever genuine quote evidence exists. Keep annual historical market comparisons distinct from executable T-60 evaluation.
6. Complete the bounded 2024 weeks 1–4 historical news/injury pilot with immutable versions, explicit missingness, historical rosters, and separate reconstructed/prospective evidence.
7. Audit gate purpose, reachability and empirical justification. A rejecting gate is not proof of a well-chosen threshold. Do not loosen production stake controls to create picks.
8. Use measured weaknesses to select the next feature/model experiment from the research below. Register trials before results; use earlier-only tuning and genuinely new confirmation games. An ensemble-conditioned simulator is not an independent mean forecast.

## What changed since the original plan

- Claude expanded the football dataset and ran the first ridge/LightGBM baseline study: 7,276 dataset games and 6,499 scored games. Stored average margin errors were market 10.249, ridge 10.675 and LightGBM 10.738 points. Neither model beat the market. Keep the result; it is not a profit test or a completed weekly pipeline.
- Several packet, quote, numerical and cutoff fixes landed. Do not blindly reimplement older fixed findings.
- The September 15 focused review ran 102 JavaScript and 54 Python tests, then reproduced issues the tests missed. Read its exact scope and evidence.
- **Branch base is `ffe4e72`.** After the review at `81a5ed6`, Claude committed injury-cutoff changes (`d531841`), adapters (`0ce5f97`), model artifacts (`9e707b2`), and an odds receipt-clock change (`ffe4e72`). Consequently, the review's “uncommitted draft” labels describe its inspection time. Those later commits were included in this branch, not newly audited or certified during document organization.
- Existing research is sufficient to start this engineering work. New research should answer a specific decision, not restart the literature review.

## Working documents

- [Claude implementation instructions](CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md)
- [Agent playbook](AGENT-PLAYBOOK.md) and [20 work-package prompts](agent-prompts/README.md)
- [Research library](../research/README.md)
- [Audit library](../audits/README.md)
- [Historical plans](archive/README.md)

The edition above controls current sequencing. The complete original design below remains the detailed specification; reconcile dated statuses with current code before execution. This document does not claim the review findings are fixed or authorize bets, paid data purchases, or deployment.

---

'''
latest.write_text(update+master.replace('# Gridiron HQ — master betting model plan','# Detailed master specification — preserved September 14 edition',1))
for name in ['CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md','AGENT-PLAYBOOK.md','DATA-RESEARCH-AND-OVERFITTING.md']:
    p=library/'plans'/name
    p.write_text('> Start with [LATEST-PLAN.md](LATEST-PLAN.md). Its September 15 update controls sequencing; dated findings below require reconciliation with current code.\n\n'+p.read_text())

for directory,title in [('research','Research library'),('audits','Audits and verification'),('plans','Plans and implementation instructions'),('plans/archive','Historical plans'),('plans/agent-prompts','Work-package prompts'),('archive','Preserved working material')]:
    folder=library/directory
    folder.mkdir(parents=True,exist_ok=True)
    files=sorted(p for p in folder.rglob('*') if p.is_file() and p.name!='README.md')
    lines=[f'# {title}','', '[Start here](%s)'%os.path.relpath(library/'README.md',folder),'']
    if directory=='plans':lines += ['**Current plan: [LATEST-PLAN.md](LATEST-PLAN.md).** Earlier versions are historical reference.','']
    if directory=='research':lines += ['Includes advanced statistics, ML/AI methods, GitHub catalogs, source papers, research sweeps and experiment reports. Research claims are evidence to evaluate; they do not certify an edge.','']
    if directory=='audits':lines += ['**Latest independent review: [September 15](CLAUDE-WORK-REVIEW-2026-09-15.md).** Review findings and database counts are dated snapshots.','']
    for p in files:
        rel=p.relative_to(folder).as_posix()
        lines.append(f'- [{rel}](<{rel}>)')
    (folder/'README.md').write_text('\n'.join(lines)+'\n')

(library/'README.md').write_text('''# Gridiron HQ betting-model library

## Start with the latest plan

**[OPEN THE LATEST PLAN → plans/LATEST-PLAN.md](plans/LATEST-PLAN.md)**

Consolidated September 15, 2026. This folder gathers our planning work, Claude's recovered research and audits, source papers, implementation prompts, test evidence, and repository reference material. The latest plan contains the full detailed specification plus the current review-driven execution order.

| Folder | Contents |
|---|---|
| [research/](research/README.md) | Advanced statistics, AI/ML, GitHub catalogs, source papers, sweeps, experiment results |
| [plans/](plans/README.md) | Latest plan, Claude instructions, agent playbook, 20 prompts, historical plans |
| [audits/](audits/README.md) | Latest independent review, line-by-line audits, audit-system research, reproducible checks |
| [archive/](archive/README.md) | Original recovery indexes, previous handoff versions, planning drafts and utility scripts |

Read the latest plan first, then the September 15 review, then the relevant work-package prompt and research. Do not reread the entire collection for every task.

The branch includes Claude's source-code history through `ffe4e72`. Organization did not implement fixes or certify later commits. Earlier plans, prompts, results and audits can contain superseded instructions, paths, or counts. The latest plan controls sequencing on this branch; historical documents preserve what was known then.

## Preservation and navigation

Exact duplicate source contents are stored once. Both older ZIP handoffs were inspected and their distinct contents preserved; redundant ZIP containers and OS/cache junk are omitted. Every input, including duplicate/archive-member aliases, is mapped in [MANIFEST.json](MANIFEST.json) and [FILE-INVENTORY.csv](FILE-INVENTORY.csv). Original source hashes and committed hashes distinguish link-rewritten documents from their inputs.

Markdown links that could be mapped to recovered files or repository code were made relative for GitHub. Source prose, old manifests, local-path examples, and historical scripts retain their original context. Archived scripts are working evidence, not a supported one-command build pipeline.

Credentials, live databases, dependencies and caches are not part of this documentation collection. Existing application documentation remains in its original locations for code references; this library adds an organized snapshot.
''')

# Make the repository's existing entry point agree about this branch's latest plan.
docs_index=checkout/'docs/README.md'
old=docs_index.read_text()
start=old.index('## The one active work-order plan')
end=old.index('## Evidence',start)
old=old[:start]+'''## Current betting-model plan and organized library

- **[Latest consolidated betting-model plan](betting-model/plans/LATEST-PLAN.md)** — full specification and September 15 review-driven priorities.
- [All research, plans, audits and prompts](betting-model/README.md).
- [Claude implementation ledger](CLAUDE-NEXT-STEPS.md) — implementation history and working notes; reconcile its dated queue with the latest plan on this branch.

'''+old[end:]
docs_index.write_text(old)
ledger=checkout/'docs/CLAUDE-NEXT-STEPS.md'
ledger.write_text('> **Organization-branch navigation:** the [latest consolidated plan](betting-model/plans/LATEST-PLAN.md) contains the current review-driven sequence. This ledger is preserved as implementation history; older “next actions” below are not a second current plan.\n\n'+ledger.read_text())

for record in records:
    p=library/record['path']
    record['committed_sha256']=hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'edition':'2026-09-15','base_commit':'ffe4e72','source_entries':len(records),
 'unique_imported_contents':len(by_hash),'duplicate_entries':sum(r['duplicate'] for r in records),
 'policy':'All distinct recovered/workspace content preserved; duplicate archive containers and OS/cache files omitted. Markdown links normalized where resolvable.',
 'files':records}
(library/'MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
with (library/'FILE-INVENTORY.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(records[0]));w.writeheader();w.writerows(records)
print(json.dumps({k:v for k,v in manifest.items() if k!='files'},indent=2))
