# Adversarial verification — G16-client-betting (34 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)

## #174 ProfitabilityControl.tsx:104 / Edges.tsx:102 — reachable:true hardcoded — CONFIRMED (P1)
- ProfitabilityControl.tsx:74 `useState('-115')`, :104 `reachable: true` literal in POST body.
- Edges.tsx:80 `useState(-110)`, :102-103 same `reachable: true` literal, note "Manually verified from teaser execution board" (also hardcoded, not verifying anything).
- server/services/nfl-profitability.js:78 `input.reachable === true ? 1 : 0`; :86 `prices.find(price => price.reachable === 1 ...)`; :90 `wong_price_gate_passed: Boolean(latestReachable && latestReachable.american_price >= -115)`.
- No UI path anywhere sets reachable=false. Confirmed exactly as claimed. Real P1 — the only gate on the one claimed +EV bet is unverified free text with a hardcoded true flag.

## #175 LineShop.tsx:29 qualified/unpriceable_reason declared, never rendered — CONFIRMED (P2)
- LineShop.tsx:29 `qualified?: boolean; unpriceable_reason?: string;` — grep shows these identifiers appear nowhere else in the file (never destructured/rendered).
- server/services/nfl-shopping-board.js:151-164 does push `qualified: false, unpriceable_reason: exec.reason` on the refusal branch.
- server/services/nfl-execution-edge.js:520-568 sets `qualified: false` on every returned branch with explicit "Sizing paths must refuse to treat this as modeled profit" commentary.
- Client render (LineShop.tsx ~264-293) reads only best/median/expected_net_return/line_edge/price_edge — never qualified or unpriceable_reason. Confirmed as claimed.

## #176 WongProjection.tsx:53 optimistic fallback under "read this one" — CONFIRMED (P2)
- Line 53: `block={uncertain.units ?? point.units}` — confirmed exact.
- File's own doc comment (5-14) states the rule this exists to enforce (never show point estimate alone).
- Headline column keeps title "With rate uncertainty" / note "This is the number to plan around" / "read this one" badge (ColumnHeading, ~line 150-ish) regardless of which block is actually being shown. Confirmed.

## #177 TeamLogo.tsx:58 containment fallback only guards candidate length — CONFIRMED (P2)
- Line 58: `if (candidate.length >= 3 && (key.includes(candidate) || candidate.includes(key))) return team;` — guard applies to `candidate.length`, not `key.length`. A 2-char key ("la") matches any >=3-char candidate that contains it (e.g. "dallas" contains "la" at index 3-4). Map iteration order = insertion order from buildIndex, so first insertion order match wins silently. Confirmed as claimed — real defect, not word-boundary safe.

## #178 FieldSim.tsx:315 "Score at this point in the drive" shows score_after — CONFIRMED (P2)
- Line 34 declares both `score_before?`/`score_after?`; grep shows `score_before` is never read anywhere in the codebase (dead field).
- Line 315 uses `drive.score_after` under label "Score at this point in the drive"; this label is shown once per drive (before/alongside play 1), not just after the last play, so within a single drive the same post-drive score is shown for every play index, not the score before that drive began.
- TERMINOLOGY.md:106-109 explicitly documents intended behavior: the black pill should show the score "at this point in the drive" as distinct from the final-game-score tiles. Documented spec and code diverge. Confirmed.

## #179 LineShop.tsx:342 "You gain" (edge_vs_worst) vs Price improvement (median) — CONFIRMED but overstated as "contradiction" (downgrade to P3)
- Line 342 confirmed: `<div ...>{pct(o.edge_vs_worst)}</div>` under "You gain" label, in the `tab === 'prices'` section (fed by `/nfl-betting/lines/shop`).
- The "board" tab (same file, ~line 283) uses `expected_net_return` labeled "Price improvement" against the median book — a genuinely different source/endpoint (`/betting/execution/board`).
- HOWEVER: server/services/line-shopping.js:118 and :167 explicitly document `edge_vs_worst` as a **deliberate, separately-honest** metric ("the honest measure of what shopping saves... requires no prediction — only refusing the worse number"), not a mislabeled median comparison. TERMINOLOGY.md's canonical "Price improvement" definition is scoped explicitly to "Line Shop → Best book per side" (the board tab) and does not claim to cover the separate "prices" tab's worst-book metric.
- So this is not literally "two incompatible definitions of the same quantity" mandated by TERMINOLOGY.md — it's two different, each-intentionally-documented metrics living in different tabs of the same page, with genuinely confusable but not contradictory labels ("You gain" vs "Price improvement"). Real UX nit (labels are close enough to blur together for a reader), but the severity/framing in the claim overstates it as a doc-contradicting bug. Recommend downgrading to P3 (naming/clarity), not a P2 correctness defect.

