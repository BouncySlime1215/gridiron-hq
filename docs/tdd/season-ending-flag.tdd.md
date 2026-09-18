# TDD evidence — season-ending / released news flag (2026-09-18)

**Module:** `server/services/player-availability.js` (`newsSeverityFor`, `seasonEndingEspnIds`, `espnStatusById`); consumer `server/routes/teams.js`.
**Why:** the flag sets `available=false`, which removes a player from every lineup and zeroes his rest-of-season value. It was a story-level co-occurrence test, and on the live 2026 week-2 feed it told Nick to drop Patrick Mahomes in two leagues and left his league-2 QB slot empty.

## User journeys
- As a manager, I want a player flagged out for the season only when the news says **he** is, so the waiver board never tells me to cut a healthy starter.
- As a manager, I want multi-week IR treated as multi-week, so an injured starter keeps his rest-of-season value.
- As a manager, I want ESPN's fresher status to win over a stale or misattributed story.

## RED → GREEN
| Stage | Commit | Evidence |
|---|---|---|
| RED | `c4e38c4` | 7 new tests from real false positives fail on the old code (pass 3 / fail 7). One test first passed for the wrong reason ("Tyler Loop's" possessive does not normalise to his name) and was reworded before the checkpoint. |
| RED 2 | (in GREEN commit) | "is also releasing punter Mitch Wishnowsky" — a real release the first fix missed (fail 1). |
| RED 3 | (in GREEN commit) | "after waiving Joe Milton III ... to make room for free agent RB Emari Demercado" — Demercado is the signing (fail 1); also exposed a slice bug where a verb directly before the name never matched. |
| GREEN | this commit | 15 / 15 pass. Coverage of the module: lines 100%, branches 87.0%, functions 100%. |

## Real-data check (production news, 45-day window)
Old rule flagged 77 rostered players, new rule 71.

- **No longer flagged (all verified):** Patrick Mahomes and Kenneth Walker III (return from a past torn ACL / same sentence), Tyler Loop (named after another kicker's cut), De'Zhaun Stribling (10 weeks; teammate ruled out), Zach Charbonnet (PUP; a release in the next sentence), Tank Dell, Jordan Mason, Drake Jackson (IR, multi-week).
- **Newly flagged (both real):** Jaydon Blue ("Cowboys are waiving running back Jaydon Blue"), Joe Milton III ("after waiving Joe Milton III").
- **All 71 remaining flags read by hand:** every one is a genuine release or a season-ending injury.

## Other files run
`legacy-route-security` 5/5, `seed-idempotence` 6/6, `fantasy-workflows` 7/7, `decision-inbox` 17/17.

## Known limits
- A player released and then signed elsewhere stays flagged for 45 days unless he is on a synced fantasy roster, where ESPN's NFL team overrides it.
- Attribution is by clause and word order, not by parsing; a sentence built as "X, who replaced the released Y, ..." can still mislead it.
