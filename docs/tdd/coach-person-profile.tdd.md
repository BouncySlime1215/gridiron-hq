# TDD evidence: per-person context rules and the counted half of a profile (2026-09-20)

**Item:** Nick, 2026-09-20 04:30Z — "I want real data on how to negotiate with all types
of people. I want our analysis of these people to be scored on TONNSSS of physiology
variables to create an aggregate of who this person is. Read my entire text chain with
each person to understand who they are. Understand the context." And: "Heads up for Josh
smith btw we coach a flag football team together so try not to mix that up. Like if he's
talking about how we need a qb that means the team. He will use the word we so that's
the team not fantasy."
**Slice:** 6 of the Coach rebuild — the facts about a person that change what their
words mean, and the variables that can be counted from a chain.
**Files:** `server/services/coach/people/context.js`,
`server/services/coach/people/lexicons.js`,
`server/services/coach/people/variables.js`; tests
`test/coach-person-context.test.js`, `test/coach-person-variables.test.js`.
**Commits:** RED `6777080` and `a5ff823`, GREEN `707b4e4` and `26cbf2a`,
mutation-driven test `829d3b6`, this file after them.
**LLM spend:** $0. Nothing here calls a model; it is arithmetic over messages.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0). **The real chat corpus is not on this machine and was not read.** Every
number below is from a synthetic fixture with invented people.

## 1. Audit: what reads the chain today

The builder that exists is `scripts/build-negotiation-profiles.mjs`. It reads at most
160 trade-flagged messages per person (`:45`) and asks a model to write prose about
them. Two things follow from that and both are in Nick's ask.

**It does not read the entire chain.** Nick asked for the whole thing, and 160
trade-flagged messages is a sample selected by the very topic filter that decides what
counts as relevant. Anything about a person that shows up outside trade talk — when they
reply, how they talk when they are losing, whether they go quiet — is invisible to it by
construction.

**Prose cannot be graded.** A paragraph saying someone is "an aggressive negotiator who
responds quickly" cannot be checked against what they did, cannot be compared between
two people, and cannot be told apart from the same paragraph written about someone else.
Nick asked for people to be "scored on TONNSSS of variables", which is a request for
numbers, and numbers can be wrong in a way prose cannot — which is the point.

The corresponding discipline already exists in this codebase and was copied rather than
reinvented: `manager-signals.js` withholds `tx_accept_rate` below a sample floor, and no
draft metric survived its repeatability test (`manager-signals.js:73-76`). Both rules are
applied here to everything.

## 2. What was built

### `context.js` — the Josh Smith heads-up as a row, not an exception

The obvious thing to do with Nick's heads-up is write an exception into the classifier.
This stores it as a row instead, with who said it and when:

```
person       Josh Smith
scope        pronoun
rule         He and Nick coach a flag football team together, so "we" in his messages
             means that team, not a fantasy roster …
applies_when we, us, our, we're, we need
author       Nick Matta
stated_at    2026-09-20T04:30:38Z
```

It is stored as data because it is the first of a kind and not a one-off. Everyone in a
chain has something about them that changes how to read them — a nickname that is a
person rather than a player, a second league, a brother who jokes harder than he means
it — and the next one of those should be addable without a deploy.

**Matching is the hard part and it is where this would go wrong silently.** A rule keyed
on "we" has to fire on "we need a QB" and must not fire on "week", "weather" or "were".
Triggers are matched as whole words or whole phrases, escaped, with unicode boundaries
asserted on either side rather than `\b` so a phrase ending in punctuation still matches.
A caller-supplied regular expression is never accepted, which would be both a matching
bug and a denial-of-service waiting to happen. M46 made matching a substring and a test
kills it on exactly the "week"/"weather"/"were" case.

Retiring a rule keeps the row. What was believed, by whom, and when it stopped being
believed is the record; deleting it loses the thing that makes a profile auditable later.

### `variables.js` — 40 counted variables, each with its sample size

Six families: responsiveness, style, negotiation, disposition, social, context. Every
variable carries `n`, the observations it rests on, and three rules hold:

**A thin variable is withheld, not reported as zero.** A reply latency from two
observations and one from two hundred must not look alike, and the zero a naive count
returns is the most confident-looking wrong number there is. Below `MIN_N = 5` the value
is `null` and a `withheld` sentence says why. M50 reported them anyway; two tests die.

**Nothing is priceable until it has been graded.** Every variable ships
`priceable: false`. Only a grading harness may flip it, the same way no draft metric
survived its repeatability test. M51 flipped it early and a test catches that.

