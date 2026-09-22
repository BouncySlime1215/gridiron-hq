# Assertions that hedged on wording, and what they were hiding

A sweep of every `assert.match` in this thread's files whose pattern is an
alternation — a literal regex with a `|` in it, on one line, against one value.

That was the scope for two passes. It widened twice, and both widenings are
recorded rather than folded in: first to a FRAGMENT of a registry constant
(site 22, §2c), then to a pattern that cannot test its own claim at all
(site 23, §2d). Neither has a `|` in it. The scope is now the shape — an
assertion whose pattern admits more than the sentence it claims — and the pipe
is one symptom of it.

**The rule being applied.** An alternation is legitimate when it asserts
membership of a CLOSED SET and every branch is a real outcome the code can
produce: "this is one of the three problems, and each of the three is a state
that exists". It is defective when it stands in for *the message says something
like this* — when the fixture can only ever produce one branch, so the others
are there to keep the assertion passing if the sentence is reworded. That is
not a test of the sentence. It is a test that a sentence exists.

**What makes a split real.** Splitting a hedged pattern into its one reachable
branch is not enough on its own. If a neighbouring clause of the same sentence
can satisfy the replacement, nothing has been tightened. So every split below
carries the mutation that motivated it, run twice: once against the new
assertion, which must go **red**, and once against the assertion it replaced,
which is recorded as **survived** where it passed. A split whose motivating
mutation the old pattern also killed is marked as such rather than claimed.

## The five questions

- **Well built?** The subject is the test suite itself. Twenty-three assertions
  across seven files asserted the existence of a sentence rather than its
  content; each now names the one clause that carries the fact, and, where two
  sentences in the same code are confusable, rules the other one out by name.
  Fourteen were found in the first pass (§1, §2), eight in the second (§2c),
  and one in a third (§2d) run by reading for the SHAPE after the second pass
  had declared itself complete by grep.
- **Stats or made up?** Neither — these are string contracts. The numbers here
  are mutation counts, and every one of them was run, not reasoned about.
- **How do we know?** Thirty-two mutations, each applied to the PRODUCER of the
  sentence, with the file's SHA-256 before and after, plus a control that must
  be a no-op. Twenty-four are positives: all twenty-four are killed by the new
  assertion, and twenty-three of twenty-four survived the assertion they replaced.
  The exception (M9) was killed by a different test in the same file, which is
  recorded as such. Eight are negations and are counted separately, for the
  reason in §2b. The table is re-derivable by anyone: the runner and the
  mutation list are committed under `docs/tdd/sweeps/`.
- **Pointed anywhere else?** It was, and §2c is the result: the sweep was
  carried over the rest of this thread's allocated suites and found eight more,
  including one (site 21) whose alternation had a branch the code cannot produce
  at all, and one (site 22) that the pass's own new rule caught after its first
  application had missed it. It pointed one place further still, and §2d is
  that: the completeness claim §2c closes with is true of the grep and false of
  the suite. Files outside this thread's allocation were read and left
  alone: `trade-verify.test.js:212` is a tense variant of one phrase, which is
  a real closed set.
- **How does it unify?** One question answers every case: *can the fixture
  produce more than one branch?* If it cannot, the pattern is a hedge. That
  question is cheaper to ask than the taxonomy it replaces.

## 1. The first pass: ten sites, and the fact each one was hiding

| # | Site | Pattern | Reachable branches | Fixed to |
|---|------|---------|--------------------|----------|
| 1 | `trade-tactics.test.js` `sell_the_crush` absent reason | `/chat\|profile/i` | 1 of 2 | names the whole "no chat read or negotiation profile" clause, and rules out the sentence for a manager whose chat WAS read |
| 2 | `trade-acceptance.test.js` `perception_delta` inert reason | `/0\.1\|less than\|below/i` | 2 of 3, both inside the same sentence | two assertions: the reading (`+0.1% on his own numbers`) and the threshold that held it out |
| 3 | `valuation-map.test.js` G2b luck under min_n | `/1 .*(week\|sample)\|below/i` | 1 of 2 | the whole min_n sentence, equality |
| 4 | `valuation-map.test.js` G4b no manager data | `/manager signals\|no manager data/i` | 1 of 2 | the whole sentence, equality — it names the script that would fix it |
| 5 | `valuation-map.test.js` G10 corpus off the machine | `/not on this machine\|corpus/i` | 2 of 2, same sentence | names this absence and rules out the other one |
| 6 | `valuation-map.test.js` G10b no trusted identity | `/identity\|never (asked\|looked)\|not read/i` | 2 of 4 | names this absence and rules out the other one |
| 7 | `valuation-map.test.js` G9a luck never measured | `/0 of the 4\|scored weeks/i` | 2 of 2, same sentence | the whole min_n sentence, equality |
| 8 | `valuation-map.test.js` G9b one-week reading | `/1 of the 4\|scored weeks/i` | 2 of 2, same sentence | the whole min_n sentence, equality |
| 9 | `valuation-map.test.js` G9d absent luck source | `/0 of the 4\|scored weeks/i` | 2 of 2, same sentence | the whole min_n sentence, equality |
| 10 | `valuation-map.test.js` G11c flat answer | `/even spread\|no information/i` | 1 of 2 | the flat-BECAUSE-no-evidence clause, and rules out the flat-but-measured sentence |

Sites 5 and 6 are the pair that matters most. `counterparty-pricing.js:277`
writes two different sentences for two different absences — "we never asked"
and "we asked and could not read it" — and the comment above them says in so
many words that the difference has to travel. Both assertions could match
either intent loosely; neither pinned which sentence arrived.

## 2. The four sites in `trade-proposals.test.js`

