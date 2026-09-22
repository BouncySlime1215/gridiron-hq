# Evidence: `football-context.js:93`'s `target_share` average is dead output

Source: coordinator/Planner assignment 2026-09-22 16:19Z, narrowed 16:26Z to
one site — `football-context.js:93`, the `AVG(target_share)` in
`availabilityPicture()`'s roster-usage query. Planner had measured real
feed-zero contamination in `player_week_usage.target_share` (866/5,234 REG
skill rows 2023, 1,041/5,271 2024 are a literal `0`, ~80% of them real
zero-target weeks) and priced a gate (join `player_week_snaps`, keep
`offense_snaps > 0` for the share mean only; counts/sums stay over every
week) sized at up to 46% understatement on the affected windows. Before
writing that fix, checked whether this specific consumer actually reads the
averaged value. It does not — no code changed, no TDD cycle spent on an
inert column.

## Five questions

1. **Well built?** N/A — no code change. The finding itself is a direct
   read of the function, not a measurement requiring a methodology.
2. **Stats or made up?** N/A, same reason.
3. **How we know:** `grep -n "u\.\|usage\[" server/services/football-context.js`
   and a full read of `availabilityPicture()` (`football-context.js:88-160`).
4. **Pointed anywhere else?** This settles only `football-context.js:93`.
   `player_week_usage.target_share` has 20+ other reader files
   (`nfl-features.js`, `opportunity-model.js`, `projections.js`,
   `season-sim.js`, `trade-engine.js`, and others per
   `grep -rl target_share server/services/*.js`) — none of them checked
   here. That sweep is Planner's, per the coordinator's 16:29Z note.
5. **How it unifies:** keeps the feed-zero fix effort pointed at code that
   actually affects what the app shows, matching this session's standing
   rule (established on the `offense_pct` audit earlier the same day) that
   every column gets independently measured — and here, independently
   *traced to a live consumer* — before treatment, rather than pattern-
   matched onto a fix that worked elsewhere.

## The finding

`availabilityPicture(team, season, week)` builds a roster-usage snapshot:

```js
const usage = rows(
  `SELECT player_id, position, SUM(targets) targets, SUM(carries) carries,
          AVG(target_share) target_share, COUNT(*) games
   FROM player_week_usage
   WHERE team = ? AND season = ? AND week < ? AND week >= ?
   GROUP BY player_id, position`,
  team, season, week, Math.max(1, week - lookback));
```

Every field this query selects is checked against the rest of the function
(`football-context.js:88-160`):

| field | read? | where |
|---|---|---|
| `player_id` | yes | `usage.map(u => u.player_id)` (id-bridge lookup), `byGsis` construction |
| `targets` | yes | `totalTouch` sum, per-player `touches` |
| `carries` | yes | `totalTouch` sum, per-player `touches` |
| `games` | yes | `touches_per_game: u?.games ? r2(touches / u.games) : null` |
| `position` | no | never read from a `usage` row (position filtering later uses `i.position` from the injury row, not `u.position`) |
| `target_share` | **no** | never read anywhere after line 93 |

The value the function actually surfaces as `usage_share` (on each flagged
injury entry, `football-context.js:~128`) is computed independently:

```js
const touches = (u?.targets ?? 0) + (u?.carries ?? 0);
const share = r3(touches / totalTouch);
```

— `touches` and `totalTouch` are both built from raw `SUM(targets)` /
`SUM(carries)`, never from the `AVG(target_share)` column. A literal-zero
`target_share` row still contributes its real `targets`/`carries` to those
sums (which are not gated and were never contaminated the way an `AVG`
would be — a `0` target-share week with `targets=0` adds `0` to the sum
either way, correctly). So this function's displayed injury-impact numbers
are unaffected by the `target_share` contamination Planner measured.

## Decision: no fix here

Gating `AVG(target_share)` at this call site would be a correct SQL change
with zero behavioral effect — the result is computed and immediately
discarded. Not worth a TDD cycle: there is no user-visible bug to prove
fixed, and a RED test against an unread column would be testing the query's
shape, not the application's behavior.

## What this does NOT settle

- Whether `player_week_usage.target_share`'s real contamination (measured
  by Planner, not disputed here) reaches the app through any of its other
  20+ reader files. That sweep is explicitly handed to Planner
  (coordinator's 16:29Z note) rather than expanded into here.
- Whether `position` (also selected, also apparently unread in this
  function) is genuinely dead weight too, or read by something outside
  this function's own body that wasn't checked — out of scope for this
  finding, which was scoped to `target_share`.
