# F14 — Entity resolution for game/team/player keys (bucket: fix)

## 1. What's actually in Gridiron today (read, not assumed)

Read in full:
- `server/services/team-codes.js` (100 lines)
- `server/services/nfl-contract-key.js` (243 lines)
- `server/services/player-ids.js` (159 lines)
- `server/services/polymarket.js` (parsePolymarketProp, lines 1-70)
- `server/services/polymarket-lines.js` (team/game orientation logic, lines 21-260)

**This is better than "ad hoc string matching" in the crude sense** — it is a hand-built
*deterministic* resolver, not regex soup. But it has exactly the properties a real
entity-resolution library exists to fix, and there are two concrete places it is
already failing silently:

1. **`teamResolver()` (team-codes.js:50-86)** — closed vocabulary (32 teams), exact
   alias dict + nickname/city fallback + "unique containment" last resort. Returns
   `null` on ambiguity (good — fail-closed) but returns a **boolean**, never a
   confidence score. Every new spelling variant (a typo, a new book's house style,
   a foreign-language feed) requires a manual dictionary edit or it silently drops
   into `contractKey`'s `unresolved_team` quarantine bucket. There is no way to ask
   "how sure are we" — every match is either a hit or a `null`, so a near-miss (e.g.
   a book that writes "LA Rams" as "LAR" — already handled — vs. one that writes
   "Los Angeles" alone for the Chargers, genuinely ambiguous) cannot be
   distinguished from a random string.

2. **`player-ids.js` (the actual crosswalk table Gridiron already has)** — this is
   the good pattern: `players.id / gsis_id / espn_id / sleeper_id`, priority-ordered
   exact lookup, name match is explicitly "last resort," and **colliding names
   resolve to `null` rather than a coin flip** (line 94-96). This is close to
   textbook deterministic linkage. `idCoverage()` (line 144) even reports resolution
   rate as a health metric — exactly the instrumentation a probabilistic linkage
   tool would want. **But it is never used for Polymarket.**

3. **The actual defect (`team-codes.js` / `nfl-contract-key.js` framing in FOUND,
   concretely located):** `parsePolymarketProp()` in `polymarket.js:49-70` extracts
   a player name from free text via **regex only** ("Will Josh Allen have 7.5+
   rushing touchdowns...") and stores the raw captured string (`p.player`) directly
   into the `polymarket_props` table (line 108-112) with **no call to
   `resolvePlayerId()`**. So a Polymarket market for "Justin Jefferson" and an
   internal player row for the same person are two different strings forever, with
   nothing that would ever notice the disagreement, let alone score it. Any downstream
   join between Polymarket props and Gridiron's own player-prop model
   (`server/services/nfl-props.js`) either does exact-string matching (unverified —
   would need a follow-up grep) or simply never joins. This is the same defect
   class as the touchdown-regression bug player-ids.js's own header describes
   (id-space mismatch, joins silently return nothing) — just recurring in a third
   place the fix for player-ids.js didn't reach.

4. **Game/event identity across providers is the weakest link.**
   `polymarket-lines.js:88-101` (`scheduled()`) infers home/away orientation from a
   Polymarket title ("49ers vs. Rams") by testing both orientations against
   `game_lines` and falling back to `orientation: 'assumed'` when neither query
   hits — a **third-priority guess with no confidence number attached to it**, and
   nothing downstream is told which orientation was assumed vs. confirmed.
   `polymarket-lines.js:251-254` then joins Polymarket-derived events to ESPN line
   moves by exact string key `${away}@${home}`, and when that fails it fabricates a
   synthetic id `pm:${event_title}` — a value that can never join to anything,
   manufactured instead of quarantined. This is exactly the "row we invented"
   problem `nfl-contract-key.js`'s own header (lines 18-23) says the project
   refuses to do for contracts — but the game-key layer feeding it does it anyway
   one level up, for the Polymarket path specifically.

5. **`nfl-contract-key.js`'s `eventKey()` (line 128-139)** joins on
   `nfl|{eastern_date}|{away}@{home}` — an exact string. This works fine when both
   feeds fully resolve to the same three fields, but it has zero tolerance: a book
   that reports a kickoff date one day off (a genuine 1:15am-UTC Monday-night style
   problem the same file already flags for time, at line 108-113, but does not
   flag for date-off-by-one from a bad timezone conversion at a different feed)
   causes a silent no-join, not a scored near-match.

## 2. Grounding in tonight's FOUND findings

FOUND says: *"Game/team identity matching across sources (ESPN, nflverse, odds
books, Polymarket) is done with ad hoc string matching in team-codes.js /
nfl-contract-key.js, not real entity resolution."* — accurate at the game-key layer
(items 3-5 above); team-codes.js's team resolver itself is closer to a reasonable
deterministic-linkage baseline than "ad hoc," but it shares the real gap: **no
probabilistic confidence score, no learned weights, no formal handling of
near-miss evidence**, which is precisely what Fellegi-Sunter-style probabilistic
linkage (Splink) and feature-based classifiers (dedupe, recordlinkage) exist to add.

