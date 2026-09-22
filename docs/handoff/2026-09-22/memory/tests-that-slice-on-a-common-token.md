---
name: tests-that-slice-on-a-common-token
description: A source-reading test that slices a file with indexOf on a common word checks the wrong region and passes by failing to fail; anchor on a string that occurs once.
metadata:
  type: feedback
  modified: 2026-09-20T03:11:33.064Z
---

When a test reads a source file as text and narrows to a region with
`src.slice(src.indexOf('a:'), src.indexOf('b:'))`, check that both anchors occur
**once**. If an anchor appears earlier in the file for an unrelated reason, the
slice silently covers the wrong region — or is empty — and every assertion
against it either passes vacuously or fails for a reason that has nothing to do
with the code.

**Why:** caught live on 2026-09-20 in `test/title-odds-drill.test.js`. It sliced
the deep-dive layers object with `page.indexOf('method:')`. `method:` appears
twice in `client/src/pages/MyTeam.tsx` as a `fetch` option, ~130 lines before the
drawer. The slice covered the wrong span; one assertion passed while checking a
string that did not contain what it looked for. Only the mutation run surfaced
it, because the mutation that should have gone red went green.

**How to apply:** anchor on something structural that occurs once — `layers={{`,
`export const X`, a component's opening tag — not on a bare object key or a word
like `method`, `source`, `value`, `name`, `id`, `data`, `type`, `error`. Then,
always, mutate the thing the assertion claims to guard and confirm it goes red.
A slice-based assertion that has never been shown to fail is not evidence.

This is the same failure as [[served-field-tested-at-the-wrong-layer]] one level
down: there the test watched the wrong layer, here it watches the wrong lines.
Both pass. Both prove nothing. The mutation run is what tells them apart.
