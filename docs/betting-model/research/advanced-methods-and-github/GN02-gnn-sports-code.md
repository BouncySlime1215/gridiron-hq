# GN02 — GNN sports-prediction repos: what they actually do, and what Gridiron could build today

Agent: GN02-gnn-sports-code | bucket: new | phase: GitHubNew | 2026-09-12

All four repos cloned into
`/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/research2/github/`
No node_modules/venv found in any. Read the actual model/data-construction code (not just READMEs) in each.

---

## 1. joewilaj/nbaGNNs

- **License**: MIT. **Stars**: 10. **Last commit**: 2021-07-04 (`pushed_at`). Dormant (5 years), MIT lets us do anything with it regardless.
- **What it verifiably does** (`nbaGNNs/src/models.py`, `graph.py`, `construct_from_data.py`):
  - Builds a **62-node "Offense/Defense" graph** per day of the season: 31 NBA teams × 2 (one node per team's offense, one per team's defense). Edge weights come from **Four Factors** box-score statistics (`weights.xls`) turned into a row-normalized transition matrix, with a "PageRank-style Oracle Adjustment" (Balreira/Miceli/Tegtmeyer, *An Oracle Method to Predict NFL games*) applied before random walks — i.e. this is literally an NFL-ranking method ported to NBA.
  - A separate **31-node "Vegas graph"**: teams as nodes, weighted directed edges from historical closing spreads.
  - Runs **node2vec** (Grover/Leskovec) on both graphs to get per-node structural embeddings, then feeds `[node2vec features, adjacency]` through one of four real GNN layers from **spektral**: `GeneralConv`, `ARMAConv` (Bianchi et al. 2019), `GINConv` (Xu et al. 2019), or a manual diffusion-CNN (Atwood/Towsley 2015).
  - A `Game_Vec` layer (custom Keras layer in `extract_team_GAT.py`) gathers the specific two teams' updated node representations for the day's matchup out of the full graph output — this is the "link prediction" step. That vector plus the market spread plus each team's last-5-games form and a one-hot team ID are concatenated into a small dense regressor that outputs predicted (home − away) score.
  - It **retrains from scratch every single day** of the test window (`for day in range(start_day, stop_day)`) using every game played so far that season — expensive but honest walk-forward evaluation, `batch_size=1`.
  - A second-stage **discriminator model** (also GIN-based) builds a third graph — a "Model Graph" from the first model's own historical prediction errors vs. the market — and predicts, per game, whether the model or Vegas will be closer, i.e., a learned **confidence/edge-detection layer on top of the primary model**, which is exactly the kind of governance gate concept Gridiron's betting side needs but currently lacks in a principled form.
  - Genuinely uses the market line as one input feature, not as the sole basis of the forecast — i.e., it's an actual combination model, unlike the "0.68 + 0.632·market" shrinkage tonight's audit found in `nfl-ensemble.js`.
- **Verdict: borrow-idea / call.** Don't lift the code wholesale (TF1-era Keras + spektral + old node2vec forks, unmaintained), but the **architecture is directly portable**: build a 64-node (32 offense + 32 defense) NFL graph from Gridiron's own weekly team offense/defense splits, run node2vec or just plain learned embeddings, feed a small GNN + market-line regressor. The **discriminator/Model-Graph idea is the most valuable transferable piece** — it's a template for a learned "should I trust this pick over the market" gate.

## 2. stevenbliu/Project-NBA-Rankings-Prediction

- **License**: `NOASSERTION` in a `LICENSE.txt` present (repo claims MIT-style terms per its own README acknowledgement of GraphSAGE's license, but GitHub can't classify it — treat as "check LICENSE.txt text before redistributing," code reuse for internal research is fine).
- **Stars**: 4. **Last commit**: 2025-12-09 (recently touched, not dead).
- **What it verifiably does**:
  - The `graphsage/` directory is **verbatim vendored code** from williamleif/GraphSAGE (Hamilton, Ying, Leskovec, NeurIPS 2017) — the repo's own README says so explicitly ("the graphsage implementation found in this repo is not our own"). This is the real, well-tested inductive GraphSAGE reference implementation, not a reimplementation.
  - The actual novel contribution is `src/features/build_features.py`: it builds a graph where **nodes = NBA teams-per-season**, node features = **181 team/player stat columns** scraped from basketball-reference, and **edges = the season schedule** (`nx.Graph` built from `data['id']` nodes and a schedule-derived `edges` dataframe — i.e., an edge between two teams if they played each other that season). The label is final standings rank (`Rk`). Data is formatted into GraphSAGE's expected `nba-G.json` / `nba-feats.npy` / `nba-class_map.json` files and run through `graphsage/supervised_train.py` for node classification (`run.py`).
  - **Verified defect, load-bearing**: there is a *second*, simpler path (`src/models/GCN.py` + `src/models/GCN_Trainer.py`, a from-scratch 2-layer GCN) whose `GCN_Trainer.train()`/`test()` train and evaluate on the **exact same `features`/`adj`/`labels` tensors** — no train/val/test split at all, and the node features are aggregated over the *entire season* used to predict that same season's final rank. The README's claimed "~88% accuracy" almost certainly comes from this leaky path, not the properly-split GraphSAGE path. **Do not cite or reuse this accuracy number**; it is not evidence the graph approach works, only that it can memorize.
