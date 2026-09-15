# G07 materiality verification — "historical CLV/ROI is a beat-the-close exercise, not decision-time evidence"

Lens: materiality. Question: would closing G07 change a number Nick reads, a decision, or the validity of the historical/forward record?

Verdict: **refuted as P1; downgrade to P3 (labeling/provenance hygiene).** The factual claim is true and already disclosed on every surface Nick reads; the "should be" either (a) adds a label that changes no number and flips no gate, or (b) asks for a decision-time replay that is infeasible for 2021-25 with this model and is already owned by the forward T-60 tape.

## 1. The factual claim is true (confirmed, not disputed)

- `server/services/nfl-replay.js:193` `gl.spread AS home_spread, gl.total,` and `:203` `AND gl.home = 1 AND gl.team_score IS NOT NULL AND gl.spread IS NOT NULL` — the replay market line is `game_lines.spread`.
- Read-only DB (g07-db.cjs): `game_lines` home rows 2021-25, all `source='nflverse'`, `closing_spread IS NOT NULL` = **0** in every season; `open_spread` non-null 272/267/285/285/285; `ABS(spread-open_spread)>=0.5` in 255/229/231/203/218 games. So `spread` is the nflverse closing consensus and it differs from the opener in ~75-90% of games.
- `server/services/nfl-ensemble.js:60` `NULL AS open_spread, NULL AS open_total,` (fitting never sees an opener); `:1247` `CASE WHEN team_score IS NULL THEN open_spread END AS open_spread` (completed games: opener nulled); `:602` market_anchor `margin: c.openSpread != null ? -c.openSpread : c.spread != null ? -c.spread : null` → in replay this IS the close; `:1290` `const marketMargin = g.home_spread != null ? -g.home_spread : null;` `:1292-1295` residualMargin anchors on it; `:1317` `market_spread: g.home_spread ?? null`.
- Fit artifact (read-only, cutoff 2026|2, champion-inputs): `market_anchor` margin_weight 0.0651, `market_regression` 0.0648 — the two largest single weights.

## 2. It is already disclosed everywhere Nick reads the number

| Surface | Line | Text |
|---|---|---|
| Replay engine | `nfl-replay.js:83-85` | "compares the pick to the CLOSING line -- a number that does not exist yet at any point a real bet could have been placed" |
| Replay engine | `nfl-replay.js:108-109` | "Neither is a real opening-time replay: both still use a model number computed with the full closing-time feature set" |
| Replay summary | `nfl-replay.js:349-352` | `opener_diagnostics: { same_side_regrade, side_reselected_counterfactual }` with notes |
| Blind-audit protocol | `nfl-blind-audit.js:193` | rule: "Historical ROI is reported but cannot establish production profitability without real archived quotes and forward CLV." |
| Blind-audit final | `nfl-blind-audit.js:522` | `interpretation: 'Historical chronological replay only. Profitability promotion still requires forward priced decisions and positive CLV.'` |
| Diagnostic API | `nfl-diagnostic.js:118` | `evidence_class: 'historical diagnostic; not untouched forward proof'` |
| Profitability API | `nfl-profitability.js:109` | `limitation: 'nfldata supplies consensus/closing fields, not a trustworthy multi-book historical opener. Opening-line edge remains forward-capture only.'` |
| UI | `client/src/components/betting/ProfitabilityControl.tsx:213` | "{min}–{max} closing spreads and totals are available from nflverse. {limitation}" |
| UI | `client/src/pages/betting/Diagnostics.tsx:346` | "Five seasons say the closing line cannot be out-forecast with public data." |
| UI | `client/src/pages/betting/Training.tsx:270` | "It is mechanically outcome-blind, but 2021–25 has already informed development. Only frozen, pre-kickoff 2026 decisions can become untouched forward evidence." |
| Plan | `docs/CLAUDE-NEXT-STEPS.md:324` | "The report's default graph is raw historical/closing replay, not the intended T−60 residual graph." |
| Plan | `docs/CLAUDE-NEXT-STEPS.md:588` | "The 2021–2025 outcomes already inspected across these audits are development data." |
| Prior audit | `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:275` | same-side at opener 58-92-3 (38.67%) vs close 72-78-3 (48%); "still use picks selected with closing information and are not an executable opening strategy" |
| Nick's memory | `~/.claude/.../memory/gridiron-nfl-betting-model.md` | "market_anchor/market_regression ARE the close … The opener path for THIS model is dead (same picks at the opener: 38.7%)" |

The only place the basis is NOT carried is the persisted `nfl_blind_audit_runs.final_json` betting block: for runs 27/31/32 the string contains 0 occurrences of `opener`, `closing`, `close`, `market_line`, `line_basis` (final keys: weeks_opened, player_faults_recorded, betting, reasoning, expert_learning, postgame_learning, interpretation). Cause: `nfl-blind-audit.js:341-365` `combineBettingSummaries` rebuilds `{bets,wins,losses,pushes,win_rate,units,roi,config,decision_audit,uncertainty,by_market}` and drops `opener_diagnostics`; `aggregate` then reduces to `{bets,wins,losses,units,roi}`. That is a provenance-hygiene gap on an artifact whose `spec_json.classification` is already `historical_algorithmically_blind_replay` and whose `interpretation` field says "Historical chronological replay only."

