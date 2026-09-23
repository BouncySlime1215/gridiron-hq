"""LS-01 study: do benched-with-intact-usage (BWIU) players outscore what their manager
accepts in his next trade, over the following four weeks?

Pre-registration: docs/evidence/2026-09-23/ls-01-bwiu-trade-prereg.md (committed first).
Prints aggregates only: no league, manager or player id leaves this script.

Inputs (all read-only):
  SH   Sleeper corpus, sh_team_weeks + sh_transactions (immutable=1)
  PTS  rnd/skill/cache/points.pkl  (base = nflverse PPR; played flag; gsis_of)
  APP  a local copy of the app database (not production): player_week_snaps.offense_pct
       joined through players.gsis_id

Run:
  nice -n 10 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
    docs/evidence/2026-09-23/ls-01-bwiu-study.py --split discovery --app <copy>/data.sqlite
  (--split holdout reads 2025 only; run it once, after the discovery result is written)
"""
import argparse, json, pickle, sqlite3, sys
from collections import defaultdict
import numpy as np

SH = "file:/Users/nick_matta/Documents/GitHub/gridiron-hq/data/derived/sleeper_history.sqlite?mode=ro&immutable=1"
PTS = "/Users/nick_matta/gridiron-local/rnd/skill/cache/points.pkl"
SKILL = {"QB", "RB", "WR", "TE"}
LOOKBACK, MIN_WEEKS, MIN_STARTS, RATIO, MIN_MEAN = 3, 2, 2, 0.9, 0.4   # = BWIU_RULE in lineup-signals.js
WINDOW, LAST_NFL_WEEK = 4, 18
B, SEED = 2000, 20260923

ap = argparse.ArgumentParser()
ap.add_argument("--split", choices=["discovery", "holdout"], required=True)
ap.add_argument("--app", required=True)
a = ap.parse_args()
seasons = [2021, 2022, 2023, 2024] if a.split == "discovery" else [2025]

pk = pickle.load(open(PTS, "rb"))
P, gsis_of, pos_of = pk["P"], pk["gsis_of"], pk["pos"]

app = sqlite3.connect(f"file:{a.app}?mode=ro", uri=True)
snap = {}
for g, s, w, pct in app.execute("""SELECT p.gsis_id, s.season, s.week, s.offense_pct FROM player_week_snaps s
        JOIN players p ON p.id = s.player_id WHERE p.gsis_id IS NOT NULL AND s.season BETWEEN 2021 AND 2025"""):
    snap[(g, s, w)] = pct
app.close()


def share(sid, season, w):
    g = gsis_of.get(sid)
    return snap.get((g, season, w)) if g else None


def ppg(sid, season, weeks):
    d = P.get(sid, {}).get(season)
    if d is None:
        return None
    v = [float(d["base"][w]) for w in weeks if w < len(d["played"]) and d["played"][w] and not np.isnan(d["base"][w])]
    return sum(v) / len(v) if v else None


sh = sqlite3.connect(SH, uri=True)
leagues = [r for r in sh.execute("SELECT league_id, season FROM sh_leagues WHERE season IN (%s) ORDER BY league_id"
                                 % ",".join("?" * len(seasons)), seasons)]
