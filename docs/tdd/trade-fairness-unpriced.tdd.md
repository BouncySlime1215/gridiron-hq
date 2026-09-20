# trade-fairness-unpriced — TDD report

**Item:** A trade the model could not price has been displaying as a perfectly
balanced trade, on the deployed app, for as long as both states have existed.

**Files changed:** `client/src/components/TradeCard.tsx`,
`client/src/pages/TradeLab.tsx`, `test/trade-fairness-unpriced.test.js` (new),
this document. No server file: `server/services/trade-engine.js` belongs to the
feature-audit thread and is only read here.

**Branch:** `claude/project-thread-xiezr0-trade-tone-hold`. No PR. Nothing is
deployed and no database is touched.

---

## The five questions

**Is this well built?** It is a rendering fix plus a contract the server has not
shipped yet. The card now renders four fields it does not receive, in a form
that is correct while they are absent and correct once they arrive — §3 is the
test that holds that line.

**Is this based on stats, or is it made up?** Neither: every claim below is a
string read out of source and an executed test. The one number the card would
have invented — a count of unpriced players when nothing served a count — is
the defect §3 exists to prevent.

**How do we know?** Twenty-four mutations at `af7f01a`, each proved applied by
its file's SHA-256 before and after, each named with the test title that turned
red. Two deliberate no-op controls were applied and survived. One mutation
survived its first run and is written up in §5, because a survivor is a finding.

**Should this data be pointed anywhere else on the platform?** The fairness
label is rendered on two surfaces — the card and the deal list — and fixing one
would have left the other. Both now share `fairnessTone`. Nothing else renders
it.

**How does it unify?** It moves the absence states onto the basis ramp, the
vocabulary the rest of this app already uses for "where did this number come
from". An unpriced deal is now the same colour as an unfitted availability.

---

## 1. The defect

`fairnessLabel` (`server/services/trade-engine.js:1327`) opens:

```js
function fairnessLabel(delta, total) {
  if (!total) return 'unpriced';
```

`FAIRNESS_TONE` in `TradeCard.tsx` had entries for the five graded values and
none for `'unpriced'`, so it fell through to a fallback of
`text-[var(--muted)]` — **byte-identical** to the tone for `'even money'`.

Nothing failed. The label was correct; the styling said the opposite of it. A
manager reading the card saw the word "unpriced" in the same grey as a deal the
model had weighed and called level.

This is the shipped state on `main`, not a risk introduced by this change. It
is reproduced as the mutation row "unpriced goes back to the even-money tone
(the shipped defect)" in §4, which is red.

## 2. What the fix is

Three absence states, three tones, all from the basis ramp:

| Value | Token | Means |
|---|---|---|
| `unpriced` | `--basis-none` | nothing in the deal could be priced |
| `partly unpriced` | `--basis-missing` | some players had no market row |
| anything unrecognised | `--basis-unknown` | a value this build has not heard of |

The ramp rather than `--good`/`--warn`/`--crit` because an unpriced deal is not
a bad deal; it is an unanswered question, and a verdict colour would tell a
manager something about his trade that nobody measured.

Each of the two named states carries a sentence on screen, not on a hover — the
same reason `BasisChip` renders its sentence: a `title` reaches a mouse and
nothing else, and this app is read on a phone.

## 3. The four fields the server does not send yet

Feature audit's contract, relayed 08:02Z: four counts per deal on the side
objects — `me.value_out_unpriced`, `me.value_in_unpriced`, and the same pair
from the other chair. Counts of **players**, never amounts; there is no amount
to report, which is the point.

Two things follow, and both are tested:

**One line per leg, not one per side.** In a two-party deal the same player is
one side's `out` and the other's `in`, so a single per-side count is identical
on both sides and says nothing about who is short-changed. Each line names the
one total it explains.

**A zero is not a fallback.** `(s.value_out_unpriced ?? 0) + (s.value_in_unpriced ?? 0)`
is `0` while the fields are absent, and "0 of these players have no market
value" claims the exact opposite of the label above it — on every deal, until
the day the fields ship. So `fairnessNote` returns the indefinite sentence when
the count is absent and splices the number in only when there is one, and rows
render only for a leg whose count is above zero.

The count in the sentence adds my two legs and not the other chair's, because
the same player appears in both chairs and adding all four would count
everybody twice.

## 4. RED, and the mutations

