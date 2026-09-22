# Evidence (negative finding): roster-risk.js / waiver-brain.js silent-default audit

**What this is.** After fixing `availabilityPicture`'s silent "close to healthy"
default on an empty `nfl_injuries` table (#115), audited the remaining
unaudited functions in this domain's own files for the same shape — an empty
or missing data path that produces a specific confident claim instead of
stating the gap. **No code change: this audit found no instance of the bug
in the functions checked.**

**Checked, with result:**
- `roster-risk.js#byeOutlook`, `#byePatches` — already state-based:
  `if (!lg?.payload) return { error: 'league not synced yet' }` and
  `if (!teams.length) return { error: 'league sync contains no rosters yet' }`
  before any claim is made. Pre-existing good pattern (the model for #115's fix).
- `roster-risk.js#fragility` — same `league not synced yet` / roster-resolution
  guards up front. Its only implicit default, `active_probability ?? 0.92`, is
  a documented modelling fallback from `contingency.js`'s own "constants path"
  (already logged there: `[contingency] chance to play is priced on the
  'constants' path: ... missing or absent`), not an unstated claim manufactured
  by this file — out of scope for this file's own audit.
- `waiver-brain.js#vegasLift` — explicitly returns `{ multiplier: 1, line: null,
  applied: false }` on missing team/game-script data, and every caller
  (`horizonValueWithVegas`) checks `lift.applied` before using it. Correct
  state-based pattern already in place.
- `waiver-brain.js#waiverUpgrades`, `#sellHigh` — on no qualifying candidates,
  both return an empty list/array rather than a synthesized claim. An empty
  result here ("no upgrades found") is not the same failure shape as
  "close to healthy": it doesn't assert a positive fact the data can't support,
  it just reports nothing found, which is true whether the reason is "genuinely
  no upgrades" or "empty free-agent pool" — both cash out as the same honest
  answer to the question actually asked ("what upgrades exist").
- `waiver-brain.js#horizonValue`, `#playoffWeight`, `#horizonValueWithVegas` —
  pure arithmetic on inputs already resolved by the caller; no independent
  data-presence question to get wrong.

**Why this is worth recording even though nothing changed:** this session's
own rule (CLAUDE.md, "a layer goes inert and the surface says nothing") makes
it tempting to assume every empty-data path in this domain has the same bug
`availabilityPicture` had. It doesn't. Recording the negative result here
means a future thread doesn't re-run this same check from scratch, and
doesn't "fix" `sellHigh`/`waiverUpgrades` returning an empty array under the
assumption that emptiness always needs a state flag — here it doesn't.

**Five questions**
1. Well built? N/A — no code change, an audit record.
2. Stats or made up? N/A.
3. How we know: read every exported function in `roster-risk.js` and
   `waiver-brain.js` not already covered by this session's prior probes
   (`byeOutlook`/`byePatches` from the rig probe, `freeAgents`/`horizonValue`
   from the same) and traced each one's behavior on an empty/missing-data path.
4. Pointed anywhere else? Scoped to these two files only; `trade-engine.js`'s
   many exports are unaudited here.
5. How it unifies: continues the "measure before treating" discipline —
   this time the measurement said "no treatment needed," which is as valid an
   outcome as a fix, and worth writing down for the same reason a fix is.
