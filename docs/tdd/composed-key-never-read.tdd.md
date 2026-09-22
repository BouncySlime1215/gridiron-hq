# The map could not see a key that nothing reads

RED `84cad21` · GREEN this commit · `scripts/wiring-map.mjs`, `test/composed-key-never-read.test.js`

## What was missing

The map reached modules, routes, tables, columns and values. It did not reach a
**key**: a name that exists only as a property of an object this repository
builds. `payloadKeys` comes closest and stops short on purpose — its own
comment says keys written inline in a returned object literal "are deliberately
not flagged", because an API response is allowed to carry a field nobody reads
back. The reader is a person looking at JSON.

That exemption is right for a response and wrong for a **component**. When a
function's result is spread into another object — `...gameContext(season, week,
team)` at `server/services/nfl-features.js:475` — it is not something a person
reads. It is machine input, assembled to be read by name. A name nothing reads
is work done on every call for nobody.

## What prompted it, and why it is NOT an instance of it

The model-evidence audit thread traced `opp_adj_def_epa`
(`server/services/nfl-features.js:228`, computed at `:445`, spread into
`teamFeatureVector` at `:477`) and reported it as correctly computed and
unreachable from the fantasy product. The caller claim holds: the three callers
of `teamFeatureVector` are `nfl-reasoning.js:84-85`, `nfl-ai-replay.js:112` and
`routes/nfl-betting.js:130`, all betting-side.

This map had **zero** findings naming it. That gap is what this rule closes —
but `opp_adj_def_epa` is not an instance of the rule, and saying so is the
point. It **is** read, at `server/services/nfl-ai-replay.js:112`:

```js
return Object.fromEntries(FEATURE_KEYS
  .filter(k => f[k] != null).map(k => [k, f[k]]));
