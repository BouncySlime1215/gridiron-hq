# Gridiron HQ — Cleanup Plan (executable, reversible)

Companion to `SYSTEM_AUDIT_2026_09_11.md` (see its Sections F and G for the evidence behind every line item below). Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`.

**How to use this file**: every command below is written to be copy-pasted and run from the repo root, in the order shown within each tier. Tier (a) needs no review — it touches only gitignored/untracked/already-worthless files. Tier (b) changes tracked history and should land as one or a few reviewed commits, not run blind. Tier (c) is a do-not-touch list, not a to-do list — it exists so nobody (human or agent) runs a broad cleanup command near these paths by accident.

**Standing constraint, carried verbatim from the task brief and honored throughout this file: never propose deleting the 9.8 GB pre-migration backup or lab outputs without saying what they are and that Nick must decide.** Both are handled that way below — see the boxed section at the end of Tier (c).

---

## (a) Safe now — gitignored junk, empty dirs, tracked runtime artifacts

These are either not tracked by git at all (so removing them changes nothing about repo history) or are a single small tracked file that should never have been committed in the first place, plus the `.gitignore` fix that stops it from happening again. None of these touch `server/data.sqlite`, its `-wal`/`-shm` sidecars, the live capture process, or any file the scheduler reads.

```bash
# 1. Untrack the accidentally-committed pre-migration WAL-journal fragment.
#    This is a 1KB SQLite journal-page fragment of a database that legitimately
#    contains ESPN session cookies (server/db/index.js:210-213 espn_s2/swid columns);
#    it is a stray artifact of an interrupted backup, not a backup itself, and it is
#    currently shipped in every `git ls-files`-based release zip (scripts/package-release.mjs).
#    --cached only removes it from git's index; the file stays on disk untouched.
git rm --cached "server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal"

# 2. Close the .gitignore gap that let #1 happen (and would let it happen again for
#    -wal/-shm sidecars of the same naming scheme, and for the -journal sidecar of the
#    older pre-reset-* scheme). Confirmed gap via `git check-ignore -v` on all four
#    synthetic filename shapes — see SYSTEM_AUDIT_2026_09_11.md Section F.
cat >> .gitignore <<'EOF'

# Backup sidecar files (interrupted VACUUM INTO / crash-mid-backup artifacts) —
# added 2026-09-12 after server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal
# was found tracked in HEAD. Covers both backup naming schemes' -journal/-wal/-shm sidecars.
*.pre-migration-*.bak-journal
*.pre-migration-*.bak-wal
*.pre-migration-*.bak-shm
*.pre-reset-*.bak-journal
EOF

# 3. Remove the empty, untracked evidence directory two plan correction rows (C01/C02)
#    cite as supporting evidence alongside other, sufficient files — the directory itself
#    contributes nothing and is not tracked by git (a plain rmdir is reversible only in the
#    sense that "nothing is lost" — there was nothing in it to lose; confirm it is still
#    empty immediately before running this, since it is a live docs/evidence path).
[ -d "docs/evidence/2026-09-10/slice1" ] && [ -z "$(ls -A docs/evidence/2026-09-10/slice1)" ] && rmdir "docs/evidence/2026-09-10/slice1"

# 4. Verify nothing unexpected is staged before committing tier (a).
git status --short
git diff --cached --stat
```

**Commit tier (a) as its own small commit** (or leave it staged for Nick to commit — this file does not commit anything on your behalf; per the audit's hard rule, no git-state-changing command was ever executed by the auditor). Suggested message:

```
Untrack pre-migration backup journal fragment; close .gitignore gap

The .bak-journal sidecar for a pre-migration VACUUM INTO snapshot was
committed in 889dcf1 and has sat tracked in HEAD since. It is a fragment
of a database that carries ESPN session cookies. .gitignore's existing
backup patterns cover .bak and the pre-reset-* -wal/-shm variants but
never the pre-migration-* -journal/-wal/-shm sidecars — add them.
```

---

## (b) Needs a commit — doc moves, script/module archive, dead-code removal (with importer proof)

Each item below cites the exact zero-importer proof from the audit before proposing removal or a move. Run these as a reviewed batch, not blindly — `git mv`/`git rm` on tracked files changes history and should be look-at-the-diff first, especially for anything touching `server/services/`.

### b.1 — Documentation moves and duplicate cleanup

```bash
# Move the orphaned Run-8 manifest into a dated folder matching every sibling
# evidence artifact's convention (it currently sits loose at the top of docs/evidence/).
mkdir -p docs/evidence/2026-09-01
git mv docs/evidence/NFL_AUDIT_RUN_8_MANIFEST.json docs/evidence/2026-09-01/NFL_AUDIT_RUN_8_MANIFEST.json

