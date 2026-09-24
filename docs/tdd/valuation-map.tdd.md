# valuation-map (WA / T1) — TDD report

**Item:** the per-manager valuation map — for every manager and every player,
what *that* manager thinks he is worth, next to what we think he is worth.
Master plan 00 → D4: *"The core object is a per-manager valuation map … The gap
on each player is the raw material of every trade."*

**Files owned and changed:** `server/services/counterparty-pricing.js`,
`server/services/talk-vs-model.js`, `test/valuation-map.test.js`, this document.

**Gate:** pre-registered in
`/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/wa/valuation-map/GATE.md`,
written before the first test and the first line of code.

---

## 1. Audit — what existed, and the decision

The inventory's default decision for the Trade Brain is **"extend `findTrades`
and `counterparty-pricing`… the per-manager 'their value vs our value' layer is
already there, so the valuation map is an extension, not a new build."**
Confirmed, with evidence, before writing anything:

| What was already there | State found |
|---|---|
| `counterpartyLayer` | receptiveness from chat rank, accept rate and Nick's priors; `players` (raw sentiment) and `reads` (talk-vs-model) attached per manager |
| `perceivedValue` | one multiplier per player: the talk read **or** raw sentiment, nothing else; capped at ±15% per package |
| `negotiationProfilesFor` | a validated loader for the richest artifact we own — **and no reader** |
| `manager_archetypes` luck | copied into `manager_signals` by the signals build — **and no reader** |
| `bluff-detector` stance | wired into ONE binary decision (is this player in the candidate pool), not into any price |
| positional need | `analyzeLeague`, used by `trade-engine#rosterContext`; the inventory counts three copies of needs/surplus already |
| "how Nick looks" | nothing at all |

So five of the seven signals the brief names existed as data with no consumer,
and two (sentiment, talk-vs-model) were already priced but as a bare,
unexplained multiplier.

**Decision: EXTEND, one function.** Every per-player multiplier now comes from
`playerValuation()`. `perceivedValue` → `readDeal` → the trade engine goes
through it, and so does the new `valuationMap()`. The map is a **view** over the
same function, not a second engine, so a number on a trade card and a number on
a manager page cannot disagree. Positional need is read from `analyzeLeague`
rather than becoming a fourth copy.

## 2. RED → GREEN

| Commit | Evidence |
|---|---|
| `9156e53` TDD RED | 24 of 24 fail |
| `ddc673f` TDD GREEN | 24/24 pass; named suites and full suite green |
| (this stage) | +2 tests: the manager-level ablation hook, and the defect in §5 |

## 3. What the map is

`their_value = our_value × ∏(named, individually capped factors)`.

| Source | Cap | Min n | Needs | Direction |
|---|---|---|---|---|
| `talk_vs_model` | 10% | 3 mentions | chat | the crossed read (sales pitch ↓, attachment ↑, buy-low ↓) |
| `chat_sentiment` | 12% | 1 | chat | the fallback where there is talk but no model read |
| `profile_roster_read` | 10% | 1 | chat | his negotiation profile's own over/undervalues, untouchables, quietly-available |
| `hype_vs_usage` | 8% | 2 games | weekly expected points | his own player outscoring the usage that earns it |
| `luck_self_view` | **0% — retired** (was 5%) | 4 scored weeks | archetype build | **tested dead (r46 IDEA-103, 2026-09-24):** a ~2-win luck gap moves at most ~1.1 pp of how a manager values his own players, against the 5% this priced. Kept in the registry with `tested` so the map reports it absent with that verdict (`retired: tested dead …; it prices nothing`) instead of "rests on n of 4". Pinned by G2c and G9j (+3 wins over 6 weeks prices exactly as no luck row). |
| `positional_need` | 8% | 1 | roster read | a hole raises what he pays there; depth lowers it |
| `recency_post_loss` | 5% | 1 | standings | **receptiveness**, not a player's price |
| `untouchable_credibility` | 10% | 1 | chat | a refusal that holds is a real price; a bluffer's is an opening one |

Per player the product is clamped to **±20%**; per package the existing **±15%**
cap is unchanged. Every factor carries `source`, `label`, `effect`, `n`, `cap`,
`fitted: false` and `why`.

