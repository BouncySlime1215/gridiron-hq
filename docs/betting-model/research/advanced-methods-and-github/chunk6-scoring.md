# Chunk 6/21 — Scoring notes (F12/N2-N3 cold-start, F13 causal-news-impact, F14 entity resolution, F15/fix-1 shrinkage)

Verification method: re-grepped fantasy-football-dashboard (read-only) directly rather than
trusting the candidate bullets alone, plus read the cited notes files' framing/do-not-do
sections (F12, F13, F14, F15 partially — chunk5 already covered F15's siblings' context).

Confirmed exact by grep (line numbers, constants, exports all matched the candidate text
verbatim — a high-trust signal for this whole chunk's applicability claims):
- weekly-learning.js: `grid()` (5-way simplex, 0.1 units) at line 25, `WEIGHT_GRID` line 34,
  `fitPosition` line 36 with the literal `data.length < 75` gate at line 37.
- nfl-news-market-latency.js: `quoteReaction` line 29, the exact flat threshold
  `reacted: Boolean(prior && ((lineMove...>=0.5) || (priceMove...>=5)))` at line 49,
  `__test` export at line 86, `research_eligible` gate at line 80.
- nfl-ensemble.js: `candidate_shrink_only` mode confirmed at line 1311.
- polymarket.js: `parsePolymarketProp` at line 49; zero hits for `resolvePlayerId` anywhere in
  the file — the claimed defect (raw string stored, never resolved) is real, not inferred.
- polymarket-lines.js: the literal `pm:${d.event_title}` fallback confirmed at line 254 inside
  the ESPN-join map, exactly as cited.
- team-codes.js `teamResolver()` line 50; nfl-contract-key.js `eventKey()` line 128,
  `contractKey()` line 149, `QUARANTINE_REASONS` line 226.
- player-ids.js: `nameCollisions` Set (line 55), `resolvePlayerId` (84), `idCoverage()` (144),
  `colliding_names` (153) — all exact.
- nfl-roster-strength.js: every one of the eight cited hand-tuned constants confirmed verbatim
  — `{0.5, 0.23, 0.17, 0.10}` (lines 282-285), `0.28` rookie slot (286), `0.88*rating+0.12*60`
  traded-veteran shrink (292), `0.78*starterScore+0.22*depthScore` (347), `0.82**index` /
  `0.84**index` recency decay (208, 268).
- shrinkage-fit.js: `fitK` (46), `buildFitSpecs` (212), `saveFit` (285), `activateFit` (308),
  `activeKVector` (318) — the machinery F15-fix-1 proposes reusing already exists and is wired
  live elsewhere (`projections.js:31,369` per the F15 notes file, itself read in full).

One minor discrepancy: F12/N3 names `role_scenario_engine.js`; the actual file is
`role-scenario-engine.js` (hyphen). It exists and does role/scenario modeling
(`buildPlayerScenarios`, `sampleScenarioMixture`), but I found no literal "usage clusters" or
"archetype" taxonomy inside it — the candidate's specific mechanism (draft-capital-tier /
scheme / depth-chart-slot clustering) is not yet code that exists, just a plausible extension
point. Applicability scored down slightly for that gap between claim and grep.

Read F13's and F14's own "Do not do" sections in full — both are unusually well-disciplined and
change my verdicts directly: F13 explicitly forbids trusting F1 without N1's placebo calibration
and forbids building N2 (causal forest) before F2 replicates; F14 explicitly recommends against
its own new-3 (dedupe active learning) in favor of new-1 (Splink) plus a small hand-labeled set.
I followed both steers rather than scoring each candidate in isolation.

## F12 — cold start (remaining two: N2, N3; F1/F2/F3/N1 already scored in chunk5)

**F12/N2** (Oreshkin-style meta-learned fast-adaptation replacing WEIGHT_GRID): The grid search
this wants to replace is not "brute-force" in the pejorative sense — enumerating a 4-simplex at
0.1 resolution over 5 fixed heads is a small, exhaustive, exactly-optimal search over that grid;
the actual weakness (confirmed at line 37) is the binary regime switch — full grid-search fit
above 75 rows, frozen champion fallback below it — not the search *method*. Oreshkin et al. 2021
is a real, replicated result, but for zero-shot time-series forecasting across 100k+ series with
learned neural blocks; applying MAML-style meta-learning to a 5-number convex combination per
position is a mechanism mismatch and a weeks-scale rewrite for a low-dimensional problem the
codebase's own empirical-Bayes machinery (shrinkage-fit.js, already validated and live) could
solve far more cheaply with a continuous sample-size-dependent blend between fallback and fit.
REJECT — dominated by a cheaper in-repo alternative the researcher didn't consider.