## 3. Primary sources (read in full where marked)

1. **Fellegi, I.P. & Sunter, A.B. (1969), "A Theory for Record Linkage"** — original
   theory, read via the Splink documentation's own full restatement (not the 1969
   JASA original PDF itself, which is paywalled/hard to access; the restatement at
   moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html
   was fetched and read in full). Model: for each compared field, an **m-probability**
   (P(observed agreement level | true match)) and **u-probability** (P(same level |
   true non-match)) are estimated; the **match weight** is
   `M = log2(λ/(1-λ)) + Σ log2(m_i/u_i)` across fields (additive under a conditional-
   independence assumption), and the final score is
   `Pr(match|obs) = 2^M / (1+2^M)` — i.e., every candidate pair gets a **calibrated
   probability**, not a boolean. Explicit caveat stated in the source: the additivity
   assumes cross-field independence, which is false whenever features are correlated
   (their own example: surname and address correlate within real families).

2. **Dasylva, A., Goussanou, A., Ajavon, D., Abousaleh, H. (2019), "Revisiting the
   probabilistic method of record linkage,"** arXiv:1911.01874 (Statistics Canada /
   U. Victoria). Read in full (title/abstract, introduction, notation, the
   estimation section 4.1-4.5, and the simulation design in section 5).
   **Model:** a finite-mixture model over the *number of neighbours* (resembling
   records) per record, replacing the classical Fellegi-Sunter conditional-
   independence assumption with one that has the "identification property" even
   when linkage variables are correlated; estimated by EM with a parametric-
   bootstrap likelihood-ratio test for the number of mixture components.
   **Data/sample:** simulated twin registers, N = 32,000 individuals each, K = 15
   binary linkage variables, two scenarios — (1) linkage variables and recording
   errors mutually independent, (2) both correlated across variables (β₁=0.5,
   β'₁=-0.5) — 100 repetitions each, mₙ = 128 sampled record-pairs per repetition
   (chosen so mₙ = o(√N), satisfying their asymptotic-independence requirement).
   **Result:** the classical conditional-independence FS estimator is consistent
   under scenario 1 but **biased under scenario 2** (the realistic case, where
   agreement on one field is not independent of agreement on another — exactly
   Gridiron's situation: a Polymarket title agreeing on team names and agreeing on
   week/date are correlated, not independent, once the market itself is real).
   Their neighbour-mixture estimator remains consistent in both scenarios without
   labeled training pairs. **Limitation, stated by the authors themselves:** the
   method needs the "proper linkage problem" identification condition (match
   probability bounded away from zero as population grows) and does not resolve
   inference on the *number* of mixture components in closed form — a parametric
   bootstrap is required, which is compute-heavy at Gridiron's scale.

3. **`moj-analytical-services/splink`** (GitHub; MIT; 2,398 stars; last push
   2026-09-11 — actively maintained). Read in full:
   `splink/internals/comparison_library.py` lines 1-45 (ExactMatch scaffolding) and
   1005-1195 (`NameComparison`, `ForenameSurnameComparison`). **Concrete API
   design worth copying directly:** a comparison is a *graded ladder* of levels —
   null → exact match (with optional `tf_adjustment_column` for term-frequency
   reweighting, so "John Smith" agreeing counts for less evidence than "Zyzstra
   Nkemdirim" agreeing, because it's a more common name) → Jaro-Winkler ≥0.92 →
   ≥0.88 → ≥0.70 → anything-else, each level carrying its own learned m/u weight.
   `ForenameSurnameComparison` also has an explicit `ColumnsReversedLevel` — exactly
   the "Rams @ 49ers" vs "49ers @ Rams" orientation problem `polymarket-lines.js`
   currently resolves by trial-querying the schedule table.

4. **`J535D165/recordlinkage`** (GitHub; BSD-3; 1,062 stars; last push 2024-02-21 —
   stable but slower-moving than Splink, worth flagging as staler). Read in full:
   `recordlinkage/compare.py` lines 1-165 (`Exact`, `String` comparison classes
   supporting jaro/jarowinkler/levenshtein/damerau_levenshtein/qgram/cosine/
   smith_waterman/lcs as pluggable distance functions) and the `Date`/`Numeric`/
   `Geographic` comparison classes (335-430) — directly relevant to the kickoff-date
   off-by-one problem in `eventKey()`, since `Date`/`Numeric` comparisons return a
   graded score rather than exact/no-match.

5. **`dedupeio/dedupe`** (GitHub; MIT; 4,512 stars; last push 2025-07-29 — the most-
   starred of the three but ~13 months stale relative to Splink). README.md read
   in full via `gh api`. Based on Bilenko's PhD dissertation on learnable string-
   similarity functions; workflow is **active learning**: the tool proposes
   uncertain pairs, a human labels y/n/u, and it trains a regularized classifier
   plus learns blocking predicates from the labels, rather than requiring the
   analyst to hand-tune thresholds. No numeric benchmark is stated in the README
   itself (it points to Bilenko's dissertation and a separate canonical-dataset
   benchmark script in `benchmarks/`, not run here). This is the right tool for
   the one place Gridiron has an actual open, unlabeled matching problem with
   enough volume to be worth training on: Polymarket's free-text market titles.

## 4. Design: a canonical game/team/player key with a confidence score

The right target is **not** "replace team-codes.js" — its closed 32-team vocabulary
with a fail-closed resolver is already close to correct and a probabilistic model
would be overkill (and slower) for a solved problem. The right targets are the two
places identity is inferred from *free text or cross-provider joins with no
labeled ground truth*: (a) Polymarket player-prop text → `players` table, and
(b) Polymarket/book event titles → the internal `game_lines`/ESPN event.

Proposed `entity_link` output shape (mirrors `contractKey`'s own `{ok, key, ...}`
discipline so it composes with the existing quarantine convention in
`nfl-evidence-dataset.js`):

```js
{
  ok: true,
  matched_id: 41207,           // internal players.id or an event_key
  match_probability: 0.94,     // Fellegi-Sunter style, not boolean
  method: 'exact' | 'jaro_winkler' | 'fs_probabilistic',
  evidence: [{ field: 'surname', level: 'jw>=0.92', m: 0.97, u: 0.003 }],
  ambiguous_alternates: []     // populated when two candidates score within a margin
}
```

A row below a chosen probability threshold (e.g. 0.85, tuned against a small
hand-labeled sample of ~200 Polymarket prop titles) quarantines with a new
`QUARANTINE_REASONS` entry (`low_confidence_entity_match`) rather than either
silently joining or silently dropping — consistent with the existing quarantine
philosophy in `nfl-contract-key.js`.

## 5. Do not do

- Do not run Splink's Spark/DuckDB backends — Gridiron's SQLite dataset (server/db)
  is tiny (thousands of players, ~12M Polymarket quote rows at most) and the
  `sqlite` backend Splink already ships is the right one; standing up Spark would
  be pure overhead.
- Do not replace `teamResolver()` with a probabilistic model. 32 teams is a solved,
  closed vocabulary; a learned m/u-probability model needs a real "how often does
  this string appear when it's NOT a match" prior, which is meaningless at n=32.
  Keep the deterministic resolver; only add a confidence field to its return value.
- Do not adopt `dedupe`'s active-learning UI wholesale for a one-time ~1,800-row
  Polymarket prop backlog — active learning earns its keep on datasets requiring
  repeated, ongoing labeling at volume; a single hand-labeled validation set of
  ~150-200 pairs plus Splink's unsupervised EM parameter estimation is cheaper and
  faster here, and is one already-built codepath in Splink
  (`estimate_parameters_using_expectation_maximisation`), not a new UI to build
  and maintain.
- Do not let `polymarket-lines.js`'s `orientation: 'assumed'` fallback keep
  fabricating `pm:${event_title}` ids silently — that specific line (254) should
  be fixed regardless of which broader library work happens, independent of cost.
- Do not conflate this work with the CLV-implementation consolidation (five
  disagreeing CLV modules) — different defect, different researcher's scope
  tonight; note only for cross-reference, do not scope-creep into it here.