**Nothing is charged twice.** `talk_vs_model` and `chat_sentiment` are
alternatives for the same evidence; `hype_vs_usage` fires only where there is no
talk read, because the expectation gap is already that read's discriminator;
`praise_means` is not its own factor — it halves an attachment premium for a
manager the model says hypes before selling, and sharpens a sales-pitch discount.

**The model's own confidence is used.** `profile_roster_read` earns its full cap
only from a profile the model marked `high`; `medium` earns 70% and `low` 40%.
On the real corpus that matters: of the ten profiles, 2 are high, 2 medium, 5
low and 1 unstated, so a flat effect would have priced half the league on the
model's own least certain reads. Adding this turned the source from something
that only moved the ranking's order (2 positions) into one of three that do,
because it stopped every named player being pinned to the same ±10%.

**A source below its minimum sample is reported inert with its reason, never
dropped.** In week 2 of 2026 that is two of the eight, and both say so:
`hype_vs_usage` ("rests on 1 of the 2 needed") and `luck_self_view` ("rests on 1
of the 4 needed") — the archetype build has one scored week, and one game of luck
is noise.

## 4. Gate results

| Gate | Result |
|---|---|
| G1 composition and caps | PASS — 26/26 tests; zero information returns exactly 1; every factor inside its own cap; the player clamped at ±20% and says so; the package cap unchanged |
| G2 provenance | PASS — every factor names a registry source with n, cap and `fitted: false`; under-sampled sources reported inert with the reason |
| G3 cutoff safety | PASS — a week-5 map's gap rests on 4 weeks; a week-6 map's on 5, with a 60-point week-5 explosion in the fixture that never leaks in |
| G4 degradation | PASS — chat-free leagues get a map and list the absent chat sources; a league with no signals returns `available: false`; a call with no priced universe is refused |
| G5 how Nick looks | PASS — offers per manager with how they answered, what the league knows he is shopping (by source), veto votes against him; he is never a counterparty in his own map |
| G6 evidence | PASS as pre-registered (computed on all 30 with its interval) — **and the result is null**; see §6 |
| G7 ablation | PASS — see §7 |
| G8 no regression | PASS — full suite 2,635 tests, 2,593 pass, 3 fail (the known prop-CLV three), 39 skipped; lint and typecheck clean; league-4 `findTrades` cold +0.9 s median (budget 1.5 s), warm +2 ms (budget 15 ms) |
| G9 LLM spend | $0 — nothing here calls a model |

## 5. The one defect found and fixed after GREEN

Running the map on the real league-4 corpus, `selfRead` reported four players
Nick is known to be shopping. One of them was **"Olave-adjacent throw-ins when
he had him"** — a prose line from the `ME` profile's `quietly_available` list,
presented to Nick as a player. Fixed test-first (`G5b2`): a profile entry now has
to resolve to a real row in `players` before it is listed. Ownership is
deliberately *not* required — he can be known for shopping someone he has since
moved. The live list is now three real names: De'Von Achane (chat **and**
profile), A.J. Brown, Zach Charbonnet.

The same prose problem is handled at the other end by `profileListHit`, which
searches only the part of an entry before the first bracket or em dash: the real
corpus contains *"Ashton Jeanty (demands Achane + Chase Brown-level return…)"*,
and matching the whole string would have attributed Achane and Chase Brown to
the list as well.

## 6. Evidence check (G6) — the honest answer is "no measurable difference"

Population: all 30 decided 2026 proposals whose related offer carries trade items
(6 accepts, 24 declines; leagues 2, 3 and 4; 13 distinct deciders; 130 of 130
trade items resolved to real players; none skipped).

| Arm | What it prices on | AUC |
|---|---|---|
| A | our own value gain for the decider | **0.813** |
| B | the map, **cutoff-safe** | 0.806 |
| C | the map, today's data (contaminated) | 0.833 |

Decider-clustered bootstrap, 2,000 resamples, stable across four seeds:

| Comparison | Median | 95% interval |
|---|---|---|
| B − A | 0.000 | −0.017 … 0.000 |
| C − A | +0.017 | 0.000 … +0.065 |

On the 16 decisions made by **someone other than Nick** — the ones the map is
actually for — B − A is exactly 0.000 (interval 0.000 … 0.000).

