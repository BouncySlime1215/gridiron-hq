---
name: chat-corpus-not-on-this-machine
description: The league chat corpus cannot exist on Fly or any cloud box — absent is the permanent correct state there, and every reader must say so rather than return a silent empty.
metadata:
  type: project
  modified: 2026-09-20T06:40:11.170Z
---

`data/derived/league_chat.sqlite` is a **separate** SQLite file from the app
database. It is extracted from `~/Library/Messages/chat.db` by
`scripts/chat/extract_league_chat.py`, which needs a Mac and Full Disk Access.
**On Fly it is not missing, it is not producible.** Absent there is permanent
and correct, not a broken sync — the register agreed with Nick's coordinator
(06:20Z 2026-09-20) is "not on this machine", not louder.

**Reading it.** Always `openChatDb()` from `manager-signals.js` — never
`new DatabaseSync` directly: the path comes from `chatDbPath()` (env
`GRIDIRON_CHAT_DB_PATH`, else the default) and the helper sets
`busy_timeout`, because the refresh loop rewrites rollup tables every 15
minutes. `openChatDb()` returns `null` when there is no file.

**Per-person text chains** (what Coach's profiles are built from): table
`messages` — `msg_id, chat_kind, chat_name, handle, name, is_from_me, ts_utc,
text`. One person's full two-sided chain is

```sql
SELECT ts_utc, is_from_me, text FROM messages
 WHERE chat_kind='dm' AND chat_name = ? ORDER BY msg_id
```

Key on **`chat_name`**, not `handle`: `handle` is the *sender's*, so it is null
on Nick's own side of a DM and keying on it silently drops half the
conversation. `chat_name` for a DM is the participant's name from
`participants(handle PRIMARY KEY, name, dm_chat_id)`. The group thread is
`chat_kind='group'`, one group, "Transfer league 2026".

**Why a silent empty is dangerous here, with the concrete case.**
`bluff-detector.js`'s `declarationCredibility()` returned
`{byManager: Map(), events: [], available: false}` with no corpus, and
`counterparty-pricing.js:144` reads an empty credibility map as *he has never
called a player untouchable* — the opposite conclusion, and it moves a trade
price. A boolean cannot say which of two opposite things it means. Fixed
2026-09-20 (`98a9deb`): the read now carries a `reason` naming the path and the
Mac-only origin, and `league-chat-sync.js`'s `status()` carries `path` at the
top level so the absent state says where it looked.

Open, Trade Brain's file: `counterparty-pricing.js:144` still does not branch
on `available`. See [[archetype-as-of-accessor]].

---

**Two defects fixed 2026-09-20 (`9ee6647`, branch `claude/project-thread-sytruo-asof-hold`):**

1. **`corpusStats` read `MAX(sent_at)` from `messages`, a column that has never
   existed** — it is `ts_utc` (`extract_league_chat.py:84`). It threw on every
   corpus, a bare catch swallowed it, and `newest_message` was always null
   behind a comment explaining the null as "an older corpus without the
   column". A permanent failure dressed as a handled edge case.
2. **Chat stamps were SQLite `YYYY-MM-DD HH:MM:SS`** while everything else on
   the manager card is `toISOString()`. Now ISO at all four producers
   (`apple_ts`, `extract_runs.ran_at`, both rollups' `computed_at`), plus
   `normalise_stamps()` in the extractor, run **before the watermark read**,
   idempotent. **Why it cannot be writer-only:** the extractor is incremental,
   so a corpus would hold both formats, and they do not sort against each other
   — `T` is 0x54, a space 0x20, so `MAX(ts_utc)` returns the newest
   *new-format* row whatever its date. `isoStamp(value)` is exported from
   `league-chat-sync.js` for reading a corpus that has not been re-pulled yet;
   both layers are load-bearing.
   `league_hour` takes both formats: `datetime.fromisoformat` only accepts a
   trailing `Z` from **Python 3.11**, and Nick's Mac may be older.

**THE AGE RULING (coordinator, 07:15Z 2026-09-20), now the contract:** how old
the chat data is = **the newest message timestamp**, ISO, on every surface. The
rollup's `computed_at` and the last pull's `finished_at` are **provenance shown
beside it, never alternative ages**. So an uploaded corpus is NOT `unknown` — it
is dated by its messages with provenance "uploaded, not pulled here".
`unknown` now means one thing only: messages that carry no readable date.
The client's enum (`fresh|aging|stale|absent|unknown`) is unchanged;
`STATE_MAPPING` in `league-chat-sync.js` declares which client state each of the
five upstream states becomes.

Two tests in `test/league-chat-sync.test.js` asserted the OLD rule (pull stamp
as the age; upload = unknown) and were rewritten to the new one with a dated
comment. Anyone re-reading them should not "restore" the old behaviour.

---

**ONE BLOCK, ONE READER (2026-09-20, Part 6).** `chatCorpusState()` in
`manager-signals.js` (Trade Brain, commit **`34250dc`** on
`claude/project-thread-3xqh5l-accessor-hold` — NOT `ef3164e`, which is a
trades.js route cull) is the shared reader:
`{ as_of, computed_at, rows, path, path_source, collected_by, reason }`.
`freshness()` in `league-chat-sync.js` is the consumer and **runs no query of
its own**; its suite runs with no corpus on disk and the env path pointed at a
decoy, so any re-derivation fails without a mutation.

**The trap in the block's field name.** `as_of` is `MAX(last_msg)` over
`manager_chat_profile` — the newest message *the rollup has seen*. `rollup()`
runs **only under `--rollup`** (`extract_league_chat.py:369`) and its `base` CTE
drops messages with no sender name and no text. So it lags the corpus. Serving
it as the age makes a stale rollup over a live corpus read as a dead league.
**The age is still the newest message** (the 07:15Z ruling stands); the block's
`as_of` is what it is measured against, and the gap is its own field
`rollup: 'current' | 'behind' | 'unknown' | 'missing'`.

`rows: 0` on the block = no manager profiles, which is **not** absent: the
messages are there and dated and the fix is one flag, not a trip to the Mac.
`STATE_MAPPING` gained `present_but_not_rolled_up` and
`rolled_up_behind_the_corpus`, and lost `no_path_configured` (unreachable —
`chatDbPath()` always returns a string; `path_source` is the real distinction).

`corpusStats()` now emits the block's shape outright (`rolled_up_at` renamed
`computed_at`), so when `chatCorpusState()` lands on this branch's base one
producer is deleted and nothing downstream changes.
