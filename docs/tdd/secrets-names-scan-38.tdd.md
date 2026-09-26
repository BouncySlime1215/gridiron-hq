# TDD record: SECRETS + NAMES SCAN in CI (plan item 38)

Ask: "SECRETS + NAMES SCAN in CI: fail on credential patterns and league-mate name strings in
committed files."

## RED (d7b1ff63)

`test/secrets-scan.test.js` (new) and three new cases in `test/names-leak.test.js`.
`node --test test/secrets-scan.test.js test/names-leak.test.js`: 7 pass, 4 fail
(secrets-scan module missing; `--denylist-env` and `--skip-if-none` unknown).

## GREEN (37a2b4b1)

- `scripts/check-secrets.mjs`: 14 rules (Anthropic, OpenAI, GitHub token and PAT, AWS, private-key
  block, Slack, Google, Stripe live, Fly, ESPN `espn_s2` and `SWID`, JWT, generic assigned secret),
  each with an entropy floor and a placeholder filter. Reports file, line, rule and a 12-hex
  sha256 fingerprint; never the value. `.secrets-allowlist` entries need a reason.
- `scripts/check-names-leak.mjs`: `--denylist-env VAR` (one name per line, from the
  `NAMES_DENYLIST` repository secret in CI) and `--skip-if-none` (a loud `::warning::` SKIPPED
  instead of exit 2 when there is no denylist, e.g. a fork PR). Terms are never printed.
- `.github/workflows/ci.yml`: "Secrets scan" and "Names scan" steps after Lint.

Same command: 18 pass, 0 fail.

## First run on the whole tree

5 hits before any allowlist. 3 were ESPN `SWID` test fixtures with repeated digits
(entropy 2.95 and 3.17): the SWID floor was raised to 3.4, which a random 32-hex GUID clears.
2 were Pinnacle's public guest API key (the one pinnacle.com's own web client sends to
`guest.api.arcadia.pinnacle.com`) in `server/services/book-feeds.js` and
`scripts/line-history/pinnacle_capture.py`: allowlisted with that reason. After: 0 hits in 2,652
text files, about 2 s.

One fix to the RED test itself: its synthetic SWID sample was built from five `rnd()` calls that
restart the same seed, so every group began with the same characters (a low-entropy fake). It now
slices one 32-character draw.
