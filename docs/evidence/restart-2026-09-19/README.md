# The restart loop, 2026-09-19 22:09Z to 2026-09-20 13:43Z

Raw evidence for the count quoted in `docs/RELEASE-TRAIN-2026-09-19.md` §7.0b-END
and in PR #35: **302 process starts, every three minutes for fourteen hours and
fifty minutes, ending on the restart caused by setting `SCHEDULER_DISABLED=1`.**

**Why this is in the repository.** It lived only on `/mnt/project-files`, a
shared rclone mount that went intermittently unreadable on 2026-09-20. The
headline number of a release should not depend on a file store that can vanish,
so it has a second home here. The copies were taken at 16:32Z; the loggers were
still running, so a later read of the mount will show more rows and the same
302 starts.

## Reproduce the number

```
bash docs/evidence/restart-2026-09-19/restart-count.sh \
     docs/evidence/restart-2026-09-19/restart-health-log*.tsv
```

Run with no arguments it globs the shared mount instead, which is how it is
invoked everywhere else.

## What the files are

Three overlapping passive loggers, each one unauthenticated `GET /api/health`
per minute, writing `read_at`, `http`, `secs`, `uptime_s`, `derived_start`,
`crossed`, `interval_s`:

- `restart-health-log.tsv` — pass 1, from ~22:54Z on the 19th
- `restart-health-log-2.tsv` — pass 2, from 06:55Z on the 20th
- `restart-health-log-3.tsv` — pass 3, from ~11:05Z on the 20th

They overlap on purpose. A gap in one file is not a gap in the restarts, and the
reducer sorts every row by derived start before clustering so the answer does not
depend on which file a row came from or on the order they are read in.

## Three traps the reducer exists to avoid

**Counting distinct `derived_start` values overcounts.** `uptime_s` is whole
seconds, so two reads of the same process derive starts a second or two apart.
Starts within 5 seconds are clustered as one process — comfortably above the
rounding and far below the ~170-second cycle.

**Rows at `interval_s=300` are a floor, not a count.** That sampling interval is
nearly twice the cycle, so restarts were missed by construction. Rows at
`interval_s=60` are below the cycle and are a count. The reducer reports the two
stretches separately and refuses to add them.

**A read that crossed a restart is void as a reading and sound as a pin.**
`uptime_s` belongs to the process that answered, so its derived start is correct
even when the request began in an earlier life. The `crossed` column marks them.

## What the data shows

| Window | Reads | Answered | Dark | Distinct processes |
| --- | --- | --- | --- | --- |
| 22:53Z–13:43Z, before the brake | 1,345 | 883 | 462 (34.3%) | 302 |
| 13:44Z onward, under the brake | 321 | 321 | 0 | 1 |

Four starts observed before the log began are not in these files and the reducer
prints them separately: 22:09:00, 22:12:07, 22:14:51, 22:19:03 on 2026-09-19.
