#!/usr/bin/env python3
"""Analyse the Jev research-auditor run: self-consistency, agreement vs hand labels, ranked audit."""
import json, re, statistics as st
from pathlib import Path

HERE = Path(__file__).parent
res = json.loads((HERE / 'jev_audit_results.json').read_text())
rows = res['rows']

# --- parse the hand labels + metadata straight out of the corpus TS (single source of truth)
ts = (HERE / 'audit_corpus.ts').read_text()
meta = {}
for m in re.finditer(
    r"id:\s*'([^']+)',\s*src:\s*'([^']+)',\s*kind:\s*'([^']+)',\s*recorded:\s*'([^']+)',\s*\n\s*title:\s*'([^']*)'", ts):
    meta[m.group(1)] = dict(src=m.group(2), kind=m.group(3), recorded=m.group(4), title=m.group(5))
for m in re.finditer(
    r"id:\s*'([^']+)'[\s\S]*?mine:\s*\{\s*placebo:\s*(\d),\s*price:\s*(\d),\s*clustered:\s*(\d),"
    r"\s*baseline:\s*(\d),\s*mult:\s*(\d),\s*\n?\s*sound:\s*(\d)", ts):
    if m.group(1) in meta:
        meta[m.group(1)]['mine'] = dict(has_placebo=int(m.group(2)), is_price_aware=int(m.group(3)),
                                        game_clustered=int(m.group(4)), has_baseline_control=int(m.group(5)),
                                        multiplicity_corrected=int(m.group(6)), sound=int(m.group(7)))

BOOLS = ['has_placebo', 'is_price_aware', 'game_clustered', 'has_baseline_control', 'multiplicity_corrected']

agg = {}
for fid in meta:
    rs = [r for r in rows if r['id'] == fid]
    if not rs:
        continue
    a = {'n_rep': len(rs)}
    for b in BOOLS:
        v = [r[b] for r in rs]
        a[b] = sum(v) / len(v)
        a[b + '_sd'] = st.pstdev(v)
    s = [r['sound_mean'] for r in rs]
    a['sound'] = sum(s) / len(s)
    a['sound_sd'] = st.pstdev(s)
    a['sound_range'] = max(s) - min(s)
    a['kind'] = max(set(r['kind'] for r in rs), key=[r['kind'] for r in rs].count)
    a['kind_agree'] = sum(1 for r in rs if r['kind'] == a['kind']) / len(rs)
    agg[fid] = a

# ---------------------------------------------------------------- 1. self-consistency
print('=' * 92)
print('1. JEV SELF-CONSISTENCY  (3 independent replicates per finding, identical state)')
print('=' * 92)
for b in BOOLS:
    sds = [agg[f][b + '_sd'] for f in agg]
    flips = sum(1 for f in agg if (min(r[b] for r in rows if r['id'] == f) < .5) !=
                                   (max(r[b] for r in rows if r['id'] == f) < .5))
    print(f'  {b:26s} mean within-finding sd of probability = {sum(sds)/len(sds):.4f}   '
          f'findings where replicates straddle 0.5: {flips}/{len(agg)}')
srs = [agg[f]['sound_range'] for f in agg]
print(f'  {"methodological_soundness":26s} mean sd = {sum(agg[f]["sound_sd"] for f in agg)/len(agg):.4f}   '
      f'mean max-min across reps = {sum(srs)/len(srs):.4f}   worst = {max(srs):.3f}')
ka = [agg[f]['kind_agree'] for f in agg]
print(f'  finding_kind: all 3 replicates agree on {sum(1 for k in ka if k==1.0)}/{len(ka)} findings')

# ---------------------------------------------------------------- 2. agreement vs my labels
print()
print('=' * 92)
print('2. LABEL VALIDATION  (my hand labels, written before the Jev run, vs Jev at p>0.5)')
print('=' * 92)
labelled = [f for f in agg if 'mine' in meta[f]]
print(f'  {len(labelled)} findings hand-labelled (the whole corpus, not a subset)')
tot_a = tot_n = 0
for b in BOOLS:
    ok = sum(1 for f in labelled if (agg[f][b] > .5) == bool(meta[f]['mine'][b]))
    mine_pos = sum(meta[f]['mine'][b] for f in labelled)
    jev_pos = sum(1 for f in labelled if agg[f][b] > .5)
    tot_a += ok; tot_n += len(labelled)
    print(f'  {b:26s} agreement {ok:3d}/{len(labelled)} = {ok/len(labelled)*100:5.1f}%   '
          f'(I said yes {mine_pos:2d}, Jev said yes {jev_pos:2d})')
print(f'  {"POOLED BOOLEANS":26s} agreement {tot_a}/{tot_n} = {tot_a/tot_n*100:.1f}%')
diff = [agg[f]['sound'] - meta[f]['mine']['sound'] for f in labelled]
exact = sum(1 for d in diff if abs(d) < .5)
within1 = sum(1 for d in diff if abs(d) < 1.0)
corr_n = len(diff)
mx = sum(agg[f]['sound'] for f in labelled)/corr_n; my_ = sum(meta[f]['mine']['sound'] for f in labelled)/corr_n
cov = sum((agg[f]['sound']-mx)*(meta[f]['mine']['sound']-my_) for f in labelled)/corr_n
r = cov / (st.pstdev([agg[f]['sound'] for f in labelled]) * st.pstdev([meta[f]['mine']['sound'] for f in labelled]))
print(f'  soundness: Pearson r = {r:.3f}   mean(Jev - mine) = {sum(diff)/corr_n:+.3f}   '
      f'|diff|<0.5 on {exact}/{corr_n}, <1.0 on {within1}/{corr_n}')
