# Verification notes — G16-client-betting (34 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
Method: opened each cited file, read >=80 lines around each cited line plus callers/callees,
traced server-side data generation where the claim depends on runtime values, and checked
reachability (lazy import into a mounted route, or single write-path into a DB table).

## CONFIRMED (26)

### #174 ProfitabilityControl.tsx:105 (P1) — CONFIRMED
`saveTeaser` posts `reachable: true` hardcoded (ProfitabilityControl.tsx:105), price defaults to
'-115' (state init `useState('-115')`). Server: nfl-profitability.js:78 stores `input.reachable
=== true ? 1 : 0` verbatim (no verification); :86 `teaserPriceLedger()` selects
`latestReachable` purely by `reachable===1`; :90 `wong_price_gate_passed =
Boolean(latestReachable && latestReachable.american_price >= -115)`. Edges.tsx:97-101 has the
identical hardcode with note "Manually verified from teaser execution board" (confirmed at
Edges.tsx:102). Reachable: ProfitabilityControl is rendered by NflModelOperations
(ModelOperations.tsx:81), mounted at NflMarketBoard.tsx (proofView==='data'). Claim stands.

### #175 LineShop.tsx:29 (P2) — CONFIRMED
Type declares `qualified?: boolean; unpriceable_reason?: string` (line 29) with a doc comment
(24-27) saying "qualified is false on every row". Server nfl-shopping-board.js:151-161 pushes
best_book:null, qualified:false, unpriceable_reason:exec.reason for unpriceable sides. Render
(LineShop.tsx:264-293 "Best book per side") never reads `qualified` or `unpriceable_reason`
(confirmed via grep — the fields appear only in the type declaration, never in JSX). A refused
side renders best_line '—', price-improvement '—', with no reason shown. Reachable: LineShop is
lazy-loaded into NflMarketBoard (executeView==='shop'); nfl-shopping-board.js is imported by
nfl-execution.js, nfl-pick-watch.js, nfl-teaser-execution.js, line-shopping.js. Confirmed.

### #176 WongProjection.tsx:53 (P2) — CONFIRMED
`block={uncertain.units ?? point.units}` under the "With rate uncertainty" headline column
(note: "This is the number to plan around", badge "read this one" at line 150, always applied
via `headline` prop regardless of whether the value is the true uncertain band or the optimistic
fallback). Confirmed at exact lines. Reachable via WongSeasonView -> NflWongHub (mounted, view
'season').

### #177 TeamLogo.tsx:58 (P2) — CONFIRMED
`normalize()` (line 29) lowercases+strips to alnum+space. `resolveTeam` fallback loop (55-58):
`if (candidate.length >= 3 && (key.includes(candidate) || candidate.includes(key))) return team;`
— the length guard applies only to `candidate`, never to `key`. A 2-char key (e.g. "LA") cannot
satisfy `key.includes(candidate)` (candidate longer than key) but CAN satisfy
`candidate.includes(key)` against any long team/city name containing "la" as a substring (e.g.
"dallas" contains "la"), with no guard on key length and first-match-wins by Map insertion order.
Reachable: TeamLogo used in TicketCard, WongComparison, WongSeason, WongRecommendedSet, all
reachable via NflWongHub.

### #178 FieldSim.tsx:315 (P2) — CONFIRMED
Header label "Score at this point in the drive" (line 315) renders `drive.score_after` (never
`drive.score_before`, which is declared in the Drive type at line 34 and never referenced
anywhere in the file besides the type — grep confirms only 3 uses of score_after and 0 real uses
of score_before beyond the interface). Drive-detail panel at line 444 has a correctly-labeled
"Score after" row using score_after. TERMINOLOGY.md:106-109 documents intended behavior: "the
field's black pill shows the score at this point in the drive — these can legitimately differ".
Reachable: FieldSim lazy-loaded into NflMarketBoard (section==='live').

