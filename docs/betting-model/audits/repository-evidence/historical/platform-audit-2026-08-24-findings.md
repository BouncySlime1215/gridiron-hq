# Platform audit findings — August 24, 2026

**Status: evidence, not instructions.** Relocated 2026-09-10 from the repository root per the
disposition table in
[`reference/architecture/FOLDER-REORGANIZATION.md`](../reference/architecture/FOLDER-REORGANIZATION.md)
and Codex correction §10.4 of the active plan.

What is preserved below: the dated observations this audit actually made about the platform on
2026-08-24, at build `1a2d359`. What was removed: its proposed backlog, its P0–P3 phase plan and
its twenty-three per-page roadmap sections. Those were a work queue, and the single active work
queue is [`docs/CLAUDE-NEXT-STEPS.md`](../CLAUDE-NEXT-STEPS.md). Merely moving a competing queue
under `evidence/` is not consolidation — §10.4 is explicit that the extraction has to happen.

Several findings here were later verified stale; see
[the implementation record](history/platform-audit-implementation-2026-09-08.md) for which, and
what changed as a result.

---

# Codex Platform Audit & Product Suggestions

Audit date: 2026-08-24  
Audited build: `1a2d359` on `main`  
Scope: every visible navigation tab from Dashboard downward, hidden/legacy routes, shared UI, APIs, persistence, data freshness, and release engineering.

## How Claude should use this document

This is an implementation brief, not a request to build everything at once.

- **P0 — Trust/reliability:** fix before adding major product surface.
- **P1 — Core product:** highest user value; build next.
- **P2 — Differentiation:** creative features that can make Gridiron HQ unusually useful.
- **P3 — Polish/scale:** valuable after workflows are coherent.
- **Quick win:** narrow enough for one focused change.
- **Design project:** requires schema/API/UX decisions and should be proposed before implementation.

For each completed section, Claude should update `CLAUDE_FEEDBACK.md` with files changed, migrations, API contracts, tests, and screenshots/manual verification. Codex should then review the diff and run acceptance checks.

---

# Executive assessment

## What the platform already does unusually well

Gridiron HQ already contains more real analytical machinery than most personal fantasy tools:

- Multi-league ESPN and Sleeper ingestion.
- Format-aware market values and roster analysis.
- Optimal-lineup, trade, VOR, schedule, volatility, correlation, and season simulation engines.
- A real mock/live tracking draft board with persisted picks.
- NFL team scheme, coaching, depth, cap, and roster context.
- First-party NFL and MLB modeling, pick ledgers, line shopping, replay, and model evidence.
- Explicit freshness banners and honest model limitations in several betting screens.
- Local-first storage and optional AI prose instead of making AI a prerequisite.

The core opportunity is not “add more models.” It is to turn these engines into a coherent decision operating system.

## The biggest platform weaknesses

### P0: Trust is uneven

- There is no automated application test suite, no `test` script, and no isolated test database.
- Tables are created across route and service modules at import time. Schema ownership and migration order are difficult to reason about.
- Many pages do not render API errors; some silently swallow failures or use browser `alert()`.
- Data freshness is excellent on a few betting pages and unclear almost everywhere else.
- Several destructive or expensive operations have weak busy-state protection.
- The default offline draft pool cannot complete the default draft size; K/team DEF representation remains unresolved.
- Browser-local pick tracking creates split-brain persistence: some records live in SQLite, some only in one browser.

### P1: The app does not answer “what should I do today?”

The Dashboard mostly links to sections. It does not synthesize lineup moves, waivers, injuries, trades, news, draft status, model freshness, and betting exposure into a prioritized command queue.

### P1: Workflows are fragmented

- Fantasy Lab is a menu linking to two older pages instead of a unified workspace.
- NFL Auto Picks routes to the same component as NFL Board, so the navigation promises a distinct product that does not exist.
- ESPN Settings duplicates functionality now available through My Leagues and ESPN Connect.
- MLB first-party and proxied/legacy products overlap without a clear migration story.
- Player, roster, news, draft, and trade insights rarely deep-link into the next useful action.

### P1: Accountability is inconsistent

The betting side has ledgers and holdout evidence, while fantasy advice has little “what did the app recommend, what happened, was it right?” memory. The app needs a recommendation journal across lineup, waiver, trade, draft, and betting decisions.

### P2: The platform has enough data for a true “digital twin”

The combined roster, league, schedule, market, usage, injury, game-script, and simulation data could power a persistent digital twin of each fantasy team: title odds, playoff odds, weekly risk, replacement plans, and the marginal value of every possible action.

---

# Global product and engineering recommendations
