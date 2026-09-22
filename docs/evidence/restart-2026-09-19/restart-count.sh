#!/bin/bash
#
# RUN IT AS:   bash /mnt/project-files/restart-count.sh
#
# NOT as ./restart-count.sh. /mnt/project-files is an rclone FUSE mount that does
# not carry the execute bit -- chmod +x appears to succeed and the file stays
# -rw-r--r--, so a direct call dies with "bad interpreter: Permission denied".
# Found the hard way at 22:55Z, minutes after handing the wrong command over.
#
# Turn the health log into the one number: how many times the app restarted, and
# when it last did. Written the night before rather than improvised at 06:00Z.
#
# THE TRAP THIS EXISTS TO AVOID. Counting distinct derived_start values naively
# OVERCOUNTS. `uptime_s` is whole seconds, so two reads of the SAME process give
# derived starts a second or two apart. At a 60s cadence against a ~90s serving
# window most processes are read more than once, so the naive count inflates by
# roughly the number of processes. Starts are therefore clustered: any two
# within TOL seconds are the same process.
#
# TOL is 5s: comfortably above uptime_s rounding plus clock skew, and far below
# the ~160s restart cycle, so it cannot merge two real restarts.
#
# THE SECOND TRAP. Rows taken at interval_s=300 are a FLOOR, not a count: the
# sampling interval was nearly twice the cycle, so restarts were missed by
# construction. Rows at interval_s=60 are below the cycle and are a count. This
# reports the two stretches separately and refuses to add them into one number.
#
# THE THIRD TRAP, and why this now sorts. There is more than one log file: the
# first logger lapses at about 09:50Z and a second one was started at 06:55Z so
# that no gap opens. Their rows overlap in time, and `cat a b` hands the
# clustering a stretch of file A's late rows followed by file B's early ones --
# a jump of hours backwards. The clustering is a single forward scan, so every
# process in the overlap would be counted a second time. Sorting the rows by
# DERIVED START before clustering makes the result independent of which file a
# row came from and of the order the files are read in. A process seen by both
# loggers collapses into one start by the same TOL rule that already handles
# being read twice by one logger.
TOL=${TOL:-5}
# Every log, or just the one named on the command line. Nothing here assumes how
# many there are, so a third pass needs no edit.
if [ $# -gt 0 ]; then LOGS=("$@"); else LOGS=(/mnt/project-files/restart-health-log*.tsv); fi
LOG="${LOGS[*]}"

# Header dropped per file, then sorted by derived_start (column 5). Empty
# derived starts are the hangs; they sort to the front and the awk counts them
# without touching the clustering state.
rows () { awk -F'\t' 'FNR > 1' "${LOGS[@]}" | sort -t"$(printf '\t')" -k5,5; }

report () {   # $1 = interval label, $2 = "count" or "floor"
  rows | awk -F'\t' -v want="$1" -v tol="$TOL" -v kind="$2" '
    $7 != want { next }
    $5 == "" { hangs++; next }                     # no reading: contributes nothing
    {
      gsub(/[-:TZ]/, " ", $5)
      t = mktime($5)
      if (t == -1) { bad++; next }
      reads++
      # ABSOLUTE difference, not signed. A crossed read derives a start slightly
      # ahead of a clean one, and a slow read can land out of order, so derived
      # starts are not guaranteed monotonic. A signed test treats a backwards
      # jump as "same process" and silently merges two real restarts.
      d = t - last; if (d < 0) d = -d
      if (last == "" || d > tol) { starts[++n] = t; last = t }
      else if (t > last) { last = t }              # same process, refine
      newest = (t > newest) ? t : newest
    }
    END {
      if (!reads && !hangs) { printf "  interval %ss: no rows\n", want; exit }
      printf "  interval %ss: %d distinct process start(s) -- this is a %s\n", want, n, kind
      printf "    %d read(s) with a reading, %d hang(s) with none", reads, hangs
      if (bad) printf ", %d unparseable", bad
      printf "\n"
      if (n) printf "    last start: %s\n", strftime("%Y-%m-%dT%H:%M:%SZ", newest)
    }'
}

echo "Restart timeline from ${#LOGS[@]} log file(s) (clustering tolerance ${TOL}s)"
for f in "${LOGS[@]}"; do echo "  $f  $(( $(wc -l < "$f") - 1 )) row(s)"; done
echo
echo "BEFORE the cadence change -- a FLOOR, never quote as a count:"
report 300 floor
echo
echo "AFTER the cadence change -- below the ~160s cycle, so a COUNT:"
report 60 count
echo
crossed=$(rows | awk -F'\t' '$6=="crossed"' | wc -l)
echo "Reads answered by a process younger than the request itself: $crossed"
echo "  (void as readings, kept as timeline pins -- uptime_s belongs to the"
echo "   process that ANSWERED, so their derived starts are sound)"
echo
echo "NOT IN THIS FILE -- starts observed before the log began, from earlier reads:"
echo "  22:09:00, 22:12:07, 22:14:51, 22:19:03 (2026-09-19)"
