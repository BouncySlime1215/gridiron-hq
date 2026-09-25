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

**A failing test is never "a flake" until proven, and "no API key" is not a
cause.** Name the failure and its real cause before calling it environmental.
This project read a `Connection error.` in `nfl-news-events` and
`page-explain` as a missing Anthropic key for weeks. PR #7 found the real
cause: a `mock.module()` call passing `exports: { default: … }` where the API
takes `defaultExport`. The wrong key was accepted in silence, the mocked
module's default became an empty object, and the SDK reported its own
`TypeError` as a connection failure. It was never the key.

**The one plan is `docs/handoff/local/ONE-PLAN.md`** on the branch
`claude/handoff-package-2026-09-22` (read it with `git fetch origin
claude/handoff-package-2026-09-22 && git show
origin/claude/handoff-package-2026-09-22:docs/handoff/local/ONE-PLAN.md`).
It superseded every earlier plan on 2026-09-24. **Stale, do not follow:**
`TASKS.md`, `docs/FANTASY-ENGINE-MASTER-PLAN.md`, `docs/CLAUDE-NEXT-STEPS.md`,
and the historical records under `docs/evidence/`, `docs/tdd/` and
`docs/betting-model/` (read them only when a task names one). The product is
the local app; the hosted Fly deploy is not maintained.

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

## 2b. UI rules (any change under `client/`)

The app is one design system and seven areas (docs/ui/DESIGN-SYSTEM.md, docs/ui/CONSOLIDATION-MAP.md).
A client change that breaks these is refused at integration:

- **Primitives only.** Card, Button, Chip, Stat, Avatar, Tabs, Table, Skeleton, EmptyState, Sheet
  (`components/ui/DesignSystem.tsx`) and the tokens in `client/src/styles/tokens.css`. No stock
  Tailwind blues/greys, ad-hoc radii or shadows, no second copy of a card that already exists.
- **Seven areas, no new top-level pages.** New features live inside Today, Trades, My team, League,
  Players, Draft or Settings. No nested app shell (one header, one tab row per area).
- **No layout defects** at 375 / 768 / 1024 / 1440 / 1920 px, light and dark: no horizontal overflow,
  no clipped text without an ellipsis, no fixed/sticky element over text or a button, no control
  whose visible text is empty. Page height at 375 stays reasonable (fold long sections, "Show more").
- **No dev text on screen.** No raw engine field names, file paths, script names, model names,
  dollar budgets or internal ids. Every number has a label; a guess says it is a guess.
- **One number, one producer.** A screen shows the served value from its single producer
  (plans.json / the one service), never a locally recomputed copy.
- **Nick's rules are shown, never bypassed.** Trade suggestions render only rule-filtered output
  (never-give.js) and show the "N ideas hidden by your rules" count; nothing rule-breaking is drawn.
- **Motion and speed.** Transform/opacity only, respect reduced motion, no long task > 50 ms on a
  view switch; skeletons at final size (no layout jump).
- **Privacy.** No league-mate names, chat text or credentials in committed fixtures or screenshots.

PR bodies for client changes list before -> after screenshots (paths) and the scan result.

## 3. Deliberately not adopted

From everything-claude-code, with the reason. Do not re-import these without
talking to Nick first.

- **"Attribution disabled globally."** Its `rules/git-workflow.md` says so.
  This project requires attribution footers on commits, PRs and GitHub
  comments. Its rule loses.
- **80% coverage minimum, and mandatory unit + integration + Playwright E2E
  on everything.** There is no Playwright here, and the suite runs against
  `timeout-minutes: 20` in `.github/workflows/ci.yml`. CI has run seven times
  on `main`, ever, checked directly against the Actions API: four early runs
  (2026-09-13 ×3, 2026-09-15 ×1) all hit the 20-minute budget and were
  cancelled, but three have completed since PR #7's runtime fix landed — run
  252 (2026-09-19, success, ~6.5 min) first, then two more on 2026-09-22.
  "CI had never once completed on `main`" is false as of today; it was true
  only through 2026-09-15. The workflow (id `357164314`) is active, not
  disabled, and gets a real CI signal on every push and PR now. A coverage
  floor and a new E2E tier would still spend headroom this project can't
  spare while `main`'s own runs aren't reliably green yet — revisit once
  `main` holds green for a stretch, not just once, and raise the timeout
  deliberately rather than rediscovering it at twenty minutes.
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
