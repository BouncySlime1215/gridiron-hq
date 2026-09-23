# Live gameday inactives: Bluesky Jetstream monitor feeding the Start/Sit warnings (RL-3-2, SS-01)

Unit RL-3-2 (plan item SS-01 dead-starter guard; also ST-01, SK-01, WV-02).
Base: `origin/main` `131a7ba0`. Branch `claude/local-rl-3-2-live-inactives-source`.
Research package: `~/gridiron-local/rnd/loop/r3-external-live-inactives-bluesky.md` (local, not in the repo).

## 1. Terms, quoted before anything was measured

Copies fetched 2026-09-23 by the research lane, in `~/gridiron-local/rnd/loop/data/terms/`
(not in the repo). Checked again for this unit before any post was parsed.

- Jetstream docs (`bsky_jetstream.txt`), one quote: "No authentication is required for the live tail; these instances serve the full network."
  The same page documents the server-side `dids` filter, the `cursor` replay
  (unix microseconds accepted for the live tail) and at-least-once delivery ("Key
  on each record's at:// URI"). This unit keys on that URI.
- Bluesky Developer Guidelines (`bsky_developer_guidelines_2026-09-23.txt`): the
  restrictions are on spam, which the page defines as automated or bulk
  *interactions* (messages, follows, likes, replies). This unit only reads. It
  never posts, follows or likes, and it has no account.
  The same page says every service must be able to delete content a user asked to
  have deleted. The monitor handles that: a Jetstream `delete` for a post it
  recorded marks that claim `retracted_at`, and the reader drops it. No row is
  deleted (house rule 12).
- Bluesky ToS (`bsky_tos_2026-09-23.txt`): a grep for scrape, crawl and automated
  finds only the moderation clause (Bluesky's own automated moderation). Nothing
  restricts read-only consumption.
- **Cost: none. No account, no key, no paid call.**
- **Content rule:** the posts are third-party text (NBC/Rotoworld, reporters).
  The table stores only claim fields: player, status, time, source handle and
  `at://` URI. The page links out. No post text is stored or republished, which
  is the house rule already used for ESPN news.

## 2. Audit: what exists for this surface, and extend or build

Commands run on `131a7ba0` in this worktree.

- `git grep -n -i -E "bsky|bluesky|jetstream|atproto|live-inactive|availability_claims|gameday inactive|inactives" -- server scripts`
  found 4 lines, none of them a live source:
  - `server/services/nfl-event-archive.js:191` stamps the nflverse weekly roster
    as `source: 'nflverse_weekly_rosters'`. That file is published after the week,
    so it only serves backtests.
  - `server/news/twitter-ingest.js:56`, a comment on the paid tweet path
    (Nick-only, not used).
  - `server/services/nfl-t60-packet.js:65` `AVAILABILITY_CLAIMS` is a set of
    data-provenance labels, not player claims.
  - `scripts/model-lab/questionable_dialect.py:210`, a comment.
- The Start/Sit warnings are `lineupCall().warnings` in
  `server/services/lineup-brain.js:728` (the `risky` filter is at `:655`). They
  are served by `GET /api/trades/:leagueId/lineup` (`server/routes/trades.js:215-221`)
  and rendered by `client/src/pages/Lineup.tsx:197-207` as "Check before
  kickoff". Today a warning comes from only two things: `active_probability < 0.75`
  (injury report plus availability model) or a bye. A starter who was Questionable
  on Friday and is declared inactive at T-90 gets no warning.
- Other news-claim stores, and why a new store was chosen instead of extending one:
  - `nfl_news_events` (migration `019`, written by
    `server/services/nfl-news-events.js:109` `insertEvent`) has
    `source_kind CHECK(source_kind IN ('news_item','press_conference'))`. Adding
    a third kind would mean rebuilding the table, which is a destructive
    migration. The table also stores `claim_text` and `evidence_span`, which is
    post text we must not keep.
  - `beat_reporter_claim_resolutions` (migration `063`) scores claims after the
    game. It is not a live source.
  - `player-availability.js` handles season-ending or released news. Its
    `textMentionsFullName` (`:99`) and `player-identity.js` `normalizePlayerName`
    (`:27`) are **reused** for name matching here, not copied.
- **Decision: build.** New producer `server/services/live-inactive-monitor.js`
  writes a new table `live_inactive_claims` through an additive migration,
  `server/migrations/071_live_inactive_claims.js` (**named here as this unit's
  one migration**). The reader lives in `lineup-brain.js` `lineupCall` warnings,
  which reaches the route and page above.
- **One number, one producer:** this is the only in-week source of "declared
  inactive for this game". The concepts next to it keep their own producers and
  are not recomputed here:
  - `active_probability` (contingency and availability fit);
  - ESPN `injuryStatus` (`irOnRoster`);
  - nflverse `INA` (post-week truth).
  The warning does not change `active_probability` or any projection. It only
  flags the starter.

## 3. Pre-registration (committed before any number was run)

This unit is not a model number. It reports a named public source's statement with
its time and link. Its parser can still attribute a claim to the wrong player, so
the default for the warning is decided by a rule written here first.

- **Hypothesis:** H1. The sentence-level parser, run over the curated
  accounts' stored 2026 W1-W2 posts, records a pre-kickoff "inactive" claim for
  the fantasy-relevant players who did not play. It records none for players who
  did play.
- **Data:** the research lane's stored posts
  (`rnd/loop/data/r3x/bsky_posts_v2.jsonl`, 7,141 posts, 22 accounts) and its 47
  events (`r3x_bsky_leadtime_events.json`: 38 did not play, 9 played; truth is
  nflverse `INA` and 0 snaps). **In-sample:** the research lane picked the
  accounts and designed the regex on these weeks, and this parser was written
  after reading some of the posts. 2025 is not opened.
- **Rule:** a claim counts for an event when it was posted within 5 days before
  kickoff and at or before kickoff. The player's latest claim wins, the same rule
  the reader uses.
- **Metrics:**
  - recall, split by Friday designation (Out / Doubtful / Questionable-or-none);
  - false flags, meaning a latest pre-kickoff inactive claim on a player who
    played;
  - the research package's raw regex as the comparison (23 of 38, 10
    wrong-direction claims);
  - the ESPN feed the app already has (9 of 38).
- **Baseline (the dumb one, what the app does today):** no live warning, so 0
  catches in the Questionable-or-none slice.
- **Sign convention:** recall and false flags are counts. Higher recall is
  better. Fewer false flags is better.
- **Ship rule for the warning's default:**
  - ON only if false flags = 0 of 9 played **and** recall ≥ 9 of 38 (the ESPN
    feed already in the app);
  - otherwise it ships default-off behind `LIVE_INACTIVE_WARNINGS=1`.
  - Either way it is labelled **"unconfirmed forward"** until the package's
    forward test runs. That test is W3-W5 kill-or-confirm against a T-75 ESPN
    league sync: pass means arm 3 catches ≥ 2 of 3 of the Questionable-or-none
    slice that arm 2 misses, with 0 false flags on Nick's starters.
  - The listener and the table ship ON regardless, because the forward test
    needs them recording.
- **Power:**
  - 9 played players. A result of 0 false flags still has a 95% upper bound of
    about 3/9 = 33% by the rule of three (Hanley & Lippman-Hand 1983, *JAMA*
    249:1743), so it cannot certify a low false-flag rate.
  - 38 non-players. Recall is estimated to about ±16 points (95%, binomial) at
    p = 0.5.
  - This run can catch a broken parser. It cannot fine-tune one.
- **Literature:**
  - Detecting events from social-media streams, with named-entity matching,
    trades recall for precision mainly on entity disambiguation (Atefeh & Khreich
    2015, *Computational Intelligence* 31:132). That is why the parser matches
    only full names against the player table, with a team hint, and refuses an
    ambiguous name.
  - Sakaki, Okazaki & Matsuo (2010, WWW, "Earthquake shakes Twitter users")
    treated posts as sensors that can report an event before official channels.
    That is the lead-time premise here.
  - The account filter (about 30 DIDs rather than keyword search) is this
    package's own precision choice. It is not a literature result.

## 4. RED

`191db862` test: RL-3-2 RED - a starter in a live pre-kickoff inactive post gets no Start/Sit warning.

The run used `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp) node --experimental-test-module-mocks --test --test-reporter=tap test/<file>`.

- `test/lineup-live-inactive-warning.test.js`, 0 of 2 pass. The failing assertions:
  - `not ok 1 - a starter in a pre-kickoff inactive post is flagged before kickoff`, with
    `error: 'no warning for the inactive starter; warnings = []'`. The fixture starter
    is Questionable at 0.85 to play and has a pre-kickoff inactive post. Today he
    gets no warning at all.
  - `not ok 2 ...`, with `error: 'known-nonzero control: the inactive claim alone flags him'`.
- `test/live-inactive-monitor.test.js` fails with
  `ERR_MODULE_NOT_FOUND ... server/services/live-inactive-monitor.js`. The module
  does not exist yet.
- **RED re-run after the last assertion change:** the final test files were
  copied into a scratch worktree at `origin/main` `131a7ba0`. They failed with
  the same two assertions and the same missing module. The worktree was removed
  afterwards.

## 5. GREEN

`b1c0654e` feat: live gameday inactives from public Bluesky posts flag Start/Sit starters before kickoff (RL-3-2).

| Test file (same command) | Result on `b1c0654e` |
|---|---|
| `live-inactive-monitor` | 7/7 pass (6 at the commit, plus the M4 test in the evidence commit) |
| `lineup-live-inactive-warning` | 2/2 |
| `availability-honest-degradation` | 8/8 |
| `decision-leftovers-lineup` | 10/10 |
| `lineup-floor-objective` | 3/3 |
| `start-sit-decision-curve` | 12/12 |
| `main-thread-only-holds` | 9/9 |
| `boot-path-off-thread` | 7/7 |
| `abandoned-run-backoff` | 10/10 |

`node scripts/wiring-map.mjs --check` exited 0 with "no missing-feed findings". The
full guard (`npm run check`) is left to the Gate phase.

## 6. What it does

- **Producer.** `server/services/live-inactive-monitor.js`:
  - Writer `recordClaim` into table `live_inactive_claims` (migration
    `071_live_inactive_claims.js`, additive, **the unit's one migration**).
  - Entry point `ingestJetstreamEvent`.
  - `pollJetstream` connects to `wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents`
    with `collections=app.bsky.feed.post`, `kinds=commit`, one `dids` parameter per
    watched account, and `cursor` set to now minus 30 minutes in unix µs. It
    ingests and closes once the stream has been idle for 4 s (hard limit 25 s).
- **Job.** `live_inactives` in `server/services/scheduler.js` JOBS: live tier,
  every 3 minutes, main thread. It stamps each claim with `tradeWeekContext()`,
  the same week context `lineupCall` reads.
- **Parser.**
  - Works clause by clause. A clause break is a line, a semicolon, or ", while /
    but / whereas / as is".
  - A clause with both an inactive word and an active word is refused.
  - "as is Y" inherits the previous clause's status.
  - Past-tense clauses and "last week" clauses are dropped.
  - "is out" only counts when a game word or the end of the clause follows it.
  - The verb binds to the names before it; the names after it count only when
    none come before.
- **Names.**
  - Full names only, matched against `players` (QB/RB/WR/TE/K with a team) using
    the shared `normalizePlayerName`.
  - Longest match first.
  - A name shared by several players needs a team nickname in the clause or the
    post; otherwise it is refused.
  - The link card's title and description are read too, because Rotoworld
    headlines carry only last names.
- **Reader.**
  - `liveInactiveClaims({season, week})` returns the latest un-retracted claim per
    player. A later "active" cancels an earlier "inactive".
  - `lineupCall` (`server/services/lineup-brain.js`) turns a flagged starter into
    one warning: `kind: 'live_inactive'`, with source handle, `source_url` (a
    bsky.app link), `reported_at`, `confirmation: 'unconfirmed forward'`, and an
    `issue` line.
  - The warning replaces that starter's probability or bye warning.
  - It reaches `GET /api/trades/:leagueId/lineup` and `Lineup.tsx` "Check before
    kickoff", which renders `issue`. Existing warnings now also carry
    `kind: 'availability' | 'bye'`.
- **Deletes.** A Jetstream delete sets `retracted_at`. No row is ever deleted.

## 7. The numbers

### 7a. Replay over stored posts

Script `docs/evidence/live-inactive-replay.mjs`. The player index for window A is
`players` in a **local copy, not production** (`.local-db/data.sqlite`, a
`.backup` of `~/gridiron-local/data.sqlite`, taken 2026-09-23). Window B's truth
is `data/line-history/nflverse.sqlite`, opened read-only.

Command:

```
GRIDIRON_DB_INTEGRITY_CHECK=off SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite \
  node docs/evidence/live-inactive-replay.mjs <rnd>/r3x/bsky_posts_v2.jsonl <rnd>/r3x/r3x_bsky_leadtime_events.json \
  <clone>/data/line-history/nflverse.sqlite
```

Final run on `b1c0654e`, watched accounts only (production reads only those).
The output was byte-identical to the pre-commit run on the same parser.

| Window | Did not play, flagged inactive before kickoff | Friday Out | Friday Doubtful | Friday Questionable | Friday none | Played, false flags |
|---|---|---|---|---|---|---|
| A. 2026 W1-W2 (in-sample) | **20 of 38** (95% Wilson 37-68%) | 10/20 | 3/7 | **7/11** | 0/0 | **0 of 9** (upper bound 30%) |
| B. 2024 W11-17 | **19 of 64** (20-42%) | 10/32 | 0/6 | **9/21** | 0/5 | **0 of 945** (upper bound 0.4%) |

- **Wrong-direction "active" as the latest claim on a non-player:** A 0, B 2.
  These suppress a warning. They never raise a false one.
- **Catches by source:**
  - A: rotoworld-fb 18, kfishbain 1, rapsheet 1.
  - B: rapsheet 13, demetrius 3, tashanreed 1, bengoessling 1, salmaiorana 1.
  - The stored B window has no rotoworld-fb catches.
- **Unmatched:** A has one event name missing from the player index (Audric
  Estimé), so it cannot match. B excluded 165 player-weeks as unknown: no stats
  row and not INA, or no kickoff found.
- **The first run, before two parser fixes, used all 25 stored accounts** (6
  accounts are not in the watched list):
  - A: 20/38 caught, 0/9 false flags.
  - B: 20/64 caught, **3/945 false flags**:
    - "Kirk Cousins is out on the field early" (watched account);
    - "With Tank Bigsby ruled out ... up to Travis Etienne" (watched account);
    - "Injury report is out and ... Darnell Mooney" (an unwatched team account).
- **Fixes after the first run:**
  - the "is out" lookahead;
  - verb binding to the names before the verb.
  - Both are pinned by tests (mutants M5 and M8 die).
  - They cost one B catch (20 to 19). **B is therefore partly in-sample for those
    two rules.**

### 7b. Pre-registered ship rule (section 3)

- **Result: passes.** Window A has 0 false flags of 9 and recall 20/38, which is
  above the ESPN feed's 9/38.
- The warning therefore ships **ON**, labelled `confirmation: 'unconfirmed
  forward'`, until the W3-W5 forward test runs.
- **Research package comparison (package numbers, not re-run here):**
  - Its raw regex: 23/38 with 10 wrong-direction claims.
  - This parser: 20/38 with 0.
  - It trades 3 catches for the false flags.

### 7c. Decision grade (rule d)

- **Dumb baseline:** start the highest projection with no live flag. That
  catches 0 of these players, the same as the app on `131a7ba0`.
- **With the warning:** every flag raised in either window was a player who did
  not play. That is 20 + 19 = **39 of 39**; the 95% lower bound is about 92% by
  the rule of three.
- A swap away from a flagged starter therefore never scored worse than keeping
  him, since he scored 0 and the bench player scores at least 0.
- **Points avoided:** not computed. The stored events are fantasy-relevant
  players, not a league's actual starters. The W3-W5 forward test measures that
  on Nick's leagues (package section 5).
- MAE does not apply, because this is a binary flag and not a projection.

### 7d. Historical, not one week (rule e)

- There are two seasons of posts: 2026 W1-W2 and 2024 W11-17. Weeks were
  replayed as of kickoff, counting only claims posted in the 5 days before.
- No earlier archive exists locally. Jetstream's Network Replay needs
  authenticated HTTP calls, which this unit does not make.
- The real baselines a user has are the Friday report (the rows above, split by
  designation) and ESPN `injuryStatus` at T-75 (the forward test's arm 2, not
  yet measurable). The HX-01 harness is not used, because this is not a
  projection.

### 7e. Live endpoint, known-nonzero

- The monitor connected to the real Jetstream endpoint from a temp DB on
  2026-09-23 09:18Z. Results, as `pollJetstream` returned them:
  - 180-minute lookback: `{"events":1,"errors":0,"ended":"idle"}`;
  - 720-minute lookback: `{"events":17,"errors":0,"ended":"idle"}`.
- Recorded was 0 in both, as expected: the temp DB has no players, and it was
  Wednesday with no inactive posts.
- So the URL, filter, cursor and subprotocol work against the live service.

### 7f. Mutation sweep (on the tests at `b1c0654e`, plus the M4 test)

| Mutant | Result |
|---|---|
| M1 reader: first claim wins instead of latest | KILLED (both files) |
| M2 call site: `deadStarters = []` | KILLED (lineup 2 fails) |
| M3 call site: `risky` no longer excludes flagged starters | **SURVIVED, designed.** "One warning per starter" is pinned only for a starter who is not already risky (0.85 to play). A flagged starter below 0.75 would get two warnings. Documented, not pinned. |
| M4 parser: past-tense guard off | SURVIVED on first sweep → test added → KILLED |
| M5 verb binding: whole clause | KILLED |
| M6 delete not honoured | KILLED |
| M7 watched-account filter off | KILLED |
| M8 "is out" lookahead off | KILLED |
| M9 shared name: first candidate guessed | KILLED |
| C0 not-applied control (pattern absent, `applied=False`) | passes, as a no-op must |

## 8. Holdout looks

**None.** 2025 was not opened (the replay reads 2024 W11-17 and 2026 W1-W2
only), so nothing was appended to `docs/evidence/HOLDOUT-LEDGER.md`.

## 9. Known defects

1. **Coverage is about half at best:** A 20/38 and B 19/64. B's Friday Doubtful
   slice is 0/6. So no warning does **not** mean the player is active.
2. **Lookback gap.** If the scheduler is down longer than the 30-minute lookback,
   posts in the gap are lost, because the cursor is not persisted.
3. **No source-trust gating yet.** All 19 watched accounts count equally.
   `beat-reporter-accuracy.js` `sourceTrustScore` keys on X handles and has no
   Bluesky rows. Follow-up: score Bluesky handles there and gate on it.
4. **The page shows the `issue` text but not the link.** `source_url` is in the
   API response only. Follow-up: a one-line link in `Lineup.tsx` (owner's file).
5. **Flag only.** It does not auto-bench, and it does not feed the
   `lineup-posture.js` dead-starter guard (SS-01 proper, not built yet). SK-01
   and WV-02 do not read it yet.
6. **Name matching is only as good as the player table.** A player missing from
   `players`, or without a `team_id`, cannot match (Estimé in window A). A stale
   team only matters when a shared name needs a tie-break.
7. **In-sample.** Window A was used to design the package, and B shaped two
   parser rules. The honest out-of-sample number is B's first run (3/945 false
   flags across all accounts, 2 from watched ones). The forward W3-W5 test is
   what confirms it.
8. **File ownership.** `scheduler.js` and `lineup-brain.js` are shared files. The
   edits are additive (one JOBS entry; one filter plus warnings in `lineupCall`).
   A coordinator grant should be confirmed at merge (rule 9).

## 10. Nick's five questions

1. **Well built?**
   - One producer, one table, one reader, one job. Parameterised SQL. No bare
     catch. No post text stored. Deletes are honoured as retractions.
   - An additive migration, named: `071_live_inactive_claims`.
   - 9 test files green; the mutation sweep kills 8 of 9 mutants, and the
     survivor is designed.
2. **Stats or made up?** Stats:
   - 20/38 and 19/64 caught;
   - 0/9 and 0/945 false flags;
   - every number comes from the replay command above, on stored real posts and
     nflverse truth.
   - The raw-regex comparison (23/38, 10 wrong-direction) is the research
     package's number and was not re-run.
3. **How do we know?**
   - RED fails on the exact missing warning.
   - GREEN passes.
   - The live endpoint returned events.
   - Two seasons were replayed, as of kickoff.
   - Forward confirmation (W3-W5 against a T-75 ESPN sync) has **not** run, hence
     "unconfirmed forward".
4. **Pointed elsewhere?** No:
   - it is the only in-week inactive source (audit in section 2);
   - nflverse `INA` stays the post-week truth;
   - `active_probability` is untouched.
5. **How does it unify?**
   - Writer and reader use the same week context (`tradeWeekContext`).
   - Names go through the shared `normalizePlayerName`.
   - The warning sits in the existing "Check before kickoff" list, one per
     starter.
   - Nav is still 8 tabs.