## #180 Ensemble.tsx:137 "80% range" shown unqualified — CONFIRMED (P2)
- Line 137 confirmed: Cell renders `e.distribution.margin_interval_80` in the collapsed row with no research-only qualifier.
- `production_eligible`/`calibration_state` declared in the `Ensemble` interface (lines 22-23) and grepped — never read/used anywhere else in the file.
- server/services/nfl-ensemble.js:248-250 confirms server stamps `calibration_state: 'research_distribution_only', production_eligible: false`.
- The "research only" pill only appears inside `DistributionPanel`, which renders only when the row is expanded. Confirmed as claimed.

## #181 Ensemble.tsx:133 Edge cell (>=1.5) vs Edge guard (>=3) mismatch — CONFIRMED (P2)
- Line 123: `const eligible = Math.abs(e.spread_edge ?? 0) >= 3 && (e.model_disagreement_margin ?? Infinity) <= 4.5;`
- Line 133-134 (Edge Cell): `tone={Math.abs(e.spread_edge ?? 0) >= 1.5 ? 'good' : undefined}`.
- Line 138: `{eligible ? 'Edge guard' : 'Abstain'}`. Two different thresholds on the same row, no explanation. Confirmed exactly as claimed.

## #182 Ensemble.tsx:213 fixed-shape margin-distribution bar — CONFIRMED (P2)
- Confirmed: `q` (margin_quantiles) is destructured and used only for the P10/Median/P90 text labels; the bar div below uses literal `left-[18%] right-[18%]`/`left-1/2` — never derived from `q`. Every game's bar renders identically regardless of actual spread. Confirmed as claimed.

## #183 GameScript.tsx:70 season picker stuck at 2025 — CONFIRMED (P2, but file is orphaned)
- Line 52 `useState(2025)`; line 70 `[2025, 2024, 2023, 2022].map(...)` — no 2026 option, confirmed.
- Verified via grep across client/src: no importer references `pages/betting/GameScript` — the file is not reachable from the app (orphaned), matching the claim's own caveat.
- Model.tsx:323 (the live equivalent) does correctly query `season=2026`. Confirmed as claimed, with orphaned-file caveat already acknowledged by the claim itself.

## #184 GameScript.tsx:110 emerald "better" for any improvement sign — CONFIRMED (P2, orphaned file caveat applies same as #183)
- Confirmed: `<span className="text-emerald-700">({(...improvement * 100).toFixed(1)}% better)</span>` at both touchdowns (:107-ish) and yards (~:116) blocks, unconditional on sign. Card background at :102-104 does correctly gate emerald/amber on `helps`. Confirmed real inconsistency within the same card.

## #185 GameScript.tsx:91 literal '+' prefix produces "+-0.41%" — CONFIRMED (P2, orphaned file)
- Confirmed: Stat values for Touchdowns/Yards/Receptions use literal `+${...toFixed(2)}%` template (no sign-awareness), while Pass share (~line 97) omits the prefix, and the `mult()` helper (lines 47-48) which already handles signs correctly is unused here. Confirmed.

## #186 NflProps.tsx:102/127 oddsConnected true when payload absent — CONFIRMED (P2)
- Line 102: `const oddsConnected = !shown?.market_status?.includes('no ODDS_API_KEY');` — `shown` undefined → optional chain → undefined → `!undefined` = true.
- Line 127 renders `tone={oddsConnected ? 'good' : 'neutral'}` / text "Odds connected". Confirmed exactly.

## #187 NflProps.tsx:129/271/276 head counts fall back to literal 24 — CONFIRMED (P2)
- Line 129: `{(heads?.count ?? 24) + (heads?.prop_calibration?.count ?? 24)} model + calibration heads`.
- Line 271: `${heads?.count ?? 24} heads`; line 276: `${calibration?.count ?? 24} heads`. All confirmed exact matches.

