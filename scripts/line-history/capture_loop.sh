#!/bin/bash
# Forward capture loop for Pinnacle, every 10 minutes.
#
# This exists because the launchd agent (com.gridironhq.pinnacle-capture) is blocked by macOS TCC:
# a LaunchAgent does not inherit Terminal's Full Disk Access, so it cannot read the repo under
# ~/Documents and dies with "Operation not permitted". Granting Full Disk Access to launchd fixes
# that properly; until then this loop, started from an already-authorised shell, does the same job.
#
# Why it matters: Pinnacle is the benchmark every CLV number is graded against, no free source
# carries its history, and week 1's closes were lost forever because nothing was capturing them.
cd /Users/nick_matta/Documents/GitHub/gridiron-hq/scripts/line-history || exit 1
while true; do
  /usr/bin/python3 -W ignore pinnacle_capture.py >> ../../data/line-history/pinnacle_capture.log 2>&1
  sleep 600
done
