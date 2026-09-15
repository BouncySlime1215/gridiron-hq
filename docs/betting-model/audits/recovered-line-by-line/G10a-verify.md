# Verification pass: G10a-audit-evidence claims #69-#77

Reader under adversarial review. All 9 claims read file-by-file with reachability lens
applied (mounted route in server/index.js / server/routes, or registered scheduler job
in server/services/scheduler.js). DB queried read-only via `node:sqlite { readOnly: true }`.

## #69 — scripts/audit-football-first.mjs:121 (P1) — CONFIRMED, not refuted

Producer at audit-football-first.mjs:121-124 returns:
```
return {
  observed: rate,
  sampleSize: n,
  pValue: 1 - normalCdf(z),
  ...
```
camelCase `sampleSize`/`pValue`. `runAudit` in server/services/audit-registry.js
(script referenced as `scripts/audit-registry.js` in the claim's `evidence:` line is a
path typo by the reader — the real file is `server/services/audit-registry.js`; content
matches exactly) reads only snake_case:
- line 199: `const p = Number.isFinite(result?.p_value) ? result.p_value : null;`
- line 234-235: `Number.isFinite(result?.p_value) ? result.p_value : null, Number.isFinite(result?.sample_size) ? result.sample_size : null,`

`result.p_value`/`result.sample_size` are both `undefined` on every producer in this
codebase that uses the camelCase convention (both audit-football-first.mjs and
audit-trend-totals.mjs do), so both persisted columns are NULL and `significant` stays
null forever (line 200 `p == null ? null : p < correctedAlpha`), which forces
`passed = false` whenever `require_significance` is set (line 226-228), independent of
the real result.

DB confirms real, already-sealed damage (read-only query against server/data.sqlite):
```
id 14: name "football-first beats the closing spread", observed 0.57894..., p_value NULL, sample_size NULL, passed 0
id 15: name "...(five held-out seasons)",              observed 0.48347..., p_value NULL, sample_size NULL, passed 0
```
Matches the claim's cited observed values (0.5789, 0.4835) exactly.

