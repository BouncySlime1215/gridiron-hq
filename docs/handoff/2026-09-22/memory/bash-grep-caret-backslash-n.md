---
name: bash-grep-caret-backslash-n
description: In a bash grep -E bracket expression [^\n] means "not a backslash, not the letter n" — it silently narrowed a verification grep and produced a false clean result.
metadata:
  type: feedback
---

2026-09-20, Gridiron HQ. A stage-by-stage verification of `npm run check`
concluded "no test reads a file under `docs/` from disk". Wrong: exactly one
does, and the grep that cleared it was running a different pattern than its
author thought.

**The pattern:** `(readFileSync|readFile|existsSync|readdirSync|glob)[^\n]*docs`

**In a POSIX ERE bracket expression a backslash is not an escape.** `[^\n]`
therefore means "not a backslash **and not the letter n**", not "any character
except a newline". The pattern silently required no letter `n` between the call
and the path. The line it had to find was
`fs.readFileSync(new URL('../docs/CLAUDE-NEXT-STEPS.md', import.meta.url), 'utf8'))`
— `new` supplies the `n`.

Proved, not reasoned, on a two-line probe:
```
grep -nE "readFileSync[^\n]*docs" probe   → only the line without `new`
grep -nE "readFileSync.*docs"     probe   → both
```

**How to apply:**
- In a bash `grep -E`, write `.*`, never `[^\n]*`. `grep` is already
  line-scoped, so `[^\n]` buys nothing even when it works.
- Python's `re` DOES treat `[^\n]` as intended, so a script is not exposed;
  this is a shell-grep-only trap. Say which engine a pattern ran under.
- **A regex that silently matches nothing is indistinguishable from a clean
  result.** Same failure shape as a mutation pattern matching nothing and
  recording as caught — which the before/after hash rule exists to catch, and
  for which a grep has no equivalent. When a grep is the evidence for a
  NEGATIVE claim, prove the pattern finds a known positive first.
- A stage-by-stage verification is only as good as each stage's pattern.
  Checking five stages does not make the one weak pattern stronger.

See [[reading-a-claim-without-its-attachment]] and
[[gridiron-docs-is-application-data]].