Allocated to this thread at 12:23Z. `trade-proposals.js:436` defines
`RESPONSE_PROBLEMS`, a frozen set of seven codes, so every one of these cases
is distinguishable in ONE WORD — and three of the four assertions hedged on
prose instead of asserting the word.

| # | Site | Pattern | What it hid |
|---|------|---------|-------------|
| 11 | G4 malformed response | `/could not be read\|malformed\|parse/i` | the TRUNCATED sentence (`:681`) also contains "could not be read", so the test named for a malformed response passed on a truncated one |
| 12 | G4 all proposals rejected | `/invent\|verification\|rejected/i` | all three branches are in the one sentence; the count of rejects was not asserted at all |
| 13 | G7 max_tokens cut off | `/cut off\|ran out of (output )?room\|output limit/i` | two of three branches in the one sentence |
| 14 | G7 cached not-a-list | `/not a list\|list of proposals/i` | both branches inside the first clause, so a cached answer and a fresh one read alike |

Each now asserts `r.problem` against the code in `RESPONSE_PROBLEMS` first, and
the sentence second. 14 is two assertions rather than one equality: the cached
answer appends a clause to the stored sentence, so the stored sentence is
pinned with `^...— ` and the cache's own clause separately.

## 2b. Positive assertions and negations are two counts, not one

Raised by the model evidence audit, and it changes how the number below must be
read. A negation's pattern matches **nothing** whenever the test passes, so
"this assertion survived the injection" means something different for an
`assert.doesNotMatch` than for an `assert.match`, and a survival count drawn
across a mixed set is not one number.

Checked rather than assumed. Every one of the fourteen replaced sites was an
`assert.match` — `git show 6422367:<file> | grep 'assert\.\(match\|doesNotMatch\)'`
filtered to the alternations returns fourteen lines and **not one of them is a
negation**. So the set that the survival count is drawn over is homogeneous,
which makes the claim stronger than it was stated, not weaker.

That leaves a real gap, and it is the useful half of the question. The sweep
ADDED six `doesNotMatch` assertions — the ones that rule out the other of two
confusable sentences — and the original twelve mutations do not exercise a
single one of them: every one of those twelve is killed by a positive
assertion, which the runner's `killed at` line now proves rather than asserts
(`assert.match` at nine sites, `assert.equal`/`assert.deepEqual` at seven). Six
negations with no mutation behind them are six assertions nobody has shown can
fail.

So six rows were added, M13 to M18, one per negation. Each makes the producer
emit BOTH confusable sentences — the honest defect for a negation, since a
producer that hedges by saying both is exactly what the negation exists to
catch — and each is killed at the `doesNotMatch` line it was written for.

**The two counts.**

| shape | rows | killed by the new assertion | survived the assertion it replaced |
|---|---|---|---|
| positive | 12 | 12 of 12 | **11 of 12** |
| negation | 6 | 6 of 6 | **not comparable** |
| control | 1 | `NO-OP` as listed | — |

The negation rows' "old" column is a pass in all six cases and is **not**
evidence: there was no negation at those sites before the sweep, so there was
nothing to survive. Reporting it as six more survivals would be counting the
absence of an assertion as the strength of one. The eleven-of-twelve figure
belongs to the positive rows alone and should always be quoted that way.

The same rule was applied to the second pass without being re-argued: §2c's
eight sites were checked the same way and all eight were positive assertions, so
the ten-of-ten figure is homogeneous too; the two negations that pass added
carry their own rows (M28, M29), and the eighth site's row is M30. The combined
table, split by shape, is at the end of §3.

## 2c. The second pass: eight sites, in three more suites

The file's own answer to *pointed anywhere else?* was "the same shape is worth
a pass over every suite, not only these four." This is that pass, over the rest
of this thread's allocated suites. Seven more alternations, each checked the
same way — read the producer, count the branches the fixture can actually
reach.

| # | Site | Pattern | Reachable branches | Fixed to |
|---|------|---------|--------------------|----------|
| 15 | `manager-signals-api.test.js:550` chat `collected_by` | `/refresh-live-data\|league_chat/i` | 2 of 2, both inside one constant | equality on the whole `roller` string |
| 16 | `manager-signals-api.test.js:573` the absent-corpus reason | `/not on this (machine\|database)\|no chat corpus/i` | **1 of 2** | two assertions: the corpus is absent AT A PATH, and it cannot be PRODUCED here |
| 17 | `manager-signals-api.test.js:586` where the corpus comes from | `/Mac\|Apple Messages/` | 2 of 2, same sentence | the whole phrase, "extracted from Apple Messages on Nick's Mac" |
| 18 | `manager-signals-api.test.js:602` `SIGNAL_SOURCES.chat.refreshed` | `/off-server\|refresh-live-data/i` | 2 of 2, both inside one constant | equality on the registry string |
| 19 | `manager-data-pipeline.test.js:394` the declared-unpriceable reason | `/priceable\|never priced\|context only/i` | 3 of 3, all in one sentence | the whole clause, and rules out the undeclared-source sentence |
| 20 | `manager-data-pipeline.test.js:412` the undeclared-source reason | `/not declared\|undeclared\|SIGNAL_SOURCES/i` | **2 of 3** | the whole clause, the offending source's own name, and rules out the declared-unpriceable sentence |
| 21 | `trade-route-retirement.test.js:61` the tombstone pointer | `/\/api\/\|trade-engine/` | **1 of 2** | anchored, `^\/api\//` |
| 22 | `manager-signals-api.test.js:633` `SIGNAL_SOURCES.tx.refreshed` | `/collect-league-transactions\.mjs/` | not an alternation — a FRAGMENT of a constant | equality on the registry string |

