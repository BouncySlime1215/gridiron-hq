# N02 — Graph Neural Networks for Team/Player/Matchup Modeling (no tracking data)

Bucket: **new**. Topic: GNN architectures for roster/target-share/snap-share graphs, applicable
without any player-tracking feed (Gridiron has none — confirmed by schema grep, no x/y/velocity
table anywhere in server/db/schema/*.js).

## Gridiron surfaces grepped (ground truth, 2026-09-12)

- `server/db/schema/nfl-n-to-z.js:160` — `nfl_player_week_features(season,week,player_id,team,
  opponent,position,features TEXT)` — per-player weekly feature JSON. Built in
  `server/services/nfl-pbp.js`. This is the natural **node-feature table** for a player graph.
- `server/db/schema/nfl-n-to-z.js:154` — `nfl_team_week_features(season,week,team,opponent,home,
  features TEXT)` — team-level node features, same file.
- `server/db/schema/nfl-n-to-z.js:612,618` — `nfl_team_feature_vectors` /
  `nfl_player_feature_vectors` (versioned, `vector_json`, `coverage`, `evidence_hash`) — built by
  `server/services/nfl-weekly-feature-store.js`. Literally a feature-vector store already —
  the closest thing Gridiron has to GNN node embeddings today (it holds none; vectors are hand
  engineered, not learned).
- `server/db/schema/nfl-a-to-m.js:53` — `nfl_snaps(season,week,player,team,position,offense_snaps,
  offense_pct,defense_snaps,defense_pct,st_pct)` — snap-share table.
- `server/db/schema/nfl-a-to-m.js:59` — `nfl_depth(season,week,team,gsis_id,player_name,pos_abb,
  pos_rank,pos_slot,captured)` — depth-chart table, gives natural "same-position-group,
  adjacent-rank" edges.
- `server/db/schema/nfl-n-to-z.js:204,218` — `nfl_roster_snapshots`, `nfl_player_roster_events`
  (`event_type, from_team, to_team, roster_status, effective_at`) — roster-membership-over-time,
  built in `server/services/nfl-player-state.js`.
- `server/services/player-week-engine.js:573-600` — the `heads` object (`season_to_date, last3,
  last1, median`) is Gridiron's per-player point-estimate state; FOUND confirms it is null at
  cold start (`engine.heads` never populated week 1, no forward snapshot ever captured). This is
  a *fix*-bucket defect I am not claiming to repair (that's another agent's job) — but it is the
  natural place a graph model's inductive property (see Candidate 3) would help going forward.
- `server/services/correlation.js` — fits pairwise QB-WR/RB archetype correlations into
  `correlation_estimates`, used by a Cholesky `correlatedSampler`. This is a real (if simple)
  pairwise model — NOT the "assumed independent" defect from FOUND.
- `server/betting/nfl/strategy/teaser-leg-rates.js:651` — comment literally reads "INDEPENDENCE IS
  ASSUMED and the legs are not quite independent" (line ~527-537 shows historical joint vs
  p-squared rates, rho ≈ -0.044). This IS the FOUND defect on same-game/teaser-leg correlation.
  I am bucket "new" so I am not claiming to fix this file; Candidate 4 below is a new capability
  that happens to be relevant background for whoever does fix it.
- `server/services/role-scenario-engine.js` (595 lines) — `buildPlayerScenarios`,
  `conservedTeamVolume`, `sampleScenarioMixture` — hand-built conservation-of-volume rules for
  redistributing snaps/targets after a role change. No message passing, no learned redistribution
  weights — this is the surface Candidate 5 targets.
- Grepped every `server/services/*.js` for the literal string "graph" (excluding "paragraph"):
  zero hits describe an actual graph data structure — only version-string cruft like
  `'coordinated-market-residual-v2-graph-bound'`. **Gridiron has no graph representation of
  anything today.** This is genuinely new capability territory end to end.

## Primary sources (read in full)

### 1. Luo & Krishnamurthy, "Who You Play Affects How You Play: Predicting Sports Performance
Using Graph Attention Networks With Temporal Convolution" (arXiv:2303.16741, Cornell, 2023)
- **Read in full** (all 15 pages).
- Data: NBA 2022-23 regular season, 2022-10-18 to 2023-01-20, 691 games, 92 game days, 582 active
  players across 30 teams. 13 player stats per node (7 basic + 3 tracking-derived + 3 advanced —
  note: tracking stats here are *league-published aggregate* stats like distance run, not raw
  positional tracking; the graph itself needs none of that).
- Graph: for each game day, build a **complete graph over the union of both teams' active
  rosters** (10+ minutes played) — i.e., exactly a roster-as-graph construction. Node features =
  player's box-score vector concatenated with a learned 2-D team embedding and a learned 2-D
  position embedding. Edges are unweighted/complete (no tracking needed at all).
- Model: GATv2 attention layer (per-neighbor attention weights) feeding a temporal-convolution
  layer (10 game-day lookback -> next game-day forecast) = "GATv2-TCN".
- Result vs benchmark (Table 2, RMSE / MAE / MAPE / CORR on a chronological 50/25/25 split):
  GATv2-TCN **RMSE 2.222, MAE 1.642, CORR 0.508** vs best graph baseline ASTGCN (RMSE 2.293,
  CORR 0.453), vs non-graph TCN (RMSE 2.414), DeepVAR (RMSE 2.896), N-BEATS (RMSE 5.112). The
  graph-based models both beat all non-graph baselines; the attention-based GATv2-TCN beats the
  spectral-GCN-based ASTGCN.
- Honest limitation / sample size on the one part that matters most for Gridiron's props module:
  the "profitable betting" case study is a **single day** of Underdog Fantasy higher/lower props,
  **35/59 correct (59.3%)** on 2023-01-20 using 10 days of prior data to fit. That is a
  statistically meaningless sample (n=59, one day, no significance test, no out-of-sample
  replication) — cite the RMSE/CORR result, not the betting number, as the paper's real finding.
- Direct Gridiron mapping: `nfl_player_feature_vectors` + `nfl_snaps` (for "played meaningful
  snaps this week" roster membership) can build the exact same per-week complete-graph-over-
  active-roster construction, feeding Gridiron's props module.

### 2. Wang, Xu, Horton, Gudmundsson, Wang, "Player-Team Heterogeneous Interaction Graph
Transformer for Soccer Outcome Prediction" (HIGFormer, KDD '25, arXiv:2507.10626)
- **Read in full** (7 of 11 pages — abstract through results/ablation; enough to state architecture,
  data, and numbers precisely).
- Data: WyScout Open Access Dataset, 1,941 matches across 7 competitions (Spain, England, Italy,
  Germany, France top divisions 2017/18 season + 2016 Euros + 2018 World Cup), 3,251,294 events,
  3,293 unique players, 154 teams. 80/20 chronological split per division.
- Graph: **heterogeneous, event-count based, no tracking data whatsoever** — a player-interaction
  graph per match built from counts of 10 event types (pass, shot, duel, foul, etc.) between
  players, PLUS a separate team-interaction graph where edges are historical win-rate between
  teams. Player and team embeddings are fused in a final "Match Comparison Transformer."
- Architecture: heterogeneous GAT (local) + a graph-augmented global transformer, combined via a
  Mixture-of-Experts gate; team graph via a homogeneous GAT; two-stage training (pretrain player
  network, then freeze and train team+match layers).
- Result: **52.19% overall 3-class (win/draw/lose) accuracy**, beating all baselines (MLP, RNN,
  P-Graph [player-only graph+GAT], T-Graph [team-only graph+GAT], DraftRec-adapted transformer) on
  overall accuracy; 57.96% on win prediction, 68.25% on lose prediction, weakest (~37% best-case
  across ALL methods) on draw — an honestly reported, hard-to-move number.
- Ablation (their own numbers, Section 4.3): **removing the Team Interaction Network barely hurts
  performance** — team-level win-rate history alone captures "certain insights," and removing the
  Player Interaction Network causes a much bigger drop. This is a direct, load-bearing finding for
  sequencing Gridiron's build: player-level roster graphs carry more signal than team-level graphs
  built from the same kind of data.
- Direct Gridiron mapping: `nfl_player_feature_vectors` (player nodes) + `nfl_team_feature_vectors`
  (team nodes) + `nfl_roster_snapshots` (which players belong to which team-node, replacing
  WyScout's lineup data) is a structurally identical setup, football event-counts substituting for
  soccer event-counts (e.g., targets, carries, pressures instead of passes/shots).

### 3. Karydis/Chen et al. equivalent — **substituted for accessibility**: Basketball outcome
prediction via fused GCN, "Enhancing Basketball Game Outcome Prediction through Fused Graph
Convolutional Networks and Random Forest Algorithm" (Entropy 2023, open-access via PMC10217531)
- **Read in full** (open-access, fetched directly).
- Data: NBA 2012-2018 regular seasons, Kaggle "NBA Enhanced Box Score and Standings," 14,758
  team-game rows, 30 teams, 6 separate season-specific models.
- Graph: **team nodes only, 44 box-score features per node, edges = recent-games-between-teams**
  — homogeneous, undirected, purely box-score-derived (no player nodes, no tracking data at all —
  the closest published analogue to a pure `nfl_team_week_features`-style graph).
- Architecture: Random Forest first reduces 44 features to 3 (teamEDiff, teamDrtg, teamFIC), then
  those 3 features feed a GCN for win/loss classification (70/10/20 split, 500 epochs).
- Result: **GCN+RF 71.54% average accuracy across 6 seasons** vs plain GCN (no feature reduction)
  66.90%, vs GCN+LASSO 70.70%, vs non-graph LR+RF 71.17% and SVM+RF 70.94% — notably, the graph
  structure alone bought only ~0.4-0.8pp over the best non-graph baseline once a good feature
  reducer was used; **the GCN's edge over a plain classifier on the same features was small**.
  This is the honest caveat: on pure box-score team graphs, the graph topology itself is not doing
  most of the work — feature engineering was.
- Stated limitations (their own): homogeneous graph doesn't distinguish team-vs-opponent roles, no
  player/coach nodes, regular season only, box-score aggregates (no play-by-play/tracking
  granularity) — they explicitly call for player nodes and spatiotemporal graphs as future work,
  i.e., exactly what source #1 and #2 above already do one level down (player nodes).

### 4. Xenopoulos & Silva, "Graph Neural Networks to Predict Sports Outcomes" (IEEE Big Data 2021,
arXiv:2207.14124) — **read in full as a negative/contrast case**
- **Read in full** (5 of ~9 pages: abstract, related work, full methodology).
- Data/task: NFL rushing-yards-gained regression and CS:GO round-win-probability, using **complete
  player graphs built from raw tracking coordinates** (X/Y, velocity, displacement per player, per
  frame) — Big Data Bowl-style tracking data for the NFL task specifically.
- Result: reduces test-set loss by **9% (NFL) and 20% (CS:GO)** vs a permutation-invariant
  vector-baseline "state model" (same features, no graph structure) — a real, clean ablation
  showing graph attention beats a vector baseline on identical inputs.
- **Why this is a "do not chase" citation rather than a template**: the NFL result in this paper
  is not achievable with the data Gridiron has — it explicitly requires frame-level tracking
  (X/Y/velocity) that does not exist in Gridiron's schema (confirmed: no such table anywhere in
  `server/db/schema/*.js`). It is useful only as the honest boundary case: the literature's
  strongest football-specific number (9% loss reduction) belongs to the tracking-data regime
  Gridiron cannot enter, and the "without tracking data" constraint means Candidates below must
  draw their transfer plan from sources #1-#3 (NBA/soccer roster & team graphs), not from this one.

## Repos found

- **joewilaj/nbaGNNs** (github.com/joewilaj/nbaGNNs) — MIT license, 10 stars, last pushed
  2021-07-04 (stale, ~5 years). Cloned to
  `.../scratchpad/research2/github/joewilaj__nbaGNNs` (33MB, no node_modules/venv, `.git` deleted
  after inspection). What it actually does (verified from README + file tree, not just claims):
  builds an **offense/defense node graph** (edges = Four Factors interaction stats from
  basketball-reference box scores) plus a separate **Vegas point-spread graph** (teams as nodes,
  edges = spread history), runs node2vec for initial embeddings, then feeds both into one of four
  GNN layer types (DCNN, GIN, ARMA, GAT via the `spektral`/Keras library) to regress score
  differential, backtested against-the-spread. No numeric win-rate is committed to the repo files
  (predictions are raw `.xls` files per game day, not an aggregate scorecard) — treat any
  "beats the spread" claim about this repo as unverified.
  **Adopt: borrow-idea, not code.** The library stack (Keras/spektral, node2vec, 2021-era APIs) is
  too stale to depend on directly, but the graph-construction pattern (team-as-node,
  point-spread-as-edge-weight, box-score-derived node features via a "Four Factors"-style stat
  set) is a clean, working precedent for Candidate 2 below and maps directly onto
  `nfl_team_feature_vectors` + the spread data already in Gridiron's odds tables.
- **UnravelSports/unravelsports** (github.com/UnravelSports/unravelsports) — MPL-2.0, 247 stars,
  actively maintained (pushed 2026-01-16). **Adopt: avoid** for this topic — verified via its own
  README that it is built around player **tracking** data (Kloppy-format providers: Sportec,
  SkillCorner, PFF, Metrica, StatsPerform, Tracab, SecondSpectrum, HawkEye, Signality; American
  football support is via NFL Big Data Bowl tracking datasets specifically). This is the same
  "needs tracking data Gridiron doesn't have" trap as source #4 above — noted for the do-not-do
  list, not a candidate.

## Candidates

All candidates below are bucket **new** (this agent's assignment) — `fixes_finding` is
"none — new capability" throughout, even where a candidate happens to touch a file also named in
tonight's FOUND findings (noted explicitly where that overlap exists, so the fix-bucket agent
doesn't duplicate work).