```

The name lives in a string array (`FEATURE_KEYS`, `:28-36`) and the access is
dynamic. A rule that looked for `.opp_adj_def_epa` and found nothing would have
called live code dead on its first run. `keyReads` counts a bare name inside
any string as a read, which is exactly what prevents that, and the last test in
the file pins it against the real two files rather than a fixture.

**So the honest answer to the original question is unchanged.** The finding is
already carried at module and route granularity — `route:nfl-betting` is
`half_done` because no page calls any of its 170 routes, and
`pipeline:nfl-features` is `unclassified` — and no new inventory row was
written for a single column, because `column` is not one of the seven row kinds
item 5 was specified with.

## The filter is the rule

A bare "key written, never read" sweep is a word list. Four exclusions earn
their place, each pinned by a test:

| exclusion | why, and the case that named it |
| --- | --- |
| a name inside any string | `opp_adj_def_epa`, read through `FEATURE_KEYS`. Without this the rule's first run reports live code as dead. |
| response position | `res.json({ seasons, ...evaluateSizing(bets) })` at `server/routes/nfl-betting.js:1050`. `flat_units` and `tiered_units` (`staking.js:429-430`) read as dead by grep and are ordinary response fields. `payloadKeys`' exemption still holds inside a response; found by walking back to the first unmatched `(` and reading the callee, because *near* a response call is not *inside* one. |
| no spread site | a function whose result is never spread is a response builder, not a component. `gameContext` is only this rule's business because `nfl-features.js:475` spreads it. |
| shorthand and nesting | `{ feature_games }` takes its value from a variable of that name, where the value rules already apply; `{ outer: { inner } }` is the inner object's business. Top-level `name:` only, counted by brace/bracket/paren depth rather than matched by regex, because a returned literal routinely holds nested objects, arrays and calls that carry `name:` pairs of their own. |

Test trees neither contribute findings nor count as readers. A key whose only
consumer is its own test is precisely the case worth reporting, and three of
the 22 are exactly that.

## What it found: 22 keys

| where | keys |
| --- | --- |
| `draft-abstention-audit.js:125,333-338` | `finish_pos_rank`, `hit_rate`, `hit_rate_95`, `vorp_plus_per_pick`, `expected_vorp_plus_per_pick`, `abs_err_per_pick`, `slot_adjusted_err` |
| `nfl-passing-diagnostic.js:73-79` | `season_to_date_yards_mae`, `component_candidates`, `oracle_attribution` |
| `routes/betting-hub.js:199-201` | `calibration_plain`, `calibration_numbers`, `calibration_detail` |
| `offseason-data.js:484,534` | `sleeper_gsis_filled`, `by_draft`, `by_name` |
| `nfl-spread-context.js:216,218` | `home_implied_points`, `division_game` |
| four singles | `cover_n` (`forecast-combination.js:713`), `raw_model_brier` (`mlb-calibration.js:74`), `expected_return_after_haircut_of` (`nfl-policy.js:248`), `training_anchor` (`nfl-research.js:96`) |

Seven were verified by hand with grep before the rule existed or after it ran;
`division_game` is the clearest — written three times
(`nfl-spread-context.js:218`, `:244`, `:355`), named nowhere else, while the
SQL column it derives from is `div_game`.

## Effect on the map

2366 findings to 2389, measured by regenerating the map at `4937719` with the
working tree stashed and diffing rule by rule: the 22 above, plus one
`export-only-tested` for `composedKeysNeverRead`, which only a test imports.
Every other rule's count is identical.

`returnedLiteralKeys` and `inResponsePosition` are deliberately **not**
exported. Exporting a helper only so a test can reach it adds a finding to this
map's own output, and a checker that dirties its own results to be testable is
not worth two tests. An intermediate run, before that decision, did carry two
extra `export-imported-by-nothing` rows and one
`docs-citation-points-at-nothing` for this file before it existed.

**A `--out` run is not comparable to the committed artifact, and that cost an
hour.** `annotations(path.join(outDir, 'annotations.json'))` reads the
accept-list from the OUT directory, so a run written to a scratch path applies
no annotations at all. Comparing a scratch run against `docs/wiring/` looked
exactly like nondeterminism: `espn_settings` appeared and vanished as
`table-never-written` between two runs on an identical tree. It is accepted in
`docs/wiring/annotations.json` and was never unstable. Both comparisons agree
once each is made against its own kind — unannotated 2366 → 2389, annotated
2365 → 2388, +23 either way. Five consecutive runs on the same tree gave the
same total.

## Defect injection

Tree sha256 is the first 16 hex of `sha256sum scripts/wiring-map.mjs`.
Baseline green `3905215b60391a89`, 11 pass / 0 fail.

| # | injection | tree | result | killed by |
| --- | --- | --- | --- | --- |
| C1 | drop the response-position filter | `e2f6e419b201d9a3` | KILLED 10/1 | *a component spread into a response keeps payloadKeys exemption* |
| C2 | stop counting a name inside a string as a read | `2160af5692d91d81` | KILLED 9/2 | *a key named only inside a string list counts as read*; *opp_adj_def_epa is NOT reported: a name list is a reader* |
| C3 | let the test trees count as readers | `9238bc5ab6f71614` | KILLED 10/1 | *a test tree neither contributes findings nor counts as a reader* |
| C4 | drop the top-level depth guard on returned keys | `a12b2ddeed6b78f6` | KILLED 10/1 | *only the top level of the returned literal is examined* |
| C5 | drop spread-call eligibility, via a fallback `bodyRange` lookup | `bb8646a64b8f2fe4` | SURVIVED 11/0 | — (misdesigned, see below) |
| C5b | drop spread-call eligibility: every declared function is a component | `3a0155bcd5202757` | KILLED 9/2 | *a function whose result is never spread is left alone*; *a component spread into a response keeps payloadKeys exemption* |
| C6 | report every write site instead of deduping the key | `81e1ce9581974a76` | KILLED 10/1 | *a key written at two return sites is reported once, at the first* |
| C7 | control, one word of the doc comment | `0ffa4df232eedd67` | SURVIVED 11/0 | — |

**C5 survived because it could not run.** It added a fallback inside the loop
over spread-called names, and the fixture that test uses has no spread call at
all, so the loop body never executed. A mutation that cannot reach the code it
mutates proves nothing about the test; it is recorded as the misdesign it was
and replaced by C5b, which removes the eligibility check at its source.

C2 is the injection that matters most. It is the one that turns this rule into
the failure it was built to avoid, and it takes out the `opp_adj_def_epa` guard
by name.

## The five questions

**Well built?** One rule, four filters, each a test. Three of the eleven tests
run against the real source files rather than a fixture, because a fixture only
ever proves the fixture was written to pass.

**Stats or made up?** Measured. 22 findings from a 987-file tree; 24 before the
`keyReads` fix, with the two removed named in
`docs/tdd/destructured-default-is-still-a-read.tdd.md`; 2366 to 2389 total
findings with every other rule's count unchanged, diffed rule by rule against a
regenerated baseline rather than against the stale committed artifact, and
annotated against annotated rather than across the two.

**How do we know?** `node --test test/composed-key-never-read.test.js` — 0/10
at RED `84cad21`, 11/0 at GREEN. Whole tree: `npm run check` exit 0
(typecheck, lint, suite, build, startup smoke), and `npm test` **3104 tests /
3063 pass / 0 fail / 41 skipped**, up from 3091 / 3050 / 0 / 41 — the 11 tests
here plus the 2 in `test/wiring-map.test.js`. Tree `df1ca9cf` and the
`node_modules` mtime identical either side of the run.

An earlier run of the same suite gave the same numbers and is recorded as
**void**: commit `ceb4548` landed inside its window and changed files under
`docs/wiring` and `docs/tdd` that ten test files read. It agreeing with the
pinned run is corroboration, not a reading. Six injections killed with the killing test
named, one control survived, and one misdesigned injection recorded rather than
quietly replaced.

**Pointed anywhere else on the platform?** Twelve of the 22 are betting-side or
diagnostic and out of scope for work. The fantasy-side ones are
`offseason-data.js`'s three resolution counters and
`draft-abstention-audit.js`'s seven, three of which are read only by that
module's own tests.

**How does it unify?** The honest inventory answers "what is decoration". Until
now it could say a module is unreachable or a table is unwritten, but not that
a live module computes a number on every call that nothing will ever look at.
That is decoration at the smallest granularity the map has, and it was the last
one it could not see.