**Site 22 is this section finding its own miss, and it is recorded rather than
quietly folded in.** Sites 15 and 18 established the rule that a registry
CONSTANT is asserted whole. Applying it, I fixed `SIGNAL_SOURCES.chat.refreshed`
and left `SIGNAL_SOURCES.tx.refreshed` — its sibling, three entries down the
same frozen object, interpolated into the served `why` the same way, and
asserted by a bare fragment naming only the script. It is not an alternation, so
the grep that found the other seven could not see it; it took re-reading the
suites for the SHAPE rather than for the pattern. The lesson is the useful half:
a rule stated from two examples is worth re-running over the files that produced
them, because the first application of a new rule is where its own siblings get
missed. `tx.refreshed` carries three facts — the script, that it runs
off-server, and where the date lives — and the fragment pinned one.

The first seven were `assert.match` before the sweep — checked with
`git show 6422367:<file> | sed -n '<line>p'`, not assumed — so §2b's rule
applies unchanged and the second pass's survival figure is drawn over a
homogeneous set. The two `assert.doesNotMatch` assertions this pass ADDED are
counted separately and carry their own mutations, M28 and M29.

**Sites 15 and 18 are a shape the first pass did not contain.** Both read a
CONSTANT — `roller` in `chatCorpusState()`, and `SIGNAL_SOURCES.chat.refreshed`
— not a sentence assembled at runtime. When the value under test is a constant,
the whole string is the contract and there is no reason to assert a fragment of
it; both alternations had both branches inside the one constant, so neither
could distinguish *names the script* from *names the step within the script*,
which are the two halves that make the thing findable by someone who has to go
run it. Both are now equalities.

**Sites 19 and 20 are the same confusable pair as 5 and 6.**
`unpriceableReason()` writes two sentences for two states that call for
completely different fixes: a source DECLARED `priceable: false` is working as
intended and needs nothing, and a source missing from `SIGNAL_SOURCES` is a
stray writer someone has to go declare. Each now names its own clause and rules
the other out by name.

**Site 21 is the one worth generalising.** `trade-engine` was not a weak branch,
it was an unreachable one: every tombstone in the repo points at an `/api/…`
path, and nothing points at a module. The assertion therefore described a
contract the code does not have — "an API path OR a module" — and would have
gone on passing if a tombstone started pointing at a source file, which is
precisely the thing a tombstone must not do. A tombstone is earned by having
somewhere LIVE to point, and a live place is a route. The fix is an anchor
rather than a phrase: `^\/api\//` also rules out a pointer that merely mentions
an API path somewhere inside a sentence.

**The sweep is now complete over this thread's suites, and that is a measured
claim rather than a stopping point.** After the second pass, a grep for a
single-line `assert.match` or `assert.doesNotMatch` carrying a `|` returns
**zero** across all sixteen of them — `find-trades`, `league-brain`,
`manager-data-pipeline`, `manager-identity-seeding`, `manager-signals-api`,
`trade-acceptance`, `trade-brain-surface`, `trade-engine-correctness`,
`trade-evidence`, `trade-manager-read`, `trade-proposals`,
`trade-route-retirement`, `trade-season-span`, `trade-tactics`, `valuation-map`,
`valuation-panel`. A multiline search, which catches an alternation whose regex
sits on a later line than the `assert`, returns exactly one site in the whole
set and it is outside this thread's allocation: `trade-verify.test.js:212`,
`/you (were|are) wrong/i`, a tense variant of one phrase and a real closed set.

What that number does NOT say is that the suites are free of the defect. Site 22
is the proof: it is not an alternation, so no grep for a pipe could ever have
found it, and the count above would have read zero with it still in place. The
pattern is findable by grep; the SHAPE is not. Any later pass should read for
the shape.

**A later pass did, and found one — §2d.** The paragraph above is left standing
rather than edited, because the zero it reports is still true: the point is
exactly that a true zero was not a clean suite.

## 2d. The third pass: one site, and an assertion that could not test its claim

Read for the shape this time rather than for a pattern, over the same suites:
**every regex assertion whose subject is an imported value.** That is the rule
site 22 produced, applied where it had not yet been.

| # | Site | Pattern | What the pattern could test | Fixed to |
|---|------|---------|------------------------------|----------|
| 23 | `trade-proposals.test.js:150` the prompt version in the cache key | `assert.match(PROMPT_VERSION, /\S/)` | that a string is not blank — **true of every non-empty string** | the key is sha256 over exactly `{ v, league, prompt }`, in that order |

The message on that line read *"the prompt version is part of the key by
construction"*, and it sat inside a test named *a changed slate, a different
league, or a bumped prompt version all miss*. The test's own name promised that
the bumped version misses. Nothing in it checked that. `/\S/` cannot check it:
it takes a string and asks whether it has a non-space character in it, which is
a fact about the constant and not about the key at all.

**This is the class neither earlier pass could have found, by construction.** No
pipe, so the grep was blind to it. No alternation either, so site 22's rule did
not reach it — that rule was about a FRAGMENT of a constant standing in for the
whole. Here the pattern is not a fragment of anything; it is a claim about a
different subject. What finds it is asking, of each assertion, *what would have
to change in the code for this to go red?* For `/\S/` on a module constant the
answer is "nothing a caller can do", and that is the whole finding.

**Why the fix is two assertions, and why their order matters.** `PROMPT_VERSION`
is a module constant and cannot be bumped from a test, so the claim has to be
tested as what it actually is — a fact about the material the key hashes:

1. `cacheKeyFor(4, [idea()])` equals sha256 over exactly `{ v, league, prompt }`,
   in that order. Without this, the line below would be a test of the test: two
   independent implementations of one idea agreeing with each other proves
   neither is right.
2. Change ONLY the version in that material, and the key differs.