print('  biggest disagreements (Jev minus mine):')
for f in sorted(labelled, key=lambda f: -abs(agg[f]['sound'] - meta[f]['mine']['sound']))[:6]:
    print(f'    {f:6s} jev {agg[f]["sound"]:.2f} vs mine {meta[f]["mine"]["sound"]}  {meta[f]["title"][:62]}')

# ---------------------------------------------------------------- 3. ranked audit
print()
print('=' * 92)
print('3. RANKED AUDIT  (all 64 findings, worst method first)')
print('=' * 92)
print(f'{"id":7s}{"snd":>5s}{"±":>5s} {"plc":>4s}{"prc":>4s}{"clu":>4s}{"bas":>4s}{"mul":>4s}  {"recorded":12s} title')
for f in sorted(agg, key=lambda f: agg[f]['sound']):
    a = agg[f]
    print(f'{f:7s}{a["sound"]:5.2f}{a["sound_sd"]:5.2f} '
          f'{a["has_placebo"]:4.2f}{a["is_price_aware"]:4.2f}{a["game_clustered"]:4.2f}'
          f'{a["has_baseline_control"]:4.2f}{a["multiplicity_corrected"]:4.2f}  '
          f'{meta[f]["recorded"]:12s} {meta[f]["title"][:52]}')

# ---------------------------------------------------------------- 4. the payload
def flags(f):
    return sum(1 for b in BOOLS if agg[f][b] > .5)

print()
print('=' * 92)
print('4a. PAYLOAD ONE -- findings recorded ACCEPTED / OPEN that fail the checks')
print('=' * 92)
acc = [f for f in agg if meta[f]['recorded'] in ('accepted', 'open')]
for f in sorted(acc, key=lambda f: agg[f]['sound']):
    a = agg[f]
    print(f'  {f:6s} sound {a["sound"]:.2f}  guardrails passed {flags(f)}/5  [{meta[f]["kind"]}]  {meta[f]["title"][:60]}')

print()
print('=' * 92)
print('4b. PAYLOAD TWO -- findings recorded KILLED/BLOCKED/WITHDRAWN whose KILL is weak')
print('   (ranked by soundness of the kill; low = the kill itself may not hold)')
print('=' * 92)
killed = [f for f in agg if meta[f]['recorded'] in ('killed', 'blocked', 'withdrawn', 'inconclusive')]
for f in sorted(killed, key=lambda f: agg[f]['sound'])[:18]:
    a = agg[f]
    print(f'  {f:6s} sound {a["sound"]:.2f}  guardrails {flags(f)}/5  {meta[f]["recorded"]:12s} {meta[f]["title"][:58]}')

# ---------------------------------------------------------------- 5. aggregate portrait
print()
print('=' * 92)
print('5. THE PROJECT-WIDE GUARDRAIL PORTRAIT')
print('=' * 92)
mt = [f for f in agg if meta[f]['kind'] in ('market_test', 'kill_of_a_market_test')]
for b in BOOLS:
    n = sum(1 for f in mt if agg[f][b] > .5)
    print(f'  {b:26s} passes on {n:2d}/{len(mt)} = {n/len(mt)*100:5.1f}% of empirical findings')
allpass = sum(1 for f in mt if flags(f) == 5)
print(f'  ALL FIVE guardrails:       {allpass}/{len(mt)} empirical findings')
for k in range(6):
    n = sum(1 for f in mt if flags(f) == k)
    print(f'    exactly {k}/5 guardrails: {n}')
print(f'  mean soundness, empirical findings: {sum(agg[f]["sound"] for f in mt)/len(mt):.2f} / 4.00')
cd = [f for f in agg if meta[f]['kind'] == 'code_defect']
print(f'  mean soundness, code-defect claims: {sum(agg[f]["sound"] for f in cd)/len(cd):.2f} / 4.00  (n={len(cd)})')
acc2 = [f for f in mt if meta[f]['recorded'] in ('accepted', 'open')]
kil2 = [f for f in mt if meta[f]['recorded'] in ('killed', 'blocked', 'withdrawn', 'inconclusive')]
print(f'  mean soundness of ACCEPTED empirical findings: {sum(agg[f]["sound"] for f in acc2)/len(acc2):.2f} (n={len(acc2)})')
print(f'  mean soundness of KILLS/refutations:           {sum(agg[f]["sound"] for f in kil2)/len(kil2):.2f} (n={len(kil2)})')

json.dump({f: dict(agg[f], **meta[f]) for f in agg}, open(HERE / 'jev_audit_ranked.json', 'w'), indent=1)
print(f'\nwrote {HERE / "jev_audit_ranked.json"}')
