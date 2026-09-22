# TDD evidence: `availabilityPicture` injury-data-gap vs. healthy

**What this is.** `availabilityPicture()` in `server/services/football-context.js`
reads `nfl_injuries` for `team, season, week` and, when it finds zero rows, reads
out "`{team} is close to healthy on offence.`" That is correct when the team
genuinely has nobody flagged, and wrong — a silent false claim — when the feed
simply has no rows for that team this season at all: an unloaded table and a
healthy roster produce the identical empty result set, and the function had no
way to tell them apart. Live production is not immune to this: `nfl_injuries`
is populated (28,411 rows, 15:37Z production read) but nothing stops a
team/season/week combination from having a genuine coverage gap, and this
session's own offline rig (built to spot-check the app feature by feature)
reproduced the failure exactly — an entirely empty `nfl_injuries` table read
out as "close to healthy" for every team probed.

**RED**, commit `fc96f87`: `test/football-context-injury-availability.test.js`,
three cases, run against the pre-fix function — all three fail:
1. Empty `nfl_injuries` table entirely → old code returns no `injury_data_available`
   field (`undefined`) and reads "close to healthy on offence."
2. Injury rows exist, but only for a different team → same false "healthy" read
   for the team under test.
3. Injury rows exist for this team/season (a different week) → sanity check that
   a real zero-flagged week still reads as healthy once data is confirmed present.

**GREEN**, commit `4ff4e44`: added a `SELECT COUNT(*) FROM nfl_injuries WHERE
team = ? AND season = ?` presence check. New field `injury_data_available`
(boolean); `reading` now says "No injury data on file for {team} in {season} —
this is a data gap, not a health reading." when that check is false, instead of
falling through to the same text a clean report produces. All three tests pass.
`usage_share_at_risk`, `injury_report`, `id_resolution_rate` and `caveat` are
unchanged in shape; `injury_data_available` is additive. Checked both server
callers (`football-first.js:177-178`, `player-case.js:166-167`) — neither reads
`reading` as a string match, both consume `usage_share_at_risk`/`injury_report`
numerically, so neither breaks.

**Five questions**
1. Well built? Yes — one presence check at the same grain (team+season) the
   existing injury query already reads at, RED/GREEN with three fixture cases
   proving both the bug and the fix.
2. Stats or made up? Not a model change. `injury_data_available` is a fact about
   whether the feed has rows, not a tuned parameter.
3. How we know: RED test run against pre-fix code, 3/3 fail; same test against
   the fix, 3/3 pass. Independently reproduced via this session's offline rig
   (whose `nfl_injuries` table is entirely empty) before writing the fix —
   `availabilityPicture('DET', 2024, 8)` there read "close to healthy on
   offence" with zero injury rows in the database.
4. Pointed anywhere else? Settles this one function. `nfl_injuries` presence
   gaps in other readers (if any exist) are unaudited here.
5. How it unifies: same "measure before treating, state absence rather than
   guess" discipline this session applied to the `offense_pct` and
   `football-context.js:93 target_share` audits, this time on a live (not
   rig-only) risk — this is CLAUDE.md's named failure shape ("a layer goes
   inert and the surface says nothing as if nothing had happened"), not a new
   pattern.

**Adjacent findings, not fixed here (per coordinator scope for this unit):**
during the same rig probe, `trade-engine.js`'s `assetUniverse()` and
`waiver-brain.js`'s `freeAgents()` both hard-crash with no league/roster data
in the database, rather than the clean `{"error":"league not synced yet"}`
`roster-risk.js`'s `byeOutlook()`/`byePatches()` return in the same situation:

- `assetUniverse(1)`: `TypeError: Cannot read properties of undefined (reading
  'startsWith')` at `trade-engine.js:280` (`buildAssetUniverse`).
- `freeAgents(1)`: `SyntaxError: "undefined" is not valid JSON` at
  `JSON.parse`, called from `loadRosters` (`trade-engine.js:502`), called from
  `waiver-brain.js:173`.

Both trace back to `loadRosters()` in `trade-engine.js`. Per
`gridiron-file-allocation` memory, `trade-engine.js` and `waiver-brain.js` are
both Feature audit's own files, not Trade Brain's — flagging that ownership
correction to the coordinator alongside this evidence file rather than acting
on it, since this unit's scope was the injury-data-gap fix only. Whether this
is a real bug (production leagues always have roster data, so the crash may
never fire live) or just an unfriendly error shape worth hardening to match
`roster-risk.js`'s pattern is an open question for a future unit.
