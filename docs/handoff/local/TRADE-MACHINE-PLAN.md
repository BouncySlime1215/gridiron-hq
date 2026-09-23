# Trade Machine plan v2 (2026-09-23 02:40Z; Nick: "spend what's left making this plan better")
Objective (one KPI): Nick's title odds per league (season-sim, current week + real record), moved by trades. Second: rest-of-season starting-lineup points gained minus given. Everything else is a means.

## What v1 (§19 TM-01..08) got wrong or left thin, and the fix
1. "Their-eyes value shifted by sentiment" (TM-01) is thin: 132 sentiment rows, no calibration. FIX: their-eyes value = a MARKET price built from the 14,882 real Sleeper trade sides (what managers actually pay, per player per week, revealed preference; free and allowed) + ESPN's public numbers they see (ROS rank/projection, %rostered, %started and their weekly change = hype) + that manager's own revealed habits from his transactions. Chat sentiment becomes a tag with n ("praised him 3x"), not a multiplier.
2. Backtest leakage (TM-06): the "fair on paper" side must use only what was known on the trade date (ESPN projections as of that week, rosters of BOTH teams that week from team_weeks). Only accepted trades are observed; declined offers are invisible, so acceptance cannot be fit there. Nick's own 20 proposals in league 4 (declined/countered/ignored) are the only acceptance data and stay unreadable until N1 (ESPN cookie on the live collector). N1 is the #1 blocker for the machine learning anything about acceptance.
3. Roadmap as a fixed path (TM-05) ignores that each step may be refused. FIX: a decision tree with acceptance odds per branch and expected title odds per branch, re-planned weekly.
4. Analyst confidence (TM-07): structured output, every number cited, influence capped, forward-only grading, and a "how this looks if it goes wrong" line on every pitch (reputation is a repeated game: the same manager has to say yes again in November).
5. Missing rules: the league's trade review window, veto rule, deadline, roster size and flex rules (A-01 league config) decide what "fair-looking" must mean (veto-proof = paper value within the review norm) and when 2-for-1s hurt (roster spots).
6. Nick's own biases: endowment (overvaluing his own players) and recency. FIX: the machine prices Nick's players at MARKET and flags when Nick is the one overpaying (selfScout exists).
7. Counters: v1 only sends offers. FIX: "evaluate this counter" in one tap (paper + real + what to reply), because most deals close on the counter.

## New data to pull in (licence-first; free unless noted)
- TM-09 Market prices from real trades: per player per week, the median package value paid across Sleeper trades (revealed price), with a hype index = price minus our real value. Sell where hype > 0, buy where < 0. Allowed by Nick (aggregates only).
- TM-10 ESPN league signals via the league API: each team's trade block ("on the block" / "untouchable" flags per player), transaction counter, %rostered/%started deltas, injury status. The block flags are the counterparty telling us what he wants to move. Needs the cookie (N1) for private leagues.
- TM-11 Injury timelines: from nflverse injuries 2009+, the distribution of games missed by injury type and position, re-injury rates, and post-return production dip. Gives "two weeks later" numbers for injured and injury-adjacent players (teammate returning = targets vanish).
- TM-12 Forward schedule strength: power ratings from closing lines -> implied team totals for every future week incl. 15-17; bye map; a "next 3 weeks vs rest" swing per player. Uses the nflverse line history we hold.
- TM-13 Role and opportunity: snap share, routes, target and air-yard share, red-zone share, xFP (ffopportunity, licence fixed in F-08), OL continuity (rnd/data/ol-continuity-snaps), FTN charting (rnd/data/ftn-charting; licence to confirm), OC/QB changes from the news feed.
- TM-14 Public hype (terms first): FantasyPros/ECR rank moves, Reddit and X mention volume, Google Trends. Only if terms allow; otherwise the ESPN %started delta is the hype proxy.
- TM-15 Nick's voice: his own messages in the corpus (length, tone, emoji, how he opens deals) so drafts read like him.