**The honest reading of the two rows.** M31 removes `v` from the material; M32
leaves it in and moves it last. Both go red, and **both are killed at the same
line — `trade-proposals.test.js:171`, which is assertion 1.** Assertion 2 has no
producer edit behind it and cannot have one: once assertion 1 pins the key to
sha256 over that exact material, "a different version gives a different key" is
a property of sha256 rather than of this code. So assertion 1 is the one doing
the work and assertion 2 states the claim in the test's own terms. Recorded here
rather than left looking like two independent checks — which would be the same
mistake as the line it replaced, one level up.

## 3. Mutations

Every row: the producer file's SHA-256 (first 12) before and after, the exact
edit as a diff, the test the new assertion fails on, and whether the assertion
it replaced survived. `node --test <file>` per row, on the tree these commits
are on.

**The table is re-derivable, not reported.** The runner and the mutation list
are committed:

```
node docs/tdd/sweeps/run-mutations.mjs docs/tdd/sweeps/hedged-assertions.mutations.json
```

It applies each edit to the producer, runs the named suites, then checks the
same suites out at `6422367` — the commit before this sweep — and runs them
again, which is where the `survived` column comes from. Every injection is
reverted and the file is re-hashed against its baseline before the next row;
the runner exits non-zero if any row did not behave as the list says.

Re-derived with that runner: **31 of 31 rows behaved as the list says** — 30
injections that APPLIED and one CONTROL that did not, over both passes — and
the seven suites are left byte-identical to `HEAD` afterwards. The runner also
reports the `file:line` of the assertion that threw, which is what the shape
split below is measured from rather than reasoned about.

Baselines: `server/services/trade-tactics.js` `c5808df9aa97`,
`server/services/trade-acceptance.js` `a0c12157cc0a`,
`server/services/counterparty-pricing.js` `96e54c44c7ce`,
`server/services/trade-proposals.js` `2a529fd8a9b6`,
`server/services/manager-signals.js` `bbc1ebea6dab`,
`server/routes/edge.js` `d17644bbc58d`.

| # | Mutation | Applied | New assertion | Old assertion |
|---|----------|---------|---------------|---------------|
| M1 | drop "or negotiation profile" from the no-chat sentence | `APPLIED c5808df9aa97 -> 1993422a224f` | **RED** 36/35/1 | **survived** 36/36/0 |
| M2 | the delta reading stops naming the number | `APPLIED a0c12157cc0a -> 95933450a1d8` | **RED** 22/21/1 | **survived** 22/22/0 |
| M3 | the smallness threshold stops naming 0.001 | `APPLIED a0c12157cc0a -> 3663f69c9a20` | **RED** 22/21/1 | **survived** 22/22/0 |
| M4 | the min_n reason stops naming the sample it NEEDS | `APPLIED 96e54c44c7ce -> b8807aa60f0e` | **RED** 47/43/4 | **survived** 47/47/0 |
| M5 | the no-signals reason stops naming the script | `APPLIED 96e54c44c7ce -> 6000f5d79c46` | **RED** 47/46/1 | **survived** 47/47/0 |
| M6 | "not on this machine" becomes "unavailable" | `APPLIED 96e54c44c7ce -> a59d97209b33` | **RED** 47/46/1 | **survived** 47/47/0 |
| M7 | "no confirmed chat identity" loses "confirmed chat" | `APPLIED 96e54c44c7ce -> 47818c9f4372` | **RED** 47/46/1 | **survived** 47/47/0 |
| M8 | the flat-prior sentence stops saying there is no evidence | `APPLIED 96e54c44c7ce -> 3219844f6bd9` | **RED** 47/46/1 | **survived** 47/47/0 |
| M9 | an unreadable response is reported as truncated | `APPLIED 2a529fd8a9b6 -> 582732cd145d` | **RED** 54/52/2 | **survived AT THIS SITE** 54/53/1 — killed by a different test |
| M10 | the all-rejected sentence drops the count | `APPLIED 2a529fd8a9b6 -> dd1861939940` | **RED** 54/53/1 | **survived** 54/54/0 |
| M11 | the truncated sentence drops "cut off mid-answer" | `APPLIED 2a529fd8a9b6 -> 0edcf0a3a73d` | **RED** 54/53/1 | **survived** 54/54/0 |
| M12 | the not-a-list sentence drops "of proposals" | `APPLIED 2a529fd8a9b6 -> 47e1995fbc96` | **RED** 54/53/1 | **survived** 54/54/0 |
| M13 | the no-chat sentence also says what the chat-present sentence says | `APPLIED c5808df9aa97 -> 2aa2d2743d7e` | **RED** 36/35/1 at `:919` | pass, not comparable |
| M14 | the corpus-absent reason also claims the identity-absent one | `APPLIED 96e54c44c7ce -> cd2a32ca95c3` | **RED** 47/46/1 at `:556` | pass, not comparable |
| M15 | the identity-absent reason also claims the corpus-absent one | `APPLIED 96e54c44c7ce -> 114d610fb28d` | **RED** 47/46/1 at `:596` | pass, not comparable |
| M16 | the flat PRIOR sentence borrows the flat MEASURED one | `APPLIED 96e54c44c7ce -> f7c0b25d0ec1` | **RED** 47/46/1 at `:1095` | pass, not comparable |
| M17 | the unreadable sentence also claims the model ran out of room | `APPLIED 2a529fd8a9b6 -> 1e27ce095306` | **RED** 54/53/1 at `:202` | pass, not comparable |
| M18 | the truncated sentence also claims it could not be read as JSON | `APPLIED 2a529fd8a9b6 -> cd8dd6af1a5d` | **RED** 54/53/1 at `:494` | pass, not comparable |
| M19 | `collected_by` names the script but not the step inside it | `APPLIED bbc1ebea6dab -> 5ae92d1db592` | **RED** 27/26/1 at `:553` | **survived** 27/27/0 |
| M20 | the absence opens by naming a machine instead of the missing corpus | `APPLIED bbc1ebea6dab -> 1d9078d6361e` | **RED** 27/26/1 at `:581` | **survived** 27/27/0 |
| M21 | the absence drops the clause saying it cannot be produced here | `APPLIED bbc1ebea6dab -> f8c8aa33bc7b` | **RED** 27/26/1 at `:583` | **survived** 27/27/0 |
| M22 | the sentence names Apple Messages but no longer whose machine | `APPLIED bbc1ebea6dab -> cc35819eea48` | **RED** 27/26/1 at `:596` | **survived** 27/27/0 |
| M23 | the registry cadence keeps "off-server" and drops everything else | `APPLIED bbc1ebea6dab -> a41573912d98` | **RED** 27/26/1 at `:616` | **survived** 27/27/0 |
| M24 | the declared-unpriceable reason keeps "context only" and drops the declaration | `APPLIED bbc1ebea6dab -> 179fcbf4a360` | **RED** 27/26/1 at `:396` | **survived** 27/27/0 |
| M25 | the undeclared-source reason says "undeclared" instead of naming the registry | `APPLIED bbc1ebea6dab -> 16d94927bf6f` | **RED** 27/26/1 at `:417` | **survived** 27/27/0 |
| M26 | the undeclared-source reason stops naming the offending source | `APPLIED bbc1ebea6dab -> d75ff64a058c` | **RED** 27/26/1 at `:420` | **survived** 27/27/0 |
| M27 | a tombstone points at a module instead of a live route | `APPLIED d17644bbc58d -> a21bb2ebc332` | **RED** 5/4/1 at `:66` | **survived** 5/5/0 |
| M28 | the declared-unpriceable reason also claims the source is undeclared | `APPLIED bbc1ebea6dab -> 9366cb155c7e` | **RED** 27/26/1 at `:399` | pass, not comparable |
| M29 | the undeclared-source reason also claims declared priceable: false | `APPLIED bbc1ebea6dab -> 29889afda31e` | **RED** 27/26/1 at `:422` | pass, not comparable |
| M30 | the transactions cadence keeps the script name and drops everything else | `APPLIED bbc1ebea6dab -> 3d4be4b1d5f7` | **RED** 27/26/1 at `:638` | **survived** 27/27/0 |
| M31 | the cache key stops hashing the prompt version | `APPLIED 2a529fd8a9b6 -> d4ebc426b664` | **RED** 55/54/1 at `:171` | **survived** 54/54/0 |
| M32 | the version stays in the key but moves to the end of the material | `APPLIED 2a529fd8a9b6 -> 1464d2457957` | **RED** 55/54/1 at `:171` | **survived** 54/54/0 |
| CONTROL | a pattern that is not in the file | `NO-OP - pattern not found` | — | — |