The test file does not load at all against `af7f01a`'s `TradeCard.tsx`: it
reads the `FAIRNESS_NOTE` map out of source, and that map does not exist there.
That is a real RED and a weak one — the file fails before any assertion runs,
so it proves only that something changed. The per-assertion evidence is the
table: every mutation below was applied to the tip tree, verified by the file's
SHA-256 before and after, is named with the test title that turned red, and
quotes its exact before and after text so it can be reproduced from this file
rather than taken on trust.

Run at `af7f01a` + the working tree of this commit, `test/trade-fairness-unpriced.test.js`, 9 tests.

**T1 unpriced loses its tone entry** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `d9558685a013` — **RED**, 3 failing · killed by *the server can send a value with no tone, and this is the one it sends*

```diff
-  unpriced: 'text-[var(--basis-none)]',
-
+  (the text is removed)
```

**T1 the server starts sending a seventh value** (`server/services/trade-engine.js`) — APPLIED `9a6539ccbdf1` → `12f0fd3e8743` — **RED**, 1 failing · killed by *the server can send a value with no tone, and this is the one it sends*

```diff
-  if (!total) return 'unpriced';
+  if (!total) return 'unpriced';
+  if (total < 0) return 'negative value';
```

**T1 fairnessLabel is renamed so the slice anchor is gone** (`server/services/trade-engine.js`) — APPLIED `9a6539ccbdf1` → `941b28f8202b` — **RED**, 1 failing · killed by *the server can send a value with no tone, and this is the one it sends*

```diff
-function fairnessLabel(delta, total) {
+function fairnessLabel2(delta, total) {
```

**T2 unpriced goes back to the even-money tone (the shipped defect)** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `5017075dfd4b` — **RED**, 2 failing · killed by *an absence never wears the tone of an answer*

```diff
-  unpriced: 'text-[var(--basis-none)]',
+  unpriced: 'text-[var(--muted)]',
```

**T2 the fallback goes back to the even-money tone** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `d57904d7cd07` — **RED**, 2 failing · killed by *an absence never wears the tone of an answer*

```diff
-export const FAIRNESS_FALLBACK = 'text-[var(--basis-unknown)]';
+export const FAIRNESS_FALLBACK = 'text-[var(--muted)]';
```

**T2 the two absence tones are merged into one** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `40a83c17bbe0` — **RED**, 1 failing · killed by *an absence never wears the tone of an answer*

```diff
-  'partly unpriced': 'text-[var(--basis-missing)]'
+  'partly unpriced': 'text-[var(--basis-none)]'
```

**T3 unpriced is styled as a verdict** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `2bfac30931b3` — **RED**, 1 failing · killed by *the absence tones come from the basis ramp, not the semantic colours*

```diff
-  unpriced: 'text-[var(--basis-none)]',
+  unpriced: 'text-crit',
```

**T3 the fallback stops reading as unknown** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `fe45593a3a8a` — **RED**, 2 failing · killed by *an absence never wears the tone of an answer*

```diff
-export const FAIRNESS_FALLBACK = 'text-[var(--basis-unknown)]';
+export const FAIRNESS_FALLBACK = 'text-[var(--basis-missing)]';
```

**T4 the sentence stops rendering** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `47e80f91261e` — **RED**, 1 failing · killed by *the absence is explained in plain words, on screen and not on hover*

```diff
-      {fairnessNote(deal) && (
+      {false && fairnessNote(deal) && (
```

**T4 the sentence moves to a hover** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `e39ab63df826` — **RED**, 1 failing · killed by *the absence is explained in plain words, on screen and not on hover*

```diff
-        <p className="text-[11px] leading-relaxed text-[var(--muted)] mb-2">
-          {fairnessNote(deal)}
-        </p>
+        <p className="text-[11px] leading-relaxed text-[var(--muted)] mb-2" title={fairnessNote(deal) ?? undefined}>
+          &nbsp;
+        </p>
```

**T4 the unpriced sentence stops saying what it is not** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `ffbbcac8c570` — **RED**, 1 failing · killed by *the absence is explained in plain words, on screen and not on hover*

```diff
- This is not a balanced deal — it is an unanswered question.
+  (the text is removed)
```

**T4 the partly-unpriced sentence stops naming the unknown direction** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `093aab2edc69` — **RED**, 1 failing · killed by *the absence is explained in plain words, on screen and not on hover*

```diff
- — the deal may be better or worse than it looks, and we don't know which.
+.
```

**T4 both absences get the same sentence** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `264f31895a28` — **RED**, 1 failing · killed by *the absence is explained in plain words, on screen and not on hover*