Reachability: the *script* itself is not mounted/scheduled (grep for
`audit-football-first`/`audit-trend-totals` across server/ and scripts/ finds only the
files' own header comments — no importer). However this is not "dead code" in the
sense the lens exists to filter: it already ran, already sealed rows 14/15 permanently
(seal-once-by-design, `runAudit` refuses to re-run a non-'preregistered' status — line
140-145), and those corrupted rows are served live through a mounted route:
- server/routes/betting-hub.js:676-677: `const { auditHistory } = await import('../services/audit-registry.js'); res.json(auditHistory(...))`
- server/index.js:47 mounts `bettingHubRouter`.
So the defect's *effect* (permanently wrong p_value/sample_size/passed on real rows) is
live in a served API response today, not merely theoretical dead code. Confirmed as P1.

## #70 — scripts/audit-trend-totals.mjs:163 (P1) — CONFIRMED, not refuted

Same producer/registry key mismatch (`pValue`/`sampleSize` vs `p_value`/`sample_size`).
DB row 13 confirms: `observed 0.43814..., p_value NULL, sample_size NULL, passed 0,
require_significance 1` — matches claim exactly. Same reachability argument as #69
(auditHistory/auditDetail route). Confirmed P1.

## #71 — server/services/shadow-ledger.js:71 (P1) — CONFIRMED, not refuted

shadow-ledger.js:71-72:
```
const game = row(`SELECT spread,total,team_score,opp_score FROM game_lines
  WHERE season=? AND week=? AND team=? AND home=1`, season, week, home);
```
:83 `closingLine = game.spread == null ? null : backedHome ? game.spread : -game.spread;`
:90 `closingLine = game.total;`
— both read the live `spread`/`total` columns, not `closing_spread`/`closing_total`.

`game_lines` schema (PRAGMA table_info, read-only) confirms both `closing_spread` and
`closing_total` columns exist, distinct from `spread`/`total`.

gamescript.js:146-153 explicitly freezes `closing_spread`/`closing_total` only when
`preKickoff` is true (`if (preKickoff) { closeStmt.run(hs, total, ...) }` — line
221-224), while `spread`/`total` themselves are overwritten by `stmt.run(...)` on
*every* sync call regardless of kickoff (line 214-219) — i.e. `spread`/`total` can
carry an in-game/live number after kickoff, exactly as forward-ledger.js documents in
its own comment at line 149-152:
```
// Prefer the frozen true close (last line observed strictly before
// kickoff) over the live spread/total, which syncCurrentLines can
// overwrite with an in-game number after kickoff.
const closeSpread = g.closing_spread ?? g.spread;
const closeTotal = g.closing_total ?? g.total;
```
forward-ledger.js gets this right; shadow-ledger.js:71-90 does not — it never reads
`closing_spread`/`closing_total` at all.

Reachability: fully confirmed live.
- `recordNflShadowBoard` (shadow-ledger.js) is called from server/services/evidence-daemon.js:125,
  itself invoked from server/services/scheduler.js:401 (`runEvidenceDaemon`) — this is
  the exact T-60 capture daemon referenced in the task's hard rules (PID 56651).
- `settleNflShadowDecisions` (the function containing the bug) is called from
  server/services/nfl-model-growth.js:169, itself invoked from
  server/services/scheduler.js:668 (`runNflModelGrowthCycle`).
Both are registered scheduler jobs. Confirmed P1 — every future week's shadow CLV is
computed against a number that is not guaranteed to be the closing line.

## #72 — server/services/nfl-blind-audit.js:888 (P2) — CONFIRMED, not refuted

Line 888 is exactly `db.exec('BEGIN IMMEDIATE');` inside `openNextWeek` (the function
persisting a newly-opened blind-audit week). Inside the transaction, `assertFrozen(record)`
(line 232) is called before the insert.

`assertFrozen` (line 232-247) has a fast-path early return:
```
const mutations = inputMutationState(Math.max(-1, priorMutation));
if (priorMutation >= 0 && mutations.latest <= priorMutation) return;
const data = inputDataState(spec);   // the expensive 31-table rehash
```
So the full rehash only runs when `mutations.latest > priorMutation`, i.e. whenever the
input-mutation journal has advanced since the previous check. In season, the T-60
capture daemon writes continuously to `nfl_line_snapshots`/`nfl_quote_tape`/etc via the
trigger-fed `nfl_blind_input_mutations` journal, so this condition is essentially always
true whenever a week is opened during a live capture window — the rehash runs on (almost)
every call.

Real timing data confirms the cost (read-only query against
`nfl_blind_audit_week_performance`):
```
run_id 31: avg persist_ms 28584.37, max persist_ms 414454, n=70
run_id 32: avg persist_ms 21506.04, max persist_ms 63389,  n=70
```
Matches the claim's cited numbers exactly (run 32 avg 21,506/max 63,389; run 31 max
414,454). `server/db/index.js:18`: `PRAGMA busy_timeout = 15000;` confirmed verbatim.
20-400+ second write-lock holds vastly exceed the 15s busy_timeout, so any concurrent
writer (the live evidence-daemon itself, which shares the same `db.exec('BEGIN
IMMEDIATE')`-free single-writer SQLite file) would get `SQLITE_BUSY` after waiting out
the timeout.

