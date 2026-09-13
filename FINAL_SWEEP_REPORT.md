# Final sweep: unify-2026-09-12-integration + insane-2026-09-13-integration

Branch: `final-sweep-2026-09-13`, worktree `/tmp/gridiron-final-sweep`, based on
`unify-2026-09-12-integration` (ec847f3) with `insane-2026-09-13-integration`
(8d7a183) merged in (`--no-ff`, commit 3eb8854). Not pushed; not merged into
the real `main`. All commands run with a fresh `/tmp` `GRIDIRON_DB_PATH`; the
real `server/data.sqlite` was touched only via `node:sqlite`'s `{ readOnly:
true }` for the two spot-checks below.

## 1. What merged

Both branches shared the same earlier base, `model-2026-09-12-integration`
(e7662e7), so this merge is the union of two independent sets of work built
on top of it:

**From `unify-2026-09-12-integration`** (already the worktree's starting
point — architecture unification, historical verdict, urgent fixes):
week-sync cross-check, market-identity assertion, beat-the-close settlement
widening, CLV abstention-inclusive grading + pre-registration, prop-quote
reconcile backfill, migration renumbering (041→046, 045/046→047/048), the
historical leaderboard re-verification, and Stage 2's architecture
consolidation — deleting the duplicate `nfl-clv.js` and `nfl-neural-replay.js`
engines into `clv-core.js` and `nfl-replay.js`.

**From `insane-2026-09-13-integration`** (newly merged): props-to-spread
consistency checking (`props-total-consistency.js`, `bottom-up-team-total.js`),
execution realism (naive-vs-depth-aware Polymarket fill measurement, bounded
margin distribution, shopping-board historical-bias fix, quote-tape join
bug fixes in both `beat-the-close.js` and `nfl-shopping-board.js`), and the
news-timing investigation (`nfl-news-market-latency.js` event-study model,
entity-extraction and multi-player status fixes) culminating in
`NEWS_TIMING_REPORT.md`'s "no real speed edge" verdict.

### Conflict resolution

Exactly one real content conflict, in `server/services/beat-the-close.js`:
both branches independently added an import line — unify added
`STALE_BOOK_HOURS` from `book-feeds.js`, insane added `CAPTURE_WINDOW_MS`
from `nfl-shopping-board.js`. Both symbols are actually referenced later in
the file (`STALE_BOOK_HOURS` at the reachable-quote cutoff, `CAPTURE_WINDOW_MS`
at the capture-window filter), so this was a genuine union, not an either/or
choice — resolved by keeping both imports. Confirmed with `node --check`
after resolving.

Everything else auto-merged cleanly, including the union of two branches
each rewriting ~46 files under `server/services/` (`nfl-ensemble.js`,
`nfl-replay.js`, `weekly-learning.js`, etc.) — checked specifically because
that overlap looked risky: `insane-2026-09-13-integration` never touched
`nfl-clv.js`, `nfl-neural-replay.js`, `nfl-replay.js`, or `clv-core.js`
relative to the shared base (`git diff` against all four is empty), so
git's 3-way merge correctly kept unify's architecture-unification result
(the duplicate engines deleted) rather than silently reintroducing them via
insane's now-stale imports. Verified by hand, not just trusted.

### One non-conflict I fixed anyway: migration number collision

`insane-2026-09-13-integration` added
`045_line_snapshots_market_captured_index.js` (an index, unrelated content)
while `unify-2026-09-12-integration` already had an unrelated
`045_market_identity_flag.js` — different filenames, so git raised no
conflict, but two migrations sharing a number is exactly the class of issue
this repo has explicitly fixed before (see `unify`'s own
"Renumber historical branch's two migrations 045/046 -> 047/048" and
"Renumber u5's audit-registry migration 041 -> 046" commits). Renumbered
the newer one to `049_line_snapshots_market_captured_index.js` (049 was
free) and updated its internal `name` export to match. Confirmed read-only
against the real database that neither `045_line_snapshots_market_captured_index`
nor `049_line_snapshots_market_captured_index` appears in `schema_migrations`,
so nothing was already applied under either name — the rename is safe. The
two 045 migrations are additive and independent (one adds a column, the
other an index only) with no ordering dependency, so this was a naming fix,
not a behavioral one.

## 2. Full suite — real counts

- **`npm test`**: 1985 tests, **1945 pass, 1 fail**, 0 cancelled, 39 skipped,
  0 todo. Runtime 172.7s.
  - The one failure — `test/nfl-execution-pipeline.test.js:62`,
    `resolveQuoteBasis: prefers the real multi-book quote tape when this
    event is actually covered by it` (`AssertionError: expected 'quote_tape',
    got undefined`) — is **pre-existing**, not introduced by this merge.
    Confirmed two ways: (1) both parent branches' own tip commits document
    it independently — unify's Stage 2 commit (47965a5) says "1
    pre-existing unrelated failure ... confirmed failing identically on the
    unmodified branch tip," and insane's integration report (8d7a183) says
    "1 pre-existing unrelated failure (confirmed present on the base branch
    before any merge)"; (2) I diffed the failing test's exact source lines
    against the shared base commit (e7662e7) — byte-identical, same
    assertion, same line number. This merge did not touch
    `test/nfl-execution-pipeline.test.js` at all.
- **`npm run typecheck`**: clean, zero output, zero errors.
- **`npm run lint`**: clean — "Syntax checked 678 JavaScript files;
  TypeScript/TSX is covered by npm run typecheck."

## 3. Spot-checks against real `server/data.sqlite` (read-only)

### (a) Zero ensemble fit artifacts have ever cleared the promotion gate

Independently re-queried, not trusted from the report text or code comments:

```
artifact rows (nfl_ensemble_fit_artifacts):        848
total component-cutoff rows (models[] across all): 26,288
component rows with residual_gate_passed === true:      0
component rows with residual_diagnostic_passed === true: 0
artifacts where residual_gate_pass_count !== 0:          0
```

**Reproduces exactly.** 848 artifacts / 26,288 component-cutoff rows / zero
gate passes matches the claim in both the code comment
(`server/migrations/045_market_identity_flag.js`, `nfl-ensemble.js` line
~1668) and `HISTORICAL_VERDICT_REPORT.md` precisely — not approximately.

### (b) News-timing report's core numbers

- **`nfl_verified_events` row count**: queried directly —
  **119,639**, matching the report's "119,639 rows" exactly.
- **The hand-verified Tua Tagovailoa injury-to-market-move trace**: pulled
  both `nfl_news_signals` rows and the `nfl_line_snapshots` quote history
  directly.
  - `news_id=79643` (ESPN, "limited," oblique) — `published_at
    2026-09-11T17:11:19.000Z`, `verification_state: verified`. Matches.
  - `news_id=88948` (Twitter/@tori_mcelhaney, "out") —
    `published_at 2026-09-11T17:24:21.000Z`, `verification_state: verified`.
    Matches.
  - Pinnacle PIT −spread quote sequence, queried directly from
    `nfl_line_snapshots` (book=`pinnacle`, market=`spreads`,
    home=Pittsburgh Steelers, away=Atlanta Falcons): every captured_at/
    line/price triple in the report's table (16:11:20 → −5/−106,
    **17:23:12 → −5/−113**, 18:38:32 → −5/−114, 19:39:02 → −5/−114,
    20:14:16 → **−6**/−108, 20:42:31 → −6/−106, 21:43:23 → −6/−106) matches
    the live data exactly, row for row.

**Reproduces exactly**, both the aggregate count and the single
hand-verified trace. On the code side: the merge changed
`nfl-news-market-latency.js` only via insane's own work (never touched by
unify), and the full suite's only failure is the unrelated, pre-existing
`nfl-execution-pipeline.test.js` case above — every `model-integrity.test.js`
news-latency test, including the new "market-model baseline absorbs a
leaguewide vig shift but still catches an idiosyncratic move" test added by
this merge, is accounted for in the 1945 passing tests.

## 4. Verdict

**ready_for_deploy: true**

Nothing found here is broken by this merge. The single conflict was a
genuine, correctly-resolved import union; the migration-number collision was
cosmetic and fixed to match the repo's own established convention; the only
failing test is a pre-existing, independently-documented, byte-identical
failure neither branch introduced or touched; typecheck and lint are clean;
and both headline claims — the zero-promotion-gate history and the
news-timing report's core numbers — reproduce exactly against the real
database, not just against each branch's own prior claims about itself.

Nothing here overrides Nick's own pending items already flagged in
`unify`'s final report (the out-of-band write to the live database by a
prior session via `scripts/backfill-prop-quote-reconcile.mjs`, confirmed
read-only and NOT performed by this integration) — that item is still his
to review, unrelated to this merge's correctness.

## blocking_issues

None.