# Remove the byte-identical, three-days-staler duplicate of implementation-checks.json.
# Proof: `diff docs/evidence/2026-09-09/implementation-checks.json docs/evidence/2026-09-10/implementation-checks.json`
# returns no differences (confirmed by G20 reader). Keep the earlier, original file.
git rm docs/evidence/2026-09-10/implementation-checks.json
```

**Before running the removal above**, re-run the diff yourself to reconfirm byte-identity (files can drift between audit and cleanup):
```bash
diff docs/evidence/2026-09-09/implementation-checks.json docs/evidence/2026-09-10/implementation-checks.json && echo "CONFIRMED IDENTICAL — safe to remove the 09-10 copy" || echo "STOP — files differ, do not remove, re-investigate"
```

### b.2 — Dead client component (zero importers anywhere in the client)

```bash
# Proof: `grep -rn "PickReasoning" client/src --include='*.tsx' --include='*.ts'`
# returns only the file's own definition, no import anywhere (G15/G16 readers, confirmed).
git rm client/src/components/PickReasoning.tsx
```

### b.3 — Fully dead server tables (schema-level orphans, zero code references)

`auction_sales` and `auction_settings` were added for a feature (auction-draft dollar values) that was built and explicitly reverted the same day (commit `603d6b4`, "not wanted") without a down-migration. Both tables are 0 rows, 0 code references anywhere in `server/` or `client/` (confirmed via H06's full-table inventory and a repo-wide grep for both names). These need a migration, not a raw drop, so the schema and the live DB move together:

```bash
# This creates a NEW migration file — it does not touch the live DB until the app's own
# migration runner applies it on next boot. Do not run this against server/data.sqlite
# directly and do not invoke any migration script yourself (hard rule: read-only on the DB).
# Hand this file to the normal migration-authoring workflow; Nick or the next coding session
# applies it via the app's own startup migration runner, not via a one-off script.
cat > server/db/migrations/036_drop_dead_auction_tables.mjs <<'EOF'
// Drops auction_sales and auction_settings: added 2026-09-04 (10105b1) for an
// auction-draft feature, reverted the same day (603d6b4, "not wanted") without a
// down-migration. Confirmed 0 rows, 0 code references anywhere in server/ or client/
// as of 2026-09-12 (Gridiron HQ full system audit, H06-data-layer).
export function up(db) {
  db.exec(`DROP TABLE IF EXISTS auction_sales;`);
  db.exec(`DROP TABLE IF EXISTS auction_settings;`);
}
export function down(db) {
  // Intentionally not reconstructed — the feature was deliberately reverted.
  // If auction drafting is wanted again, re-add via a fresh migration with the
  // current schema conventions rather than resurrecting the 2026-09-04 shape.
}
EOF
git add server/db/migrations/036_drop_dead_auction_tables.mjs
```

### b.4 — Archive zero-importer (or effectively-orphaned) server services

Each of these was confirmed by its reader (and, where noted, re-confirmed by a verify pass) to have **no importer outside its own test file**, no route, no scheduler job, and no script that calls it. Archiving preserves the content and the git history (`git mv` keeps blame) rather than destroying it — several of these are honest negative results the project's own documented policy says to keep (`docs/CLAUDE-NEXT-STEPS.md` section 10.4, "never discard a negative result").

```bash
mkdir -p research/archive/server-services

# G10a/G10b: replay experiment with zero callers; nfl_neural_replay_audits table is empty.
git mv server/services/nfl-neural-replay.js research/archive/server-services/nfl-neural-replay.js

# G13b: test-only import; documented blocked-contract negative result (genuine research
# value — keep the content, just move it out of the served tree).
git mv server/services/nfl-team-strength.js research/archive/server-services/nfl-team-strength.js
git mv server/services/nfl-preseason-blend.js research/archive/server-services/nfl-preseason-blend.js

# G11: props player-head harnesses — 0/3 documented negative result, test-only imports,
# and two files with ~200 lines of duplication between them. Fold the duplicate into the
# other before archiving both (do this fold manually — a plain git mv would just move the
# duplication, not fix it; if the fold isn't done first, archive both as-is rather than
# leaving the duplication half-fixed).
git mv server/services/nfl-prop-player-heads.js research/archive/server-services/nfl-prop-player-heads.js
git mv server/services/nfl-prop-player-weekly-heads.js research/archive/server-services/nfl-prop-player-weekly-heads.js
git mv server/services/nfl-props-player-features.js research/archive/server-services/nfl-props-player-features.js
git mv server/services/nfl-props-player-features-weekly.js research/archive/server-services/nfl-props-player-features-weekly.js