pairs = {"bwiu": [], "sk": []}                     # (league_idx, D, win, sold)
counts = defaultdict(int)
for li, (lid, season) in enumerate(leagues):
    tw = defaultdict(dict)                         # roster -> week -> (starters set, players set)
    for rid, wk, st, pl in sh.execute("SELECT roster_id, week, starters_json, players_json FROM sh_team_weeks WHERE league_id = ?", (lid,)):
        tw[rid][wk] = (set(json.loads(st or "[]")), set(json.loads(pl or "[]")))
    trades = defaultdict(list)                     # roster -> [(t, received, given, idx)]
    for idx, (wk, adds, drops) in enumerate(sh.execute(
            "SELECT week, adds_json, drops_json FROM sh_transactions WHERE league_id = ? AND type = 'trade' AND status = 'complete' ORDER BY week, seq", (lid,))):
        adds, drops = json.loads(adds or "{}") or {}, json.loads(drops or "{}") or {}
        rosters = set(adds.values()) | set(drops.values())
        for r in rosters:
            recv = [p for p, to in adds.items() if to == r and pos_of.get(p) in SKILL]
            give = [p for p, fr in drops.items() if fr == r]
            trades[r].append((wk, recv, give, idx))
    counts["trades"] += len({t[3] for v in trades.values() for t in v})
    for rid, weeks in tw.items():
        seen = {"bwiu": set(), "sk": set()}
        for w in sorted(weeks):
            starters, players = weeks[w]
            for p in players:
                if pos_of.get(p) not in SKILL:
                    continue
                counts["skill_player_weeks"] += 1
                now = share(p, season, w)
                if now is not None:
                    counts["skill_player_weeks_with_snaps"] += 1
                before = [x for x in sorted(weeks) if x < w and p in weeks[x][1]][-LOOKBACK:]
                if len(before) < MIN_WEEKS:
                    continue
                started = [x for x in before if p in weeks[x][0]]
                if len(started) < MIN_STARTS:
                    continue
                sh_ = [share(p, season, x) for x in started]
                sh_ = [x for x in sh_ if x is not None]
                if not sh_ or now is None or now <= 0:
                    continue
                mean = sum(sh_) / len(sh_)
                if p in starters:
                    kind = "sk"
                elif mean >= MIN_MEAN and now >= RATIO * mean:
                    kind = "bwiu"
                else:
                    continue
                counts[f"{kind}_events"] += 1
                nxt = [t for t in trades.get(rid, []) if w < t[0] <= w + WINDOW and t[1]]
                if not nxt:
                    continue
                t, recv, give, idx = nxt[0]
                if (p, idx) in seen[kind]:
                    continue
                seen[kind].add((p, idx))
                win = list(range(t + 1, min(t + WINDOW, LAST_NFL_WEEK) + 1))
                mine = ppg(p, season, win)
                got = [x for x in (ppg(q, season, win) for q in recv) if x is not None]
                if mine is None or not got:
                    counts[f"{kind}_pairs_dropped_no_games"] += 1
                    continue
                d = mine - sum(got) / len(got)
                pairs[kind].append((li, d, d > 0, p in give))
sh.close()


def league_sums(rs):
    n_l = len(leagues)
    tot, cnt = np.zeros(n_l), np.zeros(n_l)
    for li, d, *_ in rs:
        tot[li] += d; cnt[li] += 1
    return tot, cnt


def boot_draws():
    rng = np.random.default_rng(SEED)
    return rng.integers(0, len(leagues), size=(B, len(leagues)))


DRAWS = None


def boot_mean(rs):
    """Cluster bootstrap over leagues: each draw resamples whole leagues; returns B means."""
    tot, cnt = league_sums(rs)
    t, c = tot[DRAWS].sum(1), cnt[DRAWS].sum(1)
    return np.where(c > 0, t / np.maximum(c, 1), np.nan)


def summarize(name, rs, bs):
    ds = np.array([r[1] for r in rs])
    est = float(ds.mean()) if len(ds) else float("nan")
    bs = bs[~np.isnan(bs)]
    lo, hi = np.percentile(bs, [2.5, 97.5]) if len(bs) else (float("nan"),) * 2
    se = float(bs.std(ddof=1)) if len(bs) > 1 else float("nan")
    wr = float(np.mean([r[2] for r in rs])) if rs else float("nan")
    print(f"{name}: pairs={len(rs)} leagues={len({r[0] for r in rs})} meanD={est:+.3f} 95%CI=[{lo:+.3f}, {hi:+.3f}] "
          f"SE={se:.3f} MDE80={2.80 * se:.3f} win_rate={wr:.3f}")
    return est, lo, hi, se


DRAWS = boot_draws()
print(f"split={a.split} seasons={seasons} leagues={len(leagues)}")
print("counts", json.dumps(dict(counts), sort_keys=True))
summarize("H1 BWIU", pairs["bwiu"], boot_mean(pairs["bwiu"]))
summarize("SK control", pairs["sk"], boot_mean(pairs["sk"]))
sold = [r for r in pairs["bwiu"] if r[3]]
summarize("BWIU sold in that trade (descriptive)", sold, boot_mean(sold))
delta = boot_mean(pairs["bwiu"]) - boot_mean(pairs["sk"])
delta = delta[~np.isnan(delta)]
est = float(np.mean([r[1] for r in pairs["bwiu"]]) - np.mean([r[1] for r in pairs["sk"]])) if pairs["bwiu"] and pairs["sk"] else float("nan")
lo, hi = np.percentile(delta, [2.5, 97.5])
se = float(delta.std(ddof=1))
print(f"H2 BWIU-SK: delta={est:+.3f} 95%CI=[{lo:+.3f}, {hi:+.3f}] SE={se:.3f} MDE80={2.80 * se:.3f}")