## #188 pct() '+' prefix combining with its own sign — CONFIRMED (P2), 3 sites
- props/lib.ts:70 `pct = (v) => ... `${(100 * v).toFixed(1)}%`` — natively includes "-" for negative v via toFixed, no explicit "+" ever added by pct() itself.
- PropsBoard.tsx:109 `+{pct(b.probability_difference)}`; PropsAutoPicks.tsx:130 `+{pct(p.probability_difference)}`; NflProps.tsx:190 `+{pct(b.probability_difference)}`. All three confirmed exact line matches — a negative probability_difference renders "+-3.2%". Confirmed.

## #189 PropsPicks.tsx:176 two win rates, different push handling — CONFIRMED but "same label" is loose (keep P2)
- Line 101 `settledTickets = filteredTickets.filter(t => t.status !== 'Pending')` (includes Push).
- Line 106 `settledLegs = legRecord.won + legRecord.lost + legRecord.push` (includes Push) → feeds "leg win rate" detail at line 178.
- Line 109 `decidedLegs = filteredLegs.filter(l => l.grade.status !== 'Pending' && l.grade.status !== 'Push')` (excludes Push) → feeds "Efficiency" tile (line 260) whose own detail text says "Win rate on decided legs, excluding pushes."
- Both tiles are literally labeled differently ("leg win rate" vs "Efficiency"/"Win rate on decided legs") rather than sharing one identical label, so "same label" slightly overstates it, but the underlying inconsistency (two differently-denominated "win rate" style metrics on one screen, in different sections) is real and verified. Kept as confirmed, minor wording caveat noted.

## #190 PropsModel.tsx:136 stale "local browser only" claim — CONFIRMED (P2)
- Confirmed limitations text at line ~136-137 states pick tracking "is local to this browser only."
- usePickSlip.ts:23 `useApi<Ticket[]>('/props-tickets')`; :79 `await api('/props-tickets', {method:'POST', ...})`.
- lib.ts:17-23 doc comment explicitly documents the migration away from localStorage for saved tickets, and why (multi-device use). Confirmed factual staleness in the shown text.

## #191 PropsModel.tsx:52 "Line feed" health card hardcoded green — CONFIRMED (P2)
- Line 52: `<HealthCard label="Line feed" value={status.line_feed_status} detail={...} good />` — `good` passed as a bare literal `true`.
- HealthCard definition (~145-148): `className={... ${good ? 'text-emerald-700' : 'text-slate-800'}}`. Confirmed — value renders green regardless of actual `line_feed_status` content ("stale"/"unavailable" etc. still draw green).

## #192 Decisions.tsx:168 non-Won treated as loss (push shown red) — REFUTED
- Line 168 code is exactly as quoted: `d.result === 'Won' ? 'bg-emerald-50 ...' : 'bg-rose-50 ...'`.
- BUT: traced the sole writer of the `decision_basis` table (server/services/decision-basis.js `recordSeasonBases`, line 134): `const bets = rep.bets.filter(b => ['Won', 'Lost'].includes(b.result)).slice(0, maxBets);` — Push results are filtered OUT before ever being written to `decision_basis`. Confirmed via grep that `decision_basis` has exactly one INSERT statement (line ~153) and it only ever originates from this filtered `bets` array. `decisionDetail()` (line 322) reads `d.result` straight from that table, so `result` can only ever be 'Won' or 'Lost' by construction — never 'Push'.
- The claim's premise ("result: string is free-form, not a Won/Lost boolean") is technically true of the TS type but the actual data pipeline guarantees only Won/Lost values reach the client. This is a case where an upstream guard already prevents the failure scenario described. Refuted.

## #193 Diagnostics.tsx:228 unguarded split(':')[1] crash — REFUTED
- Line 228 code matches exactly: `{f.name.split(':')[1].replaceAll('_', ' ')}`.
- Traced `f.name`'s origin: server/services/line-move-study.js `featureNames()` (line 297-303) builds every name as `names.add(\`${t}:${k}\`)` — i.e. every name is constructed by string-template with an explicit colon, no other producer exists. `perFeature` (line 398-400) uses `names.map((name, j) => ...)` directly from this same array, so `name` is guaranteed to contain exactly one colon by construction. There is no code path (in the current `line-move-study.js`) that can produce a colon-less `f.name`.
- The claimed crash scenario ("any feature name without a colon throws") describes a structural invariant violation that cannot occur given the current generator; refuted (the "unguarded" split is real code smell but not an exploitable defect today).

