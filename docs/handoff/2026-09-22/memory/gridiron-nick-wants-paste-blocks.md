---
name: gridiron-nick-wants-paste-blocks
description: Nick's 08:05Z 2026-09-22 rule — whenever something needs his hands, give him copy-paste command blocks in project chat, one line above each saying what it does.
metadata:
  type: feedback
  modified: 2026-09-22T08:07:48.677Z
---

**Nick, 2026-09-22T08:05:49Z, `cmsg_01YAsw8AnFv4ioRMQw8dfPmTHqSPxojNMthfJBGbJyAZk9`:** *"gimme the commands for copy and paste here whenever u need me to do something"*.

**Why:** the 08:02Z live-read block (heredoc to `/tmp/read.cjs` inside `fly ssh console -a gridiron-hq`, then `node /tmp/read.cjs`) worked first time and he ran it within two minutes. Prose instructions do not get run; blocks do.

**How to apply:** any ask of Nick is a fenced block he can paste whole, preceded by ONE line saying what it does and whether it writes anything. Read-only first when possible. Never a secret in a block; presence checks only. Shell-in-shell quoting is avoided by writing a script via `<<'EOF'` heredoc and running it. Verify commands against the repo (a worker) before posting; mark anything unverified. Deploy/brake/rollback blocks are in the 08:02Z post: `fly deploy -a gridiron-hq`, `fly secrets unset SCHEDULER_DISABLED -a gridiron-hq`, rollback `fly secrets set SCHEDULER_DISABLED=1 -a gridiron-hq` then `fly deploy -a gridiron-hq --image registry.fly.io/gridiron-hq:deployment-01M2VZ9JRYSXVHCRWJ83V360QH`. See [[gridiron-live-read-2026-09-22]].
