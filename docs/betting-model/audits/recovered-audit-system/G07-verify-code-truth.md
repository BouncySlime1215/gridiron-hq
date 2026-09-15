# G07 verifier — lens: code-truth

Gap under test: "The cited historical CLV/ROI record is a beat-the-close exercise with closing-time
features, not decision-time evidence."

Verdict: **NOT refuted.** The CURRENT description is accurate in substance. Four precision corrections
below (one line-number miscite, one understatement, one overstatement about disclosure, one about where
the −2.28 CLV number actually lives).

Files read in full: `server/services/nfl-replay.js` (1102 lines), `server/services/nfl-ensemble.js`
lines 1-140, 595-612, 683-700, 808-820, 1200-1423. Targeted reads of `gamescript.js`, `odds-archive.js`,
`nfl-evidence.js`, `nfl-blind-audit.js`, `line-move-study.js`, `routes/nfl-betting.js`,
`docs/CLAUDE-NEXT-STEPS.md` §1.2/§6.3/§9.2, `docs/evidence/2026-09-11/RETURN-TO-CODEX.md`. DB read-only via
`node:sqlite`.

## 1. Replay market = `game_lines.spread` = nflverse closing consensus — CONFIRMED

- `server/services/nfl-replay.js:193` — `gl.spread AS home_spread, gl.total,` and `:203` —
  `AND gl.home = 1 AND gl.team_score IS NOT NULL AND gl.spread IS NOT NULL`. Both cites are exact.
- `:227-229` — `const marketMargin = -g.home_spread; const edge = e.projected_margin - marketMargin;` —
  the edge that selects the bet is model-vs-close.
- `:77-81` `unitsFor(won, pushed, price)` settles at `american_price: backHome ? g.home_spread_odds :
  g.away_spread_odds` (`:236`) — closing odds.
- Source of `spread`: `server/services/gamescript.js:80-81` — `// nflverse states spread_line from the
  HOME team's perspective ... const homeSpread = -Number(r[iSpread]);`.
- `server/services/odds-archive.js:9-10` — "game_lines carried only nflverse's single closing consensus
  for those seasons."
- `server/services/gamescript.js:288-289` — "Historical rows (nflverse) never populate
  closing_spread/closing_total".
- DB (read-only, `home=1`): `closing_spread` non-null = 0 for every season 1999-2025; 271/272 in 2026.
  `source` = `nflverse` only for 1999-2025; `espn,nflverse` for 2026. Matches
  `docs/evidence/2026-09-11/RETURN-TO-CODEX.md:107-108` ("`game_lines.spread` *is* the closing spread").

## 2. Ensemble market anchor consumes the same close — CONFIRMED, line cite corrected

- The gap cites `nfl-ensemble.js:1317`. That line is `market_spread: g.home_spread ?? null,` — the
  *reported* market field, not the anchor arithmetic.
- The actual market-residual anchor is `nfl-ensemble.js:1290-1295`:
  `const marketMargin = g.home_spread != null ? -g.home_spread : null;` ...
  `const residualMargin = marketMargin != null && residualWeight > 0 ? marketMargin + ... : marketMargin;`
  and `:1299` `const margin = blendMode === 'market_residual' ? residualMargin : rawMargin;`.
- `g.home_spread` comes from `:1246` `SELECT team AS home, opponent AS away, spread AS home_spread, total,`.
- The CURRENT description **understates** the close's reach. The close also feeds:
  - the `market_anchor` component `:599-604` — `margin: c.openSpread != null ? -c.openSpread : c.spread
    != null ? -c.spread : null` — and for every historical game `openSpread` is null because
    `games()` `:60` selects `NULL AS open_spread, NULL AS open_total` and `ensembleLine` `:1247` selects
    `CASE WHEN team_score IS NULL THEN open_spread END AS open_spread` (null once scores exist). So
    historically the "market anchor" is the close, despite its note `:600` saying "the number the books
    opened".
  - `marketRegression` `:687-695` — "Simple OLS of actual margin on the (negated) closing spread",
    `xs = hist.map(g => -g.home_spread)`; used by `market_regression` `:607-612`.
  - `buildContext` `:815` passes `spread: g.home_spread` into every component context.

## 3. Disclosure — CONFIRMED in-file; "only in-file" slightly overstated; SHOULD-BE unmet

In-file (confirmed at the cited lines):
- `nfl-replay.js:84-86` — "The primary grade above compares the pick to the CLOSING line -- a number that
  does not exist yet at any point a real bet could have been placed."