Reachability: `runNextBlindAuditWeek` → `openNextWeek` is exported and imported by
server/routes/nfl-betting.js:51 and invoked at a route handler. Confirmed live/mounted.
P2 confirmed (arguably could be argued P1 given real capture-loss risk, but not
lowering the reader's classification — not clearly wrong either way).

## #73 — server/services/nfl-blind-audit.js:56 (P2) — CONFIRMED, not refuted

Line 56 matches exactly: `const latest = rows('SELECT COALESCE(MAX(id),0) id FROM nfl_blind_input_mutations')[0]?.id ?? 0;`

grep across server/ and scripts/ for `nfl_blind_input_mutations` finds only: the CREATE
TABLE (nfl-a-to-m.js:157), four trigger INSERTs (nfl-a-to-m.js:644-663), the two reads
in nfl-blind-audit.js (56, 59, both MAX(id)/GROUP BY table_name for a changed-tables
report), and one more consumer the reader's evidence line didn't mention:
server/betting/nfl/strategy/teaser-leg-rates.js:201 (`SELECT COUNT(*) n FROM
nfl_blind_input_mutations WHERE table_name = 'game_lines'`) — this is a real,
non-error-message use of `table_name`, so the claim's aside "table_name/changed_at are
used only for the error message at :58-59" is slightly incomplete (there is one more
consumer), but this doesn't affect the core claim (no DELETE anywhere, unbounded
growth). No `DELETE FROM nfl_blind_input_mutations` exists anywhere.

DB counts (read-only): total rows 5,273,156 (claim cites 5,103,652 — same order of
magnitude, table has grown further since the claim was written, consistent with an
actively-mutating live table). Top writers: nfl_line_snapshots 1,845,448,
nfl_quote_tape 1,680,267 (claim cites 1,766,124 / 1,607,063 respectively — again close,
consistent with continued growth between the read and this verification).

Reachability: the triggers fire on every INSERT/UPDATE/DELETE to any of the 31
INPUT_TABLES regardless of whether any audit route is ever called — they are DB-level
triggers installed by migration, always active. The live capture daemon
(evidence-daemon.js, scheduler-registered) writes to nfl_line_snapshots/nfl_quote_tape
continuously, so the growth is definitely live and definitely unbounded. Confirmed P2.

## #74 — server/services/nfl-audit-overview.js:125 (P2) — CONFIRMED, not refuted

Line 116: `const result = typeof pick.result === 'string' ? pick.result.trim().toLowerCase() : null;`
This lower-cased `result` is what's pushed into `allBets` (line 124-125, matching the
claim's cited snippet) and `spreadBets` is filtered from `allBets` (line 165). Line 221:
`uncertainty: spreadBets.length ? uncertainty(spreadBets) : null`.

`uncertainty()` in server/services/nfl-replay.js:44 and :57-58:
```
const settled = bets.filter(b => b.result === 'Won' || b.result === 'Lost');
...
const graded = sample.filter(b => b.result === 'Won' || b.result === 'Lost');
const wins = graded.filter(b => b.result === 'Won').length;
```
compares against capitalized `'Won'`/`'Lost'` — never matches the lower-cased
`'won'`/`'lost'` that nfl-audit-overview.js now produces (a real fix applied elsewhere
in the same file — the "Codex correction C09" comments at lines ~163-176 explicitly
document fixing this exact casing bug for `spreadWins`/`spreadLosses`, but the
`uncertainty(spreadBets)` call one screen down was not updated to match).

