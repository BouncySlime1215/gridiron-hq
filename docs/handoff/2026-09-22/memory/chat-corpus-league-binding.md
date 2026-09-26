---
name: chat-corpus-league-binding
description: Uploading the league chat corpus attaches it to no league until PR #26 is deployed and Nick names who-is-who for league 3; the sync still exits 0 and looks successful.
metadata:
  type: project
  modified: 2026-09-19T19:45:00.000Z
---

**A successful `npm run chat:sync` does not mean the Trade Brain can see the
chat.** Verified 2026-09-19.

Which league owns a corpus is derived in `server/services/manager-signals.js`
from `league_member_identity` rows with `confidence = 'confirmed'` and a
`chat_name`. Only `refreshManagerData` writes those rows, and on the deployed
build that function has **no HTTP route and no scheduler job** — its only
caller is `scripts/build-manager-signals.mjs`, run by hand on a laptop, so it
has never run on the server. Every league therefore reads as chat-free, a
fresh upload attaches to nothing, and `chat:sync` still exits 0 and prints its
green success line. The only symptom is that nothing improves.

A name match cannot bootstrap it: someone posting as "MoonUnit" never matches
their ESPN name.

**PR #26** (`claude/project-thread-3xqh5l-signals-api`, based on #12) closes
it. Verified in the diff, not just its description:
- `refreshManagerData({ leagueIds, confirmations })`
- `const corpus = chatLeagues.has(lg.id) || seeded.has(lg.id)`
- seeded rows stored as `confirmed`, so later runs find the league themselves
- `POST /api/trades/managers/rebuild` (admin, `model:*`) taking
  `{"league_ids":[3],"confirmations":{"3":{"<roster_id>":"<chat name>"}}}`
- the hardcoded source label, which read "League chat (private, league 4)" and
  named the wrong league, is now "League chat (private)"

**The corpus belongs to Transfer portal = league 3**, whose name carries a
trailing space. League 4 is 'My 2025 League'. Verified against `/api/leagues`
on Fly. Nick must supply roster_id -> chat name for league 3 once; after that
it is self-sustaining.

Do not conflate two tables: `manager_chat_profile` in the corpus is
`GROUP BY name` (no league column), so its ~10 profiles are 10 *people*. The
per-league `manager_profiles` in the app DB is a different table, written by
`league-brain.js`, which the chat sync never touches.

**Run order on Nick's Mac, once #26 is deployed (not merely merged):**
1. `node scripts/build-negotiation-profiles.mjs` — a paid model pass that
   writes the `negotiation_profiles` table into the private chat DB. Verified
   2026-09-19 that the extractor's `--rollup` does NOT build this table (it
   builds only `manager_chat_profile` and `manager_player_sentiment`), so it
   must run *before* the upload or the corpus ships without it.
2. `npm run chat:sync` — uploads the corpus.
3. Seed the identities for league 3 via the rebuild route above.

`scripts/chat-sync.mjs` does not invoke step 1 itself, deliberately worth
revisiting: it is a paid model pass, so making it automatic is a decision, not
a cleanup.

See [[league-chat-sync-command]] and [[gridiron-live-data-state]].
