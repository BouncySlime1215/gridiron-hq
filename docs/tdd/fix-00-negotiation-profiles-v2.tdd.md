# TDD evidence: FIX-00 — negotiation profiles readable again (schema v2)

RED then GREEN, in that order, in `test/people-profile-reader.test.js`,
`server/services/people/profile-reader.js` and
`server/services/counterparty-pricing.js`.

## The defect

`negotiationProfilesFor` validated each stored row against the v1 schema in
`counterparty-pricing.js`, which rejects unknown keys and any enum slot that is
not exactly an enum value. The rows rebuilt after 2026-09-18 carry new
top-level keys (`deal_feelings`, `values_talk`, `behaviour_vs_words`,
`changes_since_0918`, `as_of`, `messages_read`, `nick_override`, and on some
rows `slug`, `name`, `aliases`, `league4_roster_id`, `league_roster`,
`subject`) and write sentences into enum slots (`"rarely (… is the exception)"`,
`"often (8 …)"`, `"moderate"`). Every row landed in `invalid`, so every
counterparty read built on a profile went blank without an error.

## RED (commit `b7b1e03e`)

The fixture copies the ten live rows' shapes — keys and the kind of sentence in
each enum slot — with invented names and no chat text. With the reader present
but not wired in, `node --test test/people-profile-reader.test.js`:

```
not ok 1 - FIX-00: all ten rebuilt profile shapes are valid and reach a roster
    rejected: [{"name":"ME","errors":["profile.deal_feelings: unexpected key", …
not ok 2 - FIX-00: enum slots are normalised and the sentence is kept as <slot>_text
ok 3 - FIX-00: parser cases
not ok 4 - FIX-00: an unparsed slot is reported by path, never by its text
ok 5 - FIX-00: the schema still rejects what it should
not ok 6 - FIX-00: manager_notes give Nick's read per roster; nick_override beats it
not ok 7 - FIX-00: no manager_notes table is not an error
# pass 2
# fail 5
```

All ten fixture rows were rejected (10 distinct names in `invalid`).

## The fix

- `server/services/people/profile-reader.js` (new): schema v2, the
  leading-word parsers for the four enum slots, `readProfile` (normalise, then
  validate the normalised copy), and `nickRead` (manager_notes + nick_override).
- The enum slot takes the parsed value; the stored sentence is kept as
  `<slot>_text`. Fallbacks when no word matches: holds → `unknown`,
  how_often → `sometimes`, inflation → `unknown`, praise reading → `mixed`.
  Each fallback is listed in the entry's `unparsed` by path, never by text.
- Error messages no longer quote the stored value (v1 printed it), so an
  error list can be shown without carrying profile text.
- `negotiationProfilesFor` calls `readProfile`, reads `manager_notes`
  (optional table), and exposes `nick` on each entry plus `nickByRoster` for
  every trusted non-Nick identity with notes, an override or a profile.

## GREEN

```
ok 1 - FIX-00: all ten rebuilt profile shapes are valid and reach a roster
ok 2 - FIX-00: enum slots are normalised and the sentence is kept as <slot>_text
ok 3 - FIX-00: parser cases
ok 4 - FIX-00: an unparsed slot is reported by path, never by its text
ok 5 - FIX-00: the schema still rejects what it should
ok 6 - FIX-00: manager_notes give Nick's read per roster; nick_override beats it
ok 7 - FIX-00: no manager_notes table is not an error
# pass 7
# fail 0
```

## Not proven here

The fixture copies the live shapes as the task described them; the live rows
themselves live only in the local chat DB. `scripts/check-negotiation-profiles.mjs`
prints the v2 verdict for each live row (counts and schema paths only) for a run
on a DB copy.

## Liveness: mutation sweep

Each mutant applied to the GREEN tree, `test/people-profile-reader.test.js` run,
file restored. Unit mutants in `profile-reader.js`; call-site mutants in
`counterparty-pricing.js#negotiationProfilesFor`.

| Mutant | Where | Result | Failing tests |
|---|---|---|---|
| M1 `moderate` → heavy | unit | killed | 2, 3 |
| M2 `<slot>_text` not kept | unit | killed | 2 |
| M3 reading fallback `unknown` | unit | killed | 3, 4 |
| M4 override ignored for booleans | unit | killed | 6, 7 |
| M5 `nickRead(null, …)` | call site | killed | 6, 7 |
| M6 raw profile served, not normalised | call site | killed | 2, 4 |
| M7 Nick's own roster not skipped | call site | killed | 6 |
| M8 `deal_feelings` undeclared | unit | killed | 1, 2, 4, 5, 6, 7 |
| M9 `twice` → once | unit | killed | 2, 3 |
| C1 drop `extremely` from intensifiers | designed surviving control | survived | — |
| C2 pattern absent from file | designed not-applied control | not applied | — |
