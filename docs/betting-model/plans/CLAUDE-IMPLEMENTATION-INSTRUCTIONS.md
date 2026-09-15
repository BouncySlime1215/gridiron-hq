> Start with [LATEST-PLAN.md](LATEST-PLAN.md). Its September 15 update controls sequencing; dated findings below require reconciliation with current code.

# Instructions for Claude — implement the Gridiron betting model plan

**Ready-to-assign execution pack:** [agent playbook](AGENT-PLAYBOOK.md), [20-package index](WORK-PACKAGE-INDEX.json), and individual prompts in `agent-prompts/`. The master document embeds all prompts and the full operating manual. Read its new C01–C12 findings before calling the corresponding foundation work complete.

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`, confirming the active checkout first. Scope is NFL betting only.

Read the [consolidated master plan](archive/MASTER-PLAN-2026-09-14.md). It includes the recovered research, research-to-code mapping, GitHub sources, full build stages, overfitting controls, current-system evidence and improvement protocol. These instructions translate it into execution order; do not substitute another broad research project for implementation.

Start by reconciling the latest code and in-progress changes. Continue from the first unfinished step. Preserve existing work and historical evidence. Deliver runnable, verified slices and state what remains unproven. Do not equate implemented, tested, connected, observed and qualified.

## Weekly training, news backfill and Claude execution instructions

This section turns the architecture into ordered work. Execute the steps in order, reconciling completed work first. Do not start another broad research sweep. The source files named below are repository-relative locations to inspect or extend; proposed modules and commands do not exist merely because they are specified here.

### Fresh inspection: what changed and what remains

A later September 14 inspection found repository HEAD `21789a9`, with uncommitted edits in the shared dataset builder, both labs, their tests and governance documents. Recent commits address season defaults, baseline preservation, quarantine, freshness reporting and gate ownership. Another commit is titled “Wire the overfitting/deflated-Sharpe correction into a real promotion gate”; inspect the resulting authority path and assumptions rather than assuming the earlier audit describes its current state. Preserve work in progress. No implementation or live-database verification was performed by this planning pass.

| Current inspected behavior | Action required |
|---|---|
| `research/betting/nfl/dataset.py` now shares chronology and quote-pair extraction; `tree_lab.py` and `market_lab.py` call it | Extend this common builder and its consumer-parity tests; do not recreate two independent extractors. The edited code is not certified by this read-only inspection. |
| `build_football_dataset` is present with 1999+ defaults and optional PBP | Verify its actual output and consumers. It uses `gameday` as a decision instant and also exports market fields: distinguish date-only records from actual kickoff timestamps, and exclude unqualified market columns from training features. |
| The shared chronology uses a three-day publication proxy and a seven-day settled-label lag | Preserve them as explicitly modeled historical assumptions until source-specific clocks are available. They do not prove real publication times. Separate label availability from corrected-feature availability; compare conservative versions without selecting whichever produces the best profit. |
| The existing betting builder still pairs Pinnacle opening and closing quotes, defaulting to 2022–2025 | Add a separate exact T−60 builder. A missing close must not remove an otherwise valid outcome-training example; it only prevents CLV/movement evaluation. |
| Main tree-lab branches fit on earlier seasons and score a whole later season; inner folds keep weeks together | Preserve as historical comparators. Add weekly refitting that matches the intended deployment cadence. It must incorporate newly settled eligible games without tuning on the scored week. |
| The tree lab measures movement MAE, conditional non-push classification log loss/Brier, quantiles and paper returns | These are useful, different targets. Add explicit push probabilities and price-based EV to the serving evaluator; movement error is not game-outcome accuracy. |
| `nfl-news-events.js` extracts typed claims with exact evidence spans and a content cache, but takes recent relative-day windows and stamps extraction time as `first_seen_time` | Add absolute date-range backfill and separate source receipt from extraction time. Never backdate extraction to an old article date. |
| `nfl-advanced.js::syncInjuries` writes current player-week rows and attempts revision capture | Reuse it, verify actual revision coverage and as-of reads. Importing a final weekly CSV today cannot recover every earlier daily report version. |
| News and press extraction can consult current player/team identity; press discovery uses recent channel feeds | Resolve players against historical rosters/transactions. Add archive discovery for old documents; a recent feed is not a season archive. |
| `nfl-news-event-impact.js` selects the fastest next quote pair and predicts absolute implied-probability movement | Retain as a limited historical diagnostic. It is not a directional game predictor. Review contract matching when handicaps change, event grouping, time windows and price-only controls before reuse. |

### Step 1 — reconcile the repository and create one execution ledger

Read this master plan, relevant `AGENTS.md` instructions, `docs/CLAUDE-NEXT-STEPS.md`, the current work log, and the recovered research index. Inspect current git status and commits before editing. Do not reset, overwrite or duplicate someone else's in-progress work. Recheck each relevant earlier defect against the current source and a read-only database snapshot.

Create one ledger row per work package: existing implementation, remaining task, files, research references, tests, output artifact, state and limitation. Use states such as planned, implemented, verified, connected, observed and qualified; a passing test is not evidence of betting profit. Carry forward the specialist, QBR, freshness, gate, calibration and audit-math findings without falsely calling fixed items open.

**Return:** a short reconciled status and the next uncompleted slice. Continue with that slice; do not stop after restating the plan.

### Step 2 — define training examples and clocks

Extend `research/betting/nfl/dataset.py`, the existing feature contract, and their tests. Keep three related datasets:

- **Football:** one game/cutoff example with legal prior football information; labels are home margin and total points. Use broad history without requiring archived opening or closing prices.
- **Player availability/usage:** one player/game/cutoff example. Labels distinguish game-day active status from actual participation and usage. An active player taking zero snaps is not automatically injured. Actual snaps or starters can be labels after the game, never inputs for that same earlier prediction.
- **Betting:** game, cutoff, exact market/period/handicap/side/book and offered odds. Use T−60 first. Signed home spread residual is actual home margin plus home handicap; total residual is actual total minus offered total. Preserve win/push/loss outcomes. Attach closing prices later as optional labels.

Every row needs canonical game/player IDs, season type, UTC kickoff and timestamp precision, cutoff, source IDs/versions, feature values and missingness, provenance mode, training/label availability, and immutable dataset identity. Keep labels, future quotes and retrospective metadata outside a strictly allowlisted feature matrix. Multiple books, players, snapshots and plays do not create independent game outcomes.

For each source distinguish: event/practice time, source publication/update time, independently evidenced availability bound, actual local receipt time, extraction completion time, and later revision time. Date-only evidence is an interval, not midnight masquerading as precise publication. If the conservative upper bound does not precede the cutoff, exclude it from that strict example.

**Pass:** future rows cannot change an earlier vector; no final-score/closing-price column can enter the feature matrix; date-only schedule rows cannot qualify as precise T−60 packets; missing odds/news do not delete football examples.

### Step 3 — inventory history and run a bounded backfill pilot

Produce coverage by source, team, season, week and cutoff using the existing freshness audit. Start from stored `news_items`, `press_conferences`, `press_availability`, `nfl_news_events`, `nfl_news_signals`, `nfl_injuries`, feature revisions, roster history and quote tape. Count usable documents and game coverage rather than just rows.

Use **2024 regular-season Weeks 1–4, all teams**, as the initial engineering pilot. This choice tests archive retrieval and chronology; it is development data, not a performance holdout. Exercise Thursday, Sunday and Monday/other kickoff times. Include uneventful games, rather than selecting only famous injuries or losing bets. Then expand sequentially across 2022–2024 where sources support it; assess 2025 separately because injury coverage differs. Broad football backfill can extend further independently.

Source order:

1. Existing locally preserved source versions and live capture logs.
2. nflverse structured injury, roster, player and snap data, after field/timing checks. `date_modified` documents an update, not a complete history of changes. The publisher documents an injury-feed gap after 2024. [Injury dictionary](https://nflreadr.nflverse.com/articles/dictionary_injuries.html), [availability schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).
3. Official team article archives/sitemaps, dated injury reports, transactions, inactives and media transcripts. A verified example is the [Eagles September 2024 archive](https://www.philadelphiaeagles.com/sitemap/html/articles/2024/9), which lists pregame reports separately from recaps. Generalize adapters only after testing each site.
4. Existing reputable reporter/news sources for missing details, with duplicate and provenance checks. Use accessible historical snapshots where available; inspect their actual capture time and content version. Search snippets alone cannot establish an eligible claim.
5. Written official transcripts before video transcription. Test dated video archives if transcripts are missing, retain transcript offsets and source identity, and review player-name/status extraction errors. Current channel feeds alone cannot backfill old seasons.

The pilot must report retrieval success, usable timestamp/version coverage, revision loss, duplicate rate, identity failures, extraction quality, dollars/tokens per accepted document, and projected season cost. Use a manifest of absolute date ranges and resume cursors. Cache downloads by source/content version and extraction by content, prompt, model, parser and historical identity-map version. Do not repeatedly send unchanged articles to an LLM.

**Pass:** a reviewable pilot archive and coverage report, with explicit unavailable records. No guarantee of complete 1999+ news history; sparse text history must not block the first football model.

### Step 4 — preserve source documents and extract supported events

Extend the existing news-event and bitemporal schemas rather than adding an unrelated news database. Store an immutable source document/version, its full timing metadata, content hash, retrieval status and source URL. Keep claim records tied to that exact version. Preserve contradictions and superseding events instead of overwriting Wednesday with Friday.

Parse structured injury tables with deterministic code. Use Claude only for text that needs interpretation: named player/team, practice participation, injury designation/body part as stated, expected role change, return/transaction, quote speaker and exact supporting span. Supply historical identity candidates and the document text. Require `unknown` for unsupported claims. Do not ask Claude what happened in the historical game, to infer a diagnosis/recovery duration, or to assign a point spread from prose. Extraction confidence is neither probability of playing nor probability of winning.

Keep these provenance classes separate:

- **Captured:** the source version was received and its features were ready before the actual decision. Preserve the then-used extractor/artifact. Reprocessing an old captured text with a new extractor creates a retrospective experiment, not the originally served result.
- **Archived reconstruction:** there is evidence this exact source version existed by the historical cutoff, but our new pipeline processed it later. Suitable for explicitly labeled retrospective model development; not evidence of actual historical capture, execution or low latency.
- **Uncertain reconstruction:** only a current page, final weekly row or ambiguous date/version survives. Use only for clearly labeled sensitivity/auxiliary work where timing permits; exclude from strict decision-time performance claims.
- **Post-cutoff:** available only later. Keep as later labels/context, never earlier features.

A modern LLM can know historical outcomes. Restrict historical use to span-supported extraction, keep irrelevant recap/sidebar content out of the prompt, and validate on prospective text as well. Masking dates alone does not prove absence of model memory.

**Pass:** annotated tests cover multiple players, pronouns, negation, vague quotes, historical trades, duplicated syndication, late corrections, revised pages and postgame content. A source being official does not eliminate typos or extraction mistakes.

### Step 5 — build each week's information timeline

Create one shared as-of reducer over source events, used by both Python extraction and the frozen serving packet. Reuse current `playerNewsSignal`, `teamNewsSignals` and event/revision contracts only after fixing their timing and historical identity limitations. Avoid separate historical and live business logic that silently diverges.

For each upcoming game, reconstruct changes leading up to its actual kickoff. Use a bounded recent-news window plus carried-forward unresolved states such as injured reserve; stale snippets expire, but unresolved long-term statuses need explicit resolution rather than a blind 14-day reset.

Initial snapshots are **T−72 hours, T−24 hours and T−60 minutes**. T−60 is the primary betting experiment; earlier snapshots support diagnostics and later separately declared experiments. They are alternative views of one game, not three independent tests. Do not force a Friday/Sunday template onto short weeks, international games or Monday fixtures. Retraining schedule and snapshot schedule are distinct.

Illustrative synthetic timeline:

| Source update | What a later eligible snapshot can contain |
|---|---|
| Wednesday: player did not practice | DNP, stated injury, time since update; playing status still unresolved |
| Thursday: coach says player will be evaluated | Supported uncertainty; no invented “70% active” |
| Friday: official questionable designation | Latest designation and practice trajectory; prior claims retained |
| Game day: player listed inactive before T−60 | Inactive status at T−60, if the report met that mode's timing rules |
| After kickoff: recap says replacement excelled | Outcome/usage label only; never an earlier input |

Real official pages show why versions matter: the [Eagles Week 1 report](https://www.philadelphiaeagles.com/news/packers-vs-eagles-injury-report-week-1-2024) includes several days' reporting, while [Packers game-day inactives](https://www.packers.com/news/inactives-packers-eagles-week-1-2024) provide later availability. A final page containing Wednesday text cannot establish that its Friday information was available Wednesday.

Emit compact numerical/categorical features: practice trajectory, stated designation, known active/inactive state, learned active probability where unresolved, expected usage, role uncertainty, last update age, source conflict, replacement quality from earlier games, and coverage indicators. Missing collection is **unknown**, not healthy. No-report is meaningful only when a complete expected official report was actually observed. Syndicated copies do not increase confidence as independent reports.

**Pass:** advancing the replay clock changes only events newly eligible at that time; later updates cannot alter saved earlier packets; persistent statuses, byes and rescheduled games behave explicitly.

### Step 6 — learn how availability and news matter

Start with a regularized availability model using structured reports and lagged usage; add span-supported text features as a registered comparison. Predict active/inactive separately from expected snaps/touches conditional on availability. Treat exits during the game and coaching non-use explicitly when evaluating usage rather than teaching that every low-snap game was a predicted injury absence.

Turn those earlier-only estimates into small game-level features: expected QB contribution, expected lost usage by position group, likely replacement strength and uncertainty. A possible initial aggregation is the sum of expected unavailable usage times an earlier-estimated player-to-replacement difference, with units and assumptions stated. Fit its downstream value against outcomes; do not install fixed universal “QB out = X points” adjustments or call observational associations causal injury effects.

Every upstream player model must produce chronological out-of-fold predictions for downstream game-model training. Training a player model on the whole dataset and then joining its historical outputs would leak, even if the final game split were chronological.

Compare on identical eligible games:

1. Market baseline and football baseline.
2. Football plus structured availability.
3. The same system plus text/quote features.

Compare both standalone football improvement and incremental value after conditioning on the contemporaneous market. News can be useful football information already fully reflected in the price. Start with the first two systems; do not let scarce text delay a working model.

**Pass:** predictions trace to source events and earlier upstream fits; text's added benefit is measured separately; weak or absent benefit yields an explicit inconclusive/reject verdict.

### Step 7 — implement weekly training and historical replay

Add a weekly replay entry point under `research/betting/nfl/`, reusing existing lab estimators, dataset code and probability contracts. Preserve current whole-season lab outputs as comparisons. Expose explicit season/week bounds, fit time, cutoff policy, provenance mode, dataset ID, seed and candidate configuration; commands must be implemented and exercised before documenting them as runnable.

Initial deployment policy: fit the candidate **Wednesday at 12:00 America/New_York**, using only labels and source versions available then. Store the timezone-aware UTC instant for each fit. Keep model parameters fixed through the following Tuesday; refresh legal news/quotes at each game cutoff. A game before a scheduled fit uses the previous eligible artifact. If collection or fitting fails, preserve the last eligible model and record freshness rather than fabricating a successful update. This is a declared starting schedule, not an optimized claim.

Replay this same policy historically. For each fit origin:

1. Build an immutable eligible training manifest. Exclude unsettled labels. Use prior-season and already available current-season games; do not impose an entire-season lockout on weekly learning.
2. Generate earlier-only upstream football/player predictions and preprocessing within inner chronological folds.
3. Fit the small preregistered ridge/LightGBM comparison. Select settings only on inner folds. Estimate calibration and ensemble weights from earlier held-out predictions, never fitted values.
4. Save the chosen model, preprocessing, feature schema, training cutoff, calibrator and hashes.
5. At each game's cutoff, reduce the eligible event timeline, join its quote, score once and freeze predictions for every eligible game including abstentions.
6. Append outcomes when available; append closing quotes separately. Refresh the next fit using the declared policy. Do not alter earlier predictions after settlement.

Weekly refitting of a fixed recipe is allowed; changing the feature set, search budget or selection rule starts a new experimental version. The full adaptive recipe is what the evaluation measures. Old repeatedly inspected years remain development data.

### Step 8 — measure the right things in separate reports

| Layer | Required report |
|---|---|
| Sources/extraction | Eligible coverage, timing/version failures, freshness, duplicate rate, historical identity errors, sampled claim precision/recall, conflicts and unknowns |
| Player availability/usage | Active-status Brier/log loss and calibration; usage error with clearly defined labels, subgroup sizes and unresolved cases |
| Football predictions | Paired MAE/RMSE versus simple baseline; signed bias; distribution scores where available; season/era and diagnostic-group results |
| Betting probabilities | Log loss/Brier on a stated outcome space; calibration; key-margin/push behavior at the actual offered handicap |
| Prices/execution | Offered odds and quote age, EV, attainable-paper-bet accounting, stake-weighted ROI, uncertainty and drawdown; CLV as a separate aligned-price metric |
| News contribution | Full-pipeline comparisons with/without structured injury and text features, both before and after adding the market |

If a binary classifier excludes pushes, its estimate is conditional on a non-push. Preserve it as such. To price a bet, use unconditional probabilities: `EV per unit risked = P(win) × profit_if_win − P(loss)`, with pushes returning stake. Estimate push mass from earlier data or a validated discrete distribution; do not use a generic probability disagreement threshold as a substitute for positive EV after vig.

Report unique games, weeks, bets, prices, exclusions and coverage for every comparison. Compare paired losses on the same games with week/block uncertainty and sensitivity to cross-week dependence. Label small groups inconclusive. Do not turn game snapshots, books or multiple players into inflated sample counts. Keep probability edge distinct from realized closing-line movement.

### Step 9 — treat news-to-market movement as its own later experiment

Review `nfl-news-event-impact.js`, its runner and tests. The inspected target is absolute next-quote probability movement; neither direction nor a fixed horizon is established by that target. Group all claims for the same game/week together in evaluation so duplicate stories cannot land in both train and test.

If quote coverage supports the experiment, predeclare reaction horizons and tolerances, maximum stale-before quote age, and the reference book/contract. Join each event to the intended game, rather than any future fixture involving that team. Use only information available at the event cutoff. Require actual local receipt/extraction clocks for latency claims; retrospective publication-based results are a different experiment.

Compare price-only/no-move, structured event, and combined models. Measure line movement and price movement separately: implied probabilities at different handicaps are not probabilities of the same event. Use matched-handicap prices or explicitly model the handicap change. Keep no-reaction/stale/missing cases in the coverage report rather than selecting only fast-moving quotes. Record overlapping news events and do not interpret correlation as the causal effect of one article.

### Step 10 — verify integrity, connect serving and choose improvements

Run targeted checks on the new pipeline: future-data mutation, extraction/revision clocks, historical player identity, exact market/price matching, duplicate events, game-grouped splits, upstream out-of-fold fits, missing sources, push settlement, interrupted/resumed backfill, and training/serving numerical parity. Reuse relevant repository tests; do not run live collectors or mutate live databases merely to import a module for a check.

Use the master plan's error report to decide the next experiment. A weak subgroup nominates a hypothesis; it does not justify a model automatically. Test the smallest fix, refit both full systems, retain failed attempts, and confirm on later uninspected games. Do not silently change gates to force a positive result.

Connect the trained Python artifact to the frozen T−60 runner, decision trace, settlement and error report. Produce a complete shadow game/slate demonstration using identical saved inputs. Keep learning, engineering integrity and betting authority distinct. No automatic stake increase accompanies a successful implementation.

### First work package Claude should deliver

Deliver Steps 1–5 as a narrow, verified slice: reconciled current status; shared dataset/time contracts; pilot source manifest; versioned claim extraction; and replayable player/game timelines. Develop the basic football model independently where news is missing. Then deliver the weekly baseline and structured-injury comparison from Steps 6–8, followed by shadow integration. Text impact and market-reaction models earn later priority through evidence.

For each slice return changed files, commands actually run, test results, dataset/source coverage, example frozen records, measurements where available, and remaining limitations. Save the runnable command/configuration manifest in the repository alongside the evidence. Finish the authorized slice before proposing more research. If source history is unavailable, name the gap, retain unknown values and continue the parts that do not depend on it.

## Execute the expanded specification as reviewable packages

The [master plan now contains 20 detailed work packages](archive/MASTER-PLAN-2026-09-14.md#expanded-engineering-specification-dependencies-and-effort), logical record schemas, milestone dependencies, rough effort ranges, operational failure cases and advanced-model admission tests. Read the specification for the active package before implementing it. The ten steps above remain the execution outline; these packages define their depth.

| Delivery batch | Packages | Required concrete result |
|---|---|---|
| A — reconcile and repair | WP01–WP02 | Current defect/status ledger, preserved baseline, numerical fixes and one gate-responsibility map |
| B — usable history | WP03–WP07 | Historical IDs and source clocks, immutable contracts, coverage report, common football examples and exact-horizon prices |
| C — news and injuries | WP08–WP10 | Bounded archive pilot, reviewed extraction examples, source/event revisions, cutoff timelines and earlier-only availability features |
| D — first learned comparison | WP11–WP14 | Fixed experiment configuration, weekly nested fitting, probability/push contract, row-level predictions and error report |
| E — complete shadow operation | WP15–WP17 | Actual artifact scoring, frozen decisions, policy trace, independently reconciled settlement and CLV |
| F — reliability and ongoing evidence | WP18–WP20 | Resumable jobs, migration/restart verification, integrated failure tests and a prospective improvement protocol |

Batch C can proceed separately once B's contracts are defined; it must not block D's basic football baseline. E begins with a single frozen game as soon as D can produce a legitimate artifact, then expands to the slate. Recheck current work before every batch to avoid overwriting concurrent changes.

For each package, implement its smallest complete path, exercise the named failure cases and return evidence before expanding scale. Record unfinished dependencies and continue independent work. Do not quietly skip historical-clock checks to fill the dataset, or remove betting safeguards to make a candidate appear active.

Keep the initial statistical search small even though the engineering plan is detailed. The expanded advanced backlog is conditional: hierarchical team/QB models, player interactions, drive models, discrete joint scores, copulas, mixtures of experts and deep models require a demonstrated weakness and a simpler comparison. Do not build all of them before the first complete model-to-decision path.

The effort figures are planning estimates, not a deadline or a claim that an AI agent can run unattended for that duration. Measure actual progress and remaining work after the first pilot. Return one updated execution ledger, reproducible artifacts and concise results; preserve negative and inconclusive findings.