## 3. No number changes

`market_line_basis` is a string. Adding it to `replaySeason().summary`, to `final_json`, and as a §1.2 footnote changes zero digits of 153/−7.7% or 156/−7.1%. The §1.2 table (`docs/CLAUDE-NEXT-STEPS.md:29-35`) has no CLV row at all; `grep 2.28 docs/CLAUDE-NEXT-STEPS.md` returns nothing. The −2.28 CLV lives only in Nick's memory note (2026-09-09 session) — not in repo docs, code, scripts, or `server/data` (grepped). The review's "the plan's 1.2 table" framing over-states where that number appears.

## 4. No decision flips

Every consumer of the historical closing-line record is a one-directional gate that passes only on a POSITIVE result. A decision-time regrade is WORSE (38.67% vs 48%), so relabeling or regrading cannot move any gate from fail to pass:

- `nfl-research.js:174-175` `exact_policy` gate: `passed: !!overall && overall.roi > 0 && (overall.uncertainty?.probability_roi_above_zero ?? 0) >= 0.75` — latest `nfl_policy_audits` #1 (2026-08-24): roi −0.097, P(ROI>0) 0.079 → blocked either way.
- `model-intelligence.js:102` `profit_claim_quarantined: passed: !(replay?.roi > 0 && … < .75)` — only bites on a positive ROI.
- `nfl-experiments.js:118-123` `earnsPromotion` requires `candidate.beat_vig === true`.
- `nfl-replay.js:1078` `promotion_gate_passed = c.beat_vig === true && lowerRoi > 0`.
- `nfl-execution-edge.js:625` `if (source === 'model' && !(provenClv > 0))` → zero units; `provenClv` is forward.
- `nfl-profitability.js:227-238` gates are prop coverage / T-h capture / settlement / forward sample / teaser price — none reads the historical ROI; `:284` `staking_authority` derives from those gates only. `state` at `:252` likewise.

So `staking_authority` = "0 model-derived units" today and after any G07 fix.

## 5. Validity of the records

- Historical: already classified as development data (`plan:588`), already read by Nick as "no prediction edge vs the close". A decision-time evaluation, if it existed, would only strengthen that negative (it cannot rescue the record, because a stricter reference makes the same picks lose more). The conclusion Nick acts on — do not size on the model — is invariant.
- Forward: the 2026 tape/T-60 packet (`nfl-t60-packet.js`, C11/C12) consumes received quotes, not `game_lines.spread`; G07 does not touch it.

## 6. The "decision-time evaluation" half of SHOULD-BE is infeasible for 2021-25 with this model

- No opening price: `nfl-replay.js:93-96` "There is no stored opening PRICE (no `open_spread_odds` column, only the opening line number)".
- Opener quality: `game_lines.open_spread` is a synthetic multi-book median 2022+ and 2021 openers are corrupt (memory note; `nfl-profitability.js:109`).
- Closing-time features: `nfl-features.js:342` `closing_spread_avg: r3(avg(g.map(x => x.spread)))`, `:383` `closing_spread: g?.spread ?? null`; injuries carry no publication timestamp (A04). Re-running the model on archive openers still yields a closing-information forecast (AUDIT-EVIDENCE 2026-09-09:267-271 said exactly this and prescribed the relabel, which M07 then implemented).
- The OddsTrader archive (Pinnacle open + close with book timestamps, 2022+) is already used for the only honest opener-time diagnostic: `nfl-blind-audit.js:672-700` `historicalOpenerReplay` (nfelo / TeamRankings vs Pinnacle opener, CLV vs Pinnacle close) — a different signal, not the ensemble.

## 7. What is real in G07 (the P3 residue)

1. `combineBettingSummaries`/`aggregate` strip `opener_diagnostics`, so `nfl_blind_audit_runs.final_json` carries no line-basis marker (`nfl-blind-audit.js:341-365`, `:905`). Fix: one string field `market_line_basis: 'nflverse_closing_consensus; not decision-time'` in `replaySeason().summary` (`nfl-replay.js:322`) and propagate through `combineBettingSummaries` and `aggregate`. Zero behavior change.
2. Plan §1.2 rows 33-34 could footnote "graded at nflverse closing consensus; same-side opener regrade 38.67%". Cosmetic.
3. `nfl-neural-replay.js`/`weekly-walkforward.js` silent close grading is G37, already P3.

None of the three changes a number Nick reads, a decision, or the validity of either record.

## Scripts used (read-only)
- `scratchpad/audit-system/g07-db.cjs` — coverage by season, final_json keys/greps for runs 27/31/32.
- `scratchpad/audit-system/g07-db2.cjs` — fit artifact weights, replay/policy audit rows.
