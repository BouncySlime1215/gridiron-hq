# Gridiron HQ model audit — Run 7

Date: September 1, 2026  
Code tested: `3ca6b4c0df411ac14c22baf177d0df8e830fbd21`  
Council: `nfl-expert-council-v3`  
Scope: 2021–2025, Weeks 5–18, opened in chronological order  
Status: complete, 70/70 weeks, 974 games

## The answer first

The system is much better connected than it was, but the betting product is not profitable.
Run 7's historical selector made 144 graded decisions, won 65, lost 77, pushed two, and lost
16.952 units. That is -11.77% return. Do not represent this result as a profitable model, a 52.4%
system, or permission to risk money.

This run did prove several engineering facts. The full player builder finally participated in all
974 games. The week-by-week chain completed without leakage or overwritten weeks. Every pick had a
deterministic explanation tied to its frozen inputs. Postgame learning captured all 974 games and
deep gameplay for 900 of them. Those are foundations for learning; they are not predictive edge.

## Explain it like I am five

Imagine twelve kids trying to guess how a football game will end. One watches players. One looks
for old games that look similar. One replays the game in a computer. One watches the betting line.
One is a little neural brain. A teacher listens to them and decides how much to trust each kid.

Before this repair, the player-watching kid had no old lineup sheets, so it stayed quiet. We found
the real weekly lineup archive, loaded it, and made that kid speak in every game. It was right a
little more than half the time, but not enough to beat the price of betting.

The bigger problem is that three kids still have no old homework to grade:

- the verified-news kid has no preserved historical news stream;
- the live-game kid has no sealed play-by-play prediction ledger;
- the price-shopping kid has no historical multi-book quote tape.

The teacher also has not learned a dependable way to tell when a kid is especially trustworthy.
Some years the guesses made a little, and other years they lost badly. That means the machine is
not learning one stable football truth yet.

## Exact betting result

| Season | Bets | Wins | Losses | Units |
|---|---:|---:|---:|---:|
| 2021 | 35 | 13 | 21 | -9.038 |
| 2022 | 28 | 16 | 12 | +2.770 |
| 2023 | 20 | 9 | 10 | -1.616 |
| 2024 | 38 | 14 | 24 | -10.893 |
| 2025 | 23 | 13 | 10 | +1.825 |
| **Total** | **144** | **65** | **77** | **-16.952** |

The year-to-year swing is a warning. A stable edge should not depend on one or two friendly years.
Agreement among component models did not help: settled picks where components agreed won 46.08%,
versus 45.00% when they scattered. The 1.1-point difference was noise (`z = 0.12`). Building a
filter around that observed split would be cherry-picking.

## What each specialist actually did

| Specialist | Coverage | Direction rate | RMSE | Plain-English read |
|---|---:|---:|---:|---|
| Similar games | 100% | 52.47% | 12.608 | Best full-coverage direction result; still unproven after selection costs |
| Line movement | 20.02% | 52.88% | 14.049 | Interesting but only 195 observed games |
| Player builder | 100% | 50.89% | 14.118 | Fixed and connected; not an edge yet |
| Online neural residual | 98.46% | 50.32% | 12.900 | Learning path works; learned signal is weak |
| Specialist team | 100% | 49.42% | 13.185 | Below useful direction rate |
| Game replay | 100% | 48.32% | 13.048 | Simulation is coherent but not sufficiently accurate |
| Boosted trees | 100% | 47.79% | 12.611 | Good error size, wrong directional decisions too often |
| Rulebook | 100% | 47.00% | 13.597 | Interpretable baseline, not an edge |
| Verified news | 0% | — | — | No historical timestamped evidence to test |
| Live updater | 0% | — | — | No historical live prediction ledger to test |
| Price shopper | 0% | — | — | No historical multi-book quote history to test |
| Player opportunity | 100% | not comparable | not comparable | Scored on player volume, not spread direction |

Direction rate is not the same thing as profitable bet win rate. A specialist can be slightly right
about direction but still choose the wrong games, miss the number, or fail after sportsbook vig.

## The data hole that was fixed

The downloader requested a nonexistent `depth_charts_YYYY.csv.gz` path and swallowed the HTTP
failure. The published nflverse archive uses `depth_charts_YYYY.csv`. After fixing the contract and
normalizing the Rams' legacy `LA` code to `LAR`, the local backfill contains 115,411 rows:

| Season | Rows | Teams | Weeks |
|---|---:|---:|---:|
| 2021 | 28,731 | 32 | 1–22 |
| 2022 | 28,959 | 32 | 1–22 |
| 2023 | 28,927 | 32 | 1–22 |
| 2024 | 28,794 | 32 | 1–22 |

