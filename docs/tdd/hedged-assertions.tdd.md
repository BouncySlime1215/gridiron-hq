# Assertions that hedged on wording, and what they were hiding

A sweep of every `assert.match` in this thread's files whose pattern is an
alternation — a literal regex with a `|` in it, on one line, against one value.

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

- **Well built?** The subject is the test suite itself. Ten assertions across
  four files asserted the existence of a sentence rather than its content; each
  now names the one clause that carries the fact, and, where two sentences in
  the same code are confusable, rules the other one out by name.
- **Stats or made up?** Neither — these are string contracts. The numbers here
  are mutation counts, and every one of them was run, not reasoned about.
- **How do we know?** Twelve mutations, each applied to the PRODUCER of the
  sentence, with the file's SHA-256 before and after. Eleven of twelve survived
  the assertion they replaced and are killed by the new one. The twelfth (M9)
  was killed by a different test in the same file, which is recorded as such.
- **Pointed anywhere else?** The same shape is worth a pass over every suite,
  not only these four. Two files outside this thread's allocation
  (`test/trade-verify.test.js`, and the rest of `test/trade-proposals.test.js`'s
  sibling suites) were read and left alone: `trade-verify.test.js:212` is a
  tense variant of one phrase, which is a real closed set.
- **How does it unify?** One question answers every case: *can the fixture
  produce more than one branch?* If it cannot, the pattern is a hedge. That
  question is cheaper to ask than the taxonomy it replaces.

## 1. The ten sites, and the fact each one was hiding

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

Re-derived with that runner on `c791faa`: **13 of 13 rows behaved as the list
says**, every `APPLIED` hash identical to the table below, and the four suites
left byte-identical to `HEAD` afterwards.

Baselines: `server/services/trade-tactics.js` `c5808df9aa97`,
`server/services/trade-acceptance.js` `a0c12157cc0a`,
`server/services/counterparty-pricing.js` `96e54c44c7ce`,
`server/services/trade-proposals.js` `2a529fd8a9b6`.

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
| CONTROL | a pattern that is not in the file | `NO-OP - pattern not found` | — | — |

**12 of 12 killed by the new assertions. 11 of 12 survived the assertions they
replaced**, which is the measurement this sweep exists to take.

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

**CONTROL a pattern that is not in the file** — `NO-OP - pattern not found`

```diff
- const N_NOT_A_REAL_SYMBOL = 1;
+ const N_NOT_A_REAL_SYMBOL = 2;
```

## 4. Coverage of the suites these mutations reach

The union rule: where a suite's RED would be "the module does not exist", one
red proves nothing per test. That is not the case here — every suite below
runs against a module that exists, and each mutation names the individual test
it fails. No test in these four files is left covered only by a shared red.

## 5. What was NOT changed

- `test/trade-verify.test.js:212` — a tense variant of one phrase. A real
  closed set, and outside this thread's allocation either way.
- Alternations inside `assert.doesNotMatch`. A `doesNotMatch` with alternatives
  is a wider net on the negative side, which is the safe direction: it asserts
  that NONE of the branches appears.
- Multi-line patterns and patterns built from a variable, of which there are
  none in these four files.