## Negotiation playbook (each item = a feature + a test)
- Anchor: open above the target, concede in shrinking steps; MESO: send 2-3 equivalent offers at once so his choice reveals what he values and he feels he chose. Test: acceptance and reply rate by offer style once N1 gives outcomes.
- Justify: every offer carries a true "because" tied to HIS stated need (he said he needs an RB: cite it; his RB2 slot scores 6.1). Commitment/consistency.
- Frame the loss of not trading ("your flex has averaged 5.8 the last 3 weeks"), never the gain we take.
- Quantity illusion: 2-for-1 where Nick gets the best player; show him the roster spot he frees as a plus for him; plan the throw-in he will ask for in advance (Nick's droppable bench).
- Social proof: prefer deals ESPN's own analyzer calls even or his win; say so only when true.
- Timing: after a loss (tilt) and before his bye crunch; before the deadline; in his active hours (night_share, reply latency). Test on Sleeper: acceptance rate vs the partner's prior-week result and bye load (RS-02).
- Repeated game: cap "wins" per partner per season; never take the same guy's best player twice; keep a fairness ledger per partner so November deals still happen.
- Trade-then-claim: a 2-for-1 forces him to drop someone; if Nick holds waiver priority, target the drop. Test on Sleeper: are post-trade drops picked up by the partner within 48 h and how good are they (RS-03).
- Endowment: he overvalues his own players, so buying costs more than selling earns. Prefer SELLING hype (TM-09) and buying with quantity; expect to pay a premium when buying a stud and price it in.

## Research units (pre-registered, aggregates only)
- RS-01 (=TM-06): does the paper-fair/real-edge signal predict who gained at +2/+5 weeks? vs ESPN-value baseline.
- RS-02: acceptance/timing: do trades close more often after the partner lost, in bye weeks, near the deadline? (Sleeper transactions have timestamps and matchups.)
- RS-03: trade-then-claim frequency and value.
- RS-04: hype decay: does a player's revealed market price (TM-09) above his real value fall over the next 2-4 weeks? (This is the "why did I do that" mechanism, measured.)
- RS-05: 2-for-1 outcomes: does the side receiving the best player gain more, by league size and roster rules?
- RS-06: injury-adjacent sells: production of WR2/RB2 when the WR1/RB1 returns; timing of the return vs the trade.

## Build order (after the midnight resume; each unit: RED test, skeptics, auditor where it prices)
1. Dossiers (local) + TM-09 market prices + TM-11 injury timelines + TM-12 schedule swing (data first; all local, no product risk).
2. TR-01 chance-to-play fix, TR-03 value inputs, TM-06/RS-01 backtest (the proof).
3. TM-01 finder + TM-02 tags + counter evaluator; TM-03 target board; TM-04 pitch ladder in Nick's voice; TM-05 decision tree.
4. TM-07 analyst + TM-08 research feed (after Nick's spend cap).
Weekly: title-odds trajectory per league and a "trade machine contribution" line (points from acquired minus given), so we know if it works.

## Decisions owed by Nick: N1 (ESPN cookie on the live collector: unlocks acceptance learning and trade-block flags), analyst spend cap (TM-07/08), phone alerts (N12), deploy word.

## Research notes (02:50Z, web + local checks)
- MESO (multiple equivalent simultaneous offers) is backed by six experiments: offers are accepted more often, recipients are more satisfied, the offerer anchors harder (recipients adjust less from a MESO), joint outcomes rise, and the offerer earns a cooperative reputation. Sources: Leonardelli, Gu, McRuer, Medvec & Galinsky 2019, OBHDP (https://www.sciencedirect.com/science/article/pii/S074959781630557X); Medvec & Galinsky, "Negotiating for more: the MESO" (https://pubmed.ncbi.nlm.nih.gov/24042029/); AOM 2012 (https://journals.aom.org/doi/10.5465/AMBPP.2012.14827abstract). Product rule: TM-04 sends 2-3 equivalent offers by default, each with a true "because"; the counterpart's pick is logged as a preference read (feeds the dossier).
- ESPN trade-block flags (TM-10): the mTeam view exists but the block fields are undocumented (https://github.com/cwendt94/espn-api, https://gist.github.com/nntrn/ee26cb2a0716de0947a0a4e9a157bc1c, https://thomaswildetech.com/blog/category/espn-fantasy-football-api/). Local check on the 5 stored league payloads: payloads=5, containing "tradeBlock"=5, "onTheBlock"/"untouchable"=1. If 0, the stored views (mSettings) don't carry it; the first cookie-backed mTeam fetch after N1 settles it. Until then TM-10 is a guess.
- Endowment effect and the repeated game are why the machine prefers SELLING hype over buying studs, and why it keeps a per-partner fairness ledger.
