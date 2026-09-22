# TDD evidence: a module whose data file the image never contains

**Item:** a new rule, `data-file-not-in-the-image`. A module can have every import edge
present, every export imported, and a live surface reading it, and still do nothing in
production, because it opens a file the runtime image was never given.

**Files owned and changed:** `scripts/wiring-map.mjs`, `test/wiring-map.test.js`,
`docs/wiring/WIRING-MAP.md`, `docs/wiring/wiring-map.json`, this document.

**Origin:** the fantasy-plan thread, via the coordinator, on 2026-09-20.
`team-outlook.js` has no consumer because `history-corpus.js:48` opens
`data/derived/sleeper_history.sqlite` under `process.cwd()` and returns null, and the
Dockerfile's runtime stage copies only `client/dist`, `server` and `scripts`. **An
`accepted_orphan_modules` line for it would have recorded "no consumer" and hidden the
cause** — which is the reason this is a rule and not a note.

Verified against `791b131`: the runtime stage is `COPY package.json …`,
`COPY --from=build /app/client/dist ./client/dist`, `COPY server ./server`,
`COPY scripts ./scripts`. No `data/`, no `docs/`.

---

## RED

`test/wiring-map.test.js`, three cases, all failing at HEAD:

```
not ok 31 - imageDirs reads the runtime stage, not the build stage
not ok 32 - a default data path outside the image is found, and an env override is noted
not ok 33 - a path joined to a directory inside the image is not repo-root-based
```

## The two things that make it non-trivial

1. **The build stage does `COPY . .`.** Reading the whole Dockerfile would say the image
   contains everything and the rule would never fire. Only the last `FROM` counts.
   Case 31 pins that directly, with a two-stage fixture.

2. **`server/data/analyst-notes-2026.json` is in the image and reads as `data/…` in the
   source, exactly like a repo-root path does.** The literal cannot tell them apart. The
   *base* can, so the rule keys on it: only `process.cwd()` and the repo-root names
   resolve to a directory this rule may check, and a `path.join(SERVER_ROOT, 'data', …)`
   names nothing it is allowed to flag. Case 33 pins that, and it is the case that keeps
   the rule from firing on three live JSON files that ship correctly.

The first attempt at `imageDirs` also read the *source* of each COPY rather than the
destination, so `COPY --from=build /app/client/dist ./client/dist` yielded `app` — a
path inside the build stage's filesystem, which says nothing about where the file lands.
Caught by case 31's exact-set assertion.

## GREEN, and what it found

Five instances on `791b131`, four more than the one that prompted it:

| module | file it opens | override |
|---|---|---|
| `manager-signals.js` | `data/derived/league_chat.sqlite` | `GRIDIRON_CHAT_DB_PATH` |
| `nfl-weekly-feature-store-v2.js` | `data/line-history/nflverse.sqlite` | `NFLVERSE_DB_PATH` |
| `nfl-weekly-feature-store-v2.js` | `data/line-history/line_history.sqlite` | `LINE_HISTORY_DB_PATH` |
| `nfl-weekly-feature-store-v2.js` | `data/derived/player_value.sqlite` | `PLAYER_VALUE_DB_PATH` |
| `nfl-learned-shadow-explain.js` | `docs/betting-model/research/experiment-results/unified_margin_audit` | **none** |

The last one is the sharpest: `docs/` is not in the image at all and no environment
variable can redirect the path, so that module is inert in production unconditionally.
It is betting-side and therefore out of scope for the fantasy work, but it is the same
defect and it is recorded rather than dropped.

`fly.toml`'s `[env]` block sets only `HOST`. None of the four override variables appears
there. They could be Fly secrets, which this map cannot read and I have not read — which
is exactly why the finding names the variable and says to check the deployment first.

## Report-only, never gating

An environment variable can redirect any of these paths, and the map cannot read a
deployment's secrets. A rule that failed the build on evidence it cannot complete would
be the same mistake as the one this repairs, in the other direction. The finding's job
is to say *where to look*, and the two wordings — with an override and without — say
which of the deployment or the code to look at first.

## What it still cannot see

- A path built by string concatenation rather than `path.join`, or from a variable.
- A file inside a shipped directory that is `.dockerignore`d; the rule reads `COPY`
  lines, not the ignore file.
- Whether a shipped directory's *contents* are what the module expects. This is
  presence, not correctness — the same limit as every other rule in this map.
