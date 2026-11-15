# TDD evidence: a confident need at a position nobody can price

**Change.** `claude/project-thread-5f9c3y-window-honest`, PR #74, commit
`969e1e4`. Edits `server/routes/tradelab.js`, which is this thread's file under
the one-editor-per-server-file rule.

Found by the wiring map thread and routed here. Verified before acting on it,
and the verification is in the tests rather than only in this file.

**Every injection below states whether it was APPLIED and how many lines it
changed.** A mutation that changes no file proves nothing, and a NO-OP scored as
"the test did not bite" is how a vacuous test gets certified as a guarded one.
The harness refuses to report a result at all when `git diff` comes back empty.
This convention came from the scheduler thread and it is right.

## The defect

`analyzeLeague` ranks each position group against the league average:

```js
const ratio = p.starter_value / (avg[pos] || 1);
if (ratio < WEAK) { p.status = 'need'; t.needs.push({ position: pos, ... }); }
```

`starter_value` sums `Math.max(0, p.vor)`, and `vor` is `v?.vor ?? 0` from
`vorBoard` (`routes/edge.js:31`), whose query **inner-joins**
`player_season_stats ... kind = 'projected'`. A position with no projections on
the board therefore gives every team a `starter_value` of 0, a league average of
0, and then `0 / (0 || 1)` = 0.

Zero is below `WEAK` (0.80), so the position comes back `status: 'need'`,
`ratio: 0`, `gap: 0` — the strongest verdict the page can give, derived from the
complete absence of information.

**On this deployment that is not an edge case.** An unpriced position is the
normal state, so Trade Lab was telling Nick he needed a position for the sole
reason that nobody could price it.

**And it does not stop at the page.** `trade-engine.js:156` builds
`needs: new Set(t.needs.map(n => n.position))` from this list and passes it as
`theirNeeds` into offer generation (`:1567`, `:1586`, `:2176`, `:2229`, `:2356`)
and into the memo copy. So an unpriceable position became a counterparty's stated
need and the engine proposed trades to fill it. Test 7 reads that consumer
directly rather than trusting the producer.

## The fix, and the one thing it must not do

`routes/leagues.js:396-404` already made exactly this fix for exactly this
expression on League Hub, and its own comment is the spec:

> `starter_value / (averages[pos] || 1)` turned a league-wide 0 into a ratio of
> 0, i.e. a confident NEED, for a position nobody has a price for. There is no
> verdict to give there.

League Hub got the guard; Trade Lab did not. Both now report `ratio: null`,
`status: 'unknown'`, and neither counts it as a need or a surplus.

**The guard keys on the league AVERAGE, never on a team's own value.** A team
with nothing startable at a position the league *can* price has a real hole and
must still be told so. That case exists in the fixture — one team's receiver is
below replacement, so his VOR floors at 0 and his `starter_value` is 0, the same
zero the unpriced position produces, on the same team, in the same payload. Test
5 is that case and injection n2 is the careless fix that breaks it.

## Injections (`test/board-need-without-a-price.test.js`, 7 tests)

```
### n1  the defect restored: the `|| 1` denominator, no guard    APPLIED (1+ 6-)
# tests 7   # pass 4   # fail 3
not ok 3 - a position the board cannot price is unknown, not a need
not ok 4 - and it is not counted as a need or a surplus
not ok 7 - the needs that reach the trade engine no longer include it

### n2  the guard keys on the TEAM's value, not the average      APPLIED (1+ 1-)
# tests 7   # pass 5   # fail 2
not ok 5 - a team with nothing at a position the league CAN price is still a need
not ok 6 - the priced positions still carry a real ratio on every team

### n3  ratio suppressed but the need still pushed               APPLIED (1+ 0-)
# tests 7   # pass 5   # fail 2
not ok 4 - and it is not counted as a need or a surplus
not ok 7 - the needs that reach the trade engine no longer include it

### n4  ratio reported as 0 rather than null                     APPLIED (1+ 1-)
# tests 7   # pass 6   # fail 1
not ok 3 - a position the board cannot price is unknown, not a need

### n5  CONTROL, a comment reworded — must not bite              APPLIED (1+ 1-)
# tests 7   # pass 7   # fail 0
```

n5 is declared in advance as a control and is the only green one. It is there to
show the harness reports honestly: it changed a file (so it is APPLIED, not a
NO-OP) and changed no behaviour, and a suite that went red under it would mean
something was asserting on a comment.

n3 is the one worth reading. It reports `status: 'unknown'` on the page while
still pushing the position into `t.needs` — the page looks fixed and the trade
engine still proposes trades for a position nobody can price. Only test 7, which
reads the consumer, catches it.

**Four of the seven tests pass on both sides and are named for why.** Test 1
asserts the fixture really does leave one position off the VOR board and the
others on it. Test 2 asserts the league average really is zero there and non-zero
elsewhere — if TE ever gained a price, this file would go quietly vacuous and
test 2 is what says so. Test 6 asserts the priced positions keep a real ratio on
every team. Test 5 is the genuine-hole control above.

**A fixture trap, recorded because it cost a cycle.** The first version gave all
four teams the same projection per position. VOR is `proj - replacementLevel`,
and with one QB per team in a four-team league the replacement level *is* the
fourth-best QB — so four identical projections give every QB a VOR of exactly 0,
the QB average collapses to zero too, and QB silently becomes a second unpriced
position, destroying the contrast the file is built on. The projections now
descend across the teams and test 1 asserts the result.

## Is this well built

- **Well built:** yes, and it is the guard that already exists one file away,
  applied to the second copy of the same expression. The useful part is that both
  copies now behave the same, so "ratio 0.79" means one thing in this app rather
  than two.
- **Stats, or made up.** The fix adds no number. It stops a number being
  manufactured from nothing. **Still hand-set and untouched, named so this is not
  read as a clean bill:** `WEAK = 0.80` and `STRONG = 1.15` (`tradelab.js:13`)
  are uncited thresholds, and the `FLEX_SPLIT` shares that set `perTeam` are too.
- **How we know.** Read directly: `vorBoard`'s inner join on projections is what
  makes an unpriced position score zero, and `trade-engine.js:156` is what carries
  the false need onward. Both are asserted rather than described — test 1 reads
  the VOR board, test 7 rebuilds the engine's own `Set`. **What is still
  untested:** which positions are actually unpriced on the live database. That
  decides whether this was firing constantly or occasionally, and it is one query
  (`SELECT position, COUNT(*) FROM players p JOIN player_season_stats s ON
  s.player_id = p.id AND s.season = 2026 AND s.kind = 'projected' GROUP BY
  position`). The fix is correct either way, which is why it is not waiting on it.
- **Pointed anywhere else.** The `needs` list reaches `trade-engine.js:156` and
  from there five offer-generation call sites and the memo copy. The same
  expression exists in `routes/leagues.js` and was already guarded. **A related
  inconsistency, verified and deliberately NOT fixed here:** `tradelab.js:125`
  builds `starter_value` from `p.vor` while `leagues.js:387` builds it from
  `p.value` (raw price). So the same `0.79` on League Hub and on Trade Lab are
  two different quantities — one is points over replacement, the other is market
  price. That wants one definition, and choosing it is a change to what both
  pages mean, not a bug fix.
- **How it unifies.** One rule for an absent denominator, in both places that
  divide by a league average: no average, no verdict.
