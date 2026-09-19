#!/bin/bash
# Keep the archive from quietly eating the disk.
#
# WHY. line_history.sqlite runs in WAL mode with several collectors writing and long analysis
# reads scanning millions of rows. A long-lived reader blocks checkpointing, so the write-ahead
# log grows without bound: it reached 8.3 GB on 2026-09-17 while the database itself was 18 GB,
# and the repo had quietly become 33 GB. A PASSIVE checkpoint folds the log back into the
# database; TRUNCATE additionally reclaims the file, but only when no reader holds it open.
# Both are ordinary maintenance and neither loses data -- a checkpoint that cannot run simply
# reports busy and does nothing.
#
# Run from cron or the maintenance loop. Prints one line per database.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
THRESHOLD_MB=${1:-512}

printf '%s  ' "$(date '+%Y-%m-%d %H:%M:%S')"
df -h "$REPO" | tail -1 | awk '{printf "disk %s free of %s (%s used)\n", $4, $2, $5}'

for db in "$REPO"/data/line-history/*.sqlite "$REPO"/server/data.sqlite; do
  [ -f "$db" ] || continue
  wal="${db}-wal"
  [ -f "$wal" ] || continue
  mb=$(( $(stat -f%z "$wal" 2>/dev/null || stat -c%s "$wal" 2>/dev/null || echo 0) / 1048576 ))
  name=$(basename "$db")
  if [ "$mb" -ge "$THRESHOLD_MB" ]; then
    # PASSIVE first: always safe, moves pages into the db even with readers attached.
    sqlite3 "$db" "PRAGMA busy_timeout=60000; PRAGMA wal_checkpoint(PASSIVE);" >/dev/null 2>&1
    # TRUNCATE second: reclaims the file, no-ops harmlessly if a reader is still attached.
    sqlite3 "$db" "PRAGMA busy_timeout=60000; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1
    after=$(( $(stat -f%z "$wal" 2>/dev/null || stat -c%s "$wal" 2>/dev/null || echo 0) / 1048576 ))
    echo "  $name: WAL ${mb}MB -> ${after}MB (checkpointed)"
  else
    echo "  $name: WAL ${mb}MB (ok)"
  fi
done

du -sh "$REPO" 2>/dev/null | awk '{print "  repo total: "$1}'
