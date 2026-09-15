# Chunk 9/21 scoring — N01 (time-series foundation models), N02 (GNNs), N03 (transformers on PBP), N04-F1 (LLM forecaster)

Grounded against the full notes files: N01-timeseries-foundation-models.md, N02-graph-neural-networks.md,
N03-transformers-play-sequences.md, N04-llm-as-forecaster.md (all read in full or spot-checked at the
relevant sections tonight, 2026-09-12).

## Key facts pulled from the notes that change the scoring from the raw candidate text

1. **N01 notes are unusually decisive against short-panel TSFM use**: TimesFM's own authors cut
   context to 256 because they judged multi-year *weekly* Google Trends/Wikipedia data "not
   sufficiently long" — a single NFL team-season (17 points) is 1-2 orders of magnitude shorter
   than that. Lag-Llama's own tokenization scheme structurally cannot accept a lag-52 feature from
   17 points. Zero-shot Lag-Llama ranks 6.714/13 (worse than several from-scratch supervised
   baselines) and only becomes competitive (rank 2.786) after *fine-tuning* — exactly what C4
   proposes, but C4 is explicitly gated behind cheaper zero-shot pilots (not in this chunk) that
   haven't run yet. The one thing that *is* well-grounded: Moirai is trained with per-variate
   windows as short as 2 steps because it pools many short series — Gridiron's team-week/player-week
   panels are exactly that kind of "many short series" data, so the *pooling* framing in C4 is sound;
   the *sequencing* (fund it before cheaper pilots clear) is not.

2. **N02 notes: the one real, clean NFL/cross-sport result favors player-level graphs over team-level.**
   Luo & Krishnamurthy (NBA, GATv2-TCN) shows a real ablation win over non-graph baselines (RMSE 2.222
   vs 2.414) — legitimate but cross-sport, and its own "profitable betting" claim (59.3% on n=59,
   one day) is statistically meaningless by the authors' own framing. HIGFormer's own ablation shows
   removing the *team* interaction network "barely hurts" while removing the *player* interaction
   network causes a much bigger drop — a direct, load-bearing reason to prioritize C1/C3/C5 (player-
   and roster-level) over C2/C4 (team-level / heterogeneous). PMC10217531 (NBA team-graph GCN) reports
   the graph topology itself buys only ~0.4-0.8pp over a good non-graph classifier once feature
   reduction is applied — this is the cited literature's own honest verdict that team-level graphs are
   low-value here, directly supporting a reject on C2.

3. **N03 notes: Ötting (2020) is a genuinely strong, directly-comparable NFL result** — 2-state HMM
   per team, real train/test split (2009-2017 vs 2018), 71.5% OOS play-call accuracy vs ~58.4% base
   rate, same data granularity Gridiron has (discrete play-by-play, no tracking). This is the
   literature's cleanest existence proof that sequence/state-awareness beats i.i.d. treatment on
   exactly Gridiron's kind of data, and it directly strengthens both F2 (replace nfl-drive-sim.js's
   hand-coded policy with fitted state-transition probabilities) and N1 (next-drive-outcome
   transformer). The CS230 negative result (state-only NN, no sequence structure) is the correct null
   baseline N1 must beat, and is already the exit criterion cited.

4. **N04 notes surface an explicit, deliberate governance boundary that F1 would cross.** Claude is
   already wired into Gridiron via server/services/claude.js, and its one existing betting-adjacent
   use (nfl-ai-replay.js) explicitly instructs the model "Do not... estimate a win probability";
   decision-basis.js's own header comment states "Claude is a risk gate, not a source of invented
   probabilities." F1 proposes exactly that — an LLM-seeded point estimate for
   player_week_engine.heads.season_to_date. This does not kill the candidate (cold start, where the
   alternative is a documented silent null, is a materially different case from live betting
   decisions), but it means F1 cannot be treated as a routine days-scale drop-in fix: it needs an
   explicit decision to cross an existing boundary, and should run shadow-mode-only (log, don't act)
   before it writes into heads for real. This downgrades F1 from "build" to "test-first" despite
   otherwise having the strongest evidence base in the batch (Halawi et al., a real, replicated,
   near-crowd-Brier published method), and despite Paleka et al.'s own pitfalls paper flagging
   temporal-leakage risk in backtesting LLM forecasters — a second reason any validation of F1 must
   be built carefully (date-verifiable retrieval, prospective not backtested evaluation) rather than
   taken at face value.

## Final scores

| id | evidence | applicability | value_per_cost | verdict |
|---|---|---|---|---|
| N01-C4 | 2 | 3 | 2 | later |
| N01-C5 | 1 | 2 | 2 | test-first |
| N01-C6 | 3 | 4 | 5 | build |
| N02-C1 | 3 | 5 | 3 | test-first |
| N02-C2 | 2 | 2 | 1 | reject |
| N02-C3 | 2 | 4 | 4 | test-first |
| N02-C4 | 1 | 2 | 1 | later |
| N02-C5 | 2 | 4 | 4 | test-first |
| N03-F1 | 2 | 3 | 2 | test-first |
| N03-F2 | 4 | 5 | 4 | build |
| N03-F3 | 1 | 4 | 4 | test-first |
| N03-N1 | 3 | 3 | 2 | test-first |
| N03-N2 | 1 | 2 | 1 | reject |
| N03-N3 | 1 | 3 | 1 | later |
| N04-F1 | 4 | 4 | 3 | test-first |

Two clear "build" calls this chunk: N01-C6 (cheap, durable audit harness reusing existing
pairedBootstrapDiff infra) and N03-F2 (directly fixes confirmed, verified nfl-drive-sim.js physics
bugs using existing playDistributionAudit() validation, backed by the strongest directly-comparable
literature result in the whole chunk). Everything with real NFL-relevant upside but thin or
cross-domain evidence (N02-C1/C3/C5, N03-F1/F3/N1, N04-F1) is test-first — cheap, well-specified
gates already exist in each candidate's own exit criteria. Team-level graph work (N02-C2/C4) and the
untested Kalman-filter/contingent-on-N1 candidates (N03-N2/N3, N01-C4) are reject/later given the
literature's own honest admissions of marginal or unproven value, and explicit sequencing behind
other unproven prerequisite work.