**F12/N3** (nearest-archetype transfer for true rookies/never-played players): Real, currently
totally unaddressed gap — zero-snap players get the same generic positional prior as a
replacement-level veteran today. Evidence is honestly self-scored weak (content-based cold start
is textbook recommender-systems, but the notes' own citation trail flags cross-level transfer as
often weak in the literature), and the specific taxonomy source file doesn't yet expose the
"usage cluster" structure the mechanism assumes. The candidate's own exit test (3 draft classes,
archetype-matched vs. generic-prior MAE, ship only if it wins) is exactly the right gate for
weak-evidence work like this. TEST-FIRST.

## F13 — causal inference for news-to-decision impact

**F13/F1** (event-study abnormal-move replacing the flat 0.5pt/5c threshold): Exact defect
confirmed (line 49). MacKinlay's event-study framework is the standard, decades-replicated tool
for exactly this problem (isolate a treatment's effect from background market noise) and the
fix is a small, additive baseline function next to the existing `quoteReaction`. Foundational —
F2/F3/N1/N2/N3 all build on having a signed, sized move instead of a boolean. BUILD, but per the
notes' own caution, its output should not be treated as trustworthy evidence of a real reaction
until N1's placebo calibration exists alongside it — sequence them together, not F1 alone.

**F13/F2** (DML-adjusted causal estimate of verified-news effect on the closing spread):
Chernozhukov et al. is the canonical, highly-cited DML reference and the attachment point
(`nfl-ensemble.js`'s `candidate_shrink_only` mode, confirmed at line 1311) is real infrastructure
already built to consume exactly this kind of external reliability check — a rare case where the
target hook already exists. The real cost risk: DML's cross-fitting step needs boosted-trees/
lasso nuisance models, which is more naturally a Python job than native Node/SQLite; that's fine
per tonight's "Python-lab results must be portable as JSON" allowance, but it's real engineering
above the claimed "days," and its own exit test (season-half replication) must pass before it
touches anything else. TEST-FIRST.

**F13/F3** (canonical CLV convention + fixture test reconciling the five implementations): All
five files confirmed present with exact line counts as cited (nfl-clv.js 321, nfl-execution-
clv.js 354, forward-ledger.js 335, nfl-quote-tape.js 234). This is the cheapest, highest-leverage
item in the whole chunk: a spec plus one failing-assertion test, explicitly scoped by its own
notes to NOT be a mass refactor tonight (exactly right, given a live Week 1 capture is running
on one of these paths). BUILD.

**F13/N1** (placebo/permutation null for the "reacted" boolean): `__test` export confirmed at
line 86 — the pairing logic (`quoteReaction`) is already exported for exactly this kind of reuse
without touching the live path. This is the calibration precondition F13's own do-not-do list
says F1 needs before any single reaction claim should be trusted. Cheap relative to its
leverage — turns a made-up threshold into a measured false-positive rate. BUILD, alongside F1.

**F13/N2** (causal-forest/CATE heterogeneous effects): No single file is named yet ("exact file
to be confirmed with the props research track") and the source notes explicitly forbid building
this before F2 replicates — stratifying a not-yet-validated average effect risks confident
nonsense on small strata, which the notes call out as a worse failure mode than today's honest
"we don't know." LATER, strictly gated behind F2's own exit test.

**F13/N3** (cross-market triangulation, sportsbook vs. Polymarket abnormal moves): Confirmed
`polymarket-lines.js` currently only builds the isotonic spread/total ladder (the `parseGameMarket`
/ ladder-construction logic visible at lines 128-197) and touches nothing else in the 12.4M-row
tape — matches the "essentially unused" framing exactly. Cheap reuse of F1's pairing logic
against a second, independent asset reacting to the same treatment; directly activates the
project's most neglected data asset for the least added machinery of any of the causal-forest-
adjacent candidates. BUILD, sequenced after F1 exists (needs its abnormal-move function to
parameterize over either table).

## F14 — entity resolution for game/team/player keys

**F14-fix-1** (route Polymarket prop names through `resolvePlayerId`): Confirmed — zero calls to
`resolvePlayerId` anywhere in polymarket.js today; the exact "id-space mismatch" anti-pattern the
rest of the codebase already has a fix for (player-ids.js exists and works), just not wired in
here. Hours-scale, one import + one call before an INSERT. Unlocks measuring the props model
(the project's one area of confirmed genuine skill) against Polymarket's free prices. BUILD.

**F14-fix-2** (replace the fabricated `pm:${event_title}` id with a quarantine reason): Exact
line (254) confirmed. The source notes' own do-not-do list singles this one out as something to
fix "regardless of which broader library work happens, independent of cost" — as close to a
forced BUILD as this whole research pass produces. BUILD.

**F14-fix-3** (Jaro-Winkler confidence field on teamResolver/eventKey): Both functions confirmed
at the cited lines. The source notes explicitly endorse this exact scope ("only add a confidence
field... keep the deterministic resolver") and explicitly warn against the more aggressive
version (replacing teamResolver with a learned model) that this candidate correctly avoids.
Cheap, composes with fix-1/fix-2's quarantine reasons into one consistent evidence shape. BUILD.

**F14-new-1** (Splink probabilistic linkage for the 12.4M-row Polymarket tape): Splink is a real,
widely-used Fellegi-Sunter EM library, but it is a Python package — this necessarily runs as an
offline batch job against a SQLite export, not live Node code, which is a real cross-language
seam the "days" estimate probably understates once packaging/venv/output-loading is counted.
That said, it is a one-time backfill (not a standing service), the source notes explicitly
recommend the sqlite backend over Spark/DuckDB for Gridiron's scale, and it has a concrete,
checkable exit test (95% agreement with 200 hand-labeled pairs). This is the only path in this
chunk that actually uses the project's most neglected asset for player-level (not just spread-
ladder) purposes. BUILD, scoped explicitly as a one-off script producing a JSON/SQLite output
table, not a live dependency.

**F14-new-2** (versioned `game_identity_xwalk` crosswalk table): Standard record-linkage
architecture, no independent citation beyond textbook practice, but real and current duplication
confirmed (team-codes.js and polymarket-lines.js each do their own resolution independently).
Natural complement to new-1 (a place to persist Splink's output) and to fix-1/2/3 (one schema for
all three resolvers' confidence + method). Sequence after new-1. BUILD.

**F14-new-3** (dedupe active-learning labeling for player-ids.js name collisions): `nameCollisions`
/ `idCoverage()` / `colliding_names` all confirmed real and currently a permanent dead end — the
underlying problem is genuine. But F14's own source notes explicitly argue against this exact
approach: "a single hand-labeled validation set of ~150-200 pairs plus Splink's unsupervised EM
... is cheaper and faster here" than standing up dedupe's active-learning UI for what is likely a
short, one-time list. REJECT — dominated by new-1's approach per the research's own analysis.

## F15 — empirical-Bayes shrinkage (fix-1 only; siblings not in this chunk)

**F15-fix-1** (fit nfl-roster-strength.js's 8 hand-picked constants via shrinkage-fit.js's
existing method-of-moments machinery): Every one of the eight cited constants (0.5/0.23/0.17/
0.10 evidence blend, 0.28 rookie slot, 0.78/0.22 roster score, 0.88/0.12 traded-veteran shrink,
0.84^n/0.82^n recency decay) confirmed verbatim at the cited lines, and the machinery it proposes
reusing (fitK, buildFitSpecs, saveFit, activateFit, activeKVector) is real, already validated,
and already wired live elsewhere in the same codebase (projections.js, per F15's own notes file)
— this is about as strong an applicability match as any candidate in this whole project. Brown
(2008) is a direct, quantitative, peer-reviewed precedent for exactly this "hand-fixed vs.
method-of-moments empirical Bayes" comparison. The existing `teamStrengthWalkForward` gate is
already the right validation harness — no new infrastructure needed there. Days-scale, high
confidence, strong precedent, reuses rather than builds. BUILD.
