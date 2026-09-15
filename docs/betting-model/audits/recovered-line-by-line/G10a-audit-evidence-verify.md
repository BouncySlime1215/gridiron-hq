# Verification pass: G10a-audit-evidence (9 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only throughout).
DB accessed only via `node:sqlite` `DatabaseSync(..., { readOnly: true })` one-liners.

## #69 / #70 — audit-registry key mismatch (pValue/sampleSize vs p_value/sample_size)

Files fully read:
- scripts/audit-football-first.mjs (163 lines, all read)
- scripts/audit-trend-totals.mjs (205 lines, all read)
- server/services/audit-registry.js (333 lines, all read)
- test/audit-registry-always-valid.test.js (83 lines, all read)

`runAudit` (audit-registry.js:137-272) reads the producer's return value with
snake_case keys: `result?.p_value` (line 199, used again at 234), `result?.sample_size`
(line 235, 265), and `result?.sequence` (line 207). The doc-comment at
audit-registry.js:114 states the contract explicitly:
`{ observed, sample_size, p_value?, detail?, sequence? }`. The test suite
(test/audit-registry-always-valid.test.js:39-41, 54, 67-68) uses `sample_size`/`p_value`
consistently, confirming this is the real, intended contract, not a typo in the reader.

Both `scripts/audit-football-first.mjs` (return block at lines 121-135) and
`scripts/audit-trend-totals.mjs` (return block at lines 163-176) return
`sampleSize`/`pValue` (camelCase) instead. Neither key is read by the registry, so
`result?.p_value` and `result?.sample_size` are both `undefined` -> stored as NULL.

Consequence traced through the code:
- audit-registry.js:199 `p = null` -> :200 `significant = null`.
- Both scripts set `requireSignificance: true` in `preregister(...)`
  (audit-football-first.mjs:70, audit-trend-totals.mjs:99), so
  audit-registry.js:226-228 `passed = a.require_significance ? (meetsThreshold &&
  significant === true && alwaysValidSignificant === true) : meetsThreshold` — since
  `significant` is `null`, `significant === true` is false, so `passed` is forced
  false regardless of the observed rate.
- audit-registry.js:234-235 persist NULL into `p_value`/`sample_size` on the sealed row.

Confirmed directly against the live (read-only) DB:

```
id=13 (trend totals):        p_value=null sample_size=null significant=null passed=0
id=14 (football-first v1):   p_value=null sample_size=null significant=null passed=0
id=15 (football-first v2):   p_value=null sample_size=null significant=null passed=0
```//exact match to the observed rates cited in the claims (0.4381, 0.5789, 0.4835).

Impact/severity: this is the registry whose entire stated purpose (audit-registry.js:1-29
docstring) is to prevent p-hacking a betting model's evidence base by sealing a verdict
once. All three of the registry's significance-required audits filed so far are silently
broken: they're sealed forever (no re-run possible by design, audit-registry.js:140-144)
with a permanently-null p-value and a hardcoded FAIL verdict that never reflected the
computed z. `auditHistory()`'s `survive_correction`/`significant_uncorrected_only` lists
(audit-registry.js:302-304) also silently exclude these rows because they filter on
`Number.isFinite(a.p_value)`. This is a real, confirmed defect that corrupts a "decision
recorded" system Nick built specifically to keep future model-evaluation honest. P1 for
both #69 and #70 is justified — NOT REFUTED.

## #71 — shadow-ledger.js CLV computed against live spread/total, not closing_spread/closing_total

Files fully read:
- server/services/shadow-ledger.js (123 lines, all read)
- server/services/gamescript.js (lines 1-234 read in full for the sync job; rest of file
  is unrelated OLS/fitting code, skimmed for context only, not needed for this claim)
- server/services/forward-ledger.js (lines 100-170 read for the parallel settle path)

`settleNflShadowDecisions()` (shadow-ledger.js:57-105) reads
`SELECT spread,total,team_score,opp_score FROM game_lines ... WHERE ... home=1`
(line 71) and computes `closingLine` directly from `game.spread`/`game.total`
(lines 83, 90), then `clv = decision.line - closingLine` (line 84) /
`clv = over ? closingLine - decision.line : decision.line - closingLine` (line 91-92).

