# DAILY DIGEST (Batch D item 34) — one 9 AM ET summary, quiet if nothing changed

Own flag `GRIDIRON_DAILY_DIGEST=1` (never the preview switch). Off: nothing read or written.
The runner is a dry run unless `--apply`; the refresh loop passes `--apply` only while the flag is on.

## Pre-registered bar

| id | bar | fails if |
|----|-----|----------|
| B1 | nothing changed and no replies -> no digest | any outbox row on a quiet day |
| B2 | next move, goal status, and a title-odds move >= max(1 pt, 2 SE of the difference) are listed | a listed move inside the noise, or a real change missed |
| B3 | answers to Nick's own offers in (last check, now], by roster id, each once | another team's offer, an answer repeated, or unreadable offers read as "nobody replied" |
| B4 | only inside the 9 AM Eastern hour (EDT and EST), once per Eastern day | a row at 8:59 or 10:00 ET, or two rows in one day |
| B5 | a next move that fails the ONE rule gate (never-give.js#ruleGate), has no edge, or has no/throwing gate is never written out | any player of such a move in the text |
| B6 | team and manager names never appear; partners are "Team N" | any team or manager name in the text |
| B7 | off -> nothing; dry run -> nothing written; --apply -> one row + state | a write while off or in a dry run |
| B8 | served fields only (`_run` never read) | a digest caused by `_run` alone |

## RED

`test/daily-digest.test.js` committed before `server/services/campaign/daily-digest.js`,
`scripts/campaign/daily-digest.mjs` and the loop step existed: the suite failed on the missing modules.

## GREEN

- `server/services/campaign/daily-digest.js`: pure builder (window, snapshot, changes, replies, rule check, text).
- `scripts/campaign/daily-digest.mjs`: reads plans.json, digest-state.json and the decided-offers producer;
  appends one `{ kind: 'daily_digest' }` row to pushes.jsonl (the existing push path).
- `scripts/refresh-live-data.mjs`: step 8 `daily_digest`, flag-gated, records its summary line in sync_log.

16 tests, all B1-B8 covered; fixture plans only (test/fixtures/warroom-contract/producer-plans.json).
