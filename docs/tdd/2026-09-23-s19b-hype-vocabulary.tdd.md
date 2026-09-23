# S-19b: one stat vocabulary — "hype" means price minus value only

Unit: WORK-QUEUE.md S-19b. Follow-up named in
`docs/tdd/2026-09-23-s19-one-hype-producer.tdd.md` ("rename the tactic label
('outscoring his usage') so the word 'hype' means one thing"). Built on top
of #187 (open, not yet merged; branched from
`claude/local-s-19-one-hype-producer` per the unit's own instruction).

Not statistical: no model number, projection, or held-out-season claim is
touched. Holdout-ledger discipline (a)-(e) is not applicable — recorded here
rather than silently skipped.

## 1. Audit — what already exists for this surface

`grep -rn hype server client test` on the S-19 head (`ddfbcf7b`) found three
producers of the word "hype", not one concept:

1. **Price minus value** (the allowed meaning): `server/services/hype.js#playerHype`,
   `trade-market.js` (TM-09 market hype / hype-decay), served on the PlayerCard
   verdict and the TM-09 route. This is `services/hype.js#playerHype` — the
   number S-19 already unified.
2. **`trade-tactics.js`'s `hype_window`** (`:123` def, `:795` served, `:806`
   note-absent): actual-minus-expected fantasy points from usage
   (`talk-vs-model.js#expectationGaps`), fed into a trade tactic. Different
   concept, same word.
3. **`counterparty-pricing.js`'s `hype_vs_usage`** (`:78` def, `:629,631`
   served): the same usage-gap concept, read as a valuation-map source. Its
   `label` already said "His own player is outscoring the usage that earns
   it" — no literal "hype" — but the **key** did, and the key reaches the
   user: the client's `words(a.key)` (`client/src/components/trade/ManagerRead.tsx:240`)
   renders `tactics_absent[].key` verbatim with underscores turned to spaces,
   so `hype_window` rendered as "hype window" whenever the tactic was inert
   (the common case — `test/trade-tactics.test.js` G2i shows it absent on
   the real fixture league). `f.source` (the valuation-map factor's key) is
   only ever used as a React list `key` (`ManagerRead.tsx:105`), never
   rendered as text, so `hype_vs_usage`'s key was not independently visible —
   but it is renamed anyway, both for the "one vocabulary" spirit and because
   any future reader that lists valuation sources by name (the way
   `tactics_absent` already does) would inherit the same bug silently.

`talk-vs-model.js#expectationGaps` (`:51`) itself names no "hype" anywhere —
audited, no change needed, used here only as the control consumer.

**Extend, not build**: both surfaces already carried the correct underlying
concept and mostly-correct text (the tactic's fallback/absent reasons already
said "outscoring his usage", not "hype" — see `hypeReason` at
`trade-tactics.js:784` and the `note()` fallback at `:807`, both pre-existing).
This unit renames the two keys and the one remaining label that still said
"hype", and adds a scan test so the vocabulary split cannot silently
reappear.

## 2. RED / GREEN

- **RED** `eaccd511` "test: S-19b RED for one hype vocabulary (usage-gap
  surfaces still say hype)". Failing assertions on the pre-rename tree
  (`ddfbcf7b`):
  ```
  TACTICS and VALUATION_SOURCES: no key or label names hype except the allowed exception
    the usage-gap surfaces must not use the word "hype"
    + ["TACTICS.hype_window.label 'Sell inside the hype window'"]
    - []

  served tactic: the outscoring-usage tactic fires under key outscoring_usage, never hype_window
    AssertionError: the tactic must fire under its renamed key when the gap and praise both clear
  ```
  Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/hype-vocabulary.test.js` → 1 pass (control), 2 fail, on tree `72caa45e` (RED commit's own write-tree).

- **GREEN** `420d00d1` "fix: S-19b rename usage-gap keys to outscoring_usage;
  hype means price minus value only". Renames:
  - `trade-tactics.js`: `TACTICS.hype_window` → `TACTICS.outscoring_usage`;
    label `'Sell inside the hype window'` → `"Sell while he's outscoring his usage"`;
    the served `tactics.push({ key: ... })` and `note(...)` call sites updated
    (the call-site mutant a key-only rename would miss).
  - `counterparty-pricing.js`: `VALUATION_SOURCES.hype_vs_usage` →
    `VALUATION_SOURCES.outscoring_usage` (key only; label unchanged, already
    clean).
  - Every consumer updated: `test/trade-tactics.test.js` (4 sites, `:370,380,572,573,934`
    on the pre-rename tree),  `test/valuation-map.test.js` (4 sites,
    `:397,405,465,470`), `server/routes/trades.js:189` comment.
  Command: same as above, tree `0c24d1d4` (GREEN commit's write-tree) →
  `test/hype-vocabulary.test.js` 3/3, `test/trade-tactics.test.js` 39/39,
  `test/valuation-map.test.js` 47/47, all pass, 0 fail.

## 3. Mutation sweep

Run against the GREEN tree (`0c24d1d4`), each mutant applied then reverted
with `git checkout -- server/services/trade-tactics.js`, `test/hype-vocabulary.test.js`
alone:

| Mutant | What | Result |
|---|---|---|
| A — unit | Revert `TACTICS.outscoring_usage.label` to `'Sell inside the hype window'` | **killed** — test 2 and 3 fail |
| B — call site | Revert `tactics.push({ key: 'outscoring_usage', ... })` back to `key: 'hype_window'` while leaving the registry renamed | **killed** — test 3 fails ("the tactic must fire under its renamed key") |
| C — designed survivor | Mutate an unrelated tactic's label (`sneak_in`: `'Sneak him in'` → `'Sneak him in NOW'`) | **survived**, by design — this scan test is scoped to the hype vocabulary, not a general label-diff test |
| D — not-applied control | Unmodified tree, no mutation | pass 3/3, 0 fail — confirms the harness itself is not stuck failing |

Commands: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/hype-vocabulary.test.js`
for each row.