```diff
-'partly unpriced': "We can't price everyone in this trade. Some of these players have no market value we can read, so the numbers below leave them out entirely — the deal may be better or worse than it looks, and we don't know which."
+  'partly unpriced': 'None of these players has a trade value on file, so there is nothing here to compare. This is not a balanced deal — it is an unanswered question.'
```

**T4 the sentence stops naming the absence the row names** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `91111e1b5fe8` — **RED**, 1 failing · killed by *the absence is explained in plain words, on screen and not on hover*

```diff
-Some of these players have no market value we can read
+Some of these players are missing from the figures
```

**T5 a zero count is spliced in as a number** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `df58150d1972` — **RED**, 1 failing · killed by *the count is spliced into the sentence only when the server sent one*

```diff
-  if (!n) return base;
-
+  (the text is removed)
```

**T5 the count adds the other chair and double-counts** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `ebff2f9dfb40` — **RED**, 1 failing · killed by *the count is spliced into the sentence only when the server sent one*

```diff
-const n = (deal?.me?.value_out_unpriced ?? 0) + (deal?.me?.value_in_unpriced ?? 0);
+const n = (deal?.me?.value_out_unpriced ?? 0) + (deal?.them?.value_in_unpriced ?? 0);
```

**T5 the spliced sentence stops agreeing with its number** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `5d563d12ecfa` — **RED**, 1 failing · killed by *the count is spliced into the sentence only when the server sent one*

```diff
-`${n} of these players ${n === 1 ? 'has' : 'have'}`
+`${n} of these players have`
```

**T6 the deal list prints the label untoned** (`client/src/pages/TradeLab.tsx`) — APPLIED `7fe62418f0da` → `6b3b7add5ed7` — **RED**, 1 failing · killed by *the deal list carries the same tone as the card*

```diff
-<span className={fairnessTone(d.fairness)}>{d.fairness}</span>
+<span>{d.fairness}</span>
```

**T6 the list grows its own tone logic** (`client/src/pages/TradeLab.tsx`) — APPLIED `7fe62418f0da` → `dd74bb8e9b25` — **RED**, 1 failing · killed by *the deal list carries the same tone as the card*

```diff
-import TradeCard, { PlayerPill, num, fairnessTone } from '../components/TradeCard';
+import TradeCard, { PlayerPill, num } from '../components/TradeCard';
+const fairnessTone = (f: string) => f === 'even money' ? 'text-[var(--muted)]' : '';
```

**T7 a leg with no unpriced players still renders a row** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `fe601af18be8` — **RED**, 1 failing · killed by *the unpriced count renders per leg, only where there is one*

```diff
-        ].filter(l => (l.n ?? 0) > 0).map(l => (
+        ].map(l => (
```

**T7 the arriving leg stops being read** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `b740dcbd8625` — **RED**, 1 failing · killed by *the unpriced count renders per leg, only where there is one*

```diff
-          { n: s.value_in_unpriced, leg: mine ? 'arriving on your roster' : 'arriving on theirs' }
-
+  (the text is removed)
```

**T7 the two legs collapse into one per-side count** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `cdea255e7443` — **RED**, 1 failing · killed by *the unpriced count renders per leg, only where there is one*

```diff
-          { n: s.value_out_unpriced, leg: mine ? 'leaving your roster' : 'leaving theirs' },
+          { n: (s.value_out_unpriced ?? 0) + (s.value_in_unpriced ?? 0), leg: mine ? 'in this deal' : 'in this deal' },
```

**T7 the row stops counting players** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `818c70be2cbc` — **RED**, 1 failing · killed by *the unpriced count renders per leg, only where there is one*

```diff
-{l.n === 1 ? 'player' : 'players'}
+{l.n === 1 ? 'asset' : 'assets'}
```

**T7 the row stops saying what the count means** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `54270aa94d91` — **RED**, 1 failing · killed by *the unpriced count renders per leg, only where there is one*

```diff
-{l.n === 1 ? 'has' : 'have'} no market value we can read
+{l.n === 1 ? 'has' : 'have'} no price
```

**T8 the card calls seventeen weeks "the season" again** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `bbded4cf6dc2` — **RED**, 1 failing · killed by *the horizon line names the horizon the number was actually charged over*

```diff
-{s.season_delta != null && (
-          <> · {num(s.season_delta, 0)} {horizonPhrase(s)}</>
+{s.season_delta != null && (
+          <> · {num(s.season_delta, 0)} over the season</>
```