- `:109-112` — "Neither is a real opening-time replay: both still use a model number computed with the
  full closing-time feature set (see `docs/CLAUDE-NEXT-STEPS.md` section 6.3 ...)". (Note: §6.3 of the
  current plan is "Family C: an independent game simulation", `docs/CLAUDE-NEXT-STEPS.md:444`; the T-60
  protocol section reference is stale.)

Runtime surfaces that DO carry a partial disclosure (so "only in-file" is not strictly true):
- `nfl-replay.js:341-342` summary `opener_diagnostics.same_side_regrade.note`: "re-graded against the
  opening line instead of the closing line -- no side is reselected." `:363-365` similar for
  `side_reselected_counterfactual`. These imply, but do not name, the primary basis.
- `server/services/nfl-evidence.js:141-145` coverage gap `historical_quote_snapshots`: "Historical
  decision-time prices are not reconstructed ... Blocks honest line-movement, best-price and CLV claims
  for 2021–25." — a separate report, not attached to replay output.
- `server/services/line-move-study.js:77-78` `CLV_BASIS` and `:327/:387` `clv_basis` — that study labels
  its basis per decision time. Not the ensemble replay.

Surfaces that carry NO basis field (SHOULD-BE unmet):
- `replaySeason` `summary` `:298-330` — fields: season, label, bets, wins, losses, pushes, win_rate, units,
  roi, break_even_needed, beat_vig, config, decision_audit, uncertainty, opener_diagnostics. No
  `market_line_basis`.
- `trainingIteration` `overall`/`per_season` `:900-925` — none.
- `saveReplay` `:384-401` (`nfl_replay_runs`, `nfl_replay_bets`) and `saveTrainingAudit` `:1016-1025`
  (`nfl_policy_audits.result_json`) persist no basis.
- `server/routes/nfl-betting.js:688-723` (`/replay`, `/replay/train`) pass the objects through unchanged.
- `server/services/nfl-blind-audit.js:522` `interpretation: 'Historical chronological replay only.
  Profitability promotion still requires forward priced decisions and positive CLV.'` — no line basis.
- `docs/CLAUDE-NEXT-STEPS.md:29-41` §1.2 table: the ROI rows read "153 bets ... −7.7483% ROI | Negative
  historical development record." and "156 bets ... −7.1079488272% ROI | About 0.64 percentage points
  better descriptively, still negative." No footnote on market-line basis.
- Per-bet `quote_at: g.fetched_at` (`:241`) is the nflverse import time (DB: `fetched_at` for 2021-25 is
  2026-07-31 / 2026-08-03), which misleads a reader looking for a decision time.

## 4. EVIDENCE check

- DB (`home=1`, `open_spread IS NOT NULL AND ABS(spread-open_spread)>=0.5`): 2021 255/272, 2022 229/267,
  2023 231/285, 2024 203/285, 2025 218/285 → 94/86/81/71/76%, mean ≈ 82%. "~80%" holds. (The
  RETURN-TO-CODEX antisymmetry defect on `open_spread` for 2022-25 affects the away row only; the home row
  used here is unaffected.)
- The **−2.28 CLV** figure does not appear anywhere in the repo (`grep '2\.28'` over docs/server/research:
  only unrelated hits). It appears only in the audit's own notes (`A01-blind-audit-core.md:46`,
  `A04-packet-quotes-time.md:76`, `AUDIT_SYSTEM_REVIEW.md:31,197,284`). Plan §1.2 cites ROI only, no
  CLV. The gap title's "cited historical CLV" is therefore the audit citing itself; the ROI half is what
  the plan cites.

## 5. Corrected statement

CURRENT (corrected): `nfl-replay.js:193/203/227-229` selects and grades against `game_lines.spread`
(nflverse `spread_line`, i.e. closing consensus; `closing_spread` NULL 1999-2025) and settles at closing
odds; `nfl-ensemble.js:1290-1295` anchors the market-residual blend on the same close (`:1317` merely
reports it), and the close also drives the `market_anchor` component (`:599-604`, opener nulled by `:60`
and `:1247`) and `marketRegression` (`:687-695`). Disclosed in comments at `nfl-replay.js:84-91, 109-112`
and indirectly in the summary's `opener_diagnostics.*.note` strings; no `market_line_basis` field on
`summary`, `overall`, persisted runs, blind-audit `final_json`, or the plan §1.2 table. The −2.28 CLV
figure is the audit's own number, not one the plan cites; plan §1.2 cites −7.75%/−7.11% ROI.