## 4. What this does NOT cover

- The internal `TACTIC_THRESHOLDS.hype_min_games` / `hype_min_gap` constant
  *names* still say "hype" (`trade-tactics.js:79,81`). Not user-facing (never
  served in any response), and out of the acceptance test's scope
  ("user-facing strings"). Left as-is; a follow-up could rename them for
  internal consistency, but there is no served-string defect there.
- Comments in `waiver-brain.js`, `players.js`, `trade-market.js`, and
  `trade-engine.js` that say "hype" are all the price-minus-value meaning
  (S-19's producer) and are correctly left alone.
- `docs/tdd/2026-09-23-s19-one-hype-producer.tdd.md`,
  `docs/tdd/valuation-map.tdd.md`, `docs/tdd/2026-09-23-tm-09-market-prices.tdd.md`
  still name `hype_window`/`hype_vs_usage` — these are another thread's
  (S-19's) evidence files, historical record of what was true when written;
  not edited here (standing rule 9, one editor per file; rule 7, never
  rewrite a merged evidence file — S-19's PR #187 is not yet merged, so this
  is additionally "not my file to touch", not just "already merged").

## 5. Nick's five questions

1. **Well built?** Yes for the stated scope: a rename plus a regression test
   that scans the actual served registries and a real `tacticsForDeal()` call,
   not just a string grep.
2. **Stats or made up?** Neither — no number changed. Pure vocabulary/label
   fix.
3. **How we know:** RED/GREEN + mutation sweep (section 3), not a backtest —
   there is no statistical claim to back-test.
4. **Pointed anywhere else on the platform?** No other served string names
   `hype_window` or `hype_vs_usage` (checked via `grep -rn` across
   `server/`, `client/src/`, `test/` before and after; only the two renamed
   sites and their five known consumer files matched).
5. **How it unifies:** "hype" is now a one-word vocabulary: it means trade
   price minus value everywhere it is served. The usage-gap concept
   (actual vs. expected fantasy points from usage) is now always
   "outscoring his usage" / `outscoring_usage`, in both files that produce it.

## Holdout looks

None. This unit touches no model number, no projection, and no held-out
season; nothing was added to `docs/evidence/HOLDOUT-LEDGER.md`.

## Skeptic fix (test liveness): the key scan could not see snake_case keys

**Finding (correct):** `/\bhype\b/i` never matches `hype_vs_usage` or `hype_window`, because `_` is a word character, so there is no `\b` between `hype` and `_`. `node -e "console.log(/\bhype\b/i.test('hype_vs_usage'), /\bhype\b/i.test('hype_window'))"` prints `false false`. At HEAD 68f1ceb4 the scan test stayed 3/3 green with the key reverted. Only valuation-map.test.js caught it, and only because it hard-codes the new name.

**Fix (test only, implementation unchanged):** `namesHype(s)` = `s.toLowerCase().split(/[^a-z]+/).includes('hype')`, used for keys, labels and served tactic keys. A new matcher-control test proves it catches `hype_vs_usage`, `hype_window`, `hype_gap`, `Sell inside the hype window` and `HYPE`, and does not flag `outscoring_usage`, `hyperbole`, `Outscoring usage` or `''`.

Command for every row: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/hype-vocabulary.test.js`. Trees come from `git add -A; git write-tree`.

| Tree | State | Result |
|---|---|---|
| 1b11ef1d | clean (fixed test) | 4 pass, 0 fail |
| c23944f5 | K1: `sed 's/outscoring_usage/hype_vs_usage/g' server/services/counterparty-pricing.js` (key reverted, label still clean: "His own player is outscoring the usage that earns it") | RED: test 3 fails (key scan), 3 pass 1 fail |
| f22b197e | K2: `sed 's/outscoring_usage/hype_window/g' server/services/trade-tactics.js` (key reverted, label clean) | RED: tests 3 and 4 fail, 2 pass 2 fail |
| 7b672645 | K3: future key `hype_gap` in counterparty-pricing.js | RED: test 3 fails, 3 pass 1 fail |

All mutants were reverted with `git checkout --`. The committed tree is the clean row.
