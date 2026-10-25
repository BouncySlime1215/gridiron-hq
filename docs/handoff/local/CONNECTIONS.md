# CONNECTIONS: what the arrows ARE (Nick 9/24 ~1 AM: "what exactly are these arrows? should be AI, ML, neural and Jev with insane capabilities; boxes should give each other context")
Every box connects to every other box through the hub. The hub has three layers, and each is a different kind of arrow:

## 1. Facts layer (the wires)
Typed fields with source + as_of + one owner (FIELD-REGISTRY.md). Deterministic, replayable, and a backtest sees only what existed then. This is what makes everything else trustworthy.

## 2. Learning layer (ML/neural arrows: HOW MUCH each box should listen to each other box)
Each decision (P(yes), price, partner order, timing, target) gets a FUSION model over every relevant field from every box. Its edge weights are LEARNED from outcomes, not hand-set:
- Hierarchical Bayesian fusion: league -> manager partial pooling, so league 4's 40 offers borrow strength from about 1,700 Sleeper trades plus 6,000 league-seasons. An edge that doesn't earn weight on held-out outcomes shrinks to about 0 on its own (that's how chat features got 0 weight in P(yes) tonight, and how "wants player X" got 17x in targeting).
- Neural clone (CLONE-NN): a neural manager model trained where the data is big (Sleeper 2021-22 trades, lineups, adds), then fine-tuned per league-4 manager with shrinkage. It learns interactions no hand rule sees (roster shape x standings x recent loss x player hype). It has to beat the current clone on E1 held out before it gets any weight.
- Online updating: every offer and reply updates the weights (anytime-valid, so peeking is safe). The report card grades each edge.
- Honest limit: league 4 alone is too small for a neural net (40 decided offers), so neural lives on Sleeper-scale data plus per-manager fine-tuning, never raw on 40 rows.

## 3. Jev reasoning layer (the cross-box context: the perimeter talking to itself)
Jev reads a snapshot of the WHOLE hub for league 4 each refresh and looks for connections no single box sees: "manager X said he wants an RB (credible, 17x) + his RB just got hurt + he lost by 40 (mood) + he's 2-3 (catch-up) + the planner's #3 path gives him an RB -> move that path to #1, send tonight, message framed on his need". Every cross-link Jev writes is:
- grounded (every fact cites a hub field, checked the way Coach is);
- turned into a checkable prediction ("he replies within 24 h", "he counters with X");
- graded (M10). Jev's links earn weight in the learning layer like any other edge.
Surprises (HYPO-01) feed Jev new hypotheses; confirmed ones become R&D tests and then features.

## Why not direct box-to-box wires
Direct wires = each box re-deriving the others' numbers = tonight's 4 profile readers and 2 planners. Through the hub, each box gets the others' context in one hop, one version, graded.

## Units (held by the CONVERGE GATE; R&D can start now)
- FUSION-01: hierarchical fusion for P(yes) + price with learned edge weights; graded E1/E2.
- CLONE-NN: a neural clone on Sleeper, fine-tuned per manager; R&D first (must beat the current clone held out).
- JEV-CROSS: Jev cross-box reasoner on hub snapshots -> ranked cross-links + predictions; graded M10.
