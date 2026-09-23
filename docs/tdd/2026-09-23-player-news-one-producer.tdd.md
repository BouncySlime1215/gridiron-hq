# RL-12-3: one news-attribution producer for the player card and the News page

Unit RL-12-3 (R&D round 12 internal package `r12-internal-player-card-news-ignores-resolved-players.md`).
Branch `claude/local-rl-12-3-player-card-news-attribution`, cut from origin/main `57a9ca1c`.
Not a statistical unit: no model number, no pre-registration, 2025 held-out season not opened
(no HOLDOUT-LEDGER row needed).

## Audit (before the first test): extend or build

Every producer of "which stories are about player X" on origin/main `57a9ca1c`
(`grep -rn 'entities_json\|newsFor' server client/src`):

| Producer | file:line | Rule | Readers |
|---|---|---|---|
| `newsFor(player)` | `server/routes/players.js:27-37` | substring `LIKE` of full name on headline/ai_analysis/fantasy_impact, or the last name token (so "Jr." for Pittman Jr.) when `n.team_id = player.team_id`; `ORDER BY n.date DESC LIMIT 10` (day-only) | `GET /players/:id` (`:82`) -> `PlayerCard.tsx:223` "Recent news", `PlayerDetail.tsx:103` "News mentioning {last}"; `POST /players/:id/analyze` (`:186` -> `:160`) AI Buy/Sell facts |
| News desk attribution | `server/routes/news.js:64-66` | `entities_json.players` (deduped by normalised name) | `GET /news/desk` -> `NewsHub.tsx:84` player links, "My Players" tab |
| entity readers | `nfl-news-events.js:132`, `nfl-player-state.js:38`, `nfl-news-signal.js` | `entities_json.players` | news signal / player state (model side, not a display list) |

Table and writers: `news_items.entities_json`, written by `upsertNormalizedNewsItem`
(`server/news/store.js:33`, via `extractEntities` `server/news/normalize.js:37`),
`insertArticles` (`server/routes/espn.js:197`) and `backfillNewsEntities` (`server/routes/espn.js:214`).

Two producers disagree on the same input (the R&D package measured 124/428 resolved stories missing
from the card and 35/369 card rows not resolved to the player). Decision: **build** one producer in
`server/news/player-news.js` (`attributeStory` for "which players is this story about", `playerNews`
for "which stories are about this player", the second defined by the first), and make both the card
(`/players/:id`, `/analyze`) and the News desk read it. The ingest resolver stays the writer; no
migration, no new column (read-time attribution only).

## RED / GREEN

- **RED** `c20bf02e` "test: RED player card and News page must list the same stories (RL-12-3)".
  `test/player-news-one-producer.test.js` on origin/main code: `# pass 0 # fail 4`. Failing assertions:
  - 1: `'resolved surname-only story missing from the card'` (expected true, actual false)
  - 2: `"Panthers' Brookhaven out weeks" missing from the card` (expected true, actual false)
  - 3: `assert.deepEqual(await cardIds(brook), [surgery, fullName, outWeeks])`, actual `[3]`, expected `[1, 3, 2]`
  - 4: contract, card `[3]` vs News desk `[1, 3]` for the same player
