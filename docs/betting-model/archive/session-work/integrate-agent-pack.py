from pathlib import Path
import json,re,shutil
root=Path('outputs')
manual=Path('work/agent-operating-spec.md').read_text()
prompts=Path('work/all-package-prompts.md').read_text()
master=root/'GRIDIRON-MASTER-PLAN.md';text=master.read_text()
anchor='## Current system findings and problem register\n'
assert anchor in text and '## Agent operating manual, research guardrails and code-review additions' not in text
text=text.replace(anchor,manual+'\n'+prompts+'\n'+anchor,1)
text=text.replace('6. [Current system findings and problem register](#current-system-findings-and-problem-register)\n7. [ML and AI evidence](#ml-and-ai-evidence)\n8. [Recovered Claude research and audits](#recovered-claude-research-and-audits)', '6. [Agent context, research guardrails, new code findings and output standards](#agent-operating-manual-research-guardrails-and-code-review-additions)\n7. [Prompts and edit maps for all 20 packages](#package-prompts-and-exact-edit-map)\n8. [Current system findings and problem register](#current-system-findings-and-problem-register)\n9. [ML and AI evidence](#ml-and-ai-evidence)\n10. [Recovered Claude research and audits](#recovered-claude-research-and-audits)')
text=text.replace('**Expanded scope:** the detailed specification below contains 20 work packages, six milestones, acceptance checks, operational failure cases and a conditional advanced-model backlog.', '**Expanded scope:** the detailed specification below contains 20 work packages and execution prompts, six milestones, 28 research guardrails, 12 code-review additions, exact edit/test maps, output standards, operational failure cases and a conditional advanced-model backlog.')
master.write_text(text)
(root/'AGENT-PLAYBOOK.md').write_text('# Gridiron implementation agent playbook\n\nUse the [master plan](GRIDIRON-MASTER-PLAN.md) for scope and specifications, and the [package index](WORK-PACKAGE-INDEX.json) for dependencies and file ownership.\n\n'+manual+'\n'+prompts)
hand=root/'CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md'
h=hand.read_text()
where=h.index('\n')+1
h=h[:where]+'''\n**Ready-to-assign execution pack:** [agent playbook](AGENT-PLAYBOOK.md), [20-package index](WORK-PACKAGE-INDEX.json), and individual prompts in `agent-prompts/`. The master document embeds all prompts and the full operating manual. Read its new C01–C12 findings before calling the corresponding foundation work complete.\n'''+h[where:]
hand.write_text(h)
index=json.loads((root/'WORK-PACKAGE-INDEX.json').read_text())
readme='''# Start here — Gridiron Claude implementation handoff

1. Read `GRIDIRON-MASTER-PLAN.md`. It contains the entire plan, current-state caveats, research map, source strategy, weekly training/news workflow, work packages, operating rules and prompts.
2. Use `CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md` as the execution outline.
3. Use `AGENT-PLAYBOOK.md` for research mistakes to avoid, current code findings, output/review standards and copyable prompts.
4. Assign only packages whose dependencies are ready. Individual prompts are in `agent-prompts/`; `WORK-PACKAGE-INDEX.json` maps verified existing code/test paths and proposed additions.
5. Keep the recovered research and verification reports under `recovered-evidence/`. Read the relevant bundle, not the entire corpus before every change.

This handoff was prepared in a planning task. It did not launch implementation workers or change the application. Source findings were inspected at HEAD `21789a9` with ongoing edits; earlier database counts remain dated historical observations. Reconcile current code and data first.

The isolated code checks are in `PLAN-CODE-CHECKS.json` and `code-checks/`. Fourteen existing packet-contract tests passed while seven malformed-packet probes still passed validation. Fixing the known cases and checking the real consumer is part of the acceptance criteria.

## Individual prompts

'''
readme+='\n'.join(f"- [{x['id']}: {x['title']}]({x['prompt']})" for x in index)+'\n'
(root/'README-CLAUDE-HANDOFF.md').write_text(readme)
checks=root/'code-checks';checks.mkdir(exist_ok=True)
probe=Path('work/probe-plan-gaps.mjs').read_text()
probe=probe.replace("import { pathToFileURL } from 'node:url';", "import { pathToFileURL, fileURLToPath } from 'node:url';\nimport path from 'node:path';\nconst evidenceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');")
probe=probe.replace("fs.writeFileSync('outputs/PLAN-CODE-CHECKS.json'", "fs.writeFileSync(path.join(evidenceRoot,'PLAN-CODE-CHECKS.json')")
(checks/'probe-plan-gaps.mjs').write_text(probe)
(checks/'README.md').write_text('''# Isolated code-check reproductions

The script imports only the packet contract (audited to import `node:crypto`) and evaluates an extracted quote-selection function with synthetic values in an isolated JavaScript context. It does not import database-owning app modules or call providers.

Run `node code-checks/probe-plan-gaps.mjs` from the extracted handoff directory. The repository path is declared near the top; adjust it if the checkout moved. The script writes `PLAN-CODE-CHECKS.json` next to the handoff documents. These are reproductions of inspected behavior, not replacements for regression tests in the repository. After fixes, validate expected rejections and consumer behavior rather than expecting the old failure outputs forever.

Existing pure test command actually run in the repository during planning: `node --test test/forecast-packet-contract.test.js`. Result: 14 passed, 0 failed. Full application tests and live-data training were not run in this planning review.
''')
# Include this exact source-check boundary in the dated JSON evidence.
p=root/'PLAN-CODE-CHECKS.json';j=json.loads(p.read_text());j['reproduction_script']='code-checks/probe-plan-gaps.mjs';p.write_text(json.dumps(j,indent=2)+'\n')
# Check Markdown file links, including the preserved document corpus, only for new/edited deliverables.
files=[master,hand,root/'AGENT-PLAYBOOK.md',root/'README-CLAUDE-HANDOFF.md']+list((root/'agent-prompts').glob('*.md'))
for file in files:
 t=file.read_text()
 for link in re.findall(r'\]\(([^)]+)\)',t):
  if '://' in link or link.startswith('#'):continue
  target=link.split('#')[0]
  assert (file.parent/target).exists(),(file.name,link)
print({'master_words':len(text.split()),'new_documents_link_checked':len(files),'prompts':len(index),'research_guardrails':len(re.findall(r'^\| R\d+',manual,re.M)),'code_findings':len(re.findall(r'^\| C\d+',manual,re.M))})
