"""Run the recorder until stopped.  python scripts/record.py [--root data] [--rate 1.0]"""
import argparse
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from house.client import Kalshi          # noqa: E402
from house.recorder import Recorder      # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--root", default=str(Path(__file__).resolve().parents[1] / "data"))
ap.add_argument("--rate", type=float, default=1.0)
ap.add_argument("--sweeps", type=int, default=0, help="stop after this many (0 = run until stopped)")
a = ap.parse_args()

stop = []
signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
signal.signal(signal.SIGINT, lambda *_: stop.append(1))
rec = Recorder(a.root, Kalshi(rate=a.rate), log=lambda m: print(time.strftime("%H:%M:%S"), m, flush=True))
if a.sweeps == 1:
    rec.t_meta = time.time()      # a single pass already fetches market facts for every market it has not seen
while not stop and (not a.sweeps or rec.sweeps < a.sweeps):
    try:
        line = rec.step()
        print(time.strftime("%H:%M:%S"), f"sweep {line['sweep']}: {line['scored']} books in {line['t1'] - line['t0']:.0f}s, "
              f"{line['changed']} changed, {len(line['failed'])} failed, ${line['pool_day_valid']:,.0f}/day valid on "
              f"${line['collateral']:,.0f}, throttled {line['throttled']}", flush=True)
    except Exception as e:            # never die on one bad sweep; the gap shows up in sweeps.jsonl
        print(time.strftime("%H:%M:%S"), "sweep failed:", repr(e), flush=True)
        time.sleep(20)