### #179 LineShop.tsx:342 (P2) — CONFIRMED
"You gain" label (line 341) renders `pct(o.edge_vs_worst)` (best price vs. WORST book), while the
"Best prices" tab's own doc/description at line 256 says the honest counterfactual is the
*median* book, and the other tab ("Best book per side") is correctly labeled "Price improvement"
against the median. TERMINOLOGY.md:27 defines "price improvement" as best vs. median. Two
incompatible definitions on one page, one styled as an unqualified gain in emerald. Confirmed,
reachable (same component as #175).

### #180 Ensemble.tsx:137 (P2) — CONFIRMED
Collapsed-row "80% range" cell (line 137) prints `e.distribution.margin_interval_80` with no
qualifier. Server nfl-ensemble.js:249-250 stamps `calibration_state:
'research_distribution_only', production_eligible: false` on that same object; both fields are
declared on the client type (Ensemble.tsx:23) and never read anywhere else in the file (grep
confirms 0 other usages). The "research only" pill is inside `DistributionPanel`, rendered only
when the row is expanded (`open &&`). Confirmed, reachable (EnsemblePage lazy-loaded,
proofView==='ensemble').

### #181 Ensemble.tsx:133 (P2) — CONFIRMED
Edge cell tone: `Math.abs(e.spread_edge ?? 0) >= 1.5 ? 'good' : undefined` (line 133/134);
`eligible` computed at line 123 as `>= 3 && disagreement <= 4.5`, driving the "Edge guard" /
"Abstain" pill at line 138. A 2.0-point edge highlights the Edge cell green while the adjacent
pill reads "Abstain" — two different thresholds on one row, no cross-reference. Confirmed.

### #182 Ensemble.tsx:213 (P2) — CONFIRMED
`DistributionPanel`: `const q = d.margin_quantiles` used only for the P10/Median/P90 text labels
(line 212); the bar beneath (`left-[18%] right-[18%]`, centered tick at `left-1/2`) is drawn with
literal fixed percentages, never derived from `q`. Every game's bar is visually identical
regardless of real quantile spread. Confirmed.

### #186 NflProps.tsx:102/127 (P2) — CONFIRMED
`oddsConnected = !shown?.market_status?.includes('no ODDS_API_KEY')` (line 102). When `shown` is
undefined (first paint, or a failed fetch), `undefined?.includes(...)` -> undefined, `!undefined`
-> true, so line 127 renders `<StatusPill tone="good">Odds connected</StatusPill>` with no market
data at all. Confirmed exact lines; reachable (NflProps lazy-loaded, decideView==='props').

### #187 NflProps.tsx:129 (P2) — CONFIRMED
`(heads?.count ?? 24) + (heads?.prop_calibration?.count ?? 24)` (line 129); identical `?? 24`
fallback repeated at line 271 ("Candidate registry") and 276 ("TD calibration registry"). A
failed `/nfl-betting/heads` fetch is visually indistinguishable from "24 heads really registered".
Confirmed.

### #188 PropsBoard.tsx:109 (P2) — CONFIRMED
`+{pct(b.probability_difference)}` (line 109); `pct()` in props/lib.ts:70 already emits its own
sign for negatives (`(100*v).toFixed(1)` yields e.g. "-3.2"). A negative
`probability_difference` renders "+-3.2%" in `text-emerald-700` (green). Identical pattern
confirmed at PropsAutoPicks.tsx:130 and NflProps.tsx:190 (EdgeCard). Reachable: PropsBoard
lazy-loaded via MlbHub (view==='slate', source!=='first_party').

### #189 PropsPicks.tsx:176/260 (P2) — CONFIRMED (label overlap slightly looser than stated)
"Leg record" tile (headline, line ~178 detail) computes win rate as
`legRecord.won / settledLegs` where `settledLegs = won+lost+push` (push in denominator).
"Efficiency" tile (line 260) computes `legWins / decidedLegs.length` where `decidedLegs`
(line 109) explicitly excludes Pending AND Push. Both are on the same "Saved Slips" summary row.
Note: the Efficiency tile's OWN detail text says "Win rate on decided legs, excluding pushes" —
so it is self-disclosing about the exclusion, which is a bit more transparent than the claim's
"same label" framing implies (the two detail strings are "% leg win rate" vs "Win rate on decided
legs, excluding pushes", not identical). The underlying inconsistency (two win-rate-style numbers
with different denominators on one screen) is real and verified; sibling page
PropsAutoPicks.tsx:73-77 correctly excludes pushes from its `settled`/`winRate` calc, confirming
the codebase is inconsistent about this. Keeping as CONFIRMED P2 with a note that "same label" is
a mild overstatement.

### #190 PropsModel.tsx:136 (P2) — CONFIRMED
Limitations panel text (lines 134-137): "Pick tracking on the My Picks page is local to this
browser only — no stake size, payout, account, or payment information is collected." Confirmed
stale: usePickSlip.ts:1-16 doc comment + code (`useApi<Ticket[]>('/props-tickets')`, POST to
`/props-tickets`) show saved tickets are server-side (server/routes/props-tickets.js +
server/migrations/018_saved_prop_tickets.js per props/lib.ts:17-23 comment), specifically
*because* of the multi-device problem this stale claim describes. Bonus: PropsPicks.tsx:122 has
an identical stale claim ("Everything is saved in this browser only") — this stale message
appears twice in the app. Reachable (PropsModel lazy-loaded via MlbHub, view==='model').

### #191 PropsModel.tsx:52 (P2) — CONFIRMED
`<HealthCard label="Line feed" value={status.line_feed_status} detail={...} good />` — `good` is
a hardcoded literal `true` prop (not derived from `status.line_feed_status`). HealthCard
(lines 144-148) applies `text-emerald-700` whenever `good` is truthy. A status of "stale" or
"unavailable" renders in the same green as "live". Confirmed exact line; reachable.

### #194 ModelOperations.tsx:169 (P2) — CONFIRMED, and reachable EVERY TIME for MLB
`tone={x.red_team?.passed === x.red_team?.total ? 'good' : 'warn'}` (line 169). `red_team` is
`optional` on the Intelligence type (line 42). Checked both intelligence sources:
`nflIntelligence()` (model-intelligence.js:124-129) always includes `red_team: redTeam()`, so for
NFL this branch only misfires on a malformed/partial response. But `mlbIntelligence()`
(model-intelligence.js:133-138) **never includes a `red_team` field at all** — so for the MLB
Model Operations panel (`MlbModelOperations`, reachable via MlbAutoPicks.tsx `showOperations`),
`x.red_team` is always `undefined`, `undefined === undefined` is `true`, and the pill is
permanently rendered green ("MLB policy") on every view — not a rare edge case, the default
state. Confirmed and actually reachable 100% of the time for MLB.

### #196 Venues.tsx:193 (P2) — CONFIRMED
Prose (lines 189-193) hardcodes "Brier 0.171 against a 0.25 baseline over 2,196 graded states".
Stats block 8 lines below (201-207) renders `liveStatus.model_validation?.brier`, `.baseline`,
`.states_graded` live from `/betting/live/status`. The two will drift as soon as the live model
validation numbers change. Confirmed; reachable (Venues lazy-loaded, executeView==='venues').

### #197 ResearchLab.tsx:258 (P2) — CONFIRMED
`{data.expert_selector_lab ? 'Ran · result negative' : 'Not run yet'}` (line 258) — hardcodes
"result negative" purely from object presence, never consulting
`r.verdict.any_trial_passed` (typed at line 81). Same pattern at line 222 for the news-event
package ("Extraction ran · impact not measurable" regardless of `e.evaluation?.verdict`).
Confirmed; reachable (ResearchLab lazy-loaded, proofView==='research').

### #202 BettingWorkspace.tsx:91 (P2) — CONFIRMED and reachable
Ternary (lines 87-91): `capture_stale ? 'Too old to bet on' : free_feeds?.latest_capture ? '<n>
books...' : 'Fresh and comparable'`. Traced both fields to server (betting-hub.js:296-346):
`capture_stale = board.stale` where `board = executionBoardSummary()` and
`nfl-shopping-board.js:424 stale: captures.length === 0` (a DIFFERENT capture stream — the paid
multi-book execution board) — while `free_feeds.latest_capture` comes from a SEPARATE free-feed
capture stream (`feeds.recent_captures?.[0]`). These two are independent, so it is genuinely
possible for the paid board to be fresh (`capture_stale=false`) while the free-feed stream has
never captured anything (`latest_capture=null`), landing on the "Fresh and comparable" branch
with zero real free-feed evidence. Reachable: BettingWorkspace mounted on BettingHome,
NflMarketBoard, NflWongHub, MlbHub.

### #204 NflExecutionDesk.tsx:76 (P2) — CONFIRMED (path in claim is wrong: file is under
`client/src/pages/betting/`, not `client/src/components/betting/`; line numbers match)
`ReplayPreview`: `if (!preview?.length) return null;` (line 76) discards the entire block
including the quote-provenance paragraph (lines 86-89) that lives inside the same JSX return.
Traced server side (nfl-execution-pipeline.js:220-227): `quote_provenance` and
`delayed_execution_preview` (`replay`) are set together in the SAME object literal from the SAME
`recordDecision` call — so whenever `replayDelayLadder(...)` legitimately returns an empty array
(e.g., decision made very close to kickoff, no delay buckets to replay), `quote_provenance` is
still populated on `decision.detail` but the whole panel — and with it the provenance line — is
suppressed by the early return. Confirmed as reachable, not merely hypothetical.

