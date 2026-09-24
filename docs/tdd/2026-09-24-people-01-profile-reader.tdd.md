# TDD evidence: PEOPLE-01, one reader for the chat psychology

**What this is.** Spec: `docs/handoff/local/PEOPLE-WIRING.md` (handoff branch).
Before this change, three server files each read the private chat DB's people
tables themselves:

| file | table | now reads through |
|---|---|---|
| `server/services/counterparty-pricing.js` | `negotiation_profiles` (parse, validate, map) | `negotiationProfileEntries`, `negotiationProfilesStamp` |
| `server/services/manager-signals.js` | `manager_chat_profile` ×3, `manager_player_sentiment` | `chatStyleRow`, `chatStyleNames`, `chatStyleStamp`, `playerSentimentRows` |
| `server/services/coach/people/variables.js` | `manager_chat_profile` | `chatStyleRow(…, { missing: 'null' })` |

`server/services/people/profile-reader.js` is now the only file that reads them.
It also adds `readPeopleProfiles(leagueId)`: the typed profile for each roster
(every original key, plus `deal_feelings`, `values_talk`, `behaviour_vs_words`,
`changes_since_0918`, then `as_of`, `messages_read`, `version`, `source`, a
typed `unknown` for thin chat, and `nick_override` > `manager_notes` > model).

## The guarded rules

| # | Rule | Test |
|---|------|------|
| P1 | The three consumers serve byte-identical output on main's data shape | `people-profile-parity` 1 |
| P2 | The golden file is not vacuous: attach, self, invalid and unmapped cases are all in it | `people-profile-parity` 2 |
| P3 | One typed profile per trusted roster; Nick is `self`; a `likely` identity attaches nothing | `people-profile-reader` 1 |
| P4 | A known profile carries as_of, messages_read, version, row_version, source and every new key | `people-profile-reader` 2 |
| P5 | nick_override beats manager_notes beats the model read, per field, with the winner named | `people-profile-reader` 3 |
| P6 | Under 30 messages read, every field is `unknown(reason)`, never neutral | `people-profile-reader` 4 |
| P7 | entity_map attaches a profile stored under an alias | `people-profile-reader` 5 |
| P8 | On main's shape the new keys are `unknown`; an invalid profile makes an unknown person | `people-profile-reader` 6 |
| P9 | No chat DB and no trusted identity are different absences | `people-profile-reader` 7 |
| P10 | A `manager_notes` table of an unknown shape is reported `unrecognised`, not guessed at | `people-profile-reader` 8 |
| P11 | A bad override key costs that key only, and is named in `warnings` | `people-profile-reader` 9 |
| P12 | Pricing serves the original keys only: new keys and nick_override never reach its payload | `people-profile-reader` 10 |
| P13 | Nothing outside the reader and a reasoned allowlist names the five tables; the allowlist only shrinks | `people-profile-reader-ratchet` 1-4 |
| P14 | The three consumers import the reader | `people-profile-reader-ratchet` 5 |

## RED, then GREEN

RED is commit `f60afbd`. The golden was written by the parity test itself
(`PEOPLE_GOLDEN_WRITE=1`) against main at `12a6de9`, before any consumer
changed, and both parity tests passed there. At RED:

- `people-profile-reader`: 0/1, `ERR_MODULE_NOT_FOUND` for `server/services/people/profile-reader.js`.
- `people-profile-reader-ratchet`: 2/5. Test 1 names the four direct reads:
  `coach/people/variables.js: manager_chat_profile`,
  `counterparty-pricing.js: negotiation_profiles`,
  `manager-signals.js: manager_chat_profile`, `manager-signals.js: manager_player_sentiment`.
  Tests 4 and 5 fail because the reader does not exist yet.
- `people-profile-parity`: 2/2 (it is the record of main).

GREEN is the next commit: `people-profile-reader` 10/10, ratchet 5/5, parity
2/2 with no change to the golden file.

## What changes on data this fixture does not have

These change what is served only once the rebuilt profiles land, and are named
here so nobody takes them for a regression:

1. **New keys no longer invalidate a profile.** Before, a profile carrying
   `deal_feelings` and the other new keys failed validation (`unexpected key`),
   so all ten rebuilt profiles would have dropped out of pricing. Now the new
   keys are split off before the original schema is checked.
2. **`nick_override` applies inside pricing.** An override on an original key
   replaces the model's value in `byRoster[...].profile`.
3. **A `manager_notes` row with a `field` column naming a text key replaces
   the model's text.** Notes without a field, or naming a structured key, are
   attached to the typed profile and do not touch pricing.
4. **entity_map aliases attach.** A profile stored under an alias with
   `in_league` not 0 maps to the canonical person's roster.

## Not confirmed

`manager_notes` and `entity_map` have no schema in any migration or script on
main or the handoff branch. The reader finds their columns from a fixed list
of candidates and reports `unrecognised` (column names only) when none match.
The real columns need checking on the local chat DB.
