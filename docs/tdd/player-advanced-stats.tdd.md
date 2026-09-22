# Advanced stats that say what they cannot measure

RED `6c9898b` · GREEN `a27cc10`

## 1. The ask, and why three quarters of it is a refusal

A fantasy player page is expected to carry four things: yards per route run,
route participation, touchdown rate and red-zone share. One of the four can be
computed here. The other three cannot, and the whole interest of this unit is
what you do about that.

The tempting move is to reach for the nearest column: snap share relabelled as
route participation, a receiving line divided by something that is not routes.
That is this project's signature bug — a number wearing a name it cannot
support — except built on purpose rather than by accident.

The second tempting move is quieter and worse: show the one that works and leave
the others out. An empty space makes no claim a reader can argue with, so a page
that silently omits yards per route run reads as a complete page. **A reader
counts what they can see.** So the three are listed, every time, for every
player, with the reason.

## 2. What is actually here, measured with a control

**Routes: nothing.**

```
grep -rci route server/db/schema/*.js
  core-and-fantasy.js:20    nfl-a-to-m.js:1    nfl-n-to-z.js:2
```

23 hits across four files, and every one is something else: 20 `server/routes/*.js`
path strings, one `routed_at`, one HTTP `route` column and one index on it.
Control in the same scan — `targets` — hits `mlb-model-misc.js`, which is the
real `player_week_usage` definition, so the scan works and the absence is a
measurement rather than a failed grep. Routes are not in nflverse's weekly files;
the sources that publish them are PFF and Fantasy Points Data, both paid, and
nothing here is paid.

**Red zone: field position without a player.** `nfl_play_by_play`
(`server/db/schema/nfl-a-to-m.js:306`) has `yards_to_endzone`, `down`, `distance`,
`play_type`, `yards_gained` — and no player column at all, only a free-text
`text` description of the play. Attributing a red-zone touch would mean parsing
prose, which is a guess wearing a number's clothes. Left out until it can be
attributed, not approximated.

**Touchdown rate: yes.** `player_week_usage` carries `receiving_tds`,
`rushing_tds`, `passing_tds`, `targets`, `carries` and `attempts`
(`mlb-model-misc.js:257-277`). The problem there is not availability but naming,
§4.

## 3. The contract

Four rules, each pinned by a test:

1. **A stat carries either a value or a reason — never both, never neither.** A
   row with both null is a stat that quietly disappeared.
2. **The unmeasurable three stay listed with their reason.** §1.
3. **A zero denominator is not measured, never a rate of 0.** A player with no
   targets does not have a touchdown rate of zero; he has no touchdown rate. The
   same distinction the freshness banner draws between `stale` and `empty`.
4. **Every rate names its denominator**, on the page, in `basis`.

And a fifth that only surfaced under mutation, §5: **the reason for an absence
must describe the thing that is absent.** "This player has no routes on file" and
"no routes-run data exists on this platform" are opposite claims. The first is
about a player and is false; the second is about the platform and is true.

## 4. Touchdown rate, and why the denominator is on the page

"Touchdown rate" is three different statistics. A passer's is touchdown passes
per attempt. A receiver's is receiving touchdowns per target. A receiving back
earns them both ways, and splitting him into two rates describes neither half.

So: QBs get `passing_tds / attempts`; everyone else gets
`(receiving_tds + rushing_tds) / (targets + carries)`. The choice is made from
the player's listed position rather than from whichever column happens to be
largest that week, so the basis sentence stays stable rather than flipping when
a back catches four passes. The denominator is rendered under the number, not
buried in a tooltip.

## 5. Two real gaps the sweep found

Both survived the first pass, and both were genuine.

**A4 — a reason that compares itself to itself.** The routes reason was rewritten
to *"This player has no routes on file for the season being played."* — a false
claim about a player in place of a true one about the platform. It survived all
three assertions, because every one of them compared `UNAVAILABLE.routes` to
itself: the two stats match each other, and two different players match each
other, so rewriting the constant moves both sides together and nothing notices.
Fixed by pinning the claim rather than the equality: the text must say the data
itself is absent, and must not contain player-referring language.

**A7 — the wrong absence.** A player with no usage rows had his target share
explained by "No snap counts on file", which describes a table that stat does not
read. The old code chose between two reasons where three were needed: no rows at
all, rows that exist but leave this column null, and a value. Added
`UNAVAILABLE.notPopulated` and pinned the reason, not just the null.

The pattern is now three-for-three on this branch: an assertion on a word or on
an identity is not an assertion on the behaviour it belongs to.

## 6. Mutation sweep

`python3 docs/tdd/sweeps/mutation-runner.py docs/tdd/sweeps/player-advanced-stats.mutations.json <out>`
on `6c9898b` with the GREEN applied. 11 mutations, 12 tests, every test killed.
Two controls with designed outcomes. All rows restored; every applied row's hash
moved.

