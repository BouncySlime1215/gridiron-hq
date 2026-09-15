# G09 adversarial verification (lens = code-truth) — 2026-09-12

Gap G09: "CLV is recomputed on every read, never persisted, and the default reference book set includes the execution book."

Verdict: NOT REFUTED. Every clause of CURRENT is accurate at the cited lines. Two precision notes below (the report *emits* quote IDs and a grading version in JSON; and two adjacent modules do persist a cruder CLV) — neither satisfies SHOULD BE.

Files read in full: server/services/nfl-execution-clv.js (354 lines), server/routes/nfl-market.js (450), server/services/shadow-ledger.js (122). Scanned: nfl-execution-clv-downsize.js, nfl-clv.js, line-shopping.js, nfl-decision-tape.js, test/nfl-execution-clv.test.js, docs/CLAUDE-NEXT-STEPS.md. DB read via node:sqlite readOnly on server/data.sqlite.

## Clause 1 — "recomputed on every read, never persisted"  → CONFIRMED

- nfl-execution-clv.js:232 `export function executionClvReport({ limit = 5000, books = DEFAULT_CLOSING_BOOKS } = {})` — the only import is `rows` (:35); no `run`/INSERT/UPDATE anywhere in the file (grep: zero hits).
- nfl-execution-clv.js:19-24 header: "nothing is written, so recomputing after the close lands simply produces the now-gradeable answer. There is no graded_at to race, and no second row to reconcile."
- nfl-execution-clv.js:351-352 `method: 'read-only projection over the accepted-ticket ledger; nothing is written, so grading is idempotent ...'`
- routes/nfl-market.js:391 `try { res.json(executionClvReport()); } catch (e) { next(e); }` — response only; no side effect.
- No table exists for execution CLV grades: `sqlite_master` has no table matching clv/grad/closing except `nfl_prop_clv`, `draft_grades`, `draft_team_grades`, `nfl_external_player_grades`. No column `grading_version` or `closing_quote_ids` anywhere in server/ outside this module (grep).

Precision note: the JSON *does* carry `closing_quote_ids` (:307), `grading_version: CLV_GRADING_VERSION` (:349), `declared_books` (:350). So C13's "save closing quote IDs and a grading-version artifact" was implemented as "include in the response", not "persist a row". Test :295 ("closing quote IDs and a grading version are saved with the report") only asserts on the returned object.

## Clause 2 — "default reference book set includes the execution book"  → CONFIRMED

- nfl-execution-clv.js:59 `export const DEFAULT_CLOSING_BOOKS = null;` with :53-58 "`null` books means 'every book present in the tape'".
- nfl-execution-clv.js:141-146: the only book filter is `declared == null || declared.has(q.bookmaker_key)`; nothing subtracts the accepting book.
- nfl-execution-clv.js:239-240 `SELECT line, price, stake_units, occurred_at FROM nfl_execution_lifecycle_events WHERE opportunity_id=? AND state='accepted'` — `book` is NOT selected, so executionClvReport cannot exclude the execution book even in principle; :244-247 passes `books` straight through.
- routes/nfl-market.js:391 calls `executionClvReport()` with no arguments → default null → all books.
- The capability to exclude exists (param `books`, test/nfl-execution-clv.test.js:286-292 "an independent reference must be able to exclude the book we bet at") but no production caller uses it (grep: only the route and tests call it).
- docs/CLAUDE-NEXT-STEPS.md:71 acknowledges: "Declared bookmaker set defaults to every book in the tape; no independent reference set has been chosen."

## Clause 3 — "only accepted/settled opportunities are graded (0 rows)"  → CONFIRMED

- nfl-execution-clv.js:233-234 `const accepted = [...listOpportunities({ status: 'accepted', limit }), ...listOpportunities({ status: 'settled', limit })];`
- nfl-execution-lifecycle.js:435-443 listOpportunities filters `status=?` on `nfl_execution_opportunities`.
- DB (readOnly): `SELECT status,COUNT(*) FROM nfl_execution_opportunities GROUP BY status` → [] (empty); `nfl_execution_lifecycle_events WHERE state='accepted'` → 0. Also `nfl_decision_events` → 0 rows, `nfl_decision_runs` → 0 rows, so an "all-game tape series" has no substrate yet either.

## Could SHOULD BE already be satisfied elsewhere? — NO

- nfl-clv.js:248-250 `UPDATE nfl_bet_log SET closing_line=?, closing_price=?, closing_fair_prob=?, clv_points=?, clv_pct=?, graded_at=?` — persists, but: different ledger (`nfl_bet_log`, 0 rows), source is `nfl_line_snapshots` consensus not the quote tape, no quote IDs, no grading_version, no book set, no abstains. The module header of nfl-execution-clv.js:5-10 names this exact split as the E9 finding.
- shadow-ledger.js:99-100 `UPDATE shadow_decisions SET settled_at=?,outcome_json=?,result=?,clv_points=? WHERE id=?` — does grade abstains (:39 `d.eligible ? 'observe' : 'abstain'`; :53-55 "Abstentions are settled too"). DB: 189 rows (2026 wk1 125, wk2 64); 14 graded (8 abstain, 6 observe). But: close = `game_lines.spread` (:83), a single synced number with no book identity, no quote IDs, no grading_version, no price CLV at all (points only), and event_key is `season:week:home:away` not the canonical `nfl|date|AWAY@HOME` contract key. It is a coarse paper ledger, not the exact-contract grade G09 asks for.
- line-shopping.js:232-248 closingLineValue() returns only snapshot counts/availability; grades nothing.
- nfl-execution-clv-downsize.js: pure functions over caller-supplied `history`; no DB access (grep: no rows/run/import of db). Its header :96-104 states no real CLV time series exists.

## Corrected statement (tightened, not changed in substance)

nfl-execution-clv.js:232-354 is a read-only projection that returns JSON only (no `run`/INSERT in the file; :351-352 says so); the response embeds `closing_quote_ids` (:307) and `grading_version` (:349) but nothing persists them. `DEFAULT_CLOSING_BOOKS = null` (:59) means every tape book, and the accepted event's `book` is not even selected (:239-240), so the accepting book is always inside the reference; route :391 passes no `books`. Only `status IN ('accepted','settled')` opportunities are graded (:233-234) — 0 rows in nfl_execution_opportunities, and 0 in nfl_decision_events, so no all-game series can exist today. The adjacent persisted CLV (nfl_bet_log via nfl-clv.js:248; shadow_decisions.clv_points via shadow-ledger.js:99, 14 graded incl. 8 abstains) uses non-tape closes without quote IDs/version/book set and does not satisfy SHOULD BE.