## #194 ModelOperations.tsx:169 red-team pill green when absent — CONFIRMED (P2)
- Line 169 confirmed exactly: `tone={x.red_team?.passed === x.red_team?.total ? 'good' : 'warn'}` — when `x.red_team` is undefined, `undefined === undefined` → true → 'good', while text falls to the `x.red_team ? ... : 'MLB policy'` branch, showing "MLB policy" in an emerald/good pill. Confirmed as claimed.

## #195 ProfitabilityControl.tsx:233/239 specialist count fallback 12 vs disclaimer — CONFIRMED (P2)
- Line 233: `value={\`${reporting.specialists ?? 12}\`}`.
- Line 239 empty-state text: literally contains the sentence `This is an empty model-memory state, not "12 specialists reporting."` Confirmed — exact contradiction within the same component.

## #196 Venues.tsx:193 hardcoded Brier stats vs live Stat renders — CONFIRMED (P2)
- Line 193 prose hardcodes "Brier 0.171 against a 0.25 baseline over 2,196 graded states."
- Lines 201, 202, 207 render `liveStatus.model_validation?.brier`, `.baseline`, `.states_graded` live from `/betting/live/status`. Confirmed — frozen prose sits directly above/near numbers that can drift from it.

## #197 ResearchLab.tsx:258/222 badges hardcoded from presence, not verdict — CONFIRMED (P2)
- Line 258: `{data.expert_selector_lab ? 'Ran · result negative' : 'Not run yet'}` — ignores `r.verdict.any_trial_passed` (typed at line 81), which is never referenced anywhere in the badge logic.
- Line 222 similarly: `{data.news_event_impact ? 'Extraction ran · impact not measurable' : 'Not run yet'}`, ignoring `e.evaluation?.verdict` (rendered separately at ~line 233). Confirmed both instances exactly.