M13 to M18 are the first pass's negation rows, added after §2b. Each is killed
at the `assert.doesNotMatch` line quoted beside it, which is the point of
running them: those six assertions had no mutation behind them and were
therefore six assertions nobody had shown could fail. Their "old" column is a
pass in every case and carries no information, for the reason §2b gives.

M19 to M30 are the second pass (§2c), and are split by the same rule: M19 to
M27 and M30 are positives, M28 and M29 are the two negations that pass added.
M31 and M32 are the third pass (§2d), both positive, and both killed at the
same line — which §2d records as a finding rather than leaving it to look like
two independent checks. M29 is
worth a line of its own, because the first version of it was a defective row
rather than a result. It inserted the confusable clause into the MIDDLE of the
sentence, which broke the positive assertion's contiguous match, so the runner
reported it killed at `:417` — the `assert.match` — and not at the
`doesNotMatch` it was written for. A negation row that is killed by the
positive beside it measures the positive twice and the negation not at all. The
clause was moved to the end of the sentence and the row re-run; it now kills at
`:422`. The runner's `file:line` is what caught this, not a reading of the
diff.

**The counts, by shape, over both passes.**

| shape | rows | killed by the new assertion | survived the assertion it replaced |
|---|---|---|---|
| positive, first pass (M1-M12) | 12 | 12 of 12 | **11 of 12** |
| positive, second pass (M19-M27, M30) | 10 | 10 of 10 | **10 of 10** |
| positive, third pass (M31-M32) | 2 | 2 of 2 | **2 of 2** |
| positive, total | 24 | 24 of 24 | **23 of 24** |
| negation (M13-M18, M28-M29) | 8 | 8 of 8 | **not comparable** |
| control | 1 | `NO-OP` as listed | — |

The one positive that did not survive its old assertion is M9, in the first
pass, and it is recorded in the table as killed by a DIFFERENT test in the same
file rather than by the assertion under measurement. Every one of the ten
second-pass positives survived, and both third-pass rows did, which is the
stronger result and the expected one: a hedge that the fixture can only satisfy
one branch of will pass any rewording that keeps any branch. The third pass is
the limiting case of that — `/\S/` survives every possible rewording of the
producer, because no rewording of the producer can reach it.

### The edits

**M1** — `server/services/trade-tactics.js`, APPLIED `c5808df9aa97 -> 1993422a224f`

```diff
- const noChat = `this manager has no chat read or negotiation profile touching any player in this `
+ const noChat = `this manager has no chat read touching any player in this `
```

Old `/chat|profile/i` still matches "chat read". New assertion names the whole
clause, so the half that was deleted is the half it reports.

**M2** — `server/services/trade-acceptance.js`, APPLIED `a0c12157cc0a -> 95933450a1d8`