**A variable the extractor already computes is read, never recomputed.** Thirteen of
the forty are read straight off `manager_chat_profile` with `source: 'extractor'`. Two
implementations of "night share" would eventually disagree and nobody would know which
screen was right. M52 recomputes it here from message timestamps and a test kills it.

The subtle one is what counts as a reply. A message is a reply when it follows someone
*else* more recently than it follows the speaker's own last message; otherwise it is a
continuation of his own turn, and counting it would report a man who answers in three
minutes as one who answers in one. That refinement survived the first mutation pass and
is discussed below.

**No message text survives into a profile.** A test serialises the whole output and
asserts none of the fixture's message bodies appear in it, so a derived profile could
leave the machine even though the corpus cannot. M54 leaks the last message and dies.

**`NOT_COMPUTED` names five variables that cannot be computed here**, each with what is
missing. The one the playbook most depends on is `concession_after_counter` — how much a
person moves after being countered — which needs proposals joined to the chain and has
no join key today.

## 3. RED and GREEN

RED `6777080` (context) and `a5ff823` (variables): both suites written against modules
that do not exist; 0 pass.
GREEN `707b4e4` and `26cbf2a`: 22 tests pass, 0 fail. After the mutation run below and
the test it forced, the suites stand at **23 pass, 0 fail** (11 context, 12 variables).

Three failures during GREEN were all fixture or implementation faults rather than test
faults, and are recorded because two of them were nearly resolved the wrong way.
`context_rules` and `context_rule_hits` were pushed onto the output directly instead of
through `add()`, so they reported values below the sample floor — fixed in the
implementation, not by relaxing the test. `confidence_volatility` was correctly withheld
because the fixture had four signals; the fixture was given a fifth. And the fixture's
message counts were written as 16 where the person has 15, and `question_rate` was
asserted at 2 where only one message carried a `?`; the fixture and the expectations
were both corrected to the real counts.

## 4. Mutation table — every injection APPLIED, by hash

Every row was re-measured at head `fdfebf5`, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/person.json

The harness hashes the file, applies one literal substitution, runs the named suites,
restores the file and proves the restore by hashing it again. **The literal text of every
row's injection is quoted in `docs/tdd/sweeps/EDITS.md`**, generated from those same spec
files with a staleness gate in the suite, so the quotation cannot describe an injection
nobody ran. The
SHA-256 pair is the point of the row: a diffstat says something changed, a hash pair says
exactly which bytes the suite was run against, so the row can be reproduced without
guessing at the injection. A row whose anchor is not in the source is reported NOT
APPLIED rather than scoring zero failures — that happened once in this sweep (M12's
anchor had the wrong punctuation) and is the failure mode the control below exists for.

**The last row of the table is a NO-OP control.** It rewords a sentence of the file's own
header: the hash moves, so the harness demonstrably applied it, and no test fails, so a
zero in the "Red" column is a real result rather than a silent non-match. Without it, an
injection that quietly failed to apply would look exactly like an injection the suite
survives.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| M46 | a context trigger matches as a substring, so "we" fires on "week" | `context.js` | `0fd8c764` → `ce89b389` | 1 | `coach-person-context.test.js` — "we" does not fire on week, weather or were |
| M47 | every rule applies to every person | `context.js` | `0fd8c764` → `29cdb7d0` | 5 | `coach-person-context.test.js` — one person's rule never touches another person's messages |
| M48 | a retired rule keeps applying | `context.js` | `0fd8c764` → `1a735e67` | 1 | `coach-person-context.test.js` — a retired rule stops applying but stays on the record |
| M49 | a context rule with no author is accepted | `context.js` | `0fd8c764` → `69403591` | 1 | `coach-person-context.test.js` — a rule can be added for anyone, and it needs a person, a scope, a rule and an author |
| M50 | a variable measured on too few observations is reported rather than withheld | `variables.js` | `0eac7e63` → `cca5845b` | 4 | `coach-person-profile-script.test.js` — --write loads the derived table, with the sample size on every row |
| M51 | variables ship priceable before the grading harness has run | `variables.js` | `0eac7e63` → `6545fe57` | 1 | `coach-person-variables.test.js` — a person with real volume gets variables, each with its own sample size |
| M52 | night share is recomputed here instead of read from the extractor | `variables.js` | `0eac7e63` → `a63ed8a9` | 1 | `coach-person-variables.test.js` — the extractor’s own aggregates are read, not recomputed |
| M53 | a continuation of a speaker's own turn counts as a reply *(survived the first pass; the test in the last column was written for it)* | `variables.js` | `0eac7e63` → `ad79b8ad` | 1 | `coach-person-variables.test.js` — talking to himself is not replying to anyone |
| M54 | a message carries through into the profile, on a person with enough messages to clear the sample floor | `variables.js` | `0eac7e63` → `e545a3e1` | 1 | `coach-person-profile-script.test.js` — nothing the script stored carries a message, so the table can leave the machine |
| M55 | the list of variables that cannot be computed is dropped | `variables.js` | `0eac7e63` → `b59a978a` | 1 | `coach-person-variables.test.js` — a variable we cannot compute is named, with what is missing |
| NC-context | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `context.js` | `0fd8c764` → `5f3ac758` | **0** | none — and that is the assertion |
| NC-variables | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `variables.js` | `0eac7e63` → `df76e2b3` | **0** | none — and that is the assertion |

