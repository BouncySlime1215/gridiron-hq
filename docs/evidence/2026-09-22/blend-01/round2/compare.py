import json,sys,collections
S=sys.argv[1]  # holds out-<tree>.json: 8ddebcd8 incumbent (S-03 head), dd8be956 control (blend on), a393acbd head
inc=json.load(open(f'{S}/out-8ddebcd8.json'));old=json.load(open(f'{S}/out-dd8be956.json'));new=json.load(open(f'{S}/out-a393acbd.json'))
for lid in inc['leagues']:
    I=inc['leagues'][lid]['players'];O=old['leagues'][lid]['players'];N=new['leagues'][lid]['players']
    ids=set(I)&set(N)&set(O)
    dnew=sum(1 for i in ids if abs(I[i]['cw']-N[i]['cw'])>1e-9)
    dold=sum(1 for i in ids if abs(I[i]['cw']-O[i]['cw'])>1e-9)
    bases=collections.Counter((N[i]['pos'] if N[i]['pos'] in('K','DEF') else 'skill',N[i]['basis']) for i in ids)
    oldkd=collections.Counter(O[i]['basis'] for i in ids if O[i]['pos'] in ('K','DEF'))
    espn_present=sum(1 for i in ids if N[i]['espn'] is not None)
    c=new['leagues'][lid]['ctx']
    print(f"league row {lid}: n={len(ids)} | head vs incumbent differ={dnew} | dd8be956 vs incumbent differ (control)={dold} | ESPN value present on head={espn_present} | old K/DEF bases={dict(oldkd)} | head bases={dict(bases)} | ctx on={c['on']} holds={c['holds']}")