```diff
-      `${delta > 0 ? '+' : ''}${delta}% on his own numbers`);
+      'his own numbers read as neutral');
```

Old `/0\.1|less than|below/i` still matches, because "less than 0.001" is in the
clause the `add` helper appends. This is the exact shape the rule describes: a
neighbouring clause satisfying the pattern.

**M3** — `server/services/trade-acceptance.js`, APPLIED `a0c12157cc0a -> 3663f69c9a20`

```diff
-        reason: `${why} — read, but it moves the band by less than 0.001, so it is reported `
+        reason: `${why} — read, but it moves the band too little to matter, so it is reported `
```

Old pattern still matches on "0.1" from the prefix. The mirror image of M2, and
the reason the assertion had to become two.

**M4** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> b8807aa60f0e`

```diff
-      inert.push({ source, reason: `rests on ${n} of the ${spec.min_n} needed (${spec.needs})`, as_of: asOf });
+      inert.push({ source, reason: `rests on ${n} ${spec.needs}`, as_of: asOf });
```

One mutation, four sites: G2b, G9a, G9b and G9d all read this sentence. The
page loses the sample it NEEDS and keeps the sample it HAS, which reads as a
measurement rather than a shortfall. All four old patterns survived it.

**M5** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> 6000f5d79c46`

```diff
-    return empty('no manager signals for this league yet — scripts/build-manager-signals.mjs has not built it');
+    return empty('no manager signals for this league yet');
```

The script name is the whole value of the sentence: it is what someone reading
an empty page does next.

**M6** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> a59d97209b33`

```diff
-      : 'his declaration record was never read — the chat corpus is not on this machine, so whether his refusals hold is unknown';
+      : 'his declaration record was never read — the chat corpus is unavailable, so whether his refusals hold is unknown';
```

**M7** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> 47818c9f4372`

```diff
-      ? 'his declaration record was never looked up — this league has no confirmed chat identity for him, so whether his refusals hold is unknown'
+      ? 'his declaration record was never looked up — this league has no identity for him, so whether his refusals hold is unknown'
```

**M8** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> 3219844f6bd9`

```diff
       + (informative ? '' : ' — and the answer came back an even spread across the options, which is the '
-        + 'honest answer when there is no evidence')
+        + 'honest answer')
```

**M9** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> 582732cd145d`

```diff
-        : unusable('unreadable', 'the model response could not be read as JSON, so nothing from it '
-          + 'is trusted');
+        : unusable('truncated', 'the model ran out of output room part-way through, so its list of '
+          + 'proposals was cut off mid-answer and could not be read — nothing from a half-written '
+          + 'proposal is trusted');
```

The finding, reproduced: the site at G4 survived this — its old pattern matches
"could not be read", which the truncated sentence also contains. Stated
precisely, because the file was not blind to it overall: `G7 the four failure
modes are told apart` caught the swap. What the old G4 assertion could not do
is tell the two apart ITSELF, under the name "a malformed model response is
refused".

**M10** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> dd1861939940`

```diff
-      `every proposal failed verification and was rejected — ${rejected.length} in total, `
+      'every proposal failed verification and was rejected — '
```

**M11** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> 0edcf0a3a73d`

```diff
-          + 'proposals was cut off mid-answer and could not be read — nothing from a half-written '
+          + 'proposals could not be read — nothing from a half-written '
```

**M12** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> 47e1995fbc96`

```diff
-    return unusable('not_a_list', 'the model response was not a list of proposals');
+    return unusable('not_a_list', 'the model response was not a list');
```

**M13** — `server/services/trade-tactics.js`, APPLIED `c5808df9aa97 -> 2aa2d2743d7e`

```diff
-    + 'deal, so nothing prices his own view of them';
+    + 'deal, so nothing prices his own view of them, and nothing he has said prices a player we are sending above our own number';
```

**M14** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> cd2a32ca95c3`

```diff
-      : 'his declaration record was never read — the chat corpus is not on this machine, so whether his refusals hold is unknown';
+      : 'his declaration record was never read — the chat corpus is not on this machine and this league has no confirmed chat identity for him, so whether his refusals hold is unknown';
```

**M15** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> 114d610fb28d`

```diff
-      ? 'his declaration record was never looked up — this league has no confirmed chat identity for him, so whether his refusals hold is unknown'
+      ? 'his declaration record was never looked up — this league has no confirmed chat identity for him and the chat corpus is not on this machine, so whether his refusals hold is unknown'
```

**M16** — `server/services/counterparty-pricing.js`, APPLIED `96e54c44c7ce -> f7c0b25d0ec1`

```diff
-        + 'honest answer when there is no evidence')
+        + 'honest answer when there is no evidence, and his draft record bears on this question too')
```

**M17** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> 1e27ce095306`

```diff
-        : unusable('unreadable', 'the model response could not be read as JSON, so nothing from it '
+        : unusable('unreadable', 'the model response could not be read as JSON — the model ran out of output room — so nothing from it '
           + 'is trusted');
```

**M18** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> cd8dd6af1a5d`

```diff
-          + 'proposals was cut off mid-answer and could not be read — nothing from a half-written '
+          + 'proposals was cut off mid-answer and could not be read as JSON — nothing from a half-written '
```

**CONTROL a pattern that is not in the file** — `NO-OP - pattern not found`

```diff
- const N_NOT_A_REAL_SYMBOL = 1;
+ const N_NOT_A_REAL_SYMBOL = 2;
```

---

The second pass (§2c). Producer baselines: `server/services/manager-signals.js`
`bbc1ebea6dab`, `server/routes/edge.js` `d17644bbc58d`.

**M19** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> 5ae92d1db592`