Verified `game_lines` really carries a separate, deliberately-frozen closing pair:
`PRAGMA table_info(game_lines)` (read-only) lists both `spread`/`total` AND
`closing_spread`/`closing_total` as distinct columns.

Verified `spread`/`total` are NOT guaranteed to be the closing number, by reading
gamescript.js's sync job in full:
- lines 120-137: the general UPSERT unconditionally overwrites `spread`/`total`
  with `hs`/`total` from ESPN's current odds object every time the job runs and ESPN
  still returns an `odds` object — this write is NOT gated on being pre-kickoff.
- lines 145-153 (comment) + line 226-229 (code): `closing_spread`/`closing_total` are
  only ever written inside `if (preKickoff) { closeStmt.run(...) }` — i.e. only while
  `now < commenceTime`. The comment at 145-151 explicitly documents this as "Freezes
  the true close... Once kickoff passes this is never called again for that row."
- lines 138-140 comment: "ESPN removes the odds object once a game is final... the last
  pre-final line stays" — i.e. the code's own author acknowledges `spread`/`total` can
  be whatever ESPN's odds object last contained before removal, which is not
  contractually the same moment as kickoff.

This is independently corroborated by forward-ledger.js's own settlement path
(forward-ledger.js:149-153), which explicitly does NOT use plain `spread`/`total`:
```
// Prefer the frozen true close (last line observed strictly before
// kickoff) over the live spread/total, which syncCurrentLines can
// overwrite with an in-game number after kickoff. Falls back to the live
// columns only for games synced before closing_spread/closing_total existed.
const closeSpread = g.closing_spread ?? g.spread;
const closeTotal = g.closing_total ?? g.total;
```
This is the codebase's own documented acknowledgment that `game_lines.spread/total`
can be overwritten with an in-game number post-kickoff, and that this is a known
hazard forward-ledger.js was written to avoid. shadow-ledger.js does not apply the
same `closing_spread ?? spread` fallback — it uses the raw, unprotected columns.

Verified shadow_decisions really is treated as the "untouched" forward evidence:
nfl-blind-audit.js:194 states "The genuinely untouched gate is the 2026 forward shadow
ledger" as one of the frozen spec's `rules`, and server/services/nfl-evidence.js:114-119
reads directly from `shadow_decisions` to report forward decision/settlement counts as
part of the evidence firewall.

Impact/severity: this is the one ledger the codebase treats as the trustworthy,
non-retrofittable measure of real-world edge, and its CLV column can silently be
computed against a number that moved after kickoff instead of the frozen close — exactly
the failure mode forward-ledger.js was patched to avoid elsewhere in the same codebase.
P1 is justified — NOT REFUTED.

## #72 — nfl-blind-audit.js post-compute freeze recheck rehashes 31 tables under BEGIN IMMEDIATE; busy_timeout exceeded

Files fully read:
- server/services/nfl-blind-audit.js (1005 lines, all read)
- server/db/index.js (lines 1-40 read for the busy_timeout pragma; remainder is
  migration-runner infrastructure irrelevant to this claim)

Traced the exact call chain:
- `openNextWeek` (nfl-blind-audit.js:841-915) computes a week's result, then at
  line 888 `db.exec('BEGIN IMMEDIATE')`, and at line 893 calls `assertFrozen(record)`
  a second time (the comment at 890-892 says this is "the final race" check) while
  holding that write lock, before the INSERT at 894-897 and COMMIT at 912.
- `assertFrozen` (lines 232-249): calls `inputMutationState(...)` first (line 238); at
  line 239 `if (priorMutation >= 0 && mutations.latest <= priorMutation) return;` is
  the ONLY shortcut that skips the expensive rehash — it only fires if the mutation
  journal's MAX(id) has NOT advanced since the last check for this run.
  Otherwise, line 240 calls `inputDataState(spec)`, which (lines 95-157) does a
  `SELECT ... FROM {table} ... ORDER BY rowid` and a full SHA-256 hash of every row,
  for all 31 tables in `INPUT_TABLES` (lines 40-51).
- Given a live capture process is actively writing rows into
  `nfl_line_snapshots`/`nfl_quote_tape`/etc (both in `INPUT_TABLES`), the mutation
  journal's MAX(id) will virtually always have advanced between the pre-compute
  `assertFrozen` call at line 848 and the post-compute one at line 893, forcing the
  full 31-table rehash on essentially every week during an in-season capture window.

