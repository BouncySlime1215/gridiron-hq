# A gate that rewrites the artifact it validates

RED `7e9c055` · GREEN this commit · `scripts/wiring-map.mjs`,
`test/wiring-check-does-not-write.test.js`

## What was wrong

`npm run check:wiring` is `node scripts/wiring-map.mjs --check`, and
`.github/workflows/ci.yml:70` runs it as a build step. The write block was
gated on `--findings` alone:

```js
if (!flag('findings')) {
  fs.writeFileSync(path.join(outDir, 'wiring-map.json'), …);
  fs.writeFileSync(path.join(outDir, 'WIRING-MAP.md'), …);
  fs.writeFileSync(path.join(outDir, 'MISSING-FEEDS.md'), …);
}
```

`--check` does not pass `--findings`, so it fell straight through into it. The
gate regenerated **all three** artifacts on every invocation — not one, which
is what the first report of this said.

## Why it is worth a fix and a test, not a shrug

Three costs. The third is the one that made it worth stopping for:

1. A validate-only flag that writes leaves the repository dirty in CI. The gate
   reports its verdict on a tree it has just modified.
2. `generated_at` moves on every run, so the artifact is never byte-stable and
   "did the map actually change?" cannot be answered by diffing it.
3. **It is exactly the unstaged, mid-run edit this project's TREE-HASH RULE
   cannot see.** That rule records `git write-tree` either side of a suite run
   and treats a changed hash as a void. `git write-tree` hashes the **index**,
   so an unstaged write returns an identical hash. A gate that quietly writes is
   invisible to the guard meant to catch precisely this.

Point 3 is how it was found: the write was noticed while running the two gates
for the held-commits test rundown, and chasing *why the hash had not moved*
turned up the larger fact about the guard itself.

## The fix

```js
if (!flag('findings') && !flag('check')) {
```

The verdict is computed from `found`, which is built in memory before either
block runs, and nothing in the gate reads the files back — so not writing them
changes no outcome. Confirmed before changing anything: no test asserted the
write, and the CI step consumes the exit status only.

## What the test had to cover, and the gap it exposed

The obvious test — "`--check` leaves the directory empty" — is satisfied just as
well by a script that never writes anything at all. So the file carries three
assertions, and the third exists because of a measured gap:

**Nothing else in the suite would catch a generator that stopped producing
output.** All seven test files that touch `docs/wiring` read the **committed**
artifacts; none regenerates them. They stay green whether or not the generator
still works. Since the change here narrows a write condition, the regression it
could plausibly cause is the one thing the suite was blind to, so the generate
path now gets its own assertion.

## Defect injection

Baseline (GREEN) `scripts/wiring-map.mjs`
sha256 `5c6c3217faa2360d867675cb3c550162b8663edbdedec20d2b3b4bd0511551a6`.
Three tests in `test/wiring-check-does-not-write.test.js`, 3/3 at GREEN.

| # | mutation | sha256 after edit | result | killed by (title) |
|---|---|---|---|---|
| M1 | revert the fix — `if (!flag('findings')) {` | `74fc8bf3…91717` | **1 fail / 2 pass** | `--check does not write the artifacts it is validating` |
| M2 | never write — `if (false) {` | `ce84af8b…7c566` | **1 fail / 2 pass** | `the generate path still writes all three artifacts` |
| M3 | control: add a comment line above the condition | `7f50aed4…a6134` | 3 pass | — (no-op by construction) |

M1 and M2 are mirror images and each is killed by a different assertion, which
is the point: one test alone would accept the opposite defect. Neither mutation
disturbed the other two assertions, so each is localised rather than knocking
the file over generally.

M3 is the control. Its checksum differs from the GREEN baseline while its result
does not, so a green row in this table cannot be the harness silently failing to
apply an edit.

## The five questions

- **Well built?** One condition, one line, with the reasoning kept next to it.
  Three assertions covering both directions of the change.
- **Stats or made up?** Neither — this is mechanical. Every claim is a run:
  the three filenames came out of a real `--out` directory, the checksums are
  of the mutated files, the CI dependency was read at `ci.yml:70`.
- **How do we know?** Injection table above, both mutations killed by name. The
  "nothing else catches it" claim is from reading all seven test files that
  touch `docs/wiring`, not from assumption.
- **Pointed anywhere else on the platform?** Yes, and that is the larger
  finding: the tree-hash rule is project-wide, every thread cites it, and it
  measures the index. Recorded in memory rather than left in this file.
- **How does it unify?** Same shape as the rest of this branch — *a true
  observation with the wrong mechanism attached*. The rule's conclusion (pin the
  tree) was right; its instrument was reading something else.
