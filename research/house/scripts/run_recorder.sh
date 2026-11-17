#!/usr/bin/env bash
# Keep the recorder alive. Public reads only.  nohup setsid scripts/run_recorder.sh &
cd "$(dirname "$0")/.." && source .venv/bin/activate && mkdir -p data
while true; do
  python scripts/record.py --rate 0.45 >> data/recorder.log 2>&1
  echo "$(date -u +%FT%TZ) recorder exited, restarting in 30s" >> data/recorder.log
  sleep 30
done