**M53, the survivor.** Replacing the reply rule with a bare "did anyone else speak
before this" changed nothing the suite could see. The fixture's ten reply pairs were each
preceded by a message of Nick's with nothing of the speaker's in between, so the
refinement never altered the count; and the four consecutive style messages sat fifteen
hours after the last thing Nick said, outside the six-hour reply window, so they were
filtered on the gap rather than on the rule. The fixture now includes a person whose
shape is the one the rule exists for — five clean exchanges, then a burst where he
answers once and then keeps talking — and the count is six replies, not eight. Commit
`829d3b6`.

## 5. The five questions

**Is this well built?** The two halves are deliberately different kinds of thing and that
is the design. Context rules are stated facts with an author and a date, because a fact
about a person is not something to infer from their messages; variables are counted, with
a sample size on every one. The weakest part is honest and marked: 40 variables measured
on a synthetic fixture prove the arithmetic, not the variables. Until the grading harness
runs on a real chain, every one of them ships `priceable: false` and none should reach a
price.

**Is it based on stats, or made up?** Counted, from messages, with the count attached. Of
the forty: 25 are computed here from timestamps and message text, 2 from the extractor's
typed chat signals, and 13 are read from its `manager_chat_profile` aggregates rather
than recomputed. Five more are named as not computable, with the reason. Nick's phrase was "physiology variables"; what can honestly be measured
from a text chain is behaviour — when someone replies, how long they write, how often
they hedge, how they sound when they are losing — so that is what these are, and calling
them anything more would be the invention this whole rebuild exists to remove.

**How do we know?** 23 tests and 10 injections, each stated above with the file's SHA-256
before and after it, all now killed, beside one no-op control per source file that moves
the hash and kills nothing; one survived the first pass and produced a new fixture and
test, and M54 was sharpened in this sweep so that it clears the sample floor, which moved
its killer to the test that says no message text may reach the stored table. The grading harness
is not built yet, so the correct statement about accuracy is that there isn't one: these
numbers are arithmetic that has been verified, not predictions that have been checked.

**Should this data be pointed anywhere else on the platform?** Yes, and carefully.
`counterparty-pricing` and `trade-acceptance` are the natural consumers and belong to
another thread; nothing should be handed to them until grading passes, because a variable
with no measured skill entering a price is exactly how a made-up number becomes a
recommendation. The context rules are a different case and are useful immediately:
anything that reads a manager's messages — the archetype builder, the chat sync, the
trade tactics copy — should apply them, because "we need a QB" being read as trade
interest is a wrong answer today and a row fixes it.

**How does it unify?** It gives the platform one place where a fact about a person lives,
with an author and a date, instead of an exception per classifier; and one place where a
person's countable behaviour lives, with sample sizes, instead of a paragraph per
screen. Coach reads both, so what Coach says about someone and what the trade tools price
about them can be the same thing rather than two opinions.

## 6. What this slice does not do

**The real corpus has not been read.** It is at `data/derived/league_chat.sqlite` on
Nick's machine and never ships off it — the deployment plan says so in as many words
(`docs/FANTASY-ENGINE-MASTER-PLAN.md:1098`, "Never `league_chat.sqlite` for anyone
else's provisioning"); this
container has none of it. So the fixture proves the arithmetic and nothing about any real
person, and two things need Nick's answer before that changes: whether the corpus should
be read at all for this, and whether personal chains outside fantasy are in scope.

**There is no grading harness.** The plan is a 70/30 split per person — mean absolute
error for reply latency, Brier score for the ghost, counter and hard-no rates, rank
correlation for the style variables — with `priceable` flipped only on a pass and every
failure reported by name. Until it exists, "40 variables" is a count of things measured,
not of things known to be true.

**Neither module is wired into Coach's tool list**, and no UI shows a profile. The
context rules are seeded but nothing applies them to an incoming message yet.
