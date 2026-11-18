# arb — looking for money already on the table at Kalshi (2026-11-18)

One night's hunt, public data only, nothing placed. Five ideas, five dead ends, each
closed by evidence rather than by argument. Kept so nobody re-runs them blind.

| idea | test | result |
|---|---|---|
| Prices inside one event that contradict each other | whole open board, 170,942 active markets in 20,448 events (`scripts/pull_board.py`); mutually exclusive events: buy NO on every outcome | 31 events had YES bids summing over $1; after the taker fee, none did |
| Two versions of one prop that must be ordered ("protected" pays at least what the regular one pays) | 2,247 matched pairs, same player, game and strike | the regular bid exceeded the protected ask once, by nothing after fees |
| Markets already decided but still open (Christie's sale of 17 Nov, results public) | board quotes against published prices | winners already bid 99c and offered at $1.00; what is left at 99c carries a real question (hammer price or price with fees) |
| Minimum-price orders on empty sides of rewarded markets (`../house/house/stub.py`) | reward by Kalshi's formula on five full book snapshots, then the public trades in those markets | sides facing 97c or more are empty because such orders are bought out within the hour by takers of the near-certain side (KXEOWEEK-26NOV21-4, 03:01:36 UTC: 12,050 contracts at 2c and 2,001 at 1c taken in one second, and a re-posted 1,000 taken 47 minutes later) |
| Outbidding a large minimum-price order by one tick | same snapshots | it shuts the larger order out, and the larger trader answers: 254 such shut-outs in nine hours, and 79% of the outbid orders had moved by the next pass |

Also found: the `ODDS_API_KEY` in the cloud environment is deactivated at the provider
("cancelation or a failed payment"), so nothing here could be checked against sportsbook prices.

What the reward data does say, for the record: about $3.3M sits in bids of 2c or less on
1,078 rewarded sides and those sides are paid about $9,600 a day, 0.3% a day before
losses when a side dies. That is an automated, contested business, not loose change.

`data/` is gitignored. `data/series_all.json` (fees by series) and `data/board/` are
re-creatable with the script.
