# Live (in-game) betting: is it feasible, and what would it take?

**Question asked:** could Gridiron HQ beat the market by betting NFL games *live*, while they're being played, instead of only pregame? This is an investigation, not a build — nothing described here is implemented.

## Short answer

Not with anything in this codebase today, and not as a fully automated system in the near term. A live-signal *alert* tool (flag a moment, you place the bet by hand) is realistic and could be built in stages. Full automated in-play betting is a different, much harder engineering problem than anything Gridiron HQ has attempted so far, and the honest constraint isn't modeling — it's **speed**, and this app has none of the infrastructure speed requires.

## What "live betting" actually requires

Four things have to all be fast and all be true at once:

1. **A live game-state feed** — score, quarter, clock, down/distance, possession — updating within a few seconds of each play.
2. **A live odds feed** — in-play lines move every play (sometimes every few seconds after a big gain or turnover) and go stale almost immediately.
3. **A model that outputs a probability *per play state***, not per game. Pregame win-probability models take a small number of static inputs (ratings, injuries, weather). A live model's primary inputs are the game state itself — score differential, time remaining, field position, timeouts remaining, down/distance — which is a genuinely different, well-studied problem (this is exactly what nflfastR's own public win-probability model does; it does not reuse the pregame spread model at all).
4. **Execution inside a window measured in seconds.** A live line is only good for as long as the book hasn't re-priced it — typically the gap between plays, roughly 25–40 seconds, often less after a scoring play. Miss that window and there's no bet, just an opinion.

Every one of these is a separate build. None of them currently exist in this repo.

## What Gridiron HQ actually has today (checked directly, not assumed)

| Requirement | Current state |
|---|---|
| Live game state | **Not polled.** `gamescript.js` calls ESPN's public scoreboard (`site.api.espn.com/.../scoreboard`), but only to pull the current pregame spread/total and final scores — it's called on the sync schedule, not polled during a live game. ESPN's scoreboard *does* carry live score/clock/down-distance when hit during a game, so this is a plausible feed to build on — but nothing today reads those fields. |
| Live odds | **Not integrated.** `odds-api.js` calls The Odds API's standard `/odds` endpoint with a 3-hour cache TTL — built for "check the pregame line a few times a day," not live pricing. The Odds API does sell a separate in-play product with per-minute-or-faster refresh, but it's a different endpoint, different rate limits, and materially more expensive; nothing here calls it. |
| Play-by-play data | **Batch, not real-time.** `nfl-pbp.js` pulls one CSV per season from nflverse's GitHub release (`play_by_play_{season}.csv.gz`), refreshed on a release cadence that lags actual games — this is the historical dataset the whole pregame ensemble trains on, and it is structurally incapable of describing a game still being played. |
| Model latency | **13–37 seconds cold**, measured live against this app's own `/nfl-market/picks/candidates` endpoint this session. That's the pregame ensemble scoring 16 games once. A live model would need to answer in a fraction of a second, repeatedly, all game — the current architecture (an in-process JS ensemble computing fresh every request, no persistent model server, no incremental state) was never built for that cadence. |
| Push/streaming infra | **None.** `scheduler.js` is a poll-on-interval job registry (`runIfStale`, `maxAgeMinutes`) — everything in this app is "check every N minutes," not "react within a second." There is no websocket server, no event stream, nothing that pushes state changes to a running process. |
| Validated probability model | **Not proven even pregame.** The cover-calibration gate (`nfl-cover-calibration.js`) was actually run for the first time this session — walk-forward calibration slope came back 0.33 against a target range of 0.7–1.3, and the calibrated Brier score is worse than just using the market's own implied probability. The pregame model does not yet have a validated probability output. A live model needs the *same* kind of walk-forward-calibrated validation, just against in-game states instead of pregame ones — and that foundation isn't built for pregame yet, let alone in-game.

## Why this is harder than it looks, not just "the same model, faster"

- **The model itself has to be different.** Score differential and time remaining dominate everything once a game starts; a pregame spread stops mattering by the third quarter of a blowout. This isn't a matter of running the existing ensemble more often — it's a new model with new inputs, new training data structure (situational states extracted from play-by-play, not one row per game), and its own calibration/backtest discipline.
- **Backtesting is much harder to do honestly.** A pregame walk-forward test has ~272 games a season. An in-game model has tens of thousands of play-states per season, but they're highly autocorrelated within a single drive/game — a naive backtest that doesn't account for that will look artificially good, the same class of mistake this project already caught once with the interception-rate bug (biased estimator that passed a naive check).
- **Live odds data costs real money at a different order of magnitude.** In-play odds products are priced for the update frequency they promise, not the flat "check it a few times a day" tier this app currently pays for.
- **Retail sportsbooks generally don't offer trade-execution APIs.** Even with a perfect live model and a perfect live odds feed, placing the bet fast enough is a manual click on a sportsbook's own app/site in the vast majority of cases — full automation would mean either a book with an execution API (rare, usually exchange-style products, not standard retail books) or accepting that a human is the last, slowest link in the chain regardless of how fast the model is.

## What a realistic path looks like, in stages

This is the order that actually derisks the project — each stage is independently useful and none require the next one to already exist:

1. **Live state feed only, no model.** Poll ESPN's scoreboard during live windows (every 10–15s is plenty to start) and store live game state. Zero betting logic — just prove the pipe works and the data is clean.
2. **A standalone in-game win-probability model, backtested like everything else in this project.** Train against nflverse's historical play-by-play (already synced) with situational state as the feature set. Hold out full games/seasons, not random plays, to avoid the autocorrelation trap above. This can and should be walk-forward validated exactly like `nfl-cover-calibration.js` already does for pregame — same discipline, same honesty about whether it passes.
3. **A live *odds* feed**, only once (1) and (2) prove out — no point paying for in-play pricing before there's a model to compare it against.
4. **A "live signal" alert, not an auto-bet.** Once the model and a live odds source both exist, the first real product is: flag when the model and the live line disagree by more than some threshold, and let a person place the bet manually. This sidesteps the execution-speed problem entirely and is honestly the ceiling of what's realistic without a sportsbook execution API.
5. **Automation** is a separate, later decision — and mostly a business/access question (does a usable execution API exist for the books actually being used), not a modeling one.

## Bottom line

The gap between "we have a pregame model" and "we can bet live" isn't a tuning problem — every layer (data feed, odds feed, model class, backtest method, and infrastructure cadence) has to be rebuilt for a completely different time scale. Stage 1–2 above (live state polling + a properly backtested in-game win-probability model) is a legitimate, scoped project on its own, useful even before any betting logic touches it, and is the recommended starting point if this gets picked up.