## #198 WongSeason.tsx:39 no paper/placed split on Units won/ROI — REFUTED (mischaracterizes actual behavior)
- Client code at lines 37/39/42/44 matches the claim's snippet/evidence exactly, and the `WongSeason` TS interface (types.ts:180-188) declares flat `tickets`, `record`, `units_staked`, `units_won`, `roi` fields, consistent with what the claim assumes the server sends.
- BUT traced the actual server response: `/api/betting/wong/season` → server/routes/wong.js:324-331 → `mod.wongSeason(...)` → server/betting/nfl/strategy/teaser-season.js `wongSeason()` (line 910-980) returns an object shaped `{ season, generated_at, settings, placed, paper, open_tickets, pace, price, projection, forward_leg_rate, version }` — there is NO top-level `tickets`, `record`, `units_staked`, `units_won`, or `roi` field on the actual response; those numbers exist only nested under `placed`/`paper` sub-accounts (each computed separately via the `account()` closure at line 921, which already keeps placed/paper apart, confirmed by the file's own doc comment at 906-909: "Placed and paper are kept apart throughout... a combined ROI is a number that describes neither").
- Given the actual API shape, `season.units_won`/`season.units_staked`/`season.roi` are always `undefined` in the client, so `signedUnits(undefined)`/`pct(undefined)` render as "—" (dashes), not a blended/inflated dollar figure as the claim describes. The claim's specific failure mechanism ("the dollar figure a user reads as their season P&L includes paper bets") does not occur — the actual defect (if any) is a client/server contract mismatch producing blank/missing stats, a different and arguably more severe bug than what was claimed. Refuted as stated; flag the real contract mismatch as a separate, unclaimed defect for the record.

## #199 WongSettings.tsx:151 default option shown as saved / can't confirm — REFUTED
- Line 151 code matches exactly: `const current = typeof value === 'string' ? value : REDUCED_PAYOUT_OPTIONS[0][0];`
- Traced `value` (=`draft.reduced_payout`) back to its source: server/betting/nfl/strategy/teaser-season.js `DEFAULT_WONG_SETTINGS.reduced_payout = DEFAULT_REDUCED_PAYOUT` (always a string) and `validateSettings()` (line 138) requires `REDUCED_PAYOUT_MODELS.includes(s.reduced_payout)` where `REDUCED_PAYOUT_MODELS = ['stake_back','same_price','graded_loss']` — `reduced_payout` can never be null/undefined/non-string in a value returned by `wongSettings()` (line 168, confirmed: "a stored blob that no longer validates ... defaults are used" — always a valid enum string). GET `/betting/wong/settings` route (server/routes/wong.js ~291-303) spreads `mod.wongSettings()` directly, confirming the string is always present.
- So the specific "no push rule is stored" scenario the claim requires (a non-string `reduced_payout`) cannot occur; the fallback branch is dead in practice. Refuted as stated.
- Separately (not part of the specific claim, noted for completeness): `REDUCED_PAYOUT_OPTIONS` ids (`reduce_to_single`/`push_refunds_stake`/`loses`) do not match the server's actual enum (`stake_back`/`same_price`/`graded_loss`) at all — a genuinely different, more severe bug (every dropdown option would fail server validation if selected) than what claim #199 describes, but that's a distinct defect not covered by this claim's specific mechanism.

## #200 format.ts:99 bare "api" substring match — CONFIRMED but currently unexercised (keep P2, note narrow blast radius)
- Line 99 regex confirmed exactly: `/first[\s_-]?(party|hand)|direct|quote[\s_-]?tape|api|official/i`. This is a real, generic correctness defect (no word boundary on "api").
- Traced every actual provenance value assigned in the codebase for teaser/Wong data: server/betting/nfl/strategy/teaser-scan.js only ever sets `provenance: 'first_hand_tape'` or `provenance: 'second_hand_aggregator'` (lines 54/60), which are the only two literal values propagated through the pipeline to `TeamLogo`-adjacent Wong UI (WongBoard/WongComparison/TicketCard). Both current values are correctly classified by the regex (no false positive today).
- The claim's example ("third_party_api_scrape"/"aggregator_api") is hypothetical, not sourced from live code. The underlying function defect is real and would misclassify such a string if it ever appeared, but no current call site can produce it. Kept as confirmed (the code genuinely has this flaw) with a note that real-world impact is currently nil given the fixed two-value enum.

## #201 format.ts:56 evPercentText unit-inference heuristic — CONFIRMED (P2, correctly framed as conditional risk)
- Lines 45-53 doc comment and lines 56-57 logic confirmed exactly as quoted. `evPercentText` is used at TicketCard.tsx:62, confirmed the largest/most prominent figure on each Wong ticket card.
- The claim is explicitly conditional ("If the server ever sends ev in different units...") and accurately describes a real fragility in the heuristic as coded. Confirmed.

## #202 BettingWorkspace.tsx:91 "Fresh and comparable" fallback with no capture — CONFIRMED (P2)
- Lines 88-91 ternary confirmed exactly: `capture_stale ? 'Too old to bet on' : free_feeds?.latest_capture ? '<n> books...' : 'Fresh and comparable'`. The final branch fires whenever there is no capture at all (not merely "not stale"), asserting freshness with zero evidence. This chip is shared via `BettingWorkspace` across multiple hub pages. Confirmed.

## #203 NflAutoPicks.tsx:20 quote_source withheld — REFUTED (book and quote_source are identical values)
- Confirmed `quote_source` is declared on `PickRow` (line 20) and never referenced/rendered anywhere else in NflAutoPicks.tsx (WeekTable only reads `p.book`).
- BUT traced server/services/nfl-auto-picks.js line 161: `book: quote?.source ?? null, quote_source: quote?.source ?? null` — both fields are assigned the exact same value (`quote?.source`) at the one and only place PickRow-shaped objects are constructed (grepped — only one `book:` assignment exists in the file). There is no other code path that gives these two fields different values.
- Therefore rendering `p.book` (which the table does, at line ~136) already displays exactly what `quote_source` would show; nothing is actually being "withheld" that isn't already visible under a different property name. (Separately, verified via read-only sqlite query that the underlying `game_lines.source` column only ever contains `'nflverse'` or `'espn'` — data-provider names, not sportsbook names — which is a different, real transparency concern about what "book" even means here, but that's not what claim #203 asserts.) Refuted as stated.

## #204 NflExecutionDesk.tsx:76 (file path in claim is wrong — actual path is pages/betting, not components/betting) early-return hides provenance — REFUTED
- File note: claim cites `client/src/components/betting/NflExecutionDesk.tsx`; the actual file is `client/src/pages/betting/NflExecutionDesk.tsx` (components/betting/NflExecutionDesk.tsx does not exist). Line number (76) and quoted code are otherwise exact.
- `if (!preview?.length) return null;` (line 76) does structurally discard the whole `<details>` block including the `quote_provenance` paragraph (line 87) when `delayed_execution_preview` is empty/absent — the code mechanism as described is real.
- BUT traced the only producer of `decision` lifecycle events: server/services/nfl-execution-pipeline.js line 219-227 `recordDecision(...)` always sets `detail.delayed_execution_preview: replay` where `replay = replayDelayLadder(...)` (line 216), which (server/services/nfl-execution-replay.js line 312-318) is `delays.map(...)` over `DEFAULT_DELAY_LADDER_SECONDS = Object.freeze([5, 30, 120, 600])` (line 76) — a fixed, non-empty 4-element array — so `replay`/`preview` is guaranteed non-empty for every decision recorded through the (sole) current pipeline. Grepped confirmed only one `recordDecision(` call site in the codebase.
- So for any decision produced by current code, `preview?.length` is always truthy and the early return never fires; the scenario described ("an opportunity with no replay preview shows the price with no provenance at all") cannot occur for new decisions given this structural invariant (it could only apply to legacy/pre-feature data, which the claim does not scope to). Refuted as a live, general defect.

## #205 GameSimulator.tsx:236 literal "own" prefix — CONFIRMED (P2, orphaned file)
- Line 236 confirmed exact: `<td ...>own {d.start_yard}</td>`.
- FieldSim.tsx:471 confirmed has a correct `formatFieldPosition()` handling own/midfield/opponent that GameSimulator.tsx does not use.
- Confirmed via grep that GameSimulator.tsx is not imported anywhere else in client/src (orphaned), matching the claim's own caveat. Confirmed as claimed.

## #206 UnifiedEngineRoom.tsx:19/55 frozen season/week=2026/1 vs "adapt after games settle" copy — CONFIRMED (P2)
- Line 19 confirmed: `/nfl-betting/roster/strength?season=2026&week=1&team=${rosterTeam}` — season/week are literal, never derived from state/props.
- Line 55 confirmed heading "Preseason opening prior" / copy "real weekly snaps and efficiency adapt it after games settle" sits directly above data that can never reflect any week but 1. Confirmed as claimed; the neuralReplay static-prose-vs-live-figures pairing at line 49 is a fair secondary instance of the same "frozen text next to live numbers" pattern.

## #207 BettingHome.tsx:54 progress bar hardcoded 50% — CONFIRMED (P2)
- Line 54 confirmed exact: `<div className="h-full w-2/4 rounded-full bg-emerald-600" />` — a literal Tailwind width class, not derived from `sizing_allowed` or any other model-readiness state. Confirmed as claimed.

---

## Summary of REFUTED claims (6 of 34)
- #192 Decisions.tsx push-as-loss — refuted (upstream filter in decision-basis.js:134 guarantees `result` is only ever Won/Lost)
- #193 Diagnostics.tsx split(':')[1] crash — refuted (featureNames() in line-move-study.js:297-303 guarantees every name has a colon)
- #198 WongSeason.tsx paper/placed blending — refuted (actual API response has no top-level units_won/roi at all; claim's dollar-blending mechanism doesn't match the real contract mismatch)
- #199 WongSettings.tsx default-option-shown-as-saved — refuted (reduced_payout is always a valid non-null string by server default+validation; the non-string fallback branch is unreachable)
- #203 NflAutoPicks.tsx withheld quote_source — refuted (book and quote_source are assigned the identical value server-side; nothing is actually hidden)
- #204 NflExecutionDesk.tsx hidden provenance — refuted (delayed_execution_preview is always non-empty by construction for every decision recorded through the current, sole pipeline); also note claim's file path is wrong (pages/ not components/)

All other 28 claims were verified accurate against the cited code (several with minor wording/severity caveats noted above: #179 downgrade to P3-ish naming nit, #189 "same label" is loose but core defect real, #200 real defect but currently zero live blast radius given fixed 2-value enum).
