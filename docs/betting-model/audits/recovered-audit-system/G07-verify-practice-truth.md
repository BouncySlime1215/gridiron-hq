# G07 — adversarial verification, lens = practice-truth

Question: is the SHOULD-BE (every historical summary and plan §1.2 carry a `market_line_basis`
disclosure; decision-time evaluation uses only lines available before a declared cutoff) a genuine,
widely-held backtest/ledger principle, or opinion dressed as a standard? Can it apply at NFL sample
sizes (272 games/season)?

Repo read-only. Files read in full: `server/services/nfl-replay.js` (1,102 lines),
`server/services/nfl-ensemble.js` (1,423 lines). Supporting reads: `docs/CLAUDE-NEXT-STEPS.md`
§1.2, §4, §5.3, §6.1, §7, §9, refs; `docs/reference/model-governance-manual.md` :20-56, :144-152,
:1046-1068; `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md` :150-164, :262-276;
`docs/evidence/contracts/beat-the-close-original.md` :110-120, :180-200;
`server/services/nfl-blind-audit.js` :180-200, :515-526, :655-700; `server/services/nfl-execution-clv.js`
:40-62, :200-260; `server/services/beat-the-close.js` :230-275; A04 note. DB via `node:sqlite`
`readOnly:true` (scripts g07-db*.cjs in this directory). No web lookups.

## Verdict: NOT refuted. The principle is genuine and is already the repo's own declared standard.

### 1. The CURRENT claim reproduces exactly

- `nfl-replay.js:193` `gl.spread AS home_spread, gl.total,` and `:233` `const marketMargin = -g.home_spread;`,
  `:265` `const edge = e.projected_total - g.total;` — the market line the replay bets against is
  `game_lines.spread`.
- DB (home rows, scored, `source='nflverse'`): `closing_spread IS NULL` for 100% of 2020-2025 rows
  (269/285/284/285/285/285); `ABS(spread-open_spread)>=0.5` in 255/272, 229/267, 231/285, 203/285,
  218/285 — identical to A04 headline 6 (~80%/season).
- `nfl-ensemble.js:1317` `market_spread: g.home_spread ?? null,` and `:1289-1292` residualMargin is
  anchored on `marketMargin = -g.home_spread` — the market-residual blend consumes the same close.
  Also `nfl-ensemble.js:55-60` `games()` supplies `NULL AS open_spread, NULL AS open_total` in fitting,
  and `:1262-1263` only exposes `open_spread` for unscored games (`CASE WHEN team_score IS NULL`), so
  every historical component fit and forecast sees closing context only.
- Disclosure is in-file: `nfl-replay.js:83-85` "compares the pick to the CLOSING line -- a number that
  does not exist yet at any point a real bet could have been placed"; `:108-109` "both still use a
  model number computed with the full closing-time feature set".
- Run outputs: `nfl_blind_audit_runs.final_json` for runs 27/31/32 — `betting` =
  `{"bets":545,"wins":203,"losses":338,"units":-55.414,"roi":-0.1017}`; no basis field, no CLV field.
  The string `price_and_clv` that appears in final_json is an expert-council score LABEL
  (`nfl-expert-council.js:42` `{ id: 'price_shopper', ... score: 'price_and_clv' }`), not a CLV value.
- Plan §1.2 table (`docs/CLAUDE-NEXT-STEPS.md:31-34`) reports 153 bets / −7.7483% ROI and 156 bets /
  −7.1079% ROI with interpretation "Negative historical development record." — no line-basis footnote.

### 2. Is the SHOULD-BE a principle or an opinion? — It is the repo's own written standard, four times over

1. Governance manual (`docs/reference/model-governance-manual.md`):
   - `:23` "demonstrate positive expected value without look-ahead, fake news, reconstructed prices,"
   - `:27-28` "Profitability means settled results at prices that were genuinely available at decision time, positive closing-line value,"
   - `:37` "- preserved decision-time and closing prices;"
   - `:51-52` "A prediction for week W may use only evidence available before the recorded decision timestamp for week W."
   - `:148` "- market open, intermediate, decision-time, and closing prices by book;"
   - `:1051` "- Average closing-line value must be positive." (promotion gate)
2. The canonical plan (`docs/CLAUDE-NEXT-STEPS.md`):
   - `:582` "Every label and artifact must be available before its forecast."
   - `:584` "Historical as-of reconstruction can test algorithmic chronology, but a newly fitted artifact is not a forecast that was actually emitted in the past. Label historical reconstruction and real prospective observation separately."
   - `:594` scorecard 5: "Correctly defined same-line price CLV and point movement, with exact coverage, quote IDs, reference composition and missing-close rates. CLV is supporting evidence, not profit proof."
   - `:432` "The raw historical ensemble remains useful as development evidence, but it is not the T−60 graph's qualification record."
3. The Codex audit, finding M07 (`docs/evidence/2026-09-09/AUDIT-EVIDENCE.md`):
   - `:160` "None of the opening win rates establish profitability or genuine opening-time predictive skill."
   - `:162` "Remove claims that either opening or closing quotes are proved obtainable solely by being stored."
   - `:271` "Relabel this field `closing-information forecast graded against opener` or remove it from performance headlines. ... Only a quote actually available at that timestamp may produce an executable ROI."
   - `:273` "Modifying a closing line or kickoff weather after a Tuesday cutoff cannot change Tuesday's prediction."
