# One assertion per credential: the ESPN cookie leak guards in `test/roster-snapshots.test.js`

Gate G2f. Scope: the two assertions that prove an ESPN session cookie never reaches a
log line or the operator's terminal when a roster-snapshot run fails.

## The five questions

- **Is this well built?** The guards existed and worked. What did not work was their
  *failure message*: both checked two distinct secrets through one regex alternation,
  so a leak reported a fact ("credentials never reach the log") that named neither the
  credential that leaked nor how many did.
- **Is this based on stats, or made up?** Measured. Three injections, each leaking a
  different credential at the one site where a failed period's error text is built,
  plus a control whose pattern is absent from the file. Before the change all three
  injections produce a byte-identical failure message; after it each names its own
  cookie. The runs are in §3 and §4, the injections in Appendix A.
- **How do we know?** Every row names the file hash before and after the injection and
  the tests that turned red. The sweep refuses to record a row whose `from` text it
  could not find, which is what the control row exists to demonstrate.
- **Should this point anywhere else on the platform?** Yes, narrowly — see §6. The same
  shape appears at three other sites in the suite. It does **not** generalise to
  `assert.match` over a list of acceptable wordings, and §6 says why.
- **How does it unify?** It makes one rule concrete: an assertion over a list of
  independent prohibitions owes the reader which prohibition broke.

## 1. What was there

`test/roster-snapshots.test.js`, sha256
`91763d0bc8258af3be1a9da6c03e7810dea1dc187d51760429de1b8e9c70c622`:

| line | assertion | message |
| --- | --- | --- |
| 329 | `assert.doesNotMatch(log.last_detail, /test-s2\|TEST-SWID/, …)` | `'credentials never reach the log'` |
| 371 | `assert.doesNotMatch(online.stdout + online.stderr, /test-s2\|TEST-SWID/)` | none |

The fixture seeds one league with two distinct secrets (`test/roster-snapshots.test.js:110`):
`espn_s2 = 'test-s2'` and `swid = '{TEST-SWID}'`. They are sent as one `Cookie` header
(`scripts/collect-roster-snapshots.mjs:180`) but they are two separate credentials, and
a leak of one is not a leak of the other.

Baseline, no injection: **15 tests, 15 pass, 0 fail, 0 skipped.**

Every run in §3 and §4 was made in a detached worktree at `a2e7f97`, a head of this
thread's other branch, because that is where the sweep was already set up. The two
files the sweep touches are byte-identical there and on `origin/main`, which is this
branch's base — `test/roster-snapshots.test.js` at `91763d0b…` and
`scripts/collect-roster-snapshots.mjs` at `6c108f5a…`, the same hashes recorded below.
So the rows hold for this branch unchanged. The full check in §7 was run here, on this
branch, not in that worktree.

## 2. The injection site

All three injections replace one line, the catch that records a failed period
(`scripts/collect-roster-snapshots.mjs:259`), so the leaked text flows into both
observables at once: `sync_log.last_detail` (case at :319) and the script's stdout
(case at :364). File sha256 before and after every injection:
`6c108f5a09f3186df1631638ccf7d9728beff1bf386dbf30dd1d1654d1f47804` (restored each time).

## 3. RED — the old assertions cannot tell the three apart

Test file at `91763d0b…`. Each row names the tests that must be **among** the failures.

| row | what it leaks | pass / fail | tests turned red | message reported |
| --- | --- | --- | --- | --- |
| L1 | `espn_s2` only | 13 / 2 | G2f network-failure; G2f script-offline | `credentials never reach the log` |
| L2 | `SWID` only | 13 / 2 | G2f network-failure; G2f script-offline | `credentials never reach the log` |
| L3 | both, as the whole Cookie header | 13 / 2 | G2f network-failure; G2f script-offline | `credentials never reach the log` |
| C0 | CONTROL, pattern absent from the file | — | — | NOT-FOUND, as required |

The defect is the last column: it is the same string for a leak of one credential, of
the other, and of both. The guard fires; it just cannot say what it caught.

## 4. GREEN — one assertion per credential

Test file at sha256 `6c6437313e69fb2ce07a0bed543ab67bc0410eb6d914b0f39b68122a000ee601`.
Same three injections, same site, same script hash:

| row | pass / fail | messages reported |
| --- | --- | --- |
| L1 | 13 / 2 | `the espn_s2 cookie reached sync_log.last_detail` · `the espn_s2 cookie reached the script output` |
| L2 | 13 / 2 | `the SWID cookie reached sync_log.last_detail` · `the SWID cookie reached the script output` |
| L3 | 13 / 2 | `the espn_s2 cookie reached sync_log.last_detail` · `the espn_s2 cookie reached the script output` |
| C0 | — | NOT-FOUND, as required |

Clean run with the split and no injection: **15 tests, 15 pass, 0 fail, 0 skipped.**

