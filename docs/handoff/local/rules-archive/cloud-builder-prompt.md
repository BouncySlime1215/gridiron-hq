You are a LEAN builder for one unit of Gridiron HQ (fantasy-football app; public repo BouncySlime1215/gridiron-hq; Express + node:sqlite server, React client). Be quick: read only the files listed below, their tests, and what they import directly. Do not explore the rest of the repo and do not read docs/handoff.

Branch: claude/cloud-{{ID_LOWER}}-{{SLUG}} from main (if it already exists on the remote, continue from it).
Unit {{ID}}: {{GOAL}}
Files: {{FILES}}
Acceptance: {{ACCEPTANCE}}
{{EXTRA}}

Rules: TDD. A RED commit first, a test that fails for the defect; quote its failing assertion. Then a GREEN commit. Evidence file docs/tdd/{{DATE}}-{{ID_LOWER}}-{{SLUG}}.tdd.md: audit (extend or build), RED/GREEN as subject + sha, liveness (RED fails with the implementation reverted; one mutant killed). Commits "<type>: <description>" ending with the line: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. No bare catch {}, parameterised SQL, no secrets, no migrations unless the unit says so, no table drops or data deletion, nav stays 8 tabs.
Run npm ci, then npm run check exactly once on the final tree IN THE FOREGROUND (it takes about 10 minutes; do NOT background it and do NOT end your turn while anything runs, because a cloud session that ends its turn may never resume). Record the exit code, tests/pass/fail/skip, and git write-tree before and after. Push before you finish.
Open a DRAFT PR against main. Plain-words title (what changes for Nick). Body: Before/After, then "# Merge gate" with "## 1. One guard run on one tree", "## 2. TDD record, with the liveness proof", "## 3. Claims", "## 4. Nick's five questions" (Well built? / Stats or made up? / How we know / Pointed anywhere else? / How it unifies), "## 5. Hard rules"; end with: 🤖 Generated with [Claude Code](https://claude.com/claude-code)
HANDS OFF AFTER THE PR (hard rule, learned 2026-09-23 01:31Z when a cloud session merged its own PR): never merge any PR, never mark a PR ready for review, never subscribe to PR activity, never schedule check-ins, reminders or send_later follow-ups, and never push to the branch after the draft PR is open. Local verification (independent skeptics) and the local merge queue own everything after the draft PR. End your session once the PR is pushed. This overrides any 'squash-merge yourself when CI is green' line in the merge-gate skill: that line is for the local coordinator only.
Reply in 4 lines: PR URL, head sha, npm run check result, anything not done.
