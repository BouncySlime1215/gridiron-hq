---
name: gridiron-no-pr-noise-rule
description: From 2026-09-20 01:31Z, no Gridiron HQ thread opens a documentation-only PR, comments on a PR, or closes one — every new PR emails Nick, and he asked for work rather than notifications.
metadata:
  type: feedback
---

**His words, 2026-09-20 01:31Z**, sent with a screenshot of the GitHub email a
new PR had just sent him:

> "Pls just work not ask or push any bs."

**The rule for every thread from that moment:**

- **No documentation-only pull requests.** No new PR whose diff is only docs,
  notes, evidence files or plans.
- **No PR comments**, including status notes and stand-down write-ups.
- **No closing PRs.**
- **Commits on branches that already exist are fine** — that is how work
  continues, including on an existing docs PR.

**Why it is a rule and not a preference.** Every new PR sends him an email.
Overnight that turned bookkeeping into a notification stream that looked like
activity, at the exact hour he had said he was going to bed and wanted nothing
until morning. See [[gridiron-release-train-2026-09-19]] for that night.

**How to apply.** Before opening anything, ask what it puts in his inbox. If a
finding needs recording, it goes in a commit on a branch that exists, in
project memory, or to the coordinator — never as a new PR or a comment. The
release plan's block carries the consequence for a reader: **no PR number
beyond the ones it lists should appear before morning unless it is code that
ships**, so an unfamiliar number is worth a second look.

**One exception is not an exception:** a comment the drive-to-green rules would
normally require on a PR you own now goes to the coordinator instead. Pairs
with [[gridiron-ci-dead-2026-09-20]], since CI is off and there is nothing to
report on a PR anyway.
