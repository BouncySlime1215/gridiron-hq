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

(filled after the RED commit)

## 5. GREEN

(filled after the GREEN commit)