Verified against the live (read-only) DB that this actually happened, matching the
claim's own cited numbers exactly:
```
run_id=31: n=70, avg persist_ms=28584.4, max persist_ms=414454
run_id=32: n=70, avg persist_ms=21506.0, max persist_ms=63389
```
(claim's summary said "run 32 persist avg 21,506 ms max 63,389 ms; run 31 max
414,454 ms" — exact match.)

Verified `server/db/index.js:18`: `PRAGMA busy_timeout = 15000;` — confirmed literal
value. Persist times of 63.4s (run 32 max) and 414.5s (run 31 max) are ~4x and ~27x
this timeout, while the BEGIN IMMEDIATE write lock is held for that entire span.

Impact/severity: this directly threatens exactly the kind of concurrent-write
scenario the audit's own environment right now embodies (a live T-60 capture process
writing into these same 31 tables). A long-held write lock during that window risks
SQLITE_BUSY failures on the capture path (a missed forward-evidence packet), which is
data-integrity-affecting and not cosmetic. The claim's own severity assignment of P2
is a defensible (if arguably conservative) call given it's a live-writer risk on a
system explicitly flagged as untouchable infra elsewhere in this project. NOT REFUTED.

## #73 — nfl_blind_input_mutations table grows without bound

File nfl-blind-audit.js already fully read above (line 56 confirmed: only
`SELECT COALESCE(MAX(id),0) id FROM nfl_blind_input_mutations` is read there).