L3 leaks both and reports only the first, because `assert` throws at the first failing
line and the second never runs. That is expected and is still strictly more than the
old behaviour told us: the reader learns one real credential name instead of none.
Recording it here rather than trimming the row.

## 5. A hypothesis that was measured and did not hold

Before running this, the guess was that `:371` having no message made it worse in a
second way: that node would print the leaked string as the assertion's `actual` value
and echo the credential into the log, and that a custom message would suppress that.

**It does not.** Node's TAP output prints `actual:` either way. The L1 run at `:329` —
which *does* carry a message — printed the full leaked detail:

```
error: 'credentials never reach the log'
actual: '{"status":"partial",…,"final":[{"period":1,"error":"ECONNRESET [espn_s2=test-s2]"}]}'
```

So the message changes the `error:` line only. A leaked fixture credential appears in
the failure output regardless, which is fine here — these are fixture values, not real
ones — but the containment claim was wrong and is not made. The change earns its keep
on naming alone.

## 6. Where this generalises, and where it must not

The rule this establishes is narrower than "split every alternation":

> An assertion over a list of **independent prohibitions** — a `doesNotMatch` whose
> branches are separate things that must each be absent — owes one assertion and one
> message per branch. An assertion over a list of **acceptable wordings** — a `match`
> whose branches are synonyms for one fact — is a single assertion and must stay one.

Splitting the second kind would break it: `assert.match(w.reason, /fewer than \d+
training rows|no measurable variance/)` (`test/consensus-weights.test.js:238`) would
become a demand that the reason say *both* things at once.

A sweep of `test/*.test.js` **after** this change counted 26 remaining assertions
carrying an alternation. 21 of them are `assert.match` — the acceptable-wordings kind —
and must be left alone. The other 5 are `assert.doesNotMatch`; of those, four are the
shape fixed here and one is not. None of the four is this thread's file:

| site | assertion | owner |
| --- | --- | --- |
| `test/health-endpoint.test.js:80` | `doesNotMatch(res.text, /data\|sqlite\|unable/i, …)` | not allocated here |
| `test/health-endpoint.test.js:91` | `doesNotMatch(res.text, /locked\|sqlite\|data/i)` — no message | not allocated here |
| `test/nfl-team-strength.test.js:89` | `doesNotMatch(k, /implied\|spread\|total_line\|market/, …)` | not allocated here |

The fourth, `test/page-explain.test.js:178`, is the same shape but its branches are
whole forbidden claims rather than tokens; it is the Coach thread's file. All four are
reported, none touched, under the one-editor-per-file rule.

One near miss that is **not** this shape: `test/trade-verify.test.js:212`,
`doesNotMatch(text, /you (were\|are) wrong/i)`. The alternation is inside a single
phrase, so it is one prohibition and stays one assertion.

## 7. The full check

Run on the tree of commit `ef513b6`, which is this file's parent — the
figures cannot be quoted inside the tree they measure, so they name the commit they
were taken on. `ef513b6` is this branch's only other commit and carries the code change
alone.

The other branch of this thread reports 2,985 for the same suite. The difference is
four test files and several added cases that exist only there and not on `main`; none
of them is this change.

```
$ npm run check
# tests 2950
# pass 2909
# fail 0
# cancelled 0
# skipped 41
# todo 0
✓ built in 2.45s
Application startup smoke passed on isolated database (32 teams).
exit=0
```

## Appendix A — the injections, exactly as applied

Generated from the sweep's own `MUT` list, not retyped.

### L1 — leaks espn_s2 only, into the recorded period error

`scripts/collect-roster-snapshots.mjs`

```diff
- summary.final.push({ period: p, error: String(e?.message ?? e).slice(0, 200) });
+ summary.final.push({ period: p, error: String(e?.message ?? e).slice(0, 200) + ` [espn_s2=${lg.espn_s2}]` });
```

### L2 — leaks SWID only, into the recorded period error

`scripts/collect-roster-snapshots.mjs`

```diff
- summary.final.push({ period: p, error: String(e?.message ?? e).slice(0, 200) });
+ summary.final.push({ period: p, error: String(e?.message ?? e).slice(0, 200) + ` [SWID=${lg.swid}]` });
```

### L3 — leaks the whole Cookie header, both credentials at once

`scripts/collect-roster-snapshots.mjs`

```diff
- summary.final.push({ period: p, error: String(e?.message ?? e).slice(0, 200) });
+ summary.final.push({ period: p, error: String(e?.message ?? e).slice(0, 200) + ` [espn_s2=${lg.espn_s2}; SWID=${lg.swid}]` });
```

### C0 — CONTROL: a pattern this file does not contain; must report NOT-FOUND

`scripts/collect-roster-snapshots.mjs`

```diff
- const COOKIE_JAR = new CredentialStore();
+ const COOKIE_JAR = null;
```
