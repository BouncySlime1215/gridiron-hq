---
name: gridiron-wiring-map
description: scripts/wiring-map.mjs (PR #36) derives what-feeds-what and what-should-be-wired from the source — how to run it, what now fails the build, and the four blind spots it prints on every run.
metadata:
  type: project
  modified: 2026-09-19T21:06:22.169Z
---

Draft **PR #36**, `claude/wiring-map-8f96ur` on `-3ldl77-docs`. Output in
`docs/wiring/`, baselines in `docs/wiring/annotations.json`. Five seconds over
912 files. **Run it before asking "what else touches this".**
Page for Nick: https://claude.ai/artifact/CUKM2d3hSkhfYAGLRbuMjY

    npm run map:wiring
    node scripts/wiring-map.mjs --findings
    node scripts/wiring-map.mjs --blast <table|module>
    npm run check:wiring      # CI, as a ratchet

## What FAILS the build
1. A new **missing feed** — a surface needs what nothing produces.
2. A **column read live and written nowhere** (`players.bye_week`;
   `auth_sessions.revoked_at` and `users.disabled_at`, so the login check's
   revoked and disabled branches can never fire).
3. A **producer nothing calls** that writes a served table (`syncEspnMarket`).
4. **A new MODULE reaching no live surface.** Added because the fantasy-plan
   thread is right that *a documented defect is not a wired one* — prose gets
   ignored and nothing fails. Escape hatch: `accepted_orphan_modules`, one
   deliberate line in a review. **Next to trip it: `injury-return.js` (PR #38),
   whose own description says nothing imports it.** Tell whoever sequences the
   train, or #38 goes red for a reason that looks mysterious.

Everything else reports only — 992 dead exports cannot each be a build failure.

## The generative rules (report only)
`two-names-different-sources` (two exported functions in one module whose names
contain one another, reading different tables — the `/api/model/availability`
defect generalised, 9 pairs); `constant-standing-in-for-a-model` (see
[[gridiron-availability-constant-0-92]]); `parameter-never-passed` (`from_week`
and 7 more outside betting).

## FOUR BLIND SPOTS — printed on every run, in every artifact
- **Rows, not writers.** It cannot tell you the rows are usable.
- **Whole-file replacement is invisible** — the chat-corpus false alarm.
  See [[gridiron-chat-corpus-two-databases]].
- **An edge can change with no deploy.** `scripts/fit-availability.mjs` reprices
  three live consumers; nothing on the graph says so.
- **It is a source tree, not the running app.** On 2026-09-19 the deployed
  binary was ahead of main on `contingency.js`.

## Writing findings so they survive review
The coordinator sends a finding to the thread that owns the code to verify.
**Name the file, the line and the handle, and say what would disprove it.**
Three peer threads closed a blind spot here on 2026-09-19, every time by
checking rather than taking. Once the tool was right and my prose was wrong
(`manager_archetypes`), which is why every table is generated, never
transcribed. Tuning turned up four false-positive classes, the worst in my own
parser — a destructured parameter list opens a brace inside the PARAMETERS, so
those functions read as four characters long. **Assume a new rule is wrong until
it reproduces a case somebody already found by hand.**

**THE BRANCH-PAIR SWEEP IS PART OF THE STANDING AUDIT** (coordinator decision,
2026-09-19). Running the gate on each branch is not enough: a collision between
two branches passes every per-branch check, because each side is correct alone
and the clash exists only in a combination nobody has a reason to build. Method:
detached worktree at main, `git merge` each open head in turn, abort on
conflict, record. The conflict is the finding before the map is even run. Re-run
it whenever a head moves, and report only NEW collisions. It found
[[gridiron-league-history-name-collision]] — two threads creating one filename
as two different modules — which no other instrument would have caught.

See [[gridiron-fantasy-audit-findings]], [[gridiron-wiring-map-blind-spot]] and
[[gridiron-checker-template-literal-blindness]].
