#!/bin/bash
# Nightly snapshot of the Gridiron databases.
#
# On 2026-09-16 the 16 GB live database was deleted with no backup newer than 2026-09-03,
# and that 2026-09-03 file turned out to be a pre-restore shell holding no history at all.
# Everything recoverable had to be rebuilt from public sources over the following night.
# This job exists so that cannot happen twice.
#
# VACUUM INTO is safe to run against a database being written under WAL: it takes a read
# snapshot and writes a compacted copy, without blocking writers or requiring the app to stop.
#
# Installed via ~/Library/LaunchAgents/com.gridironhq.nightly-backup.plist (runs 04:30 daily).
set -uo pipefail

REPO="/Users/nick_matta/Documents/GitHub/gridiron-hq"
DEST="$HOME/Documents/gridiron-db-backups"
KEEP=7
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$DEST/backup.log"

mkdir -p "$DEST"
echo "[$(date -u +%FT%TZ)] starting" >> "$LOG"

# The application database is the one that matters most: it is the surviving restore point and
# the only file here that is not reconstructible from public sources.
for SRC in "$REPO/server/data.sqlite" "$REPO/data/line-history/line_history.sqlite"; do
  [ -f "$SRC" ] || { echo "  skip (missing): $SRC" >> "$LOG"; continue; }
  NAME=$(basename "$SRC" .sqlite)
  OUT="$DEST/$NAME.$STAMP.bak"
  # Free space check: require the source's own size plus 2 GB of headroom.
  NEED=$(( $(stat -f%z "$SRC") / 1048576 + 2048 ))
  FREE=$(df -m "$DEST" | awk 'NR==2 {print $4}')
  if [ "$FREE" -lt "$NEED" ]; then
    echo "  REFUSING $NAME: need ${NEED}MB, have ${FREE}MB free" >> "$LOG"
    continue
  fi
  if sqlite3 "file:$SRC?mode=ro" "VACUUM INTO '$OUT'" 2>>"$LOG"; then
    echo "  ok $NAME -> $(basename "$OUT") ($(( $(stat -f%z "$OUT") / 1048576 ))MB)" >> "$LOG"
  else
    echo "  FAILED $NAME" >> "$LOG"
    rm -f "$OUT"
    continue
  fi
  # Retain the newest $KEEP snapshots of THIS database only, so a large archive rotating
  # does not evict the application database's history.
  ls -1t "$DEST/$NAME."*.bak 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r OLD; do
    echo "  prune $(basename "$OLD")" >> "$LOG"
    rm -f "$OLD"
  done
done

echo "[$(date -u +%FT%TZ)] done" >> "$LOG"