4. The repo's own CLV code and preregistration:
   - `nfl-execution-clv.js:44-48` "a CLV number computed under one definition of 'the close' is not comparable with one computed under another, and a report that does not say which definition it used cannot be re-checked later."; `:55-57` "It is a DECLARED choice rather than an implicit one, and it is recorded on every report, because a close computed across a different set of books is a different benchmark."
   - `beat-the-close-original.md:114-116` gate: "mean CLV ≥ +0.3 points with a bootstrap interval that excludes zero on ≥ 300 games, at a single decision time."; `:194` "CLV per decision at settlement against Pinnacle's last pre-kickoff line".
   - `beat-the-close.js:251` already writes `bet_line_basis: 'home-perspective line at the chosen book'` into every frozen decision — the disclosure pattern the gap asks for exists in the forward ledger and is simply absent from the historical one.

So "declare the reference line/time, and grade only against lines that existed at the decision time" is not one auditor's taste: the repo has adopted it as its qualification rule, its chronology contract, its CLV-versioning rule, and its preregistered gate. The gap merely applies the repo's forward standard to its historical record.

Externally (from general knowledge; no web check this run, per instruction): closing-line value against a named sharp book is the standard practitioner benchmark for whether a bet had edge; "look-ahead bias" (using data not available at decision time) is the canonical backtest defect in the quant-finance literature (e.g. López de Prado, *Advances in Financial Machine Learning*, ch. 7 purged/embargoed CV; Bailey, Borwein, López de Prado & Zhu, "Pseudo-Mathematics and Financial Charlatanism", 2014). Both are widely held, not niche.

### 3. Does it apply at NFL sample sizes? — Yes; timing is a validity condition, not a power condition

- Point-in-time input hygiene does not depend on n. A biased evaluation at n=150 is still biased; with
  ~80% of games moving ≥0.5 pt open→close, a closing-conditioned pick set is a different population
  from a decision-time one (Codex M07 `:269` "It is not the same decision population or necessarily
  the same sides"; 23/153 spreads and 22/48 totals flip side, `AUDIT-EVIDENCE.md:156`).
- It is feasible in-repo: `nfl_odds_archive` holds Pinnacle `spreads` with BOTH `open` and `close`
  rows for 267/285/285/285 events in 2022/2023/2024/2025 (DB, g07-db3.cjs) — 1,122 games, enough to
  run the same policy at the book-stamped opener. `nfl-blind-audit.js:664-698`
  `historicalOpenerReplay` already does this for two external rules at NFL scale.
- Sample size bears on whether a decision-time evaluation can *detect* an edge (plan §9.3
  `:600-602` "200 selections require at least 40 fully used weeks"), not on whether the closing-basis
  record may be presented as decision-time evidence.

### 4. Refinements the gap should carry (the only places the SHOULD-BE overreaches)

- (a) "Received before the declared cutoff" cannot be satisfied by ANY historical source. The
  OddsTrader archive's receipt clock is `fetched_at` 2026-09-02 (A04 headline 5); only
  `book_updated_at` is pre-kickoff, and it is the book's claim. So the historical leg of the SHOULD-BE
  must read "book-stamped opener, labelled historical reconstruction" (plan `:584`), and the strictly
  receipt-clocked leg is prospective-only (the 2026 tape) — which is itself legacy-clocked today
  (A04 headline 3). The principle holds; the wording "received" is only achievable forward.
- (b) `game_lines.open_spread` is not a valid decision-time basis either: per the 2026-09-09 memory
  note it is a synthetic multi-book median (2022+) with corrupt 2021 openers; the opener diagnostics
  at `nfl-replay.js:359-410` read it and must carry the same basis label, not be treated as the fix.
- (c) The "−2.28 CLV record" named in the gap is not persisted anywhere in the repo or DB
  (grep: no `2.28`/`−2.28` outside an unrelated fantasy table; runs 27/31/32 `final_json` carry no
  CLV). It exists only as a session diagnostic (memory note 2026-09-09). By construction it can only
  be open→close movement on the closing-selected side — a "does the model fade steam" diagnostic, not
  the CLV of any executable bet. This strengthens G07: the historical record has no CLV at all, and
  the only CLV number in circulation is unpersisted and closing-conditioned.
- (d) "Disclosed only in-file" is slightly overstated: `nfl-blind-audit.js:193` puts "Historical ROI
  is reported but cannot establish production profitability without real archived quotes and forward
  CLV." into every preregistration, and `nfl-replay.js:1065` stamps
  `evidence_class: 'chronological development replay; not sealed forward proof'` on candidate
  comparisons. Neither names the LINE basis, and the `betting` summary and plan §1.2 carry nothing —
  so the material point stands.

### 5. Bottom line

The SHOULD-BE is the repo's own standard applied consistently (governance manual, plan §9.2, Codex
M07, nfl-execution-clv.js, beat-the-close preregistration) and matches the widely-held
no-look-ahead / declared-CLV-reference practice. It is not opinion, and NFL sample size is irrelevant
to it. Amend only the wording: historical = book-stamped opener labelled reconstruction; receipt-clocked
= prospective only; the −2.28 figure is unpersisted and should be cited as such.
