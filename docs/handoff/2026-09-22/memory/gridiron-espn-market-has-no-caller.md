---
name: gridiron-espn-market-has-no-caller
description: server/services/espn-market.js is imported by nothing on Gridiron HQ's main, so espn_player_market has no live writer while feeding the Draft board at double weight — verified on 791b131, 2026-09-20.
metadata:
  type: project
  modified: 2026-09-20T02:45:00.000Z
---

Verified with `git grep` on **791b131**. Sibling cases (built, served, nothing
reads it): [[gridiron-server-surfaces-with-no-client-reader]].

**`server/services/espn-market.js` is not imported by anything on main.**
`syncEspnMarket` has zero callers — no route, no scheduler job, no script, no
dynamic import. The only occurrences of the string `espn-market` in the tree are
its own definition, two schema-manifest entries, a line in
`scripts/schema-files.txt`, a folder-map row, and a sentence in
`docs/FANTASY-ENGINE-MASTER-PLAN.md` proposing someone run it.
`espnMarketFreshness` likewise has none.

**Why it matters far beyond the module.** `espn_player_market` has exactly ONE
writer — the INSERT inside that uncalled function — and FIVE readers
(`routes/aggregates.js`, `consensus-weights.js`, `draft-assist.js`,
`manager-archetypes.js`, `preseason-model.js`). So **the table cannot be
refreshed by anything running on this deployment**: it is a frozen snapshot or
empty. And ESPN is weighted **2** against FFC 1 and Sleeper 1 on the Draft
board's consensus. The board's heaviest market input is a table nothing writes
to. PR #55 gates it on season, which is right either way; **wiring a caller is
the real fix and is in no PR.**

Consequence for the routed cookie finding (espn-market.js:19 reads espn_s2/swid
off the league row, :31 sends no Cookie header and fetches anonymously): correct,
but **unreachable**, so latent not live. Requirement recorded on #55's evidence
file for whoever wires the caller — credentials from
`platform/espn-credentials.js`, and fail rather than fetch anonymously.