- **GREEN** `cf5d5563` "fix: one news-attribution producer for the player card and the News page (RL-12-3)": 4/4 pass.
- **GREEN refinement** `7d2cd432` "fix: reject first-name, speaker and team-word surname matches in news attribution (RL-12-3)":
  adds a fixture ("Jets waive TE Wexley Barnes" must not reach Javonte Wexley's card); 4/4 pass.
- **Test added** `7e27b27d` "test: pin the AI Buy/Sell evidence packet to the same player news (RL-12-3)":
  test 5 stubs the Anthropic client (`setAnthropicClientForTesting`, no network, no spend) and asserts that
  `POST /players/:id/analyze` puts the card's three stories, in the card's order, into the evidence packet.
- **RED re-run after the assertion changes**: the full 5-test file run against origin/main's `server/routes` and
  `client` (`git checkout origin/main -- server/routes client`, run, `git checkout HEAD -- server/routes client`)
  gives `# pass 0 # fail 5`. Test 5 fails on the deep-equal of the packet's news facts.

Command (each run): `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/player-news-one-producer.test.js`.
Neighbouring tests on `cf5d5563`, same command shape: news-ingest 20/20, nfl-expert-council-news-feed-cutoff 3/3,
legacy-route-security 6/6, table-read-but-never-created 11/11. `node scripts/wiring-map.mjs --check` exit 0.

## What it does

- New `server/news/player-news.js`: `attributeStory(story, index)` = the ingest's resolved ids
  (deduplicated by normalised name, preferring the one on the story's team) plus a surname rule: his family
  name with the generational suffix dropped ("Pittman Jr." -> "Pittman", never "Jr."), whole word, in a
  headline about his team (its `team_id`, or his team's name in the headline), unique on that team, not
  already resolved to a same-surname player, not preceded by another capitalised first name ("Quinnen
  Wexley"), not followed by a capitalised word or hyphen ("TE Hunter Long", "Coleman-Lyles"), not a
  "<Team>' <Name>:" speaker line, and not a family name that is itself a team word ("DeeJay Dallas").
  `playerNews(id, {limit=10})` = the stories whose `attributeStory` includes him, ordered
  `COALESCE(published_at, date) DESC, id DESC` (the News desk's order; was day-only `date`).
- Readers: `GET /players/:id` (`server/routes/players.js:69`) -> PlayerCard "Recent news", PlayerDetail
  "News about {name}" (was "News mentioning {last token}"); `POST /players/:id/analyze`
  (`players.js:173`) -> AI Buy/Sell facts; `GET /news/desk` (`server/routes/news.js:70`) player links and
  "My Players" tab. `newsFor` is deleted. No table, column or migration added.
- Dropped behaviour: the old matcher also searched `ai_analysis` / `fantasy_impact` (our own generated
  text). Attribution now reads reporting only (the resolver reads headline + body; the surname rule reads
  the headline).

## Numbers (local copy, not production; `.local-db/data.sqlite` backed up 2026-09-23 08:38 ET from `~/gridiron-local/data.sqlite`, tree `7d2cd432`)

Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$WT/.local-db/data.sqlite SAMPLE=40 node docs/tdd/2026-09-23-player-news-one-producer/measure.mjs $WT` (`SAMPLE` prints the surname-rule rows for the hand census; `SEED=11` on the refined tree)
(old side = `newsFor`'s SQL verbatim from origin/main `57a9ca1c`; "resolved" = the ingest's `entities_json` ids,
which is what the News page linked before this unit). Universe: 224 fantasy-relevant, non-historical players with
a team and at least one attributed story; 1,506 news rows.

| Measure | Before (`newsFor`) | After (`playerNews`) |
|---|---|---|
| Resolved top-10 stories missing from the card | 190 / 675 (28%) | 8 / 675 (1.2%) |
| Card rows not resolved to him | 70 / 586 (25 via the "Jr./III" token) | 40 / 707, all from the surname rule |
| Empty card while resolved stories exist | 19 | 0 |
| Players whose card and News page disagree (all stories, no limit) | nonzero (control: the 190 / 70 above) | 0 / 224 |

- The 8 remaining misses are all displacement: newer surname-rule stories push them past the card's 10-row
  limit (`docs/tdd/2026-09-23-player-news-one-producer/miss.mjs`: displaced 8, dropped 1). The 1 dropped story is resolved to two "Josh Johnson"
  ids; name dedup keeps the one on the story's team and drops the historical-phase namesake. That drop is correct.
- Surname-rule rows, hand-checked as a census (every row, not a sample):
  - The first rule version gave 46 rows, 6 wrong: two "Bears' Johnson:" coach quotes, "RB Coleman Bennett",
    "TE Hunter Long", "Rams' Stafford passes Rivers" (a retired QB) and "from Dallas".
  - The refined version gives 40 rows. 1 is wrong (the Rivers headline). 1 is uncertain ("Brown on injured
    reserve."). 38 are right.
  - Caveat: the refinement was tuned on those same 46 rows. So "1 wrong of 40" is an in-sample figure; W4
    stories are the out-of-sample check.
- Liveness (route, local copy): `docs/tdd/2026-09-23-player-news-one-producer/live.mjs` calls `GET /api/players/:id`.
  - Jonathon Brooks: the card now leads with "Sources: Panthers RB Brooks set for surgery, out at least 6
    weeks". The old SQL returned 2 rows without it.
  - Michael Pittman Jr.: the card now shows 3 Pittman stories. The old SQL returned 10 rows, 3 of its top 4
    about Joey Porter Jr.

## Mutation sweep (`python3 docs/tdd/2026-09-23-player-news-one-producer/mut.py` from the worktree root, tree `7e27b27d`, each mutant restored by `git checkout`, tree clean after)

| Mutant | Result |
|---|---|
| M1 card call site drops the newest row (`players.js`) | killed (tests 1, 3, 4) |
| M2 News desk call site back to raw entities (`news.js`) | killed (contract test 4) |
| M3 first-name preceder check disabled | killed (2) |
| M4 follower check disabled | killed (2) |
| M5 order by id instead of published_at | killed (3, 5) |
| M6 team named in the headline ignored | killed (2, 3, 5) |
| M7 resolved ids ignored | killed (3, 5) |
| M8 `/analyze` call site returns `[]` | killed (5). It survived on `7d2cd432`, before test 5 existed; test 5 was added to kill it |
| M9 designed survivor: team-word surname skip removed | survived as designed. No fixture player has a team-word surname; this rule is covered only by the local-copy census ("from Dallas") |
| M10 not-applied control (pattern absent) | applied=False, survived |

## Known defects

- A retired or non-fantasy player who shares a surname with a rostered player on the named team
  (the "Rivers" headline) can still attach. The index only knows fantasy-relevant players.
- The resolver's own namesake ambiguity is resolved only by name dedup preferring the story's team. When
  neither same-name player is on the story's team, the first-listed id keeps the story (the old desk kept
  the last-listed one), which can be the wrong player.
- The card cap stays at 10 rows, so a burst of surname-rule stories can displace older resolved ones
  (8 cases on the local copy).

## Holdout looks

None: the 2025 held-out season was not opened. This is not a model or start/sit number, so no decision
win rate or MDE applies.

## Nick's five questions

1. **Well built?** One producer (`attributeStory`) decides which players a story is about. The card is
   defined from it and the News desk reads it. Parameterised SQL. No migration. No bare catch: the malformed-JSON
   path returns an explicit empty entity set. The contract test fails if either side forks again (M2 killed).
2. **Stats or made up?** Every count above comes from the named command on the local copy at tree `7d2cd432`.
   The wrong-row counts are a hand census of every surname-rule row (46, then 40). They are not a sample.
3. **How we know:** RED 5/5 fail on origin/main code, then GREEN 5/5. 8 of 8 behaviour mutants killed (call sites included), plus the
   named survivors and the control. The route liveness shows the Brooks surgery story on his card.
4. **Pointed elsewhere?** Card, player page, AI Buy/Sell facts and the News desk now all use one rule.
   `nfl-news-events.js`, `nfl-player-state.js` and `nfl-news-signal.js` still read raw `entities_json` (model
   inputs, not display lists). Follow-up: decide whether they should read `attributeStory` (it adds
   surname-rule rows at confidence 0.6). Not changed here, because it would move model inputs.
5. **How it unifies:** "which stories are about player X" used to have two producers that disagreed on 190
   resolved stories and 70 shown rows. It now has one producer, with 0 of 224 players disagreeing.

- **Defect fixed:** `server/routes/players.js:27-37` `newsFor` on origin/main `57a9ca1c`, which used a substring
  LIKE, matched the last name token (including "Jr."), and ordered by the day-only date.
- **Incumbent, by command:** the `measure.mjs` "before" column, which runs `newsFor`'s SQL verbatim.
- **Not covered:**
  - the model-side readers of raw `entities_json` (question 4);
  - ingest-time resolution quality (the resolver still misses surname-only body mentions);
  - retired or non-fantasy namesakes.
- **What would make it wrong:** the W4-W5 stories show the surname rule's wrong-row rate above 2 of 40
  out of sample. If so, turn the surname rule off (resolved ids only) and keep the single producer.