# G13a: draft-value-of-information measurement tool; own header says it measures an idea
# and changes no ranking. Test-only import.
git mv server/services/draft-abstention-audit.js research/archive/server-services/draft-abstention-audit.js

# G08: staking-policy modules whose only importer is each other, built for a prop-market
# calibrated-Kelly path that was never wired; header admits zero real settled CLV
# observations exist to fit nfl-execution-clv-downsize.js against.
git mv server/services/nfl-execution-staking-policy.js research/archive/server-services/nfl-execution-staking-policy.js
git mv server/services/nfl-execution-clv-downsize.js research/archive/server-services/nfl-execution-clv-downsize.js

git add -A research/archive/server-services
```

**Do NOT include in this batch** (confirmed live/wanted despite looking similar to the above):
- `server/betting/nfl/strategy/margin-distribution.js` — 1,654 lines, zero importers, but explicitly protected by the project's own "never discard a negative result" policy (section 10.4). Its actual defect (citing a test file, `test/margin-distribution.test.js`, that has never existed) should be *fixed*, not used as grounds for removal. **Keep in place.**
- `server/services/nfl-prospective-collection.js` — looked stale to one reader but is in fact live-referenced from a mounted route and rendered on `DataHealth.tsx`; the real defect is its misleading exported status string (see audit Section D.2), not the module's existence. **Keep in place, fix the string separately (code change, not a cleanup-plan move).**
- `server/services/nfl-specialists.js` — only `ridgeFit` is actually consumed (by `nfl-rookies.js`). This needs a real code change (extract `ridgeFit` to a shared util, then archive the rest) before any file move — **do not `git mv` the whole file**; flag for the next coding session instead of including it in this mechanical batch.
- `server/services/nfl-research.js`'s `runNflFeatureAblations` — superseded by `nfl-family-contribution.js` per its own docstring, but still wired at `nfl-market.js:210`. This is a merge (fold callers onto the newer module, then remove), not a plain archive — needs a code change, flag for the next coding session.
- `client/src/pages/Rankings.tsx`, `client/src/pages/Projections.tsx`, `client/src/components/StatTable.tsx` — all zero-importer/orphaned, but each holds a real, otherwise-unreachable write path (drag-reorder, tier assignment, per-player notes, consensus-board creation). **Do not delete or archive until Nick decides whether those features are wanted** (see audit Section J, question 7) and, if so, until they are migrated into `Players.tsx`. Flagging only, no command here.
- `client/src/pages/betting/GameScript.tsx`, `GameSimulator.tsx` — zero importers, but each contains something the live equivalent lacks (a walk-forward validation block; a working "does it work?" honesty tab). **Do not delete** — either re-wire the mount point or fold the missing piece into the live version first. Flagging only, no command here.

### b.5 — Stale comment/doc-text fixes bundled with the above commit (no file moves, small diffs)

These are one- or two-line documentation corrections identified during the audit that are safe to fold into the same review pass as b.1–b.4 (they touch only comments/prose, not executable logic):

- `server/db/schema/README.md` — reconcile the "FROZEN" claim with the two post-freeze edits at `nfl-n-to-z.js:372,377,805-806`, or regenerate the schema manifest.
- `scripts/schema-files.txt` — reword its "DDL-bearing modules" description; 0 of the 122 listed files still carry a `CREATE TABLE` statement post schema-centralization.
- `README.md:176`, `docs/reference/model-governance-manual.md:73` — replace the Run 7 headline (`-11.77%` ROI, 144 bets) with the canonical Run 27/31/32 figures.
- `docs/reference/model-governance-manual.md:811` — strike the claim that `SCHEDULER_DISABLED` is currently set; it is not, and the scheduler is live.
- `docs/CLAUDE-NEXT-STEPS.md` — add the two missing commits' findings (`ab42ac5`, `14c5e65`: unauthenticated execution-slate close, `qualified` fix, 67% teaser-staking fix) and correct the stale test count to 1,623/1,584/0/39.

*(These are content edits, not moves — no `git mv`/`git rm` command applies; listed here so they land in the same reviewed commit rather than being lost.)*

---

## (c) DO NOT TOUCH

Nothing in this section should be moved, removed, renamed, or written to by any cleanup command, script, or future agent working from this file — this is the explicit opposite of a to-do list.

- **`server/data.sqlite`, `server/data.sqlite-wal`, `server/data.sqlite-shm`** — the live database, actively being written by the running server (PID 56651, port 5177) throughout NFL Week 1 T-60 capture. Read-only access only, and only via `node:sqlite` with `{readOnly:true}` in a one-off `node -e`, per the audit's own hard rule.
- **The live capture process itself (PID 56651, port 5177) and anything it depends on at runtime** — `server/index.js`, `server/db/index.js`, `server/services/scheduler.js`, every service the scheduler's 52 registered jobs import. Never start, stop, or restart this process for any reason connected to this cleanup plan.
- **`scripts/tunnel.mjs`'s running child process** (confirmed alive, correctly parenting `cloudflared`) — do not touch.
- **Any table the scheduler reads or writes** — this is effectively all 262 tables in `server/data.sqlite`; the "dead tables" identified in Section b.3 (`auction_sales`, `auction_settings`) are the only two independently confirmed to have zero code references anywhere, and even those are handled via a proper migration, never a raw `DROP TABLE` run by hand.
- **`server/db/migrations/000` through `035`** — the applied migration history. Never edit an already-applied migration file; if a bug is found in one, fix it forward in a new migration (as `036` above does for the auction tables), never by rewriting history.
- **Anything under `.git/`** — no git commands beyond the read-only ones already used for this audit (`log`, `show`, `diff`, `status`, `blame`) were ever run, and this cleanup plan's own commands are limited to `git rm`, `git mv`, `git add`, and `git status`/`git diff --cached` for review — no `push`, `reset`, `rebase`, or `checkout -- <path>`.

### The two items this plan will never recommend deleting without Nick's explicit decision

> **Per the standing constraint on this task: neither item below is proposed for deletion here. Both are described so Nick can decide, and this section exists specifically so that decision is never made by default.**

**1. `server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak` (≈9.8 GB, referred to elsewhere in the audit as "the 9.8 GB pre-migration backup").**
What it is: an automatic `VACUUM INTO` snapshot taken by `assertRoomForSnapshot`/`backupBeforeMigration` (`server/db/index.js`) immediately before the most recent set of schema migrations were applied on 2026-09-11. It is the one and only recovery point that lets the database be rolled back to its exact pre-migration-035 state, including every row of ESPN league/roster/cookie data, every captured quote, and the entire T-60 capture history up to that timestamp. The code's own design philosophy (confirmed in this audit) deliberately never auto-prunes snapshots like this one — "deleting a recovery point is a judgment call that belongs to a person who knows what's in it." This audit agrees with that design and will not override it. **Nick must decide**: keep it as an active recovery point (current cost: ~9.8 GB of the ~66 GB free), move it to external/off-machine storage (recommended, since there is currently no off-machine backup of the live DB at all per H05), or delete it once confident the post-migration state is stable and no rollback will ever be needed.

**2. The `server/data/` lab-output directories (Python research lab artifacts under `research/`/`server/data/*-lab/`, including the confirmed byte-for-byte duplicate run `market-lab/20260908T152001Z-7f69ded8/`).**
What they are: frozen output snapshots from the Python research labs (`market_lab.py`, `tree_lab.py`, `book_lag_lab.py`, `expert_selector_lab.py`, and others) — each run's fitted models, metrics, and reports, used as the evidentiary record for every research conclusion cited in this audit's Section C (including the "no NFL betting edge exists" finding measured three times). Even the confirmed duplicate run is not proposed for deletion here, because a duplicate run is still evidence that the pipeline is reproducible byte-for-byte — that has research value distinct from disk space. **Nick must decide**: which runs (if any) are safe to prune, whether the duplicate specifically should be kept as a reproducibility record or removed as pure waste, and whether any retention window should apply going forward given there is currently no policy for this directory at all (Section F of the audit).

---

## Summary of what this plan actually changes if run in full

- Tier (a): 1 file untracked (stays on disk), 1 `.gitignore` addition, 1 empty directory removed. Zero risk to any running process or live data.
- Tier (b): 1 file moved, 1 duplicate file removed (after a live re-check), 1 new forward migration added (not yet applied — applies only when the app's own migration runner next boots), 8 server-service files archived with git history preserved, plus a handful of doc/comment text corrections. All backed by a specific zero-importer or byte-identity proof cited above; none delete anything without a `git mv` (recoverable) except the one confirmed-duplicate JSON file.
- Tier (c): nothing changes. It exists to draw the boundary the rest of this plan, and any future cleanup pass, must respect.
- Nothing in this plan touches `server/data.sqlite`, the 9.8 GB backup, or the lab-output directories — those last two are surfaced for Nick's decision, not acted on.