- **Verdict: borrow-idea (schema) / call (GraphSAGE library) / avoid (the GCN.py side-path's evaluation claim).** The team-vs-schedule-graph node-classification framing is exactly the shape of Gridiron's `nfl-team-strength.js` problem, and vendoring real GraphSAGE (MIT-licensed upstream) rather than a hand-rolled GCN sidesteps the leakage bug this repo demonstrates.

## 3. sanjeevnara7/FootballPassPrediction

- **License**: MIT. **Stars**: 41. **Last commit**: 2024-04-30. Active/recent, most credible engineering of the four (PyTorch Geometric 2.3, torch 1.13, real requirements.txt).
- **What it verifiably does** (`gnn/gnn_models.py`, `gnn/gnn_datagen.py`):
  - This is a **per-play, per-frame spatial graph**, not a season/roster graph: for one broadcast frame at the moment of a pass, nodes = the ~22 detected players (from a YOLO detector) + ball-possessor flag; node features = `[team_onehot(2), x, y, has_ball]` (5 dims, matching `hc_prev=5` in every model class). Edges are **fully connected** (`case=1`, all-pairs) with edge features = a Gaussian kernel of Euclidean pitch-distance, `exp(-(distance/25)^2)`, optionally sign-flipped by team to encode adversarial vs. cooperative relationships (`negate_edge`).
  - Implements real, correct PyG layers: `GATConv`, `GATv2Conv` (with `edge_dim=1` so the distance-decay edge feature actually gates attention), `GCNConv`, `GCN2Conv` — output is a `softmax` over nodes = probability each player is the pass receiver. This is a legitimate, working spatial-attention-over-players model, not a toy.
  - The wider repo is a 4-stage vision pipeline (YOLO detection → team clustering → homography/perspective transform to pitch coordinates → this GNN); the GNN stage only exists because the upstream stages already produce (x, y) coordinates per player per frame.
- **Verdict: reference-only for Gridiron today, borrow-idea for the future.** Gridiron has no player x/y tracking data (no Next Gen Stats ingestion), so this can't attach to any current table. It **is** the right template *if* Gridiron ever ingests NFL Next Gen Stats tracking data (which does exist as a public dataset via nflreadr/nflfastR extensions) — distance-decayed GATv2 edges are a much better way to encode "who's near whom" than any hand-built spatial feature. Not actionable tonight; flagged as a forward-looking capability only.

## 4. juancamilocampos/nfl-big-data-bowl-2020

- **License**: none present (no LICENSE file → default all-rights-reserved; treat as reference/study only, do not vendor code verbatim without asking the author).
- **Stars**: 12. **Last commit**: 2023-03-25.
- **What it verifiably does** (`nfl_graph_neural_networks_v1.ipynb`):
  - Directly NFL, and directly motivated by a cited sports-analytics GNN paper (Stöckl/Seidl/Marley/Power, Stats Perform). Builds a **per-play graph**: nodes = ballcarrier + all defenders (offense besides the rusher is dropped in this first version), node features = `[X_std, Y_std, Sx, Sy, Dir_std, IsRusher]` (standardized position, velocity components, direction, rusher flag) from NFL Next Gen Stats tracking data. Edges = **rusher-vs-every-defender** pairs, edge features = the raw feature-difference vector (relative position/velocity) between sender and receiver — a genuine relational encoding, not just distance.
  - Uses DeepMind's `graph_nets`/Sonnet **EdgeBlock → NodeBlock** message-passing architecture (an Interaction Network, not just a convolution): edges are transformed by an MLP first, then aggregated into each node before a second MLP produces a per-node output.
  - Trained with the actual competition loss — **CRPS over a 199-class cumulative yards distribution** — and the notebook states it reached the equivalent of **~53rd/lower place, top 3% by CV score** in the 2020 Kaggle Big Data Bowl leaderboard using *only* the rusher-vs-defenders subgraph (explicitly noting that adding the rest of the offensive line back in is a stated future improvement).
  - Two sibling notebooks in the same repo (`1st_place_zoo_solution_v2.ipynb`, `pytorch_version.ipynb`) reproduce the actual 1st-place non-GNN CNN-image solution for comparison — useful as a documented benchmark that the GNN version is compared against honestly rather than cherry-picked.
- **Verdict: reference-only today (no tracking-data ingestion in Gridiron), but the strongest example of the exact NFL play-graph pattern** — rusher/defender relational edges via Interaction Networks. Same forward-looking status as #3: valuable once/if Next Gen Stats tracking is ingested, not attachable to `player_week_usage`/`nfl_snaps` today.

---

## What Gridiron's tables can build a graph from TODAY (verified schema, read from `fantasy-football-dashboard`, read-only)

Relevant tables (server/db/schema/*.js):
- `roster_players` — current roster membership per team
- `player_week_usage` (`server/services/nflverse.js`): player_id, season, week, team, opponent, position, attempts, carries, targets, receptions, **target_share**, air_yards_share, wopr, receiving/passing air yards, EPA, CPOE, RACR, PACR
- `player_week_snaps` / `nfl_snaps`: **offense_snaps, offense_pct**, defense_snaps/pct, st_pct
- `nfl_depth`: team, gsis_id, pos_abb, **pos_rank**, pos_slot (depth-chart hierarchy)
- `nfl_roster_snapshots` / `nfl_player_roster_events`: roster transactions over time (signings, trades, cuts)
- `nfl_player_week_features` / `nfl_team_features`: season, week, player_id/team, JSON feature blob (already-engineered features, no sequence/graph structure used on them per tonight's audit)

None of these currently feed anything graph-shaped (tonight's audit: 251,591 PBP rows "used only for hand-built features, never sequence models" — same is true of these usage tables).

**Concrete graph spec buildable today, no new data ingestion:**

- **Node types** (heterogeneous graph):
  - *Player nodes*: one per (player_id, season, week) row in `player_week_usage`/`player_week_snaps`; features = target_share, air_yards_share, wopr, offense_pct, EPA, CPOE, position (one-hot), depth-chart pos_rank from `nfl_depth`.
  - *Team-offense / Team-defense nodes*: one per (team, season, week), aggregated from the same tables (32×2 = 64 nodes per week, directly mirroring `nbaGNNs`' Offense/Defense graph design above).
- **Edge types**:
  1. **Teammate-competition edges** (player↔player, same team+week): weight = negative correlation implied by shared target/carry pool — direct analogue of `df2graph`'s fully-connected per-frame graph in FootballPassPrediction, but at season-usage granularity instead of per-frame spatial.
  2. **Depth-chart edges** (player↔player, same team+position+week): starter→backup hierarchy from `nfl_depth.pos_rank`, weighted by pos_rank gap — encodes "who absorbs snaps if X is out," which is exactly the role-changepoint problem `role-changepoint.js` currently handles with hand-tuned heuristics.
  3. **Player↔Team-offense edges**: membership edge, weight = offense_pct (snap share) — this is the natural "how much of this node's identity is this player" edge, same role as `IsOnOffense`/team membership in the two NFL tracking repos above.
  4. **Team-offense↔Team-defense matchup edges** (weekly): the team's opponent that week — direct analogue of `nbaGNNs`' 62-node weekly Offense/Defense graph, buildable from the existing schedule + `player_week_usage.opponent` column.
  5. **Roster-transaction edges** (temporal): `nfl_player_roster_events` gives edges across time when a player changes teams — lets embeddings propagate prior-team performance into a new team context (addresses the "cold start" flavor of problem, distinct from the fantasy weekly-learning cold-start defect but related in spirit).

This is a graph GraphSAGE (repo #2's vendored, MIT-licensed library) or a spektral/PyG GNN (repos #1/#3's libraries) can run over **without waiting on Next Gen Stats tracking data** — it only needs tables that already exist and are already populated weekly.

## Sources consulted (papers referenced by the repos, not separately fetched in full)
- Hamilton, Ying, Leskovec. "Inductive Representation Learning on Large Graphs" (GraphSAGE), NeurIPS 2017 — https://arxiv.org/abs/1706.02216 (vendored in repo #2)
- Bianchi, Grattarola, Livi, Alippi. "Graph Neural Networks with convolutional ARMA filters", 2019 — https://arxiv.org/abs/1901.01343 (used in repo #1)
- Xu, Hu, Leskovec, Jegelka. "How Powerful are Graph Neural Networks?" (GIN), ICLR 2019 — https://arxiv.org/abs/1810.00826 (used in repo #1)
- Grover, Leskovec. "node2vec: Scalable Feature Learning for Networks", KDD 2016 — https://arxiv.org/abs/1607.00653 (used in repo #1)
- Balreira, Miceli, Tegtmeyer. "An Oracle Method to Predict NFL Games" (PageRank-style oracle adjustment ported to NBA in repo #1)
- Stöckl, Seidl, Marley, Power (Stats Perform). GCN for sports tracking data — cited as direct motivation in repo #4's notebook
- Also found but not cloned (not read in full, cited by title/abstract only): Luo & Krishnamurthy, "Who You Play Affects How You Play: Predicting Sports Performance Using Graph Attention Networks With Temporal Convolution" (GATv2 + temporal conv over a player-interaction graph), arXiv:2303.16741 — no public code repo found; relevant as a design reference for edge type #1 above (teammate-interaction attention) if Gridiron wants an attention-weighted rather than hand-weighted teammate edge.