Grepped the whole repo (`server/` and `scripts/`) for any DELETE against this table —
none found. The only other consumer is
server/betting/nfl/strategy/teaser-leg-rates.js:201, which reads
`SELECT COUNT(*) n FROM nfl_blind_input_mutations WHERE table_name = 'game_lines'`
as a cache-invalidation stamp — also a read-only consumer, and this COUNT(*) actually
gets more expensive, not less, as the table grows unbounded (slightly widens the
claim's "only MAX(id) is ever consumed" framing but does not weaken the core defect).

Verified current row counts against the live (read-only) DB:
```
total: 5,273,692 rows
nfl_line_snapshots: 1,845,448
nfl_quote_tape:      1,680,267
nfl_depth:             346,805
nfl_snaps:             253,122
game_lines:            218,648
```
These are close to (slightly higher than, consistent with continued live growth since)
the claim's cited "5,103,652 rows... nfl_line_snapshots 1,766,124... nfl_quote_tape
1,607,063."

Impact/severity: real, unbounded write amplification (triggers fire on every quote
capture across many tables) and DB bloat for a value a per-table integer counter would
serve just as well. This is infrastructure debt rather than a wrong number on a page —
P2 as submitted is fair (not P1, since nothing displayed to Nick is wrong because of
this by itself; it does compound #72's lock-duration risk as the table it's queried
against grows). NOT REFUTED.

## #74 — nfl-audit-overview.js spread_only.uncertainty computed on lower-cased results vs nfl-replay's Won/Lost filter

Files fully read:
- server/services/nfl-audit-overview.js (272 lines, all read)
- server/services/nfl-replay.js — read lines 1-90 (the `uncertainty` function and its
  immediate context); remainder of the 1102-line file is the replay engine itself,
  unrelated to this claim and not needed to verify it.

Confirmed nfl-audit-overview.js:116 lower-cases every pick's result:
`const result = typeof pick.result === 'string' ? pick.result.trim().toLowerCase() : null;`
and that this lower-cased `result` is what's pushed into `allBets` (line 125-126) and
filtered into `spreadBets` (line 173). `uncertainty(spreadBets)` is called at line 221.

Confirmed nfl-replay.js's `uncertainty` (lines 43-74) filters strictly on the
capitalized literals:
- line 44: `bets.filter(b => b.result === 'Won' || b.result === 'Lost')`
- line 57: `sample.filter(b => b.result === 'Won' || b.result === 'Lost')`
- line 58: `graded.filter(b => b.result === 'Won').length`

Since `spreadBets[i].result` is always lower-case ('won'/'lost'/'push'/etc, per
nfl-audit-overview.js:117-121), `graded` at line 57 is always empty for every one of
the 4000 bootstrap trials, so line 59 `winRate: graded.length ? wins / graded.length : 0`
is always `0`. `win_rate_95` (line 67) is therefore `[quantile(all-zeros,.025),
quantile(all-zeros,.975)] = [0, 0]` for every run. `roi_95` (line 68) is unaffected
because it's computed from `sample.map(b => b.units)` (line 59), which does not
depend on the result-string casing at all — confirming the claim's own caveat that
"roi_95 is unaffected."

Impact/severity: real defect, a genuinely wrong confidence interval is reported on a
number Nick would read (spread_only's uncertainty band) — but note that
`spread_only.win_rate` itself (line 219, computed directly from `spreadWins`/
`spreadLosses` counted with the correct lower-case-aware `isWin`/`isLoss` helpers at
lines 187-188) is NOT affected — only the bootstrap confidence *interval* around it
collapses to a degenerate `[0,0]`. That's a real but narrower defect than "the win
rate is wrong" — P2 as submitted (not P1) is the right call. NOT REFUTED.

## #75 — listBlindAudits() estimated_remaining_ms always overstated because weekLimit:0 makes weeks.length=0

nfl-blind-audit.js already fully read above.

Confirmed at line 991-994:
```
export function listBlindAudits() {
  return rows('SELECT id FROM nfl_blind_audit_runs ORDER BY id DESC').map(x => blindAuditStatus(x.id, {
    weekLimit: 0,
    compact: true
  }));
}
```
`weekLimit: 0` is NOT `null`, so in `blindAuditStatus` (line 959) `weekLimit == null`
is false: `limit = ' LIMIT ?'` (line 963) and `params = [record.id, Math.max(0,
Number(0)||0)] = [record.id, 0]` (line 964) — the weeks query at line 965-967
therefore returns zero rows (`LIMIT 0`), so `weeks = []` (line 968, after `.reverse()`
on an empty array) regardless of how many weeks are actually opened.

`estimated_remaining_ms` (line 983-984):
```
estimated_remaining_ms: averageTotalMs == null ? null
    : averageTotalMs * Math.max(0, record.spec.schedule.length - weeks.length),
```
Since `weeks.length` is always 0 here, this evaluates to
`averageTotalMs * record.spec.schedule.length` — the FULL schedule length (70 for a
standard 5-season x 14-week spec, matching the claim's "avg x 70") — every time,
including for a `status: 'complete'` run where the real remaining time is 0.

Meanwhile `opened` (line 962, `COUNT(*) FROM nfl_blind_audit_weeks WHERE run_id=?`)
is computed correctly and independently of `weekLimit`, so the `progress.opened` field
in the same response is accurate while `performance.estimated_remaining_ms` is not —
confirming the claim's framing precisely.

Impact/severity: cosmetic but genuinely wrong number on the audit list dashboard view
(a "number Nick reads on a page"). P2 as submitted is appropriate — it's a
progress/ETA estimate, not a correctness-of-evidence issue. NOT REFUTED.

## #76 — nfl-candidate-analysis.js macroDiagnosis has hardcoded verdict/state literals

Files fully read:
- server/services/nfl-candidate-analysis.js (313 lines, all read)
- grepped nfl-diagnostic.js for the surfacing path (`candidate_robustness:
  latestCandidateRobustnessReport()` at nfl-diagnostic.js:144, confirmed).

Confirmed `macroDiagnosis` (lines 191-, return block starting 210):
- line 211: `verdict: 'The candidate is not profitable. The failure is primarily
  forecast/selection quality, not missing rows or a lack of model complexity.'` —
  a literal string, not built from any of the function's computed inputs
  (`gap`, `reliabilityLift`, `weakEdge`, `bestEdge`, etc. are all available in scope
  but none feed this string).
- line 220: `data_integrity: { state: 'not_primary_failure', ... }` — literal.
- line 234: `regime_instability: { state: 'critical', ... }` — literal.

Contrast confirmed against sibling fields in the SAME decomposition object that ARE
computed from live data: `selection_dilution.state` (line 224,
`weakEdge?.roi < 0 ? 'critical' : 'unclear'`), `edge_ranking.state` (line 229),
`candidate_increment.state` (line 239), `roster_signal.state` (line 244),
`automatic_learning.state` (line 251) — all ternaries over computed values. Only
`data_integrity` and `regime_instability`'s states, and the top-level `verdict`, are
bare string literals with no data dependency.

`latestCandidateRobustnessReport()` (line 309, calling `macroDiagnosis` at line 298)
is confirmed surfaced verbatim as `candidate_robustness` in nfl-diagnostic.js:144.

Impact/severity: a real defect — this is a diagnostic report explicitly presented as
data-driven findings, and three of its fields (including the top-line `verdict`) are
constants that would read identically regardless of what the computed numbers show.
Given the model currently IS believed to have no edge (consistent with project
memory), the literal happens to currently agree with reality, but the code has no
mechanism to ever change it if that stopped being true — which is exactly the kind of
silently-stale "decision recorded" the impact lens flags. P2 (misleading output,
not a wrong number feeding a stake) as submitted is fair — NOT REFUTED.

## #77 — missed/blocked extra point charged as 3 variance points instead of 1

Files fully read (this function's full context):
- server/services/nfl-postgame-truth.js lines 340-435 (residualDecomposition, its
  neighbours, and the filtration/buildPostgameTruth boundary) — full read of relevant
  section; the rest of this 657-line file (packet assembly, expert-council joins) is
  unrelated to this narrowly-scoped claim and wasn't needed to verify it.
  Also read lines 580-606 for the persistence path.

Confirmed at nfl-postgame-truth.js:383-386:
```
if (play.play_type === 'fg_miss' || /blocked/i.test(text) && /field goal|extra point/i.test(text)) {
  const sign = play.offense === home ? -1 : play.offense === away ? 1 : 0;
  if (sign) items.push({ kind: 'missed_or_blocked_kick', period: play.period, home_points: sign * 3, text: text.slice(0, 120) });
  continue;
}
```
The condition on line 383 explicitly admits extra-point text via the
`/field goal|extra point/i` alternation combined with `/blocked/i`, so a play whose
text says e.g. "PENALTY... extra point is blocked" or similar matches this branch.
`home_points` is unconditionally `sign * 3` regardless of whether the matched play was
a field goal (worth 3) or an extra point (worth 1) — there is no branch that charges 1
point for the PAT case.

Confirmed persistence: `variance_points`/`adjusted_residual` (computed at
lines 401-408, `variance = items.reduce((sum,item)=>sum+item.home_points,0)`) are
written to `nfl_game_variance` at two call sites — `recordPostgameTruthWeek`'s bulk
path (lines 580-582) and `persistPostgameTruth` (lines 597-599) — both confirmed
present and writing `d.variance_points, d.adjusted_residual, d.raw_residual`.

Impact/severity: confirmed, narrow, systematic +/-2 point overstatement of variance
attribution (and hence understatement/overstatement of `adjusted_residual` by 2 points
in the opposite direction) specifically for games with a missed or blocked PAT. This
is a real but low-frequency event (blocked/missed PATs are rare, single-digit per
season league-wide), and `adjusted_residual` is a training/diagnostic feature rather
than something that changes a stake directly — but it IS a persisted number that
feeds model diagnosis. P2 as submitted (not P1) is appropriate — NOT REFUTED.

## Summary table

| key | file:line | submitted severity | verdict |
|---|---|---|---|
| #69 | scripts/audit-football-first.mjs:121 | P1 | CONFIRMED, P1 |
| #70 | scripts/audit-trend-totals.mjs:163 | P1 | CONFIRMED, P1 |
| #71 | server/services/shadow-ledger.js:71 | P1 | CONFIRMED, P1 |
| #72 | server/services/nfl-blind-audit.js:888 | P2 | CONFIRMED, P2 |
| #73 | server/services/nfl-blind-audit.js:56 | P2 | CONFIRMED, P2 |
| #74 | server/services/nfl-audit-overview.js:125 | P2 | CONFIRMED, P2 |
| #75 | server/services/nfl-blind-audit.js:983 | P2 | CONFIRMED, P2 |
| #76 | server/services/nfl-candidate-analysis.js:211 | P2 | CONFIRMED, P2 |
| #77 | server/services/nfl-postgame-truth.js:383 | P2 | CONFIRMED, P2 |

All 9 claims survive adversarial review at their submitted severities. Every claim
was independently re-derived from the source and, where the claim cited DB evidence,
independently re-queried read-only against the live database with matching (or
slightly-further-along, consistent-with-ongoing-growth) numbers.
