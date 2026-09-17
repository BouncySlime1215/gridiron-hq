"""Match scored espn_plays rows to nflverse play_by_play rows, for LABEL VALIDATION only.
Writes espn_play_id -> nflverse structured flags into the scratch DB."""
import sqlite3, re, os
from collections import defaultdict
OUT = os.environ['OUT_DB']
P1 = '/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/line_history.sqlite'
P2 = '/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/nflverse.sqlite'
c = sqlite3.connect(f'file:{P1}?mode=ro', uri=True)
c.execute(f"ATTACH DATABASE 'file:{P2}?mode=ro' AS nv")
norm = lambda s, n: re.sub(r'[^a-z]', '', s.lower())[:n]

esp = c.execute("""SELECT p.event_id,p.play_id,p.text,g.game_id,p.period,p.clock
 FROM espn_plays p JOIN nv.nfldata_games g ON CAST(g.espn AS TEXT)=p.event_id
 WHERE g.game_type='REG' AND g.season BETWEEN 2016 AND 2025
 AND (p.text LIKE '%INTERCEPTED%' OR p.text LIKE '%FUMBLES%' OR p.text LIKE '%MUFFS%' OR p.text LIKE '%BLOCKED%')
 AND p.text IS NOT NULL AND LENGTH(p.text)>25""").fetchall()

FIELDS = ['posteam','defteam','interception','fumble_lost','fumble','fumble_forced','fumble_not_forced',
          'aborted_play','punt_blocked','safety','pass_defense_1_player_name','forced_fumble_player_1_team',
          'fumble_recovery_1_team','fumbled_1_team','epa','air_yards','qb_hit','sack','touchdown','return_touchdown']
full, pre, qc = defaultdict(list), defaultdict(list), defaultdict(list)
q = f"SELECT game_id,play_id,desc,qtr,time,{','.join(FIELDS)} FROM nv.play_by_play WHERE season BETWEEN 2016 AND 2025"
for r in c.execute(q):
    gid, pid, d, qt, tm = r[0], r[1], r[2], r[3], r[4]
    if not d: continue
    rec = dict(zip(FIELDS, r[5:])); rec['_pid'] = pid
    full[(gid, norm(d,100))].append(rec); pre[(gid, norm(d,45))].append(rec)
    qc[(gid, int(qt or 0), tm)].append((norm(d,25), rec))

out = sqlite3.connect(OUT)
out.execute('DROP TABLE IF EXISTS nv_match')
out.execute('CREATE TABLE nv_match (event_id TEXT, play_id TEXT, method TEXT, ' +
            ', '.join(f'"{f}"' for f in FIELDS) + ', PRIMARY KEY(event_id,play_id))')
n = 0
for ev, pid, t, gid, per, clk in esp:
    m = full.get((gid, norm(t,100)))
    meth = 'exact'
    if not m:
        cand = [r for k, r in qc.get((gid, int(per or 0), clk), []) if k == norm(t,25)]
        if len(cand) == 1: m, meth = cand, 'qtrclock'
    if not m:
        cand = pre.get((gid, norm(t,45)), [])
        if len(cand) == 1: m, meth = cand, 'prefix'
    if not m: continue
    rec = m[0]
    out.execute(f'INSERT OR REPLACE INTO nv_match VALUES (?,?,?,{",".join("?"*len(FIELDS))})',
                [ev, pid, meth] + [rec[f] for f in FIELDS])
    n += 1
out.commit()
print(f'espn candidates {len(esp)}  matched {n}  rate {n/len(esp):.4f}')