### #206 UnifiedEngineRoom.tsx:19 (P2) — CONFIRMED
`useApi<any>(\`/nfl-betting/roster/strength?season=2026&week=1&team=${rosterTeam}\`)` (line 19) —
season and week are string-literal-hardcoded, never derived from current date or a selector.
Panel heading (line 55): "Preseason opening prior" / "Trades and rookies update the preseason
state; real weekly snaps and efficiency adapt it after games settle." — the described adaptation
can never be observed since the query is pinned to week 1 forever. Secondary instance also
confirmed at line 49: static prose ("one opened season supplies more profit than the combined
total, while 2023 and 2025 lose") sits beside live-rendered `neuralReplay` metrics. Reachable
(component mounted at NflMarketBoard, proofView==='overview').

### #207 BettingHome.tsx:54 (P2) — CONFIRMED
`<div className="h-full w-2/4 rounded-full bg-emerald-600" />` (actual line ~54) under labels
"Built" / "Proven live" / "Funded" (line 56-57) — a literal Tailwind width class, never bound to
`status.data?.model.sizing_allowed` or any other state. Identical regardless of whether the model
is cleared to bet. Confirmed; reachable (BettingHome uses BettingWorkspace, default betting
landing page).

## REFUTED (8)

### #183, #184, #185 GameScript.tsx (betting) — REFUTED: unreachable/orphaned file
`client/src/pages/betting/GameScript.tsx` has **zero importers anywhere in the codebase**
(grep across client/src for `betting/GameScript` and for any import of this specific file: no
hits outside the file itself). `client/src/pages/Model.tsx` renders a *different*, self-contained
`GameScript` function defined inline at Model.tsx:321 (imported nowhere, just declared and used
in the same file) — it is not the same component as the one in betting/GameScript.tsx, and does
correctly query `season=2026` (Model.tsx:323). The reader's own evidence for #183 acknowledges
"Currently masked because the file is orphaned (no importer)" — per the reachability lens, a
component with no caller in the mounted app cannot manifest any of the three claimed defects
(season picker capped at 2025, walk-forward "better" mislabeling, missing '+' sign vs. literal
'+' prefix) to a real user. Refuted as not-a-defect in the running app; flagged as dead code
worth a cleanup pass rather than a P2 UI bug.

### #205 GameSimulator.tsx — REFUTED: unreachable/orphaned file
`client/src/pages/betting/GameSimulator.tsx` — grep across the entire client and server trees
for "GameSimulator" returns exactly one hit: its own `export default function GameSimulator()`
declaration. No lazy import, no static import, no route table reference anywhere. Fully dead
code; the "own 60" formatting bug (vs. the correct `formatFieldPosition` in FieldSim.tsx:471-477)
cannot render in the running app. Refuted under the reachability lens.

### #192 Decisions.tsx:168 (claimed P2) — REFUTED
`d.result === 'Won' ? emerald : rose` (line 168) is syntactically as described, but traced the
only write path into the `decision_basis` table (decision-basis.js `recordSeasonBases`, the sole
INSERT into `decision_basis` in the whole server tree): line 134 —
`const bets = rep.bets.filter(b => ['Won', 'Lost'].includes(b.result))` — filters OUT any push
result *before* it is ever written to the table. Every `result` value ever stored in
`decision_basis`, and therefore every `d.result` the client can ever receive from
`GET /betting/decisions/detail`, is either 'Won' or 'Lost' — never 'Push'. Additionally, the
claim's premise that "the compiled record above ... does track pushes separately" is also false:
the Compiled aggregate (`overall_record`, decision-basis.js:266) is computed as `${wins}-${losses}`
with no push count at all — it has the exact same blind spot. The described failure scenario
(a push rendered as a red loss, disagreeing with a push-aware aggregate) cannot occur given the
current data pipeline. Refuted; the code defensively declares `result: string` but no live path
ever feeds it anything but Won/Lost.

### #193 Diagnostics.tsx:228 (claimed P2) — REFUTED
`f.name.split(':')[1].replaceAll('_', ' ')` (line 228) would indeed throw if `f.name` lacked a
colon, but traced the single generator of these feature names:
`server/services/line-move-study.js:297-304` `featureNames()` builds every name as
`` `${t}:${k}` `` (template literal, colon always present) — there is no other producer of the
`close.features[].name` field anywhere in the tree (single `serveReport('line_move_study')` call
in nfl-market.js:165, single `lineMoveStudy` report definition in report-cache.js). Since every
name is guaranteed to contain a colon, `.split(':')[1]` is always defined (possibly an empty
string, never `undefined`), so `.replaceAll` never throws in the live app. Refuted; the crash
scenario requires a data shape the generator cannot produce.

### #198 WongSeason.tsx:39 (claimed P2) — REFUTED (mechanism wrong; a bigger different bug exists)
The claim assumes the server sends a *combined* `season.units_won` / `units_staked` / `roi` that
blends paper and placed tickets together. Traced `wongSeason()`
(server/betting/nfl/strategy/teaser-season.js:910-982): the function's own doc comment (904-908)
says "Placed and paper are kept apart throughout... a combined ROI is a number that describes
neither" and the actual `return` statement (962-982) contains **no top-level `tickets`, `record`,
`units_staked`, `units_won`, or `roi` fields at all** — only `placed: placedAccount` and
`paper: account(paper)`, each with their own nested `units_staked`/`units_won`/`roi`. The client
type (types.ts:180-188) and WongSeason.tsx (lines 21-24, 37-42) read `season.tickets`,
`season.record`, `season.units_staked`, `season.units_won`, `season.roi` directly — none of which
exist on the real response. In the live app these render as `[]` / '—' / dashes (via the `?? []`
and `!= null` guards throughout the component), not as a blended real+paper dollar figure. This
is arguably a *worse* bug (the whole season-tracker summary row never shows real numbers at all)
but it is not the mechanism the claim describes, so the claim as written is refuted. Recommend a
follow-up finding: WongSeason.tsx / WongSeason type is out of sync with wongSeason()'s actual
return shape.

### #199 WongSettings.tsx:151 (claimed P2) — REFUTED (mechanism wrong; a different, worse bug exists)
Traced `wongSettings()` (teaser-season.js:168-182): it always returns either
`DEFAULT_WONG_SETTINGS.reduced_payout` (= `DEFAULT_REDUCED_PAYOUT` = the string `'stake_back'`,
per teaser-staking.js:265) or a stored value that has passed `validateSettings` (which throws for
anything not in `REDUCED_PAYOUT_MODELS = ['stake_back','same_price','graded_loss']`, so an
invalid/null stored value falls back to the default rather than surfacing as null). `typeof value
=== 'string'` is therefore always true in practice — the null-triggered
`REDUCED_PAYOUT_OPTIONS[0][0]` fallback described in the claim does not fire with real data. There
is, however, a much bigger real defect one line above: the **client's dropdown option ids**
(`REDUCED_PAYOUT_OPTIONS`: `reduce_to_single` / `push_refunds_stake` / `loses`, WongSettings.tsx:9-12)
**share no values whatsoever with the server's valid set** (`stake_back` / `same_price` /
`graded_loss`). So on every real load, `known` (line 152) is always `false`, the select shows the
raw server value (e.g. "stake_back") as an ugly extra option, and picking any of the three
human-readable options and saving would fail server-side validation (`validateSettings` rejects
anything outside `REDUCED_PAYOUT_MODELS`). The claim as written (about a null-triggered default)
is refuted; recommend a follow-up finding about the id-set mismatch, which is a more severe,
always-reachable defect.

