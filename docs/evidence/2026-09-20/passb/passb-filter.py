import subprocess, sys, os
SP='/tmp/claude-0/-home-user-gridiron-hq/8e84373d-278d-5d3b-9686-92d6aac5089c/scratchpad'
commit=sys.argv[1]
rep=subprocess.run(['node',SP+'/passb-analyse.mjs',f'{SP}/passb-{commit}.jsonl'],
                   capture_output=True,text=True,cwd='/home/user/gridiron-hq')
txt=rep.stdout
head=[l for l in txt.split('\n') if l.startswith('#')]
print('\n'.join(head))
cache={}
def body(f):
    if f not in cache:
        r=subprocess.run(['git','show',f'{commit}:{f}'],capture_output=True,text=True,cwd='/home/user/gridiron-hq')
        cache[f]=r.stdout if r.returncode==0 else None
    return cache[f]
kept=[]
for b in txt.split('--- ')[1:]:
    lines=b.rstrip('\n').split('\n')
    loc=lines[0].strip(); pat=lines[1].strip() if len(lines)>1 else ''
    src=pat[1:pat.rfind('/')] if pat.startswith('/') and pat.rfind('/')>0 else pat
    f=loc.split(':')[0]
    src_body=body(f)
    if src_body and src in src_body:
        kept.append(b.rstrip())
print(f"\n### dead branches whose pattern is written in that test file at {commit}: {len(kept)} site(s)\n")
for b in kept: print('--- '+b)
