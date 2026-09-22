# A mistyped command could bill the Anthropic API

`scripts/run-news-event-impact.mjs`, and the new `scripts/paid-run-optin.mjs`.

## The five questions

**Well built?** A twenty-line module with one pure function and one process
exit, plus three lines in the script that calls it. The guard runs before every
other import in that script, which is the only placement that is actually true
to what it claims.

**Stats or made up?** Not a statistical finding — a reachability one, read off
the code. `package.json` exposes the script as `news:event-impact`; the script's
own header says it "makes real, billed calls to the Anthropic API (Haiku 4.5,
~$1/$5 per million input/output tokens)"; `command = args[0] ?? 'impact'` means
a bare invocation is a valid one, and `controls` reaches
`duplicateArticleControl(extractNewsEventsFromItems, ...)`, which bills.

**How do we know?**

| | commit |
|---|---|
| **RED** | #92 · *test: RED — nothing stops a mistyped command from billing the Anthropic API* · `aa964bf` |
| **GREEN** | #92 · *fix: a script that spends money refuses to run without an explicit opt-in* · `85598b6` |

RED is 6 tests, 0 passing. Its failing assertion, verbatim from the run at that
commit:

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/scripts/paid-run-optin.mjs' imported from …/test/paid-run-opt-in.test.js
#   code: 'ERR_MODULE_NOT_FOUND',
not ok 1 - test/paid-run-opt-in.test.js
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
```

GREEN turns all six. **Nine mutations killed**, with a no-op control that
correctly survived. One mutation survived a first pass and exposed a real defect
in the change itself, not only in the test — see below.

**Pointed anywhere else?** Three other paths reach a billed call. They are
listed below and **none is changed here**, under one editor per file.

**How does it unify?** "Nothing paid, ever" stops being a rule people remember
and becomes a property of the process: the default is refusal, and spending is
something you type on purpose.

## The mutation that survived, and the defect it found

The first version put `assertPaidRunOptIn()` after the script's two static
imports and claimed the refusal happened "before the database is opened". The
mutation that moves the guard below `await runMigrations()` **survived**, and it
should have: the claim was false either way.

`server/db/index.js:19` runs `mkdirSync(path.dirname(DB_PATH), { recursive: true })`
**at module scope** and opens the database there. A static import runs before any
statement in the importing file, so the original guard had already created a
directory and opened a database by the time it refused.

Two things were wrong and both were fixed:

1. **The script.** `runMigrations` and `rows` are now loaded with `await import(...)`
   *after* the guard, joining the service modules that were already dynamic for
   a different ordering reason. Nothing that touches the database or holds the
   API client loads until the opt-in is established.
2. **The test.** The first ordering test pointed `GRIDIRON_DB_PATH` at a
   directory that does not exist, which discriminates nothing, because
   `mkdirSync(..., { recursive: true })` creates it. It now points at a path
   whose parent is a **file** (`package.json/db.sqlite`), so the mkdir fails with
   `ENOTDIR` regardless of who is running — including root, where permission
   bits prove nothing.

With both fixed, the mutation is killed.

## Presence, never the value

The guard reads whether `GRIDIRON_ALLOW_PAID_RUN` is set. It does not read what
it holds, and the returned reason names the variable rather than its contents.
The opt-in sits in the same environment as the API keys and this project has had
three key-exposure incidents; a guard that echoed what it read into a log or an
error message would be a fourth. `trim()` decides that an empty or all-whitespace
setting is not an opt-in, and nothing else inspects the contents. One test asserts
the verdict never carries the value, and the mutation that interpolates the value
into the reason is killed by it.

## Mutations

| # | mutation | verdict |
|---|---|---|
| M1 | drop the `trim()` check, so an empty string opts in | killed |
| M2 | `present = true` | killed |
| M3 | `present = false` | killed |
| M4 | interpolate the value into the reason | killed |
| M5 | `process.exit(0)` instead of `1` | killed |
| M6 | write the reason to stdout instead of stderr | killed |
| M7 | move the guard below `await runMigrations()` | killed |
| M8 | append a second line to the reason | killed |
| M9 | restore `rows` as a static import above the guard | killed |
| C0 | rename a local variable (no-op control) | **survived**, correctly |

## The other billed paths — listed, not changed

| path | how it reaches a billed call | what gates it today |
|---|---|---|
| `scripts/build-negotiation-profiles.mjs:244,:402` | imports `services/claude.js`, calls `callClaude` | `--dry-run` at `:45` is an **opt-out**; the default bills. **No env opt-in.** |
| `scripts/build-manager-archetypes.mjs:147` | the AI gateway, not the Anthropic client directly | exits 1 when `AI_GATEWAY_API_KEY` is unset, and caps spend with `JEV_MAX_USD` at `:39`. A key-presence check rather than a spend opt-in, but it is a gate. |
| `server/scripts/run-nfl-ai-replay.js:2` | `services/nfl-ai-replay.js` → `callClaude` | a detached worker the server spawns with a run id; started by a user action, not by a stray command line. **No env opt-in.** |
| nine route files importing `callClaude` | request-driven | `getApiKey()`; a request, not a command line. |

**`scripts/build-negotiation-profiles.mjs` is the closest sibling to this
defect** — a command-line script whose default is to spend — and it is the
obvious second application of the same guard. It belongs to another editor, so
it is reported here and left alone.

## Open question for Nick

An environment opt-in is the weakest gate that works. Stricter options exist: an
interactive confirmation, a required `--yes-i-will-pay` flag, or a hard spend cap
in the script the way `JEV_MAX_USD` does it. **Which of those this should be is
his call**, and it is on his morning list. What is settled is that the default is
no longer "runs and bills".
