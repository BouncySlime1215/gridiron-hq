---
name: gridiron-claude-rules-location
description: Where Nick's two Claude skills now live for Gridiron HQ — repo CLAUDE.md plus project instructions — and what was deliberately not adopted.
metadata:
  type: project
---

Settled 2026-09-19. Nick's "i have adhd" and "make claude better" skills were
Mac-only and no cloud session had ever followed them. Now in two places,
because neither alone is enough:

- **Repo `CLAUDE.md`** (PR #8, branch `claude/project-thread-5podec`) — loads
  in any session with the repo checked out. Also vendors the skill verbatim at
  `.claude/skills/i-have-adhd/` (MIT, `SOURCE.md` says re-clone and diff, never
  edit in place). Vendored rather than marketplace-installed because cloud
  sessions do not share the Mac's `~/.claude` and an uninstalled skill fails
  silently.
- **Project instructions** — carry the output rules only. Verified present
  verbatim 2026-09-19. Needed because half the threads here never check out
  the repo.

Sources: "i have adhd" = https://github.com/ayghri/i-have-adhd (one file,
adopted whole). "make claude better" = https://github.com/worldflowai/everything-claude-code
(a 36-piece collection, not a skill; adopted in part).

**Not adopted, and `CLAUDE.md` section 3 says why** so nobody re-imports them:
its "attribution disabled globally" rule (conflicts with this project's
required footers), an 80% coverage floor plus Playwright E2E (would spend the
CI headroom PR #7 bought), the `continuous-learning` Stop hook (auto-writes
skill files from transcripts, unreviewed), and blanket immutability/CSRF/XSS
rules written for a public React app.

**The load-bearing sentence, do not drop it** when restating the five-item
cap: "This is about what is shown, not what is analysed or retained." Without
it the rule reads as license to stop analysing at five findings, which is the
opposite of the intent and degrades the work rather than the formatting.

**Ordering:** PR #8 is based on PR #7's branch, not `main`, so it must land
after #7. On `main` the suite cannot finish inside `timeout-minutes: 20`
(`.github/workflows/ci.yml:33`), so #8 could never have gone green there.

See [[gridiron-open-risks]] and [[fly-deployment-outside-repo]].
