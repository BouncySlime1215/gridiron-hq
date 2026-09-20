# One accessor that cannot hand out an unpriceable row — TDD record

2026-09-20. Code: `server/services/manager-signals.js`,
`server/routes/trades.js`. Tests: `test/manager-data-pipeline.test.js`
(three `accessor:` tests). RED `3f7b4e5`, GREEN below.

## What was wrong, stated exactly

`draft` is the one signal source declared `priceable: false`, because no draft
metric survived the year-over-year repeatability test across 12 league-seasons
(`study/features/archetypes.md`). That flag was attached in **one place**:
`routes/trades.js`, in a local `signalOf` helper — the HTTP layer, which prices
nothing.

The accessor the pricing path reads through, `managerSignalsFor`, whose own
comment is "everything the trade engine needs about one league's managers, in
one read", returned every stored metric in a single `metrics` bag with **no flag
at all**. `counterpartyLayer` reads that bag.

**This was a hardening, not a bug fix, and the RED commit says so too.** Checked
before writing anything: the four draft-sourced metrics are `draft_auto_rate`,
`draft_reach_rate`, `draft_pick_vs_consensus` and `draft_name_brand_excess`
(`manager-signals.js:266-267`), and a grep across all of `server/` and `client/`
finds **no consumer reading any of the four by name**. Nothing priced on a
failed metric. There was also nothing that would have stopped it: a reach for
`m.metrics.draft_reach_rate` inside `counterpartyLayer` would have compiled, run
and been wrong.

## The fix: a property, not a rule

`managerSignalsFor` now partitions:

- `metrics` / `samples` / `sources` — **only** what may be priced on;
- `context` / `context_samples` / `context_sources` / `context_reasons` —
  everything that may not, each with the reason.

A caller on the pricing path cannot reach a draft metric by name, because it is
not in the bag it reads. That survives the next person who has not read the
comment, which a flag does not.

`unpriceableReason(source)` is the single decision, beside the registry it reads.
An **undeclared** source returns a reason rather than null: absent means *not*
priceable, never priceable-by-default, or a metric added without its registry
entry silently becomes an input to a price. The old route helper had this right
with `spec?.priceable ?? false`; the accessor keeps the same direction.

`signalRowsFor(leagueId)` is the read side — every stored row with `priceable`
and `why` — so the page still shows everything, labelled. The route's own SQL and
its `signalOf` helper are gone; it calls the accessor. Nothing is hidden from a
reader; it is hidden from a pricer.

The pricing layer was checked by name first, so the partition is known not to
starve it: `counterparty-pricing.js` reads only `chat_msgs`,
`chat_open_to_trade`, `chat_trade_talk`, `chat_own_untouchable`, `chat_reacting_to_loss`,
`prior_*`, `tx_accept_rate`, `outcome_luck_wins` and `last_week_margin` — every
one from a source declared priceable.

## RED, GREEN, and six mutations

RED: 2 failing of 26 in `manager-data-pipeline`, with the third test — the pin —
passing on both sides. GREEN: **26 of 26**, and 41 of 41 across that file plus
`manager-signals-api`.

All six were re-run 2026-09-20 through `/tmp/claude-0/mutate.py`, which
**asserts the substitution changed the file** before it runs anything and prints
`APPLIED` or `NO-OP`. Each printed `APPLIED`. The rule is the scheduler thread's,
and this file is the reason it matters here: see the section below.

| mutation | applied? | fails |
|---|---|---|
| P1 — undeclared source returns null, so it fails *open* | APPLIED | "an undeclared source fails closed" |
| P2 — the partition removed, everything back in the pricing bag | APPLIED | both `accessor:` behaviour tests |
| P3 — the context bag dropped, so unpriceable rows are hidden rather than labelled | APPLIED | both `accessor:` behaviour tests |
| P4 — `priceable` inverted on `signalRowsFor` | APPLIED | 2 route tests in `manager-signals-api` |
| P5 — a priceable source wrongly partitioned out of `signalRowsFor` (read path) | APPLIED | the same 2 route tests |
| P6 — a priceable source wrongly partitioned out of `managerSignalsFor` (pricing path) | APPLIED | the pin, and only the pin |

## The mistake in this file's own first draft

**P6 did not exist at first, and what stood in its place proved nothing.** The
mutation was written against `signalRowsFor` and the pin was read against league
11 alone. It killed two route tests and left the pin green, and the first reading
of that was "the pin is weak". Both halves were wrong:

1. the mutation had landed in the **read** accessor, not the pricing one, so it
   never touched what the pin watches — there are two `unpriceableReason` calls
   and the patch hit the first. It was `APPLIED`, not a `NO-OP`, which is the
   sharper version of the scheduler thread's rule: an injection can change the
   file and still be aimed at the wrong code, so `APPLIED` establishes that the
   substitution landed, never that it landed **where the test looks**. Only the
   pairing of an injection with the specific test it is supposed to break
   establishes that;
2. league 11 stores no `tx` rows, so even the right mutation would have missed.

Fixed by running the pin over leagues 11 **and** 12 and asserting the sources the
two fixtures actually cover (`roster`, `standings`, `tx`, `outcome`), so "some
priceable metric survived" cannot pass on one source while another is quietly
partitioned away. P6 then fails it, and nothing else.

This is the **second** time tonight a regression pin turned out to be watching
nothing: the first was G9e in `docs/tdd/luck-read-not-firing.tdd.md`, where a
fixture sat exactly on the `min_n` boundary and so never reached the branch it
claimed to protect. Both were found only by mutating the thing the pin was
supposed to protect and noticing that nothing broke. The general lesson, worth
more than either fix: **a pin that passes on both sides of a change has not been
shown to work — it has only been shown not to fail.** The mutation is the test of
the test.

## Is this well built? (the five questions)

**Based on statistics, or made up?** The rule it enforces is the statistics: the
repeatability study is why `draft` is `priceable: false`, and this change makes
that result structural instead of advisory. No new number.

**How do we know?** Six mutations, each named above with what it kills, including
one that exists only because the fifth was wrong.

**Structure.** One function decides (`unpriceableReason`), one accessor serves the
pricing path, one serves the page. The route lost its local copy of the rule.

**Should this point anywhere else?** Yes, and here is the remaining gap: only
`manager_signals` is covered. `manager_archetypes` is read directly by
`archetypesFor` for the `archetype` block on the same payload, and that path has
no equivalent partition — the draft metrics are in the weekly feature store too.
Named rather than widened.

**What would unify it?** The rule that covers all three of tonight's findings:
**no served value may carry a default, or a bag, that is indistinguishable from a
measurement it is not.** The luck read
(`docs/tdd/luck-read-not-firing.tdd.md`) was a default reading as a measurement;
the acceptance tier (`docs/tdd/acceptance-provenance.tdd.md`) was an assumption
reading as an elicited fact; this one was an unpriceable metric sitting in the
same bag as priceable ones. One rule, three instances, all found in a night.