```diff
-  const roller = 'the league_chat step of scripts/refresh-live-data.mjs (off-server)';
+  const roller = 'scripts/refresh-live-data.mjs';
```

Old `/refresh-live-data|league_chat/i` still matches the script name. The step
within the script is the half a reader needs to run it, and the old pattern
could not tell the two apart.

**M20** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> 1d9078d6361e`

```diff
-      reason: `there is no chat corpus at ${file} — it cannot be produced on this machine `
+      reason: `the chat corpus is not on this machine: ${file} — it cannot be produced on this machine `
```

Old `/not on this (machine|database)|no chat corpus/i` matches the injected
wording through its FIRST branch — which is the whole point of the site: the
pattern was written to accept either of two different claims. The path is kept
in the injection deliberately, because a neighbouring assertion at `:594`
checks that the sentence names it and would otherwise have killed this row for
an unrelated reason.

**M21** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> f8c8aa33bc7b`

```diff
-      reason: `there is no chat corpus at ${file} — it cannot be produced on this machine `
+      reason: `there is no chat corpus at ${file} `
```

The second half of site 16's split. "Missing here" and "cannot be made here"
are different instructions to the reader — the first says deploy again, the
second says upload — and the old pattern passed on either.

**M22** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> cc35819eea48`

```diff
-        + '(it is extracted from Apple Messages on Nick\'s Mac) but it can be uploaded to this one '
+        + '(it is extracted from Apple Messages) but it can be uploaded to this one '
```

Old `/Mac|Apple Messages/` still matches. Which machine holds the source is the
fact that makes the absence actionable.

**M23** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> a41573912d98`

```diff
-    refreshed: 'only when the league_chat step of scripts/refresh-live-data.mjs is run (off-server; see chat.as_of)',
+    refreshed: 'off-server',
```

Old `/off-server|refresh-live-data/i` matches the two-word replacement exactly.
This string is interpolated into the `why` served on every chat signal row, so
the assertion is a per-metric client-facing claim and is now an equality.

**M24** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> 179fcbf4a360`

```diff
-  return `${spec.label} is declared priceable: false — context only, never priced`;
+  return `${spec.label} is context only`;
```

Old `/priceable|never priced|context only/i` matches the third branch. The
declaration — that a human wrote `priceable: false` on purpose — is the part
that tells a reader there is nothing to fix.

**M25** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> 16d94927bf6f`

```diff
-    return `source '${source}' is not declared in SIGNAL_SOURCES, so nothing may price on it`;
+    return `source '${source}' is undeclared, so nothing may price on it`;
```

Old `/not declared|undeclared|SIGNAL_SOURCES/i` matches through its `undeclared`
branch — a branch the producer never emitted, which is what made the pattern a
hedge rather than a closed set.

**M26** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> d75ff64a058c`

```diff
-    return `source '${source}' is not declared in SIGNAL_SOURCES, so nothing may price on it`;
+    return 'this metric\'s source is not declared in SIGNAL_SOURCES, so nothing may price on it';
```

The source's own name is what turns the reason into a fix; without it the
reader starts with a grep.

**M27** — `server/routes/edge.js`, APPLIED `d17644bbc58d -> a21bb2ebc332`

```diff
-  use: '/api/trades/:leagueId/evaluate',
+  use: 'server/services/trade-engine.js',
```

Old `/\/api\/|trade-engine/` matches the injected value through the branch that
was unreachable in the real code — so the injection is exactly the defect the
dead branch was hiding: a tombstone pointing a caller at a source file instead
of a live route, passing.

**M30** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> 3d4be4b1d5f7`

```diff
-    refreshed: 'only when scripts/collect-league-transactions.mjs is run (off-server; see transactions.as_of)',
+    refreshed: 'scripts/collect-league-transactions.mjs',
```

Old `/collect-league-transactions\.mjs/` matches the bare script path exactly,
which is the whole defect: the fragment was satisfied by a string that had lost
both of the other facts the sentence carries. Site 22, the sibling entry §2c
records as this section's own miss.

**M31** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> d4ebc426b664`

```diff
-    v: PROMPT_VERSION,
+    league_only: true,
```

The version leaves the hashed material entirely, which is the defect the old
line claimed to rule out and could not: `/\S/` on the constant passes here
unchanged, because the constant is still a non-blank string — it just no longer
reaches the key. Killed at `trade-proposals.test.js:171`.

**M32** — `server/services/trade-proposals.js`, APPLIED `2a529fd8a9b6 -> 1464d2457957`

```diff
   const material = JSON.stringify({
-    v: PROMPT_VERSION,
     league: String(leagueId),
     prompt: proposalsPrompt(ideas ?? []),
+    v: PROMPT_VERSION,
   });
```

The subtler of the two: the version is still in the key, so any assertion of the
form "the version is in there somewhere" passes. What changes is the ORDER of
the serialised material, and therefore every key — so the assertion has to know
the exact material, not merely that the version appears in it. Killed at
`trade-proposals.test.js:171`, the same line as M31, for the reason §2d gives.

**M28** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> 9366cb155c7e`, NEGATION

```diff
-  return `${spec.label} is declared priceable: false — context only, never priced`;
+  return `${spec.label} is declared priceable: false — context only, never priced (it is not declared in SIGNAL_SOURCES)`;
```

Killed at the `assert.doesNotMatch` on `manager-data-pipeline.test.js:399`. A
producer that hedges by saying BOTH is what the negation exists to catch.

**M29** — `manager-signals.js`, APPLIED `bbc1ebea6dab -> 29889afda31e`, NEGATION

```diff
-    return `source '${source}' is not declared in SIGNAL_SOURCES, so nothing may price on it`;
+    return `source '${source}' is not declared in SIGNAL_SOURCES, so nothing may price on it (declared priceable: false)`;
```

