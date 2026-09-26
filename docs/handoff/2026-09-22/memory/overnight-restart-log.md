---
name: overnight-restart-log
description: The overnight restart record: final count 302, the brake that ended it 13:43Z 2026-09-20, and the one command to re-read it.
metadata:
  type: project
---

Set up 2026-09-19 ~22:53Z by the Trade Brain thread to produce the single
overnight restart number. Traps and proofs: [[overnight-restart-count-traps]].

## THE COUNT IS CLOSED: 302
**302 distinct process starts between 22:53Z on 2026-09-19 and 13:43:13Z on
2026-09-20** — every three minutes for fourteen hours and fifty minutes. Nick
ran `fly secrets set SCHEDULER_DISABLED=1 -a gridiron-hq` at about 13:43Z and it
stopped dead. **The 302nd start is the brake's own restart** (setting a secret
restarts the machine), so everything after it is the quiet period, not another
life. Do not quote a higher number without re-running the reducer and saying why.

**The brake held, measured not assumed.** Probe at 20s, 13:44:51Z-13:53:31Z:
27 reads, all answered, one derived start, `uptime_s` 99 → 619 unbroken. Passive
logs since 13:44Z: 321 reads, **zero dark**, one process. Before it: 1,345 reads,
462 finding nothing — **34.3% dark**. The first braked life went straight through
the 94-110s band that had ended every life before it.

**Attribution is still open and the brake cannot settle it.** Both 90s
candidates are unarmed by the single `return` at scheduler.js:1732, so a quiet
machine is equally consistent with either. It waits for the unset and for the
`nfl_model_growth_runs` query. Presence of a `running` row proves the job
started; absence proves nothing, because the row is inserted at
nfl-model-growth.js:163-166, below the warehouse snapshot and its hash.

## Files, and how to invoke them
- **In the repo**, on `claude/release-train-2yv3x6-hold` at `02db06c`:
  `docs/evidence/restart-2026-09-19/` holds all three logs, the reducer and a
  README. **Use this** — `/mnt/project-files` went intermittently unreadable on
  2026-09-20. Checked: the reducer returns 302 from the repo copies too.
- `/mnt/project-files/restart-health-log*.tsv` — the live data, three
  overlapping files (pass 1 ~22:54Z, pass 2 06:55Z, pass 3 ~11:05Z). A gap in a
  file is not a gap in the restarts.
- `bash .../restart-count.sh [files...]` — **one command, one number.** With no
  arguments it globs the mount; pass the repo copies to read those instead.
- Passes 2 and 3 still run in the release-train session, one GET a minute:
  the proof the quiet period stays quiet. Leave them until after the unset.

**The reducer SORTS rows by derived start before clustering, and it must.** The
clustering is one forward scan, so concatenated overlapping logs hand it a jump
of hours backwards and every process in the overlap is counted twice.
`restart-count.sh.bak` is the pre-change copy.

**Never edit a script while bash is executing it** — bash reads it
incrementally and can run a corrupted tail. Each pass is a new file for that
reason as much as to avoid two writers on one output.

**`/mnt/project-files` is an rclone FUSE mount with NO execute bit.** `chmod +x`
returns success and the file stays `-rw-r--r--`, so `./script.sh` dies with
"bad interpreter: Permission denied". Always `bash <path>`, for any script in
that directory. It lives there and not in `/tmp` because `/tmp` goes with the
container: a reclaim kills the logger, never the data.

## Cadence, and why each row carries `interval_s`
300s until ~22:53:06Z, 60s after. The cycle was ~170s, so `interval_s 300` rows
are a **FLOOR** (sampling slower than the period misses restarts by
construction) and `interval_s 60` rows are a **COUNT**. The reducer reports them
separately and refuses to add them. The logger sleeps the REMAINDER of the
interval, not a flat 60s: a read against a wedging app took up to 25s, and a
flat sleep drifts the cadence to ~85s, reintroducing the undersampling.

Crossed rows still pin a restart correctly. See [[reads-that-cross-a-restart]].

Starts seen before the log began, not in the file: 22:09:00, 22:12:07,
22:14:51, 22:19:03 (2026-09-19). The reducer prints these too.
