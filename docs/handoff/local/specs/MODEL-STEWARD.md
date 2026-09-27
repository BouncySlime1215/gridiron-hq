# MODEL STEWARD: the always-on loop that designs, organises and understands the model (Fable, 9/27)

Nick: "design it so you work on the model constantly: design, organise, operate in the files 24/7, not just building but really understanding."
Framework, from the loops-and-graphs course: a LOOP makes one unit of work correct without a human (produce → check → correct → repeat); a GRAPH decides which units exist, when they run, and where results flow back. Gates are set by blast radius, not confidence.

## The steward graph (runs 24/7: the cloud Project for thinking, the Mac overnight for compute)
| Node | Cadence | Does | Writes to |
|---|---|---|---|
| 1 OBSERVE | hourly | Ingest outcomes, source health, ledger grades, drift, spend | observations.jsonl |
| 2 UNDERSTAND | daily | Read the ledger and gate diagnostics. Write a journal entry: what surprised us, which reasons gained or lost credibility, which contexts are blind, what Nick asked and why | MODEL-JOURNAL.md, BELIEFS.md |
| 3 HYPOTHESIZE | daily | From the journal, propose 3 experiments (a new expert, feature, data source or rule) with pre-registered bars, ranked by information gain × decision value | EXPERIMENTS.md |
| 4 EXPERIMENT | continuous | Run them in the replay lab, walk-forward, through the ablation gate | lab results |
| 5 PROMOTE / DEMOTE | on result | Shadow → served only through the bars; demote experts that decay; kill switches | registry, flags |
| 6 REORGANIZE | weekly | Refactor the map, specs and reason taxonomy to what was learned; retire dead experts; "change the map before the code", done for real | MASTER-MAP.md, specs |
| 7 TEACH | weekly | A plain-language "state of the model" for Nick: wins vs ESPN and FantasyPros, what it's testing, what it wants from him | STATE-OF-THE-MODEL.md, morning brief |

## Return paths (what makes it a loop, not a queue)
- Failed experiments → the journal (what we now know NOT to try).
- Nick's questions and overrides → hypotheses, and the Nick expert.
- Outcomes → the ledger → the trust gate → which contexts need new experts.
- The decision scoreboard → the objective (risk setting), not only the models.

## BELIEFS.md: the understanding layer
A structured table the steward maintains and re-reads every cycle: belief, confidence, evidence (with links), last tested, what would change it. Examples: "stars are over-projected by about 20 pts/season (FFA, 12 seasons; ours: untested)"; "TPRR beats target share for WR (2 sources; ours: untested)". No belief without evidence; every belief has a test.

## Gates by blast radius
- Docs, journal, specs, shadow experiments: automatic.
- Anything touching a served number or a flag: verifier + skeptic workflow, then the merge queue.
- Nick's hard rules, money, or outward actions: Nick only.

## Budget
- Per cycle token budget; the usage gate (stop launching at 94%); compute on the Mac only when mem-ok and load allow.
- Uses the cloud Project (24/7 per Nick) and cloud credit for thinking; the Mac overnight for replay compute.

## First runs
1. Seed BELIEFS.md from the research already in WEIGHTS-RESEARCH.md (about 30 beliefs, all marked "ours: untested").
2. Journal entry 1: the 9/27 state (what exists, the 5 gaps, why contention mode).
3. Hypotheses 1-3: star-shrink calibration on the ESPN backfill; TPRR vs target share on FTN data; inactives-timing edge on 2025 replay.