### #200 format.ts:99 (claimed P2) — REFUTED
`isFirstHand` regex is as quoted, and would misclassify a value containing "api" as first-hand.
But traced every producer of a `provenance` string that actually reaches `ProvenanceTag` in the
Wong hub (TicketCard.tsx:115 `leg.provenance`, WongComparison.tsx:92 `quote.provenance`,
WongBoard.tsx:102 `book.provenance`): the entire Wong pipeline's only source is
`teaser-scan.js` `SPREAD_SOURCES` (lines 53-62), which defines exactly two provenance strings —
`'first_hand_tape'` and `'second_hand_aggregator'` — propagated unchanged through
teaser-scan.js:130/155/275/290/465/592 and wong.js:359/530 into every board/leg/quote object.
Neither string contains "api", "direct", "official", etc. outside the intended "first_hand"
match, so both are classified correctly by the current regex given the data that is actually
produced. (A different module, nfl-sharp.js:96, does use a provenance value `'the_odds_api'` that
would trip this bug, but that module is not part of the Wong hub's provenance pipeline traced
here.) The specific failure scenario (a third-party aggregator value containing "api" reaching
the Wong board) does not occur with the current data. Refuted for this file/pipeline as
described.

### #201 format.ts:56 (claimed P2) — REFUTED
`evPercentText`'s unit-inference logic is as quoted, and the ambiguity is real in the abstract.
But the ONLY producer of both `ev` and `ev_percent` for a Wong ticket candidate is
`ticketEV()` (teaser-leg-rates.js:764-774), which computes them from the exact same local
variable in the same return statement: `ev_percent: ev * 100`. Traced the one call site that
copies these onto a candidate (teaser-scan.js:278: `ev: ev.ev, ev_percent: ev.ev_percent`). Given
`ev_percent` is always precisely `ev*100` (not equal to `ev` except when both are exactly 0), the
function's primary branch (`Math.abs(evPercent-ev)<1e-9`) is never taken for real data and the
fallback branch (`return `${evPercent>0?'+':''}${evPercent.toFixed(2)}%`;`) is what always
executes — which is already the correct interpretation, since `ev_percent` is genuinely a
percentage. The "different units" failure mode described requires a change to `ticketEV()` that
does not exist in this codebase today. Refuted as not reachable with current data generation.

