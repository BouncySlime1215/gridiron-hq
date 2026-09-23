"""RL-10-1 fix: precision of 'ESPN at-lock 0' split by Friday NFL report status, 2021-24 REG weeks 2-17
(2025 not read). Same pool/labels as rnd/loop/scripts/r10x_espn_zero_flag.py (relevant = ESPN prev week >= 5,
QB/RB/WR/TE, roster status ACT or INA; did-not-play = INA or no stat row). Adds the split the card needs:
the producer excludes Out/Doubtful, so the card's population is Friday Questionable or undesignated."""
import json, gzip, sqlite3, collections, math
D='/Users/nick_matta/gridiron-local/rnd/loop/data'
c=sqlite3.connect('file:/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/nflverse.sqlite?mode=ro',uri=True)
e2g={str(int(e)):g for g,e in c.execute("select gsis_id, espn_id from players where espn_id is not null and gsis_id is not null")}
proj={}
for s in (2021,2022,2023,2024):
    d=json.load(gzip.open(f'{D}/espn_proj_hist/espn_leaguedefaults3_{s}.json.gz'))
    for p in d['players']:
        g=e2g.get(str(p['player']['id']))
        if g is None: continue
        for x in p['player'].get('stats',[]):
            if x.get('seasonId')==s and x.get('statSplitTypeId')==1 and x.get('statSourceId')==1 and 1<=x.get('scoringPeriodId',0)<=18:
                proj[(s,x['scoringPeriodId'],g)]=x.get('appliedTotal',0.0) or 0.0
rep={(s,w,g):st for g,s,w,st in c.execute("select gsis_id,season,week,report_status from injuries where season between 2021 and 2024 and game_type='REG'")}
played={(s,w,g) for g,s,w in c.execute("select player_id,season,week from stats_player_week where season between 2021 and 2024 and season_type='REG'")}
for thr,name in ((1,'e<1 (r10 rule)'),(0.05,'e<0.05 (producer ZERO_MAX)')):
    n=collections.Counter(); dnp=collections.Counter()
    for s,w,g,st in c.execute("select season,week,gsis_id,status from roster_weekly where season between 2021 and 2024 and game_type='REG' and week between 2 and 17 and position in ('QB','RB','WR','TE')"):
        if not g: continue
        e=proj.get((s,w,g))
        if e is None or e>=thr or proj.get((s,w-1,g),0)<5 or st not in ('ACT','INA'): continue
        f=rep.get((s,w,g)) or 'none'
        k='Q/none' if f in ('Questionable','none') else f
        n[k]+=1; dnp[k]+= (st=='INA' or (s,w,g) not in played)
    print(name)
    for k in sorted(n):
        p=dnp[k]/n[k]; se=math.sqrt(p*(1-p)/n[k])
        print(f'  Friday {k}: flagged {n[k]}, did not play {dnp[k]} ({p:.3f}, 95% CI {p-1.96*se:.3f}-{p+1.96*se:.3f})')
    print(f'  all: flagged {sum(n.values())}, did not play {sum(dnp.values())} ({sum(dnp.values())/sum(n.values()):.3f})')
# recall on surprise scratches (INA, Friday Q/none), both thresholds
for thr in (1,0.05):
    t=r=0
    for s,w,g,st in c.execute("select season,week,gsis_id,status from roster_weekly where season between 2021 and 2024 and game_type='REG' and week between 2 and 17 and position in ('QB','RB','WR','TE') and status='INA'"):
        if not g: continue
        e=proj.get((s,w,g))
        if e is None or proj.get((s,w-1,g),0)<5: continue
        if (rep.get((s,w,g)) or 'none') not in ('Questionable','none'): continue
        t+=1; r+=(e<thr)
    print(f'recall surprise INA thr {thr}: {r}/{t} ({r/t:.3f})')
