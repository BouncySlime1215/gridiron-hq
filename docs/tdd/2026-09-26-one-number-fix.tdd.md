# ONE-NUMBER-FIX: the two broken number_audit checks, one producer each

## weekly_range (league 2)

Every surface already read the one range producer (lineup-week-range.js), but over different
lineups. Week 3: a starter ESPN had locked played on Thursday (actual 35.3).
- The lineup posture held him in his slot and scored him 0, because his week projection was gone.
- The trade card, My team and the ceiling lineup benched him for a healthy back.

Result: 138.9 vs 123.6.

Fix:
- `settled-points.js` scores a starter whose game is final at ESPN's actual, inside the one range producer.
- `trade-engine.js#thisWeekLineup` is THE lineup fielded this week: locked starters held, locked bench out. The My team / trade card range, the ceiling lineup and the audit use it; the posture already applied that rule.

## title_odds_paths (league 5)

- With the one-world flag off, My team's `/simulate` ran its own unseeded `simulateSeason` beside the Title tab's world.
- The audit ran two simulations that no page served.

Fix: the twin, the TradeCard, the sense-check, the Title tab and the finder's horizon all read the league world. The audit reads exactly those producers.

## Tests

- `test/one-number-fix.test.js` covers settled points, the range with a settled starter, the lock-aware lineup, and a source guard on the title-odds producers.
- Seven legacy tests that pinned the flag-off producers now follow the one-world contract: b-01, rl-6-3, rl-19-2, trade-engine-correctness, scoring-call-sites, scoring-call-site-followups, serve-log.

## Red / green

- RED is the audit on a copy of the live DB before the fix: league 2 `weekly_range` broken.
- The second test shows the old totals: a finished starter counts 0.
- GREEN is the same audit after the fix: 0 broken in all 5 leagues. Numbers are in the PR.
