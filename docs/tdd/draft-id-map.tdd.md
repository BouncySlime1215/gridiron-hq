# DRAFT-ID-MAP: draft picks joined on the ESPN id

RED `2f7577c` · GREEN follows · `test/draft-id-map.test.js`, 13 cases.

## The defect

`league_draft_picks.player_id` is ESPN's id, not `players.id`. The ONE-PLAN
column sweep (section 4b, row 1) measured it on the live DB: 0 of 1,738 picks
join `players.id`, 1,738 of 1,738 join `players.espn_id`. Anything that reads
draft capital through `players.id` sees nothing, silently.

`server/services/manager-archetypes.js:655` already joins on `espn_id`, so the
archetype draft metrics are not changed here. What was missing is a reader the
War Room producer can use: draft capital per app player, owner-independent,
with the current owner taken from the producer's own roster.

## What the tests pin

- 170 of 170 fixture picks (10 rosters x 17 rounds, snake) join `players.espn_id`;
  the same picks through `players.id` join 0, measured in the same call.
- `overall_pick` stays with the player when he is traded or dropped; only
  `current_roster` moves (null when on no roster).
- `espn_id = 0` never joins (4b row 5: 2,884 placeholder rows would fan one
  pick out thousands of ways). A pick of id 0 is unjoined with a reason.
- An espn id on two `players` rows is unjoined as ambiguous, never guessed.
- Other leagues and seasons are not read; a missing table and a league-season
  with no picks each return their own status and reason instead of throwing
  or returning an empty `ok`.
- Flag `GRIDIRON_DRAFT_ID_MAP` is off unless `'1'`. Off, the plans entry has no
  `draft_id_map` key at all. On, only `_run.inputs.draft_id_map` (counts, no
  names) is added; every served field is deep-equal to the flag-off entry.

## RED

`ERR_MODULE_NOT_FOUND: server/services/campaign/draft-capital.js`: all 13 fail.

## GREEN

`server/services/campaign/draft-capital.js` (one reader), wired into
`scripts/campaign/league-adapter.mjs` (`adapter.draft`, flag-gated) and
`scripts/campaign/produce-plans.mjs` (`_run.inputs.draft_id_map`). 13 of 13 pass.

## Guard (review note 1, Batch B)

RED `eeaddf9` · GREEN follows · 4 new cases, 17 in all.

The adapter called `draftCapital` unguarded, so with the flag on any SQL error
there threw out of `buildAdapter` and took the whole league entry, served
plans included, down with a shadow read. `draftCapitalGuarded` catches it and
returns `status: 'error'` with the message and an empty `by_player`; the
producer writes that to `_run.inputs.draft_id_map`, so the error is recorded,
not swallowed, and the served fields stay deep-equal to flag off.

RED: `draftCapitalGuarded` is not exported (3 cases), and the adapter still
calls `draftCapital(` directly (1 case). GREEN: 17 of 17 pass.
