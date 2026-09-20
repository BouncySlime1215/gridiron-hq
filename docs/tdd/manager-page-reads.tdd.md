# The manager page's two reads, and the span in the trade explanation

Three fixes, one defect in three sets of clothes: a fact about a store arriving
without the date it was measured, a fault arriving as an empty result, and a
span asserted to a model rather than read from what produced it.

Files: `server/routes/trades.js`, `server/services/counterparty-pricing.js`
(the shared accessor), `test/manager-signals-api.test.js` and
`test/trade-season-span.test.js`.

---

## 1. The explain prompt told the model the wrong season, every time

`season_delta` is the weekly lineup gain multiplied out. The prompt said it
held **"for a full 17-week season"** on every date the page was opened. In week
15 a gain worth three more weeks was handed to the model as seventeen weeks of
it, and the model then reasoned about a number five times the real one — while
being asked, in the same prompt, to sanity-check the engine's arithmetic.

The lineup diff now serves what it actually multiplied by:
`season_delta_weeks`, and `season_delta_basis` saying whether that is the weeks
left or a season-length default (feature audit's D11, names frozen at
`b048c86`). `fmtSeasonSpan` follows them.

**A payload carrying neither keeps the old wording.** That is deliberate and
tested: this branch does not have D11's producer yet, and guessing a count would
be worse than the sentence it replaces. The guard is `Number.isFinite`, not a
null check, so a string where a number belongs also falls back (D1).

A season-length default says it is a default. "Seventeen weeks left" and
"seventeen weeks assumed" are different claims, and the model has no way to tell
them apart unless the sentence does it (D3).

## 2. A read that threw was served as a store that is empty

`archetypesFor` sat inside a bare `catch {}`. A read that **failed** and a store
that is **empty** arrived identical: every manager's `archetype` came back
`null` and the page said the build had not run.

Not hypothetical. `archetypesFor` joins `league_season_teams`, whose only
`CREATE TABLE` is in `scripts/backfill-league-history.mjs` — an off-server
history backfill. Nothing in `server/db/` creates it and no migration adds it,
so on any database where that script has never run the join throws `no such
table` and the page blames the archetype build. Different facts, different
fixes. CLAUDE.md is explicit: if a layer goes inert, the surface must say so.

The store now gets a block of its own beside `transactions` and `chat`, carrying
`archetypesBuilt()` plus `read_failed`. The test renames the table away and
asserts the failure is named; a second test pins that a healthy read reports no
failure, or the sentence would mean nothing (D8).

## 3. The undated copy and the dated one were both on the page

`archetypesFor` carried the store's raw `jev` straight onto this payload: the
stored probabilities, with no evaluation date and no statement of which of them
have evidence under them. Nothing rendered it. The dated, basis-honest block
from `docs/tdd/jev-model-read.tdd.md` now reaches the page as `model_read`, and
the raw copy is stripped — two shapes of one answer on one payload is how a page
ends up rendering the one with no date on it.

`managerModelReads(leagueId, rosterIds)` is the shared call, so the page and the
counterparty layer cannot disagree. The page does **not** read it through the
layer: the layer is built from `manager_signals` keys, and a manager with no
signals still has a draft record somebody paid a gateway call to have read.

## 4. Mutations

Baseline `server/routes/trades.js` at `ff55095f19fc`, on the exact tree these
tests pass on. Every row records the file's SHA-256 before and after, so a
pattern that did not match is reported as a `NO-OP` and not counted as a result.
The named test is the ONE test that injection must turn red.

| # | injection | verification | named test | result |
|---|---|---|---|---|
| 1 | accept anything non-null as a week count | `APPLIED ff55095f19fc -> b55cadcaece3` | went red | **RED** (1 failing) |
| 2 | drop the singular | `APPLIED ff55095f19fc -> cd675d5716d6` | went red | **RED** (1 failing) |
| 3 | report a season-length default as the weeks left | `APPLIED ff55095f19fc -> 7acaa9b240fd` | went red | **RED** (1 failing) |
| 4 | swallow the archetype fault again | `APPLIED ff55095f19fc -> 6a07a043ace2` | went red | **RED** (1 failing) |
| 5 | serve the store's raw undated jev beside the dated read | `APPLIED ff55095f19fc -> e8dd18c80e43` | went red | **RED** (1 failing) |
| 6 | drop the dated model read from the manager | `APPLIED ff55095f19fc -> f3d0a3fcaf52` | went red | **RED** (1 failing) |
| 7 | never report a failed archetype read | `APPLIED ff55095f19fc -> 57c4f497776e` | went red | **RED** (1 failing) |
| 8 | report a failure whenever the store is merely healthy | `APPLIED ff55095f19fc -> 5b4587366bed` | went red | **RED** (1 failing) |
| 9 | CONTROL a pattern that is not in the file | `NO-OP - pattern not found` | — | **-** (0 failing) |