**T8 the line stops asking what horizon it is printing** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `fb78e7c67a0a` — **RED**, 1 failing · killed by *the horizon line names the horizon the number was actually charged over*

```diff
-{num(s.season_delta, 0)} {horizonPhrase(s)}
+{num(s.season_delta, 0)} over 17 weeks
```

**T8 a missing season_delta still renders a horizon sentence** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `f94b91ca69b5` — **RED**, 1 failing · killed by *the horizon line names the horizon the number was actually charged over*

```diff
-{s.season_delta != null && (
-          <> · {num(s.season_delta, 0)} {horizonPhrase(s)}
+{(
+          <> · {num(s.season_delta, 0)} {horizonPhrase(s)}
```

**T9 the served basis stops being read** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `47d4af8a279f` — **RED**, 1 failing · killed by *each of the three horizon states gets the sentence that is true of it*

```diff
-if (s?.season_delta_basis === 'weeks_remaining') return `over the ${weeks} weeks left`;
-
+  (the text is removed)
```

**T9 the remaining-weeks wording is replaced by the default one** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `8e5c0d776c17` — **RED**, 1 failing · killed by *each of the three horizon states gets the sentence that is true of it*

```diff
-return `over the ${weeks} weeks left`;
+return `over ${weeks} weeks`;
```

**T9 a served default horizon is printed as a literal 17** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `a76868eab84b` — **RED**, 1 failing · killed by *each of the three horizon states gets the sentence that is true of it*

```diff
-if that weekly gain held for a full ${weeks}-week season
+if that weekly gain held for a full 17-week season
```

**T9 the default stops being labelled as a default** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `1474e9c3a1f9` — **RED**, 1 failing · killed by *each of the three horizon states gets the sentence that is true of it*

```diff
-, which is a default rather than this league's own length
+  (the text is removed)
```

**T9 the no-fields fallback is dropped** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `14d5ab069af0` — **RED**, 1 failing · killed by *each of the three horizon states gets the sentence that is true of it*

```diff
-  if (weeks == null) return 'if that weekly gain held for a full 17-week season';
-
+  (the text is removed)
```

**NO-OP CONTROL: a word in a comment** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `0444efd617ff` — **green — survived, as intended**

```diff
- * Without this the label is a word a manager has to guess at:
+ * Without this the label is a term a manager has to guess at:
```

**NO-OP CONTROL: whitespace in the deal-list markup** (`client/src/pages/TradeLab.tsx`) — APPLIED `7fe62418f0da` → `b8972a1f7de3` — **green — survived, as intended**

```diff
-<span className={fairnessTone(d.fairness)}>{d.fairness}</span>
+<span className={fairnessTone(d.fairness)}>{d.fairness}</span>{' '}
```

**NO-OP CONTROL: a word in the horizon comment** (`client/src/components/TradeCard.tsx`) — APPLIED `75a1f313ca52` → `e93c6d0136fd` — **green — survived, as intended**

```diff
- * What horizon the season figure was charged over,
+ * Which horizon the season figure was charged over,
```

32 mutations, 32 red, each by the test that names it. All three controls were
applied — they are real edits to the file, not patterns that failed to match —
and all three survived, which is what shows the assertions are reading the
things they claim to read and not the file as a whole.

## 5. The survivor, and the fourth anchor bug

**A mutation survived on the first run.** "The row stops saying what the count
means" replaced `no market value we can read` — and that phrase occurs twice in
the file, in the sentence and in the row. A first-occurrence replace landed on
the sentence, which nothing was asserting, so the row's assertion stayed green
and the mutation reported as survived. Both holes were real:

- the mutation was re-anchored on `{l.n === 1 ? 'has' : 'have'} no market value we can read`, which occurs once;
- and the sentence gained its own assertion, because the two copies describe the same fact and a change to either would otherwise go unnoticed in the other.

Both rows are red in the table above. Nothing here is declared equivalent;
there are no unkilled mutations left in this set.

**This file's first draft could not fail.** It sliced `fairnessLabel` out of
`trade-engine.js` with `engine.indexOf('/* -----')` as the closing anchor. That
token occurs eleven times in the file and first occurs 1,161 lines *before* the
function, so the slice ran backwards and came out empty, and the assertion
failed reporting "found 0" — a failure with nothing to do with the code.

That is the **fourth** instance of this class in this stack:

| # | Where | Shape |
|---|---|---|
| 1 | `title-odds-drill.test.js` | sliced on `method:`, which is a `fetch` option 130 lines earlier |
| 2 | `capture-bookmarklet-surface.test.js` | a double-escaped RegExp matched a literal backslash |
| 3 | `deleted-pages-stay-deleted.test.js` | a literal matched anywhere in the file rather than inside the entry |
| 4 | this file | sliced on a comment rule that occurs eleven times |

So every slice in this file now asserts that it landed where it says: the
`fairnessLabel` slice checks that it starts at the declaration, reaches the last
branch, and is under 2,000 characters; `literalBetween` counts the entries
declared in the block and fails if it parsed fewer.

`literalBetween` earned that guard immediately. Its first version knew only
single-quoted values, and the partly-unpriced sentence is double-quoted because
it contains apostrophes — so the entry read as **absent** when it was merely
quoted differently. The count check is what turns that from a silent skip into
a failure.

## 6. The horizon line, which was wrong in both directions

`TradeCard.tsx` printed `{season_delta} over the season`. The server computes
`ppg_delta × GAMES` with `GAMES` fixed at 17 (`trade-engine.js:119`, `:1096`),
so at week 2 of a league ending in week 16 the number covers seventeen weeks
that do not exist, and "the season" describes neither seventeen weeks nor the
fifteen that remain. Calling it "the rest of the season" would have been the
second wrong answer, not the fix.

Feature audit froze the payload while this was being written, so the line reads
it. `season_delta_basis` says which horizon the figure was charged over and
`season_delta_weeks` says how many weeks were actually multiplied. Three states,
three true sentences, in `horizonPhrase`:

| `season_delta_basis` | Sentence |
|---|---|
| `weeks_remaining` | *over the N weeks left* |
| `full_season_default` | *if that weekly gain held for a full N-week season, which is a default rather than this league's own length* |
| fields absent | *if that weekly gain held for a full 17-week season* |

**The served count is printed, never a literal 17.** A default that changes
would otherwise leave this sentence asserting a number the payload no longer
carries — the same class of error as the string it replaces, one release later.
A test counts the occurrences of `17` in the function and fails at two, so the
only place it may be written is the branch where no field was served and 17 is
what the untouched server actually does.

`season_delta` is `null` when a caller gave no horizon, so the whole sentence
is withheld rather than wrapped around an em dash — `num()` would print a dash
and the sentence would still assert a horizon around nothing.

## 7. Two more assertions that could not fail

Both were found by re-running mutations for the two stack evidence files that
had no recorded run, and both are fixed in this commit.

**`basis-chip-adopted.test.js`** proved that six pages render the shared chip
with `assert.match(src, /<BasisChip/)`. That pattern matches `<BasisChipX` too,
so renaming the element to anything with the same prefix passed the test whose
only job was to prove the shared component is what renders. Now `/<BasisChip[\s/>]/`.

**`teams-page-honest-prose.test.js`** proved the placeholder guard with
`coachName(team.oc_name)` matched anywhere in the file. Each coordinator appears
twice — the guard that decides whether the slot renders, and the name inside it
— so replacing the guard with the raw value left the render to satisfy the
pattern. A raw guard renders "· OC " followed by nothing for a team whose
coordinator is still "TBD (camp)", which is the empty-space-where-a-name-belongs
failure the head-coach branch of the same test exists to prevent. Both positions
are pinned now, by their occurrence count.

With the anchor bug in §5 that makes three found in one sitting, all by mutation
runs and none by reading the tests.

**And one about the instrument itself.** The first re-run of the chip mutations
was piped through `head -3` to skim the result. `head` closed the pipe, the
runner took SIGPIPE partway through, and its restore step never ran — so a
mutation was left in `client/src/pages/Lineup.tsx`, and the results file still
held the *previous* run, whose two survivors were already fixed. The evidence
table folded from it was therefore describing a run that no longer matched the
code. The full check is what caught it: one failing test, in a file this commit
had touched for an unrelated reason. Both were corrected and the batch re-run to
completion. Nothing here is asserted from a run that did not finish, and the
tree was verified clean by `git status` afterwards rather than assumed clean
because the runner said so.

## 8. Full check

`npm run check` on the tree of this commit: typecheck clean, **3,182 tests,
3,141 pass, 0 fail, 41 skipped**, build 2.61s, startup smoke passed on an
isolated database. The commit these numbers were measured on is named in the
commit that immediately follows this one — it cannot name itself, and quoting
the parent would point at a tree that is not the one measured.