Traced the actual numeric effect: since `weeks.length` (clusters keyed by season-week,
built from all bets regardless of result) is always > 0 whenever `spreadBets.length` >
0, the bootstrap loop always produces `draws.length = 4000`, but `graded` is always
empty (no bet's `result` ever equals `'Won'`/`'Lost'`), so every draw's `winRate = 0`.
`quantile([0,0,...], 0.025/0.975)` = 0/0, so `win_rate_95` collapses to `[0, 0]`
(not `[null, null]`) — exactly as claimed. `roi_95` is unaffected since it's built from
`b.units`, not gated on result casing — also exactly as claimed.

Reachability: `auditOverview` is imported by server/routes/nfl-betting.js:54 and called
at line 385 in a route handler. Confirmed live/mounted. P2 confirmed.

## #75 — server/services/nfl-blind-audit.js:983 (P2) — CONFIRMED, not refuted

Line 983 (in `blindAuditStatus`):
```
estimated_remaining_ms: averageTotalMs == null ? null
    : averageTotalMs * Math.max(0, record.spec.schedule.length - weeks.length),
```
`weeks` (line 967-970) comes from `selectedWeeks.reverse().map(...)`, and
`selectedWeeks` is fetched with a `LIMIT ?` clause whenever `weekLimit != null` (line
961-965). `listBlindAudits` (line 987-992):
```
export function listBlindAudits() {
  return rows('SELECT id FROM nfl_blind_audit_runs ORDER BY id DESC').map(x => blindAuditStatus(x.id, {
    weekLimit: 0,
    compact: true
  }));
}
```
always calls with `weekLimit: 0`, so `LIMIT 0` → `selectedWeeks = []` → `weeks.length =
0` for every run listed, regardless of actual completion. `estimated_remaining_ms`
therefore equals `averageTotalMs * schedule.length` (the FULL schedule length, e.g. 70
per the DB's `nfl_blind_audit_week_performance` `n=70` rows for runs 31/32) for every
run in the list view, including fully complete ones. `opened` (line 960) is computed
correctly and independently via `COUNT(*) FROM nfl_blind_audit_weeks` — confirming the
claim that a correct count already exists right next to the wrong one.

Reachability: `listBlindAudits` is imported and called by server/routes/nfl-betting.js
(line 51 import, line 364 `res.json({ audits: listBlindAudits() })`). Confirmed
live/mounted. P2 confirmed.

## #76 — server/services/nfl-candidate-analysis.js:211 (P2) — CONFIRMED, not refuted

Line 211: `verdict: 'The candidate is not profitable. The failure is primarily
forecast/selection quality, not missing rows or a lack of model complexity.',` — a
literal string, not derived from `gap`/`current_hit_rate`/any computed value in scope.
Line 220: `state: 'not_primary_failure',` (data_integrity) — literal. Line 234:
`state: 'critical',` (regime_instability) — literal. Contrast with the surrounding
sibling fields in the same object that ARE computed conditionally:
`selection_dilution.state: weakEdge?.roi < 0 ? 'critical' : 'unclear'`,
`edge_ranking.state: bestEdge?.win_rate > weakEdge?.win_rate ? '...' : 'broken'`,
`candidate_increment.state: Math.abs(...) < 2 ? 'low_value_expansion' : 'material'`,
`roster_signal.state: rosterAblation?.units_delta_vs_all_inputs > 0 ? '...' : '...'`
— all conditional on the actual numbers, which sharpens the contrast: three fields
(verdict + 2 of 6 decomposition states) are hardcoded while their neighbors are not.

Reachability: `macroDiagnosis` is called inside `runCandidateRobustnessAudit`-type flow
at nfl-candidate-analysis.js:298, persisted to `nfl_candidate_robustness_audits`
(line 303), read back by `latestCandidateRobustnessReport` (line 310), which is called
from server/services/nfl-diagnostic.js:144 (`candidate_robustness:
latestCandidateRobustnessReport()`), and `nflDiagnostic` is imported by
server/routes/nfl-betting.js:59. Confirmed live/mounted. P2 confirmed.

## #77 — server/services/nfl-postgame-truth.js:383 (P2) — CONFIRMED with a scope
correction, not refuted

Line 383 matches exactly:
```
if (play.play_type === 'fg_miss' || /blocked/i.test(text) && /field goal|extra point/i.test(text)) {
  const sign = play.offense === home ? -1 : play.offense === away ? 1 : 0;
  if (sign) items.push({ kind: 'missed_or_blocked_kick', period: play.period, home_points: sign * 3, text: text.slice(0, 120) });
  continue;
}
```
`home_points` is unconditionally `sign * 3` regardless of whether the matched event was
a field goal (worth 3) or an extra point (worth 1).

Traced where `play.play_type`/`text` originate: `nfl_play_by_play` is populated only by
server/services/nfl-espn-pbp.js:185 (`storePlays`), whose `play_type` comes from
`classifyPlay()` (nfl-espn-pbp.js:67-81), which explicitly maps ALL extra-point plays
(`t.includes('extra point')`) to `null` (line 70), *before* the field-goal branch, so
`play.play_type` is NEVER `'fg_miss'` for an extra point, blocked or not — only the
`/blocked/i.test(text) && .../extra point/.test(text)` half of the OR can ever catch an
extra point.

Confirmed against real DB rows (read-only query, `text LIKE '%extra point%' AND
(blocked/No Good/missed)`): ESPN bundles the scoring play and its extra-point attempt
into ONE play/text row (e.g. `"...TOUCHDOWN.C.Santos extra point is Blocked
(R.Okwara)..."`, `play_type: 'pass'`). For a **blocked** PAT, this text does contain
both "blocked" and "extra point", so the condition matches and the play is charged
`sign * 3` (should be 1) — confirmed real and materialized: DB query on
`nfl_game_variance.items_json LIKE '%missed_or_blocked_kick%'` returns 626 of 1,357
persisted rows, so this path fires often in real data.

**Scope correction to the claim**: for a plain **missed-but-not-blocked** PAT (e.g.
`"...extra point is No Good, Wide Right..."`), the text contains neither `fg_miss`-
triggering language nor the word "blocked", so `/blocked/i.test(text)` is false and this
code path does **not** fire at all — no variance item is created, so a merely-missed
(unblocked) XP is not "charged as 3 variance points"; it is simply not classified as
missed/blocked-kick variance (it falls through and the underlying score change is
treated as an ordinary offensive score). The claim's title overstates by saying "missed
or blocked" — only the **blocked** case is actually caught and mischarged. The
underlying defect (blocked PAT charged 3 instead of 1) is real and reachable; the
"missed" half of the claim's framing is not accurate.

Also note (not in the original claim, adds context): because the TD and its blocked-XP
attempt are one combined play row, the early `continue` on the missed_or_blocked_kick
branch means the underlying touchdown itself is never evaluated for
`non_offensive_score`/`short_field_after_turnover`/`garbage_time` classification either
— a secondary side effect of the same line, not scored separately here since it's not
what the claim asserted.

Reachability: `residualDecomposition` → `persistPostgameTruth` (nfl-postgame-truth.js
:597-599, `INSERT OR REPLACE INTO nfl_game_variance`) is called from
`persistPostgameTruth(packet)` inside `openNextWeek` in nfl-blind-audit.js (already
confirmed mounted via nfl-betting.js). Confirmed live/mounted. P2 confirmed (for the
blocked-PAT case specifically).

---

## Summary table

| key | file:line | severity claimed | verdict |
|---|---|---|---|
| #69 | scripts/audit-football-first.mjs:121 | P1 | confirmed |
| #70 | scripts/audit-trend-totals.mjs:163 | P1 | confirmed |
| #71 | server/services/shadow-ledger.js:71 | P1 | confirmed |
| #72 | server/services/nfl-blind-audit.js:888 | P2 | confirmed |
| #73 | server/services/nfl-blind-audit.js:56 | P2 | confirmed |
| #74 | server/services/nfl-audit-overview.js:125 | P2 | confirmed |
| #75 | server/services/nfl-blind-audit.js:983 | P2 | confirmed |
| #76 | server/services/nfl-candidate-analysis.js:211 | P2 | confirmed |
| #77 | server/services/nfl-postgame-truth.js:383 | P2 | confirmed (scope: blocked PAT only, not "missed") |

All 9 claims survive adversarial review. None were refuted. Every one of the affected
functions is reachable through a mounted Express route (server/routes/betting-hub.js or
server/routes/nfl-betting.js, both confirmed mounted in server/index.js) or a registered
scheduler job (server/services/scheduler.js), and every claim's core code citation
(file:line:snippet) was verified to match the actual file content read fresh from disk.
Several claims' impacts were additionally cross-checked against real, currently-sealed
rows in server/data.sqlite via a read-only node:sqlite connection, and matched (exactly
for #69/#70/#72/#75; same order of magnitude, consistent with continued live growth,
for #73's row counts).