### #203 NflAutoPicks.tsx:73 (claimed P2) — REFUTED
`quote_source` is indeed declared on `PickRow` (line 20) and never rendered in `WeekTable`
(confirmed by inspection of lines 116-162 — only `p.book` is shown). But traced the single write
path (`server/services/nfl-auto-picks.js:161`): `book: quote?.source ?? null, quote_source:
quote?.source ?? null` — both fields are set to the **exact same value** (`quote.source`, itself
sourced from the `game_lines.source` column, which is a data-provider tag like `'espn'`/
`'nflverse'`, not a sportsbook name). Since `book` and `quote_source` are always identical in the
data as produced, rendering `quote_source` would show nothing beyond what `p.book` already shows
— there is no additional distinguishing qualifier being silently withheld from the reader. The
claim's premise (that `quote_source` would substantiate or qualify the price-provenance claim
beyond what `book` already shows) does not hold given the current server code. Refuted as
described; a legitimate but different concern is that "book" here is really a data-provider tag
('espn') rather than a real sportsbook, which is not what the claim raises.

## Downgraded but not refuted (1)

### #195 ProfitabilityControl.tsx:233 (claimed P2) — kept CONFIRMED, downgraded confidence/severity
`value={\`${reporting.specialists ?? 12}\`}` (line 233) beside the "empty model-memory state, not
'12 specialists reporting'" text at line 239 is real code. But traced
`expertCouncilStatus()` (nfl-expert-council.js:761-822): on every successful response,
`reporting.specialists` is unconditionally set to `NFL_EXPERTS.length` (line 820) — there is no
code path that returns a `reporting` object without `specialists`, and a request that throws is
caught separately (the parent component already renders "Specialist coverage unavailable" when
`council` itself is null/undefined, before reaching this line). So the `?? 12` fallback is,
practically, dead in the current codebase (and would show the true count in the one case it might
matter, since `NFL_EXPERTS.length` coincidentally is the same class of number). Kept as a real
but low-likelihood defensive-code smell rather than an observable P2 bug; downgrading severity to
P3 and confidence accordingly.