The exact text of every injection, before and after. A description of an edit is
not an injection, and a row that cannot be re-applied from what it prints is not
reproducible.

**D1 accept anything non-null as a week count** — `server/routes/trades.js`, APPLIED ff55095f19fc -> b55cadcaece3

```diff
-   if (!Number.isFinite(weeks)) return 'if that weekly gain held for a full 17-week season';
+   if (weeks == null) return 'if that weekly gain held for a full 17-week season';
```

**D2 drop the singular** — `server/routes/trades.js`, APPLIED ff55095f19fc -> cd675d5716d6

```diff
-   const plural = weeks === 1 ? 'week' : 'weeks';
+   const plural = 'weeks';
```

**D3 report a season-length default as the weeks left** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 7acaa9b240fd

```diff
-   return s?.season_delta_basis === 'full_season_default'
+   return false
```

**D4 swallow the archetype fault again** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 6a07a043ace2

```diff
-   } catch (e) { archetypeError = String(e?.message ?? e); archetypes = new Map(); }
+   } catch { archetypes = new Map(); }
```

**D5 serve the store's raw undated jev beside the dated read** — `server/routes/trades.js`, APPLIED ff55095f19fc -> e8dd18c80e43

```diff
-       archetype: withoutRawJev(archetypes.get(id)),
+       archetype: archetypes.get(id) ?? null,
```

**D6 drop the dated model read from the manager** — `server/routes/trades.js`, APPLIED ff55095f19fc -> f3d0a3fcaf52

```diff
-       model_read: modelReads.get(id) ?? null,
+       model_read: null,
```

**D7 never report a failed archetype read** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 57c4f497776e

```diff
- read_failed: archetypeError }
+ read_failed: null }
```

**D8 report a failure whenever the store is merely healthy** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 5b4587366bed

```diff
- read_failed: archetypeError }
+ read_failed: String(archetypeError) }
```

**CONTROL a pattern that is not in the file** — `server/routes/trades.js`, NO-OP - pattern not found

```diff
- const D11_NOT_A_REAL_SYMBOL = 1;
+ const D11_NOT_A_REAL_SYMBOL = 2;
```

**8 of 8 killed on the first pass**, each by the test it names, file restored
clean, control a `NO-OP`.

## 5. Surviving mutations

None.

One thing deliberately not guarded: no test asserts the prompt's *wording*
around the span, only that the count and the basis reach it and that the
fallback is the old sentence. Rewording is allowed; dropping the count is not.

## The five questions

**Is it well built?** Three deletions of a false claim and one shared accessor.
The only new code is `fmtSeasonSpan`, which is a sentence, and a helper that
strips a field.

**Is it based on stats, or made up?** The span was made up — a constant asserted
to a model as a fact about this week — and is now read from the process that
multiplied it. The model read says per answer whether it rests on anything.

**How do we know?** Six tests and eight mutations, all killed on the first pass,
each by the test it names, with the exact text of every injection printed above.

**Should this data point anywhere else?** The `archetypes` block belongs
wherever an archetype number is shown, the same way `transactions` and `chat`
already travel; and `model_read` answers "will he counter or just decline" on
the trade card. Neither is taken here — both are other threads' surfaces, and
the data is now on the payload for them to read.

**How does it unify?** One rule, three placements: **a served value carries the
stamp of the process that measured it**, **an absence must say which absence it
is** — a failed read is an absence, and the bare catch made it the wrong one —
and **a value that is a prior, or a default, must say so where it is read**.

## Full check on the exact tree

Recorded in `docs/tdd/jev-model-read.tdd.md`, which is the head these changes
were measured on; both were checked together.