| Row | Aimed at | Applied | Hash before → after | pass/fail | Killed by |
|---|---|---|---|---|---|
| A1 a zero denominator becomes a rate of zero | T7 zero denominator, T1 value-xor-reason | yes | `06d0770e5521` → `036eaf36b05e` | 11/1 | `a zero denominator is not measured, never a rate of zero` |
| A2 snap share is offered as route participation | T4 not under another name | yes | `06d0770e5521` → `44b21bd50d89` | 8/4 | `the three uncomputable stats are listed with their reason, not dropped`; `the routes reason says there is no routes data, not that the player has none`; `snap share is not offered as route participation under another name`; `a player with no usage rows at all is reported as such, not as all-zero` |
| A3 the unmeasurable stats are dropped from the block | T2 listed with a reason | yes | `06d0770e5521` → `f1e16c305018` | 10/2 | `the three uncomputable stats are listed with their reason, not dropped`; `the routes reason says there is no routes data, not that the player has none` |
| A4 the routes reason becomes a claim about the player | T3 a fact about the platform | yes | `06d0770e5521` → `dd3259c9e1b5` | 11/1 | `the routes reason says there is no routes data, not that the player has none` |
| A5 a passer's rate uses targets like everyone else's | T6 the passer denominator | yes | `06d0770e5521` → `e2548706a8de` | 11/1 | `a passer's touchdown rate uses attempts, not targets` |
| A6 the denominator stops being named | T5 basis named, T6 passer basis | yes | `06d0770e5521` → `a1e2d96d962a` | 11/1 | `touchdown rate is computed, with its denominator named` |
| A7 a player with no rows is explained by the wrong absence | T8 the right absence for no usage rows | yes | `06d0770e5521` → `82a52d88cdca` | 11/1 | `a player with no usage rows at all is reported as such, not as all-zero` |
| A8 weeks_measured is invented rather than counted | T9 weeks_measured | yes | `06d0770e5521` → `6f241b56a328` | 10/2 | `a player with no usage rows at all is reported as such, not as all-zero`; `weeks_measured says how much data is behind the numbers` |
| A9 the panel renders only the stats that have numbers | T11 absences survive to the page | yes | `7b072d2a2587` → `e0701b8573e2` | 11/1 | `the panel renders the unmeasurable stats rather than filtering them away` |
| A10 a failed load renders as a player with nothing to show | T12 failed load is not an empty block | yes | `7b072d2a2587` → `4e79b7843298` | 11/1 | `a failed load is not rendered as a player with no advanced stats` |
| A11 the panel is unmounted from the player page | T10 mounted and asking the right endpoint | yes | `fe3b0ea16a55` → `ef56d0738c62` | 11/1 | `the panel is mounted on the player page and asks the right endpoint` |
| C1 control: a comment reworded, nothing behavioural | nothing — must SURVIVE | yes | `06d0770e5521` → `c8d7a26a2ac0` | 12/0 | **SURVIVED** |
| C2 control: an anchor that does not exist | nothing — must report NOT APPLIED | **NOT APPLIED** (anchor ×0) | — (no edit) | — | — |

## 7. The full check

`npm run check` on `a27cc10`, tree `4a0c1832ed6ba101005f0081b8d54f63c7cbce57`:

```
rc=0
# tests 3068
# pass 3027
# fail 0
# skipped 41
Application startup smoke passed on isolated database (32 teams).
```

`git status --porcelain` empty before and after; tree hash identical after the
run; the post-run `find -newermt` touched nothing outside `client/dist/`.

This file is the only change after that measurement.

## 8. What this does not settle

- **Not pushed.** Held under the standing instruction that nothing pushes until
  Nick restores it.
- **The block is season-to-date, not weekly.** Target share and WOPR are means
  over the weeks on file, which is the right summary for a page but hides a
  trend. `weeks_measured` is shown so two weeks and twelve do not read alike,
  but that is a weaker signal than a sparkline.
- **Red-zone share stays unattributable until play-by-play carries a player.**
  If a source with player-level red-zone touches ever lands, this is a one-row
  change and the reason constant is where to start.
- **No position gating.** A quarterback gets a target-share row explained as not
  populated rather than as not applicable to him. That is honest but not sharp;
  the depth-chart panel already distinguishes `not_applicable_to_this_position`
  from `not_measured` and this should borrow it.

## The five questions

- **Well built?** The interesting half of this block is the part with no numbers
  in it, and that part is constants and a contract rather than prose that can
  drift. Every rate carries its denominator to the screen.
- **Stats or made up?** Stats where they exist, and a measured absence where they
  do not: 23 route hits of which zero are routes, against a control that hit the
  real table; a play-by-play schema with field position and no player.
- **How do we know?** RED then GREEN; 11 mutations killing all 12 tests with
  hashes either side and two designed controls; a full check on the commit
  recorded. Two survivors were real gaps, named in §5 rather than quietly
  patched.
- **Pointed anywhere else on the platform?** Nothing else reads this service yet.
  The absence facts are the reusable part — `no-route-data-exists-in-the-schema`
  in memory — because the next person asked for yards per route run will
  otherwise re-derive it.
- **How does it unify?** The same sentence as the freshness work, one surface
  over: when the system cannot answer, it has to say so in the place where the
  answer would have gone. A gap is not an answer, and a reader treats it as one.
