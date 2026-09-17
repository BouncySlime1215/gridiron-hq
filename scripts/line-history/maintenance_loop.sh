#!/bin/bash
# Overnight maintenance: Pinnacle capture every 10 minutes, database backup once a day.
#
# WHY THIS EXISTS INSTEAD OF launchd.
# Both jobs were first written as LaunchAgents and both are blocked by macOS TCC: a LaunchAgent does
# not inherit Terminal's Full Disk Access, so it cannot read or write anything under ~/Documents —
# which is where both the repo and the backup directory live. Moving the script out to
# ~/Library/Application Support let launchd EXECUTE it, but it still could not touch the databases
# or the log, so that is not a fix. The agents remain installed and will start working the moment
# Full Disk Access is granted; until then this loop, started from an already-authorised shell, does
# the same work.
#
#   Grant it at: System Settings -> Privacy & Security -> Full Disk Access
#   (add /bin/bash, or the Terminal/Claude app that launches the agents)
#
# WHAT IS AT STAKE. On 2026-09-16 a 16 GB database was deleted with no usable backup — the newest
# one turned out to be an empty pre-restore shell — and the whole of that night went on rebuilding
# what could be rebuilt. Separately, Pinnacle's week-1 closing lines were lost forever because
# nothing was capturing them, which is why 56 preregistered shadow decisions can never be settled by
# their own stated rule. These two loops exist so neither happens again.
#
# Start:  nohup scripts/line-history/maintenance_loop.sh > /dev/null 2>&1 &
# Stop:   pkill -f maintenance_loop.sh
set -uo pipefail

REPO="/Users/nick_matta/Documents/GitHub/gridiron-hq"
LOGDIR="$REPO/data/line-history"
LAST_BACKUP_DAY=""

cd "$REPO/scripts/line-history" || exit 1

while true; do
  # --- Pinnacle forward capture. Every CLV number in this project is graded against Pinnacle and
  # no free source carries its history, so a gap here is permanent.
  /usr/bin/python3 -W ignore pinnacle_capture.py >> "$LOGDIR/pinnacle_capture.log" 2>&1

  # --- Daily backup, first pass after 04:00 local.
  TODAY=$(date +%Y-%m-%d)
  HOUR=$(date +%H)
  if [ "$TODAY" != "$LAST_BACKUP_DAY" ] && [ "$HOUR" -ge 04 ]; then
    if bash "$REPO/scripts/nightly-backup.sh"; then
      LAST_BACKUP_DAY="$TODAY"
      echo "[$(date -u +%FT%TZ)] maintenance: backup ok" >> "$LOGDIR/maintenance.log"
    else
      echo "[$(date -u +%FT%TZ)] maintenance: BACKUP FAILED" >> "$LOGDIR/maintenance.log"
    fi
  fi

  sleep 600
done