The model prefers the official weekly chart. If one is genuinely absent, it reconstructs a clearly
labeled position order from at most four snap rows strictly before the target week. It never calls
that fallback an official depth chart.

Primary public acquisition sources:

- nflverse draft, combine, depth chart, snap, player-stat, and play-by-play releases:
  <https://github.com/nflverse/nflverse-data>
- SportsDataverse/cfbfastR college play data for opponent-adjusted rookie evidence:
  <https://github.com/sportsdataverse/cfbfastR-cfb-data>

No betting-data API key is required. An Anthropic key is optional and only adds written analysis.
AI prose cannot create a numeric fact or bypass source verification.

## Important Run 7 caveat

Run 7's frozen manifest named the current production policy, which requires a validated calibration
advantage. The replay intentionally executed the older historical selector without that gate so old
decisions could be graded instead of disappearing as zero bets. Therefore:

- the 65–77 result is a valid diagnostic of the historical selector;
- it is not a valid test of today's calibration-gated publication policy;
- the code now names the diagnostic policy separately as
  `nfl-spread-historical-replay-v1` with `diagnostic_only` authority;
- no Run 7 result can grant production or staking authority.

Run 7 is immutable. The mismatch is documented instead of rewriting its manifest after seeing the
answer.

## What to build next

Do these in order. Do not add another giant model until these measurement holes are closed.

1. **Make one frozen team card per team/week.** Store the roster, player value, availability,
   coaching, tendencies, and evidence hash once. Every specialist and simulation must read the same
   card. This removes repeated work and prevents experts from quietly using different team stories.
2. **Backfill timestamped news evidence.** Acquire primary-source transaction and injury items with
   publication time, entity identity, exact evidence text, and verification state. Measure the
   forecast before and after the news and whether the market already moved. Generic headlines get
   no numeric authority.
3. **Build a real quote tape.** Capture multiple books at fixed times before kickoff, preserve line
   and price together, and calculate closing-line value. Without this, price shopping is a feature
   name rather than a tested model.
4. **Train the coordinator on residual value, not popularity.** Each specialist should predict the
   part the market and base model missed. Use leave-one-season-out and rolling-week evaluation. A
   specialist receives weight only when it improves unseen weeks in that circumstance.
5. **Repair the simulation.** Calibrate possessions, success rate, explosives, sacks, turnovers,
   penalties, red-zone conversion, and player opportunity separately. Then verify score shape,
   totals, spreads, and player usage—not only the average final score.
6. **Create the live ledger.** Freeze a pregame answer and an update after every possession with
   score, clock, field position, possession, injuries, and observed team strength. Grade probability
   calibration and change attribution after the game.
7. **Run a newly named audit, then wait for 2026.** Historical work can reject bad ideas. Only a
   preregistered forward shadow ledger with real quotes can support a profitability claim.

The likely path to improvement is not “more neural network.” It is better shared state, preserved
decision-time evidence, specialists trained to correct different mistakes, and honest forward
measurement. A 75% spread target is not credible. A durable result above the roughly 52.4% break-even
area at common pricing would already be exceptional and must be demonstrated rather than coded in.

## Install and run

### Easiest install from GitHub

1. Open <https://github.com/BouncySlime1215/gridiron-hq>.
2. Choose **Code → Download ZIP** and unzip it.
3. macOS: open `mac` and double-click `Install Gridiron HQ.command`.
4. Windows: open `windows` and double-click `Install Gridiron HQ.cmd`.
5. The installer checks Node 22.5+, installs packages, builds the UI, creates the local database,
   pulls public data, creates a Desktop launcher, starts localhost, verifies it, and opens a browser.

The operating-system warning for an unsigned downloaded script cannot safely be bypassed in code.
On macOS use **System Settings → Privacy & Security → Open Anyway**. On Windows use
**More info → Run anyway**. The project does not disable platform security.

### Command-line install

macOS/Linux:

```bash
git clone https://github.com/BouncySlime1215/gridiron-hq.git
cd gridiron-hq
./install.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/BouncySlime1215/gridiron-hq.git
cd gridiron-hq
powershell -ExecutionPolicy Bypass -File install.ps1
```

### Start, refresh, verify, and audit

```bash
npm start
npm run sync:data
npm run check
npm run audit:nfl -- protocol
npm run audit:nfl -- preregister
npm run audit:nfl -- run RUN_ID 70
```

The app opens at <http://localhost:5177>. `npm run check` runs typechecking, lint, all tests, a
production build, and an isolated startup smoke test. Never edit code or model-input data between
audit preregistration and the last opened week; the manifest will block the run.

## Current decision

Keep building the product and the measurement system. Do not present the betting layer as
profitable. Preserve the failed audit, close the three zero-coverage evidence loops, coordinate every
specialist through one frozen team state, and judge the next design on unseen weeks.