Arm B rebuilds each manager's chat sentiment from the messages strictly before
that decision's own timestamp, takes the expectation gap as of that week, and
takes ownership from the offer itself (a man gives what he owns). The sources
that cannot be rebuilt as of the date — the negotiation profiles (written
2026-09-18 from the whole corpus), today's rosters and today's luck — are zeroed
in B and present in C. That is why C is not evidence: its lift is exactly the
part that can see the future.

**Reading it plainly:** with 6 accepts, our own value already separates accepts
from declines well (AUC 0.81 — people mostly decide on value). The chat layer's
contribution is smaller than 30 decisions can detect. The map ships because it
is a *read* that the tactics and the Coach are built on, not because this
measured it; the pre-registered red flag (a negative difference whose interval
excludes zero) did not fire, and the number is reported rather than buried.

Re-testable as proposals accrue — that is the master plan's own plan for this
number (E1: "tested on what exists, shown as a band; re-tested as proposals
accrue").

## 7. Ablation (G7) — league 4, week 2

Each source zeroed in turn. The arithmetic is exact, not approximate: zeroing a
player-level source can only move `perceptionFactor`, and zeroing
`recency_post_loss` can only move `managerFactor`, so each deal's score rebuilds
from its own parts. Two controls run first and the table is not reported unless
both pass — every unablated score rebuilds to < 1e-6, and `perception_shift`
recomputed here with nothing zeroed equals the engine's own number on every
deal. Both passed.

| Source | Deals repriced (of 15 mutual / 61 plausible) | Top-10 membership changed | Top-10 order changed (mutual / plausible) |
|---|---|---|---|
| `profile_roster_read` | 7 / 39 | 0 | **2 / 4 positions** |
| `positional_need` | 5 / 41 | 0 | **2 / 0** |
| `chat_sentiment` | 2 / 13 | 0 | **2 / 2** |
| `recency_post_loss` | 15 / 61 | 0 | 0 |
| `talk_vs_model` | 0 / 6 | 0 | 0 |
| `untouchable_credibility` | 0 / 0 | 0 | 0 |
| `hype_vs_usage` | inert (1 of 2 games) | — | — |
| `luck_self_view` | inert (1 of 4 weeks); retired 2026-09-24, prices nothing at any sample | — | — |

**No source changes which ideas surface.** Three change their order. The
binding constraint is not the map: `perceptionFactorFor` in `trade-engine.js`
bounds the whole counterparty read to ±10% of a deal's score, and it is applied
to `perception_shift`, which by construction cancels our own value gap. That
constant is hand-set and belongs to a file this item does not own — it is named
in the handoff rather than widened here.

What the map *does* change is what Nick is told about each deal and each
manager, which is what the tactics step (T2) and the Coach consume.

## 8. Coverage, live

| League | Map available | Sources firing |
|---|---|---|
| 4 Transfer portal | yes | chat_sentiment, talk_vs_model, profile_roster_read, untouchable_credibility, positional_need, recency_post_loss |
| 1, 2, 3, 5 | yes | positional_need, recency_post_loss (the chat sources listed absent with the reason) |

On the production database as it stands, leagues 1, 2, 3 and 5 have **no**
`manager_signals` rows at all, so their maps return `available: false` until
`scripts/build-manager-signals.mjs` next runs — it is already on the refresh
loop (`scripts/refresh-live-data.mjs`) and has not ticked since it was wired.
Everything above was measured on a `VACUUM INTO` copy with that build run, which
is why the all-league path is exercised rather than assumed. No production write
was made.

## "No captured transactions" was a claim about the league, not about a read (2026-09-22)

CLAUDE.md, §2: *"Errors are handled or they throw. No bare `catch {}` that
swallows a fault — this project has shipped two real bugs of exactly that shape,
where a silent catch deleted a whole data layer and the page kept printing
numbers as if nothing had happened. If a layer goes inert, the surface must say
so."*

This is the third. It is worth setting out in full because `selfRead` is not a
function that forgot to report — it is a function that **has** the reporting
channel, `available` and `reason`, and filled it with a false sentence.

### The line

```js
let tx = [];
try {
  tx = rows(`SELECT ... FROM league_transactions_raw WHERE league_id = ? AND season = ?`, leagueId, yr);
} catch { tx = []; }
```

Nothing downstream can tell that `[]` apart from a real empty result. Sixty
lines later, the function reaches:

```js
out.available = out.sources.length > 0;
if (!out.available) {
  out.reason = 'nothing the league can see: no captured transactions for this league and no chat corpus';
}
```

That sentence is a positive factual claim about the league. It was made on three
different states and is true of one.

### Why this is live and not hypothetical

`league_transactions_raw` is in **no migration**. `scripts/collect-league-transactions.mjs`
creates it and nothing else does. So on any database where that hand-run,
cookie-gated capture has never run, the table does not exist, `rows()` throws
`no such table`, the catch absorbs it, and Nick is told his league has no
transaction history.

"Nobody has ever collected this" and "your league has no history" send a person
to fix two different things, and only the first names something he can act on.

### The quiet half

The half above only fires when nothing else is available. When a chat corpus IS
present the function returns `available: true`, `reason: null`, and an empty
`to_each_manager` — so **"he has sent nobody anything" and "we could not read
what he sent" are the same answer to a caller.** No caveat, no null, nothing to
notice. This is the half that would have survived a review.

### RED -> GREEN

| | commit (#100) | subject | result on the rebased tree |
|---|---|---|---|
| RED | `7ec04548` | test: RED — selfRead tells Nick his league has no transaction history | 49 tests, 47 pass, **2 fail** |
| — | `bdb97355` | fix: selfRead says which of three things happened to the transaction read | 114 tests, 112 pass, **2 fail** — still red, see below |
| GREEN | `f7977515` | fix: GREEN — the transactions accessor says "would not read", instead of throwing | 116 tests, **116 pass**, 0 fail |

**The GREEN moved, and that is the finding, not a bookkeeping fix.** Before this
branch was rebased onto main `f620a120` this pair was `6043bfa` → `5f0da99`
(now `7ec04548` → `bdb97355`), 29 / 27 / 2 then 86 pass, and it closed at the
second commit. Re-measured after the rebase, `bdb97355` does not close it. The
rebase brought in main's `transactionsCollected`, which reads `last_seen_at`
with no guard, so G5e2 now throws out of the accessor before `selfRead`'s own
answer is ever reached:

```
not ok 29 - G5e2: "no captured transactions" is a claim about the league, not about a read that failed
  location: 'test/valuation-map.test.js:784:1'
  error:    'no such column: last_seen_at'
  code:     'ERR_SQLITE_ERROR'
  stack:    rows (server/db/index.js:241)
            transactionsCollected (server/services/manager-signals.js:585)
            selfRead (server/services/counterparty-pricing.js:1049)

not ok 30 - G5e3: an offer history that could not be read is not an empty offer history
  location: 'test/valuation-map.test.js:821:1'
  error:    Expected values to be strictly equal:
            + actual - expected
            + undefined
            - 'read'
  operator: 'strictEqual'
```

So the defect had two layers and only one of them was visible from the old base.
`bdb97355` fixes `selfRead`; the accessor underneath it is fixed two commits
later by `92e77d9f` (RED) and `f7977515` (GREEN), which were written for exactly
that throw. On this base the pair is `7ec04548` → `f7977515`, and `bdb97355` is
an intermediate that is red on its own. Nothing was reordered to make the record
look tidier: the commits stand as written and the table says which one actually
closes it.

The RED assertion for G5e3 still prints the sentence itself rather than only a
missing field, which is what it was ordered for. G5e2 no longer gets that far —
its failure is now the throw above, which is a stronger RED than the one it was
written with, and the reason is stated rather than smoothed over.

### What G5e was measuring

Directly above the new tests, G5e asserts:

```js
assert.ok(self.reason.length > 0);
```

Which is true of any sentence at all, including the false one. Ask the question
this branch has been asking of every assertion — *what would have to change in
the code for this to go red?* — and the answer is: the reason would have to
become empty. Not wrong. Empty. It is left in place rather than rewritten,
because moving it would hide which test caught what; G5e2 is what makes it mean
something.

### The fix

`tx_read_state` is `'not_attempted' | 'absent' | 'unreadable' | 'read'`, set on
every path and declared in the initial object literal so the early return for a
league with no roster of Nick's carries it too. A field that is only there when
the read succeeded is a field a consumer cannot rely on — the same defect as
`read_state` on `vetoClimate`, which set it on two paths of three.

Each reason sentence is now true of exactly one state, and each points at a
different thing to go and fix.

It is reported rather than thrown: one uncollected table must not take down
every trade search. But it is reported **as a fault**, which is the distinction
CLAUDE.md is drawing. The rule is not "never catch". It is that a layer which
has gone inert must say so, and `[]` does not say so.

### Not touched

`trade-engine.js:1843` holds `catch { self = null; }`, the same family, and
consumes this function. That file belongs to the Feature audit thread. The
contract it was waiting on now exists on this side: the enum above, with
`reason` carrying a sentence that is true of the state it names.

### The five questions

**Is it well built?** The read is, now. `tx_read_state` is declared in the
initial object literal rather than assigned on the paths that happen to reach
it, so the early return carries it too, and each `reason` sentence is true of
exactly one state. The weakest part is that the vocabulary is a bare string
union held by convention rather than by a constraint — there is no CHECK behind
it as there is behind `trade_outcomes` — so a fifth state added carelessly would
not be caught by anything but the tests.

**Are these statistics or are they made up?** Neither. This changes no
projection, no price and no ranking; it changes what the surface says when it
has not read anything. The only number involved is the count of captured
transactions, and the defect was precisely that a zero produced by *not looking*
was presented as a zero produced by looking.

**How do we know?** RED and GREEN are named in the table above, with the RED
assertion written to fail on the false sentence rather than on the state field,
so the failure output prints the claim being made about Nick's league rather
than an enum mismatch. That ordering is deliberate and is the reason the test is
worth having.

**Is it pointed anywhere else?** One place, named and not touched:
`trade-engine.js:1843` holds `catch { self = null; }`, the same family, and it
consumes this function. It belongs to another thread. The contract it was
waiting on now exists on this side — the enum, with a reason sentence true of
the state it names — so the fix there is no longer blocked on this one.

**How does it unify?** Same rule as the rest of the branch, on the read that
speaks most directly to Nick: the page told him a fact about his league that was
really a fact about this machine. "Nobody has collected this" and "you have
none" are different sentences, and only one of them was true.

## After merging main (2026-09-23): the catch G5d5 was leaning on

Merging `origin/main` `a3e2bf3` brought in #94 (`088bd65`), which removed
`timingRead`'s bare `catch { tx = []; }` so query faults throw. G5d5 passed on
this branch's old base (`f620a12`) only because that catch swallowed the
drifted-table error. On the merge commit `npm run check` exited 1 with one
failure (4126 tests, 4084 pass, 1 fail, 41 skipped):

```
not ok 3697 - G5d5: a transactions table that will not read does not take the trade reads down with it
  error: 'no such column: tx_id'
  at Module.timingRead (server/services/trade-tactics.js:260)
```

**RED** `6e99f48` (test: RED — after merging main, a table that will not read
throws out of timingRead, 40 of 42). G5d7 pins the state, not just the
no-throw: both G5d5 and G5d7 fail with `no such column: tx_id`.

**GREEN** `f663917` (fix: GREEN — timingRead and vetoClimate take the
accessor's 'unreadable', 42 of 42). Both reads now check
`transactionsCollected(...).read_state` before querying. An unreadable table
gives `read_state: 'unreadable'` with the accessor's reason. The two
"rests on N of the M" sentences are held back, because no sample was taken.

| mutant | killed by |
|---|---|
| M5 min-n guard `txPresent && !txUnreadable` → `txPresent` | G5d7 |
| M6 vetoClimate `unreadable` branch → `if (false)` | G5d5, G5d7 |

**Not covered:** a table whose shape passes the accessor's probe
(`last_seen_at`, `first_seen_at`) but lacks a column the timing query needs still
throws out of `timingRead`. That is main's intended behaviour since #94, and
the caller catches it (PR #120 makes that catch report `unreadable`). This
touches `server/services/trade-tactics.js`, which #120 also edits, in
different functions. Whichever lands second gets a mechanical merge.
