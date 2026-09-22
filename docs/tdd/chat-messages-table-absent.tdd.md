# The messages table can be absent outright, and corpusStats() must say so

Flagged by the coordinator, 2026-09-22, in `server/services/league-chat-sync.js`:
`corpusStats()`'s `newest_message` read (`SELECT MAX(ts_utc) AS m FROM
messages`) throws `no such table: messages` when a corpus sqlite file exists
(so the function is past its own no-corpus-at-all check) but was never run
through `scripts/chat/extract_league_chat.py` — the only thing in this repo
that creates `messages`. The existing catch swallowed that into the exact
same shape a genuine column-read failure produces (`test/chat-age.test.js`'s
"a corpus whose timestamp column is unreadable" case, where the table exists
but lacks `ts_utc`): both set `newest_message: null` plus a generic
`newest_message_error` string, distinguishable only by pattern-matching the
error text for "no such table" versus a column name.

Same failure family as Parts 6-9 of `archetype-as-of.tdd.md` (a caller told
"nothing here" without being told which of two different nothings it is),
in a different file, on a database this file opens itself rather than the
app's shared one — so the fix cannot reuse `tableExists()` from
`manager-signals.js` (that helper queries the app's own `rows()`), and
instead checks `sqlite_master` on the already-open corpus `db` handle.

**RED**, `test/chat-messages-table-absent.test.js`, commit `cf43ff6`: 3
tests, 0 pass, 3 fail — `newest_message_state` did not exist yet, so every
assertion on it failed with `undefined`.

**GREEN**, commit `9c2a072`: a `messagesTablePresent` check added ahead of
the existing try/catch, using `SELECT name FROM sqlite_master WHERE type =
'table' AND name = 'messages'` against the open corpus handle. Three states,
named:

- `table_absent` — the table itself is missing. `newest_message: null`,
  `newest_message_reason` names both the fact (not the same as a corpus with
  zero messages) and the one script that creates the table, so a reader does
  not go looking elsewhere. No `newest_message_error` on this path.
- `read_failed` — the table exists but the query threw (e.g. an old corpus
  with no `ts_utc` column). Unchanged behavior from before this fix:
  `newest_message_error` still carries the exception text, still matches
  `/ts_utc/` in the existing test that covers it.
- `present` — the normal case; reads succeed.

3/3 new tests green. Re-ran the full existing coverage for this file
(`chat-age.test.js`, `league-chat-sync.test.js`, `chat-block-wiring.test.js`,
`wiring-absent-states.test.js`) — 68 tests, 68 passed, 0 failed, confirming
the new state field does not disturb any existing assertion (none of them
inspect `newest_message_state`, so its addition is additive only).

**Mutations, hash-verified before and after every run:**

Unmutated `league-chat-sync.js` = `97053db49b53e8b6` (first 16 hex of the
full sha256, from `sha256sum`, not transcribed).

| # | Replaced (verbatim) | With (verbatim) | Test file / title | Result |
|---|---|---|---|---|
| M1 | `if (!messagesTablePresent) {` | `if (false) {` | `chat-messages-table-absent.test.js` / "a corpus file with no messages table says so by name, not by a generic read error" | caught — 2 pass, 1 fail |
| M2 | `'messages is not on this corpus database — created only by ' + 'scripts/chat/extract_league_chat.py, so a corpus file that exists but was never run through ' + 'it has no age to report here. This is not the same as a corpus with zero messages.'` | `'this corpus file has no age to report here. ' + 'This is not the same as a corpus with zero messages.'` (extractor-naming clause dropped) | same file / same title, the `extract_league_chat\.py` regex assertion | caught — 2 pass, 1 fail |

After each mutation the file was restored from a saved copy
(`/tmp/.../scratchpad/league-chat-sync.js.orig`) and re-hashed:
`97053db49b53e8b6` both times, confirmed byte-identical via `sha256sum`, and
`git diff` empty after the second restore — not merely "tests pass again."
M1 targets the guard itself (a reverted fix throws `no such table: messages`
again, landing in `read_failed` with a `ts_utc`-shaped error message instead
of `table_absent`). M2 targets the same weak-assertion failure mode Parts
6-9 of `archetype-as-of.tdd.md` already found repeatedly: a message that
says something happened without naming what a reader should actually do
about it.

Full check: see the thread's guard-block report for the commit this lands
on, not duplicated here to avoid two authoritative numbers for one commit.
