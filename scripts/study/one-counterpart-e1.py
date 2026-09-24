"""ONE-COUNTERPART E1 grade (study only). Log loss of the counterpart model's P(accept) on one league's decided
2026 offers vs activity-only. Activity-only = the E1 activity block (rnd/eval/e1l_eval.py ACT: log1p of the
receiver's adds, offers sent, offers received, decisions, league offers, all strictly before the offer),
logistic, leave-one-ISO-week-out on this league's offers. The counterpart model = activity-only with the
model's own (lift, mult) applied: sigmoid(logit(p) + lift) * mult (counterpart.js#adjustP).
CI: week-clustered bootstrap, 2000 reps, seed 303 (as PEOPLE-03). Roster ids only; no names.

  python3.12 scripts/study/one-counterpart-e1.py <db copy> <offers.json> <league_id> <lifts.json> [<lifts.json> ...]
"""
import sys, json, math, sqlite3, collections, datetime
import numpy as np
from sklearn.linear_model import LogisticRegression

DB, OFFERS, LEAGUE, *LIFTS = sys.argv[1:]
LEAGUE = int(LEAGUE)
offers = sorted([o for o in json.load(open(OFFERS))['offers'] if o['league_id'] == LEAGUE], key=lambda o: o['T'])
assert offers and all(o['T_iso'] >= '2026-01-01' for o in offers)
N = len(offers)
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC).strftime('%Y-%m-%dT%H:%M:%S')
db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
tx = [dict(zip(['lid', 'tx', 'type', 'ex', 'status', 'team', 'rel', 'at', 'items'], r)) for r in db.execute(
    """select league_id, tx_id, type, execution_type, status, team_id, related_tx_id, proposed_at, items_json
       from league_transactions_raw where season = 2026 and league_id = ?""", (LEAGUE,))]
for t in tx: t['at'] = (t['at'] or '')[:19]

def feats(o):  # rnd/eval/e1l_eval.py feats(), activity part
    r, T = o['receiver'], iso(o['T'])
    before = [t for t in tx if t['at'] < T]
    adds = sum(sum(1 for i in json.loads(t['items'] or '[]') if i.get('type') == 'ADD')
               for t in before if t['type'] in ('WAIVER', 'FREEAGENT') and t['status'] == 'EXECUTED' and t['team'] == r)
    sent, recv, lo = set(), set(), set()
    for t in before:
        if t['type'] != 'TRADE_PROPOSAL': continue
        key = t['tx'] if t['ex'] == 'EXECUTE' else t['rel']
        lo.add(key)
        if t['team'] == r: sent.add(key)
        parties = {i.get(f) for i in json.loads(t['items'] or '[]') for f in ('fromTeamId', 'toTeamId')}
        if r in parties and t['team'] != r: recv.add(key)
    dec = [t for t in before if t['type'] in ('TRADE_ACCEPT', 'TRADE_DECLINE') and t['ex'] == 'EXECUTE' and t['team'] == r]
    for t in dec: recv.add(t['rel']); lo.add(t['rel'])
    return [math.log1p(adds), math.log1p(len(sent)), math.log1p(len(recv)), math.log1p(len(dec)), math.log1p(len(lo))]

X = np.array([feats(o) for o in offers])
y = np.array([o['y'] for o in offers], float)
week = np.array([datetime.datetime.fromtimestamp(o['T'] / 1000, datetime.UTC).isocalendar()[1] for o in offers])
p_act = np.zeros(N)
for w in np.unique(week):
    te, tr = week == w, week != w
    mu, sd = X[tr].mean(0), X[tr].std(0); sd[sd == 0] = 1
    if y[tr].min() == y[tr].max(): p_act[te] = (y[tr].sum() + 0.5) / (tr.sum() + 1); continue
    m = LogisticRegression(C=1.0, max_iter=2000).fit((X[tr] - mu) / sd, y[tr])
    p_act[te] = m.predict_proba((X[te] - mu) / sd)[:, 1]
clip = lambda p: np.clip(p, 1e-3, 1 - 1e-3)
ll_vec = lambda p: -(y * np.log(clip(p)) + (1 - y) * np.log(1 - clip(p)))
rng = np.random.default_rng(303)
weeks = np.unique(week)
def ci(delta_vec):
    reps = []
    for _ in range(2000):
        pick = rng.choice(weeks, len(weeks), replace=True)
        idx = np.concatenate([np.where(week == w)[0] for w in pick])
        reps.append(delta_vec[idx].mean())
    return [round(float(np.quantile(reps, 0.025)), 4), round(float(np.quantile(reps, 0.975)), 4)]
out = {'league': LEAGUE, 'offers': N, 'yes': int(y.sum()), 'weeks': len(weeks),
       'activity_only_ll': round(float(ll_vec(p_act).mean()), 4), 'models': []}
for path in LIFTS:
    L = json.load(open(path))
    by = {x['offer_id']: x for x in L['lifts']}
    lift = np.array([by[o['offer_id']]['lift'] for o in offers]); mult = np.array([by[o['offer_id']]['mult'] for o in offers])
    lg = np.log(clip(p_act) / (1 - clip(p_act)))
    p = np.clip(1 / (1 + np.exp(-(lg + lift))) * mult, 0, 1)
    d = ll_vec(p_act) - ll_vec(p)  # positive = the model beats activity-only
    out['models'].append({'impl': L['impl'], 'moved': int(((lift != 0) | (mult != 1)).sum()),
                          'll': round(float(ll_vec(p).mean()), 4), 'gain_vs_activity': round(float(d.mean()), 4),
                          'gain_ci95': ci(d) if d.any() else [0.0, 0.0]})
print(json.dumps(out, indent=1))
