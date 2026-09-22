# Nothing ever ran the inventory generator

RED `eab8b92` · GREEN this commit · `scripts/inventory.mjs`,
`test/inventory-generate-path.test.js`

## What was missing

Four test files name `scripts/inventory.mjs` — `data-lineage-inventory`,
`inventory-blockers`, `inventory-route-callers`, `inventory-table-locality` —
and every one of them **imports a named helper** out of it. None runs it.
Importing `blockers` never causes the generator to write a byte, so
`buildRows → check → writeFileSync` could stop producing output entirely and
all four would stay green, reading an artifact committed weeks earlier.

This is the mirror of the gate defect fixed beside it. There, a gate wrote what
it should only have read. Here, a producer is never exercised while its output
is read everywhere. **"Verify the consumer, not the producer" is a rule about
where to look for a defect, not permission to leave the producer unwatched.**

## How it was found, including the three wrong answers on the way

By sweeping every tracked file a script writes and asking, per artifact,
whether any test actually spawns its producer. The sweep was wrong three times
first, and each failure is the same shape this branch keeps finding:

1. **A path literal in a file that writes somewhere is not a write target.**
   v1 credited `wiring-map.mjs` with writing `docs/CLAUDE-NEXT-STEPS.md`, which
   it only names in a comment.
2. **A spawn-shaped string is not a spawn.** v1 counted
   `test/wiring-map.test.js` as regenerating the map because the text contains
   `execFileSync` — inside a fixture string.
3. **A content question asked of a view with strings blanked returns nothing.**
   v2 blanked string bodies and then tried to read path literals out of them,
   and reported zero artifacts. The sweep reproduced the exact bug it was
   written to find.
4. **A fixed window is not a resolution.** Requiring the script name within 300
   characters of the spawn missed a test that declares
   `const SCRIPT = path.join(REPO, 'scripts', 'inventory.mjs')` at the top and
   spawns `SCRIPT` sixty lines later. That is the third fixed-window defect on
   this branch, after `bodyRange` and `moduleEdges`.

Every surviving row was then verified by hand rather than trusted.

**Result: 8 tracked artifacts are written by a script; 5 have a producer no
test ever runs.** One pair is this repository's inventory and is fixed here.
The other three belong to other threads and are reported, not touched.

## Why the fix needed a code change first

`inventory.mjs` wrote to two hardcoded paths under `docs/inventory/`. Running
it from a test would overwrite the committed artifacts mid-suite — dirtying the
tree, moving `generated_at`, and being **invisible to a `git write-tree`
guard**, which hashes the index. So "run the generator" and "keep the tree
clean" were mutually exclusive, and the generator went untested.

The RED run demonstrated exactly that: it left `INVENTORY.md` and
`inventory.json` modified. The generator now takes `--out <dir>`, the interface
`scripts/wiring-map.mjs` already had.

## A wrong assertion, corrected against the data

The third test first asserted a status vocabulary taken from the spec in my
head: `dead_or_stale`, `phantom_table`. The real values are `dead` and
`referenced_but_never_created`, and it also rejected the **blank** status,
which is deliberate — model rows are emitted ungraded so the model-evidence
audit thread grades them, because nobody grades their own rows. Measured before
changing anything: 880 rows, 56 blank, **all 56 of kind `model`, none
otherwise**.

So the assertion is now the rule rather than a list: blank is legal on a model
row and only there. A blank leaking onto a non-model row would be the inventory
quietly declining to judge something it is supposed to judge, which reads
identically to a clean run.

The test was wrong about the code. It was corrected, not the code.

## Defect injection

Baseline (GREEN) `scripts/inventory.mjs`
sha256 `ac4b6eaadeeb90e1dda8c26b63b486a2f76de84d7e4b06302e590e335ead1994`,
3/3 in `test/inventory-generate-path.test.js`.

| # | mutation | sha256 after edit | result | killed by (title) |
|---|---|---|---|---|
| N1 | ignore `--out`, write to the hardcoded paths | `10303a03…9ea0b` | **0 pass / 3 fail** | all three, incl. `--out is honoured, so generating never touches the committed copies` |
| N2 | write an empty row set — `rows: []` | `61d217f5…3cc` | **2 pass / 1 fail** | `the generated inventory is a real inventory, not an empty shell` |
| N3 | skip the `INVENTORY.md` write | `e73c6e7b…1a1be` | **2 pass / 1 fail** | `the inventory generator writes both artifacts` |
| N4 | control: add a comment line above `OUT_JSON` | `9a3c6616…791dd` | 3 pass | — (no-op by construction) |

N2 and N3 are the two ways a generator "works" while producing nothing usable —
an empty artifact and a missing one — and each is killed by a different
assertion. N1 confirms the `--out` contract is load-bearing rather than
decorative: without it the test cannot run honestly at all.

N4 is the control. Its checksum differs from the GREEN baseline while its result
does not, so a green row here cannot be the harness failing to apply an edit.

## The five questions

- **Well built?** One flag, resolved once, defaulting to the committed
  location so every existing caller is unaffected. Three assertions covering
  written-at-all, written-in-the-right-place, and written-with-real-content.
- **Stats or made up?** Mechanical throughout. The 880/56 split is a count of
  the committed artifact, not an estimate.
- **How do we know?** The injection table, every mutation killed by a named
  test. The "no test runs this" claim was verified twice — by the sweep and by
  a direct grep for a spawn in each of the four files that name the script.
- **Pointed anywhere else on the platform?** Yes: three more artifacts under
  `docs/evidence/` have producers no test runs. Reported upward for routing
  rather than touched, since they are not this thread's files.
- **How does it unify?** It closes the producer half of the map's own slogan.
  The wiring map verifies consumers exhaustively; until now nothing verified
  that the thing producing its input still worked.
