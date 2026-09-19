# CLAUDE.md — how Claude works on Gridiron HQ

Loaded automatically by every session, on the Mac and in the cloud alike.
Two sources feed it, both third-party and both adopted selectively:

- **[i-have-adhd](https://github.com/ayghri/i-have-adhd)** — adopted whole.
  Vendored at `.claude/skills/i-have-adhd/`. Section 1 below is its ruleset,
  condensed; the skill file is the full text.
- **[everything-claude-code](https://github.com/worldflowai/everything-claude-code)**
  — adopted in part. Section 2 is what applies here. Section 3 is what was
  deliberately left out, so nobody re-imports it by accident.

---

## 1. Output style — always on

These shape every message to Nick. They are on by default in this repository;
he can turn them off for a session by saying "stop adhd mode".

1. **Lead with the next action.** First line is something he can do — a command,
   a path, a snippet. Context comes after, if at all.
2. **Number multi-step work.** One bounded action per step. Fewest steps that
   still work.
3. **End with one concrete next action**, doable in under two minutes.
4. **Suppress tangents.** Finish the first thing, then offer the second as a
   separate question. A question that comes up mid-work gets answered by Claude
   if it can be, not handed back.
5. **Restate state every turn.** "Step 3 of 5 done: X. Next: Y." Do not assume
   he is holding the plan in his head. Use the status checklist for this.
6. **Give specific time estimates** in concrete units. Not "some work".
7. **Make completed work visible** in concrete terms. "Login works now. Try
   `npm run dev`, open `/login`."
8. **Matter-of-fact on errors.** State cause and fix. Never "Uh oh".
9. **Cap visible lists to about five items**, most relevant first. This shapes
   presentation only — it must never limit analysis, search, or what is
   retained.
10. **No preamble, no recap, no closing pleasantries.** Start with the answer,
    end when the answer is done.

Break them when: he asks for an explanation or a walkthrough; a destructive
action needs confirming first; three turns have been "still broken" (stop
iterating, name the assumption that might be wrong); the request is genuinely
ambiguous; or a rule would delete the answer itself — "what are my options"
gets ranked options, recommendation first.

## 2. Engineering rules

**Tests.** This repository already runs TDD with a written record: a RED
commit, a GREEN commit, and an evidence file under `docs/tdd/`. Keep that
shape. Fix the implementation, not the test, unless the test is wrong.

**A failing test is never "a flake" until proven.** Name the failure and its
cause before calling it environmental. The suite currently carries known
environment-dependent failures — check `TASKS.md` before assuming a failure
is new.

**Run `npm ci` before trusting any suite number.** A fresh clone has no
`node_modules`, and the offline-guard tests fail with `ERR_MODULE_NOT_FOUND`
until it is run, which looks exactly like a regression and is not one.

**Secrets never appear in the repo, a commit, chat, or a screenshot.**
Environment variables only. A key that has been shown anywhere is burned and
must be rotated, and the rotation confirmed. Read a value's presence, never
its content, into a log or a message.

**Errors are handled or they throw.** No bare `catch {}` that swallows a
fault — this project has shipped two real bugs of exactly that shape, where a
silent catch deleted a whole data layer and the page kept printing numbers as
if nothing had happened. If a layer goes inert, the surface must say so.

**Parameterised queries only.** No string-built SQL.

**File size.** Prefer many small files. 200–400 lines typical, 800 a ceiling
worth arguing about, not a hard gate.

**Commits.** `<type>: <description>` — feat, fix, refactor, docs, test, chore,
perf, ci. Attribution footers stay on; see section 3.

## 3. Deliberately not adopted

From everything-claude-code, with the reason. Do not re-import these without
talking to Nick first.

- **"Attribution disabled globally."** Its `rules/git-workflow.md` says so.
  This project requires attribution footers on commits, PRs and GitHub
  comments. Its rule loses.
- **80% coverage minimum, and mandatory unit + integration + Playwright E2E
  on everything.** There is no Playwright here, and CI on `main` has never
  once completed — all four runs ever were cancelled for exceeding the job
  budget. A coverage floor and an E2E tier would make that worse. Revisit
  after CI completes on `main` at all.
- **"NEVER mutate, always spread."** Written for a React/TypeScript codebase.
  This is Node, Express and SQLite, and the rule would flag ordinary correct
  code on nearly every file.
- **"Rate limiting on all endpoints", CSRF, XSS sanitisation as a blanket
  pre-commit checklist.** This is a single-user app that was loopback-only
  until the Fly deploy. Real auth gaps get fixed on their merits — one already
  was, `POST /espn-connect/cookies` — but the checklist as written fires on
  every route and teaches nobody anything.
- **The `continuous-learning` Stop hook.** It auto-writes new skill files into
  `~/.claude/skills/learned/` from session transcripts. That is instructions a
  past session wrote, applied unreviewed to future ones. No.
- **`strategic-compact`, `clickhouse-io`, `frontend-patterns`,
  `backend-patterns`, `project-guidelines-example`.** Irrelevant or
  stack-mismatched: there is no ClickHouse here, and cloud sessions compact
  on their own.
- **The upstream hooks and agent definitions generally.** They are third-party
  scripts that run automatically at session start and end. Each would need
  reading on its own merits before it runs against this repo.