Killed at the `assert.doesNotMatch` on `manager-data-pipeline.test.js:422`. The
clause is appended rather than inserted, for the reason given in §3: inserted
mid-sentence it broke the positive assertion's contiguous match and measured
the wrong assertion.

## 3b. The check, and what the numbers are worth

Full check on the tree these commits carry, `npm run check` — typecheck, lint,
the whole suite, build and `start:smoke` — exit 0:

**3,008 tests, 2,967 pass, 0 fail, 41 skipped**, 467.6 s; lint clean over 877
JavaScript files; build clean; startup smoke passed on an isolated database.

That 877 is also the tracked count — but only against the right set, and the
loose version of this sentence is a trap I walked into while writing it. The
walker visits `server`, `scripts` and `test` and counts `.js` and `.mjs`
(`scripts/lint.mjs:5`), so the figure to compare is
`git ls-tree -r --name-only HEAD -- server scripts test | grep -cE '\.(js|mjs)$'`,
which is 877. Repo-wide `.js` alone is 780 and repo-wide `.js|.mjs` is 890;
either of those looks like a discrepancy and is only a different question. The
walker counts untracked files too, so the two agreeing is worth stating rather
than assuming — there are no untracked `.js`/`.mjs` under those three roots.

Three things about that figure, because a suite number with none of them is a
number nobody can grade.

**What moved during the run, measured either side.** `git write-tree` before and
after matched, and `node_modules` mtime before and after matched. The two hashes
themselves are in the commit message of the commit that carries this paragraph,
not here: a number describing a tree cannot live inside the tree it describes,
because writing it in changes it. A tree that moves inside the window voids the
run whatever the numbers say, and an install anywhere in the container voids it
the same way with nothing failing visibly — neither shows up as anything but a
wrong number, so a recorded hash that either matches or does not is the only
check that works.

**And what that pair does not measure.** `git write-tree` hashes the INDEX, not
the working tree, and this run was started with two paths modified and unstaged
— this file and `docs/tdd/sweeps/hedged-assertions.mutations.json`. An edit to
either during the window would have left both write-tree hashes identical and
gone unrecorded. What actually pins those two is mtime: 07:14:21Z and 07:14:36Z,
both before the run's own snapshot at 07:14:43Z and its last line at 07:23:26Z.
A guard that reports on a state it cannot see is the same shape as the
assertions this whole file is about, so it is written down rather than left to
be inferred from a matching hash that never had the chance to differ.

**Which isolation this was.** Not source-isolated and not dependency-isolated:
this ran in place in the container's own working tree against the container's
single `node_modules`, with nothing else running against either. That is a
weaker guarantee than an isolated run and the measurements above are what stand
in for it — they say nothing moved, not that nothing could have.

`npm ci` has not been run in this container. A fresh clone fails the
offline-guard tests with `ERR_MODULE_NOT_FOUND` until it is, which looks exactly
like a regression and is not one.

**The base is three commits behind `main`, and that bounds what the total
means.** This branch was cut at `791b131`; `origin/main` is at `654ff93`, three
commits ahead (#49, #52, #63). Those three touch `server/index.js`,
`server/platform/loop-watchdog.js`, `server/services/scheduler.js`, `fly.toml`
and nine test files. Checked, not assumed: the intersection between the files
they touch and the files this branch touches is empty, and the intersection
between them and the seven suites the mutation table runs is also empty. So the
**3,008** total is a total for this tree and will move when `main` comes in —
those nine test files are not in it — while every per-row result in §3 is
measured in suites `main` does not touch and is unaffected by the merge.

**One caveat on the "docs are invisible to the suite" shortcut**, which this file
is a natural place to get wrong. It is false in exactly one place:
`test/nfl-execution-integrity.test.js:258` reads `docs/CLAUDE-NEXT-STEPS.md` byte
for byte, because `nfl-research-lab.js:279` serves that file at runtime and
`paths.js:55` names it `CANONICAL_PLAN`. Editing that one path can turn the suite
red. No commit on this branch touches it — checked against the branch diff, not
assumed — so reusing a suite figure across the docs-only commits here is sound.
Every other path under `docs/` is invisible to typecheck, lint, the suite, the
build and the smoke.

## 4. Coverage of the suites these mutations reach

The union rule: where a suite's RED would be "the module does not exist", one
red proves nothing per test. That is not the case here — every suite below
runs against a module that exists, and each mutation names the individual test
it fails, and now the `file:line` of the assertion that threw. No test in these
seven files is left covered only by a shared red.

The seven: `trade-tactics`, `trade-acceptance`, `valuation-map`,
`trade-proposals`, `manager-signals-api`, `manager-data-pipeline`,
`trade-route-retirement`.

## 5. What was NOT changed

- `test/trade-verify.test.js:212` — a tense variant of one phrase. A real
  closed set, and outside this thread's allocation either way.
- Alternations inside `assert.doesNotMatch`. A `doesNotMatch` with alternatives
  is a wider net on the negative side, which is the safe direction: it asserts
  that NONE of the branches appears. That is why they were left alone — but it
  is also why they need their own mutations rather than inheriting the positive
  rows' evidence, which is §2b.
- Multi-line patterns and patterns built from a variable, of which there are
  none in these seven files.
- The producers themselves. Every mutation in §3 edits a producer and reverts
  it; not one sentence this suite reads was reworded to suit a test. Where the
  second pass found a sentence it wanted to be more specific, it made the
  ASSERTION more specific and left the sentence alone. The one exception worth
  naming is site 21, where the contract the assertion described ("an API path
  or a module") turned out to be wider than the code's — and there too the code
  did not move: every tombstone already pointed at a route, and the test now
  says so.
