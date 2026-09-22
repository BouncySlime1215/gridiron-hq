---
name: mutation-sweep-two-invalid-verdicts
description: Three ways an injection reports a false verdict, all hit in the gridiron scheduler units on 2026-09-22 — a perl s/// that lands in a doc comment, a sed with no line address that hits 13 call sites, and a test that asserts an import rather than a call.
metadata:
  type: feedback
---

Two sweep failures, each found twice in two units on 2026-09-22. Both make a
sweep report something it did not measure, which is worse than no sweep.

**1. `perl -0pi -e 's/X/Y/'` replaces only the FIRST match in the whole file,
and the first match is usually a doc comment.** The code is untouched, the
tests pass, and the sweep records a SURVIVOR — a test gap that does not exist.
Happened as M5 in the archetype-parse unit and again as M5 in the
flush-then-exit unit.

**Why:** `-0` slurps the file so `s///` without `/g` is one substitution over
the whole text. Well-commented code puts the identifier in prose first.

**How to apply:** after every injection, `grep -q` for the mutated text in the
CODE and print "applied" or "NOT APPLIED" before running the suite. Do not read
a verdict from an injection that was not confirmed applied. Anchor the pattern
to its surrounding code, not to the bare identifier.

**1b. `sed -i 's/X/Y/'` with NO line address applies to EVERY line.** Stripping
`offThread: true` from one injected scheduler job also stripped it from **13
real jobs**, which made four tests fail instead of two and briefly looked like
a finding — reported as such before the control caught it. Opposite failure to
#1 (too few) but the same root: not checking what the edit actually touched.

**How to apply:** `grep -c` the pattern BEFORE editing. If the count is not 1,
anchor to a line number or a longer unique string. Then re-run the unmutated
baseline: a green baseline plus a red mutation is the only pair that licenses
reading a verdict, and it is cheap.

**2. A test that asserts a module is IMPORTED does not assert it is CALLED.**
An injection that restored `console.log(JSON.stringify(...))` while leaving the
now-unused import in place SURVIVED a guard matching the module path. That is
exactly the regression a later edit makes.

Related: **do not gate a bad shape by proximity.** The same guard forbade
`console.log(JSON.stringify(...)` only when a `process.exit` followed within a
few lines; a closing brace and two comment lines in between were enough to slip
it. Where the codebase has no legitimate instance of the shape (check with
grep), forbid it absolutely.

**How to apply:** assert the CALL (`assert.match(src, /theHelper\(/)`), and
add an injection that breaks the behaviour without using the forbidden words at
all — e.g. `process.stdout.write(...)` then `process.exit(0)` — to check the new
guard is about the shape rather than about a string.

Record an invalid injection AS invalid and re-run it correctly, rather than
folding it into the killed total or leaving it in the survivor column. Both
units state the applied count, the killed count, the invalid one and the real
gap separately. See [[process-exit-truncates-a-piped-report]].
