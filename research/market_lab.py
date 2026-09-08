"""Opening-market research. No production writes, promotions, or wagering.

Run from any directory with --db and --output. Uses already-held historical
odds and prior-game aggregates, with a point-in-time label embargo. All opened
seasons remain development data; chronological folds do not restore holdout status.

Every fit is preceded by a per-fold observation-to-parameter check from
research/model_discipline.py (see that module's docstring for why the movement
target's numerator is the week-clustered row count and not the raw one). The
verdicts are recorded in `model_discipline` in this run's report whether they
pass or fail; `--discipline strict` turns a failure into a hard stop instead.

Every outer fold is also scanned for distributional drift between its training
seasons and its scoring season (research/drift.py, `drift_scans` in the
report) -- reported only, never used to withhold a fold or a model.
"""
from __future__ import annotations
import argparse, collections, hashlib, json, math, os, sqlite3, subprocess
from pathlib import Path
from datetime import datetime, timezone, timedelta
import numpy as np
from sklearn.base import clone
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error
import joblib

from model_discipline import check_fold, record, summarize
from drift import scan_lab_fold

# v2 adds two additive, optional blocks: `model_discipline` (research/model_discipline.py)
# and `drift_scans` (research/drift.py). Readers accept v1 and v2 alike
# (server/services/nfl-research-lab.js), so an already-frozen v1 report on disk
# keeps rendering rather than being invalidated by this change.
VERSION = 'market-lab-v2'
SEED = 83017
THRESHOLD = 0.5  # fixed before looking at evaluations; points, not probability
PB_KEYS = ['off_epa_per_play', 'def_epa_per_play', 'off_success_rate',
           'def_success_rate', 'off_proe', 'off_seconds_per_drive', 'off_sack_rate']

def stamp(value):
    if not value: return None
    try:
        v = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v
    except ValueError: return None

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()

def atomic_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False))
    tmp.replace(path)

def american_profit(price):
    if price is None or not math.isfinite(price) or abs(price) < 100: return None
    return price / 100 if price > 0 else 100 / -price

def settlement(market, positive, line, margin, total, price):
    outcome = margin + line if market == 'spreads' else total - line
    if not positive: outcome = -outcome
    payoff = american_profit(price)
    if payoff is None: return None
    return 0.0 if abs(outcome) < 1e-9 else payoff if outcome > 0 else -1.0

def build_dataset(db_path):
    con = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    con.execute('BEGIN')  # consistent read snapshot while the live collector runs
    games = [dict(x) for x in con.execute('''SELECT season,week,team,opponent,spread,total,
        team_score,opp_score,gameday,rest_days,div_game FROM game_lines WHERE home=1 AND season<=2025 ORDER BY season,week''')]
    history = collections.defaultdict(list)
    week_end = {}
    game_map = {}
    for g in games:
        game_map[(g['season'],g['week'],g['team'])] = g
        d = stamp(g['gameday'])
        if d is None or g['team_score'] is None or g['opp_score'] is None: continue
        # End of gameday plus 48h; intentionally conservative publication proxy.
        ready = d + timedelta(days=3)
        k = (g['season'],g['week']); week_end[k] = max(week_end.get(k,ready),ready)
        m = g['team_score']-g['opp_score']; total = g['team_score']+g['opp_score']
        for team,margin in [(g['team'],m),(g['opponent'],-m)]:
            history[team].append((ready,margin,total))
    pbp = collections.defaultdict(list)
    for r in con.execute('SELECT season,week,team,features FROM nfl_team_week_features WHERE season<=2025'):
        ready = week_end.get((r['season'],r['week']))
        if ready is None: continue
        try: f=json.loads(r['features'])
        except (TypeError,ValueError): continue
        pbp[r['team']].append((ready,f))
    for v in history.values(): v.sort(key=lambda z:z[0])
    for v in pbp.values(): v.sort(key=lambda z:z[0])
    archive=[dict(x) for x in con.execute('''SELECT eid,season,week,home,away,commence_time,
       market,side,phase,line,price,book_updated_at,source FROM nfl_odds_archive
       WHERE book='pinnacle' AND market IN ('spreads','totals') AND season BETWEEN 2022 AND 2025''')]
    con.close()
    by_game=collections.defaultdict(dict)
    for q in archive: by_game[(q['eid'],q['market'])][(q['phase'],q['side'])]=q
    dropped=collections.Counter(); out=[]
    for (eid,market), qs in by_game.items():
        sample=next(iter(qs.values())); pos=sample['home'] if market=='spreads' else 'Over'
        neg=sample['away'] if market=='spreads' else 'Under'
        o=qs.get(('open',pos)); opposite=qs.get(('open',neg)); c=qs.get(('close',pos))
        g=game_map.get((sample['season'],sample['week'],sample['home']))
        if not all([o,opposite,c,g]): dropped['missing_pair_or_result']+=1; continue
        ot,nt,ct,kick = [stamp(v) for v in [o['book_updated_at'],opposite['book_updated_at'],c['book_updated_at'],sample['commence_time']]]
        if any(t is None for t in [ot,nt,ct,kick]) or not (ot <= ct < kick) or abs((nt-ot).total_seconds())>60:
            dropped['invalid_or_unpaired_timestamps']+=1; continue
        decision=max(ot,nt)
        if not decision<ct or decision>=kick or g['team_score'] is None or g['opp_score'] is None:
            dropped['no_future_close_or_score']+=1; continue
        if any(american_profit(q['price']) is None for q in [o,opposite]): dropped['missing_real_prices']+=1; continue
        if not all(isinstance(q['line'],(int,float)) and math.isfinite(q['line']) for q in [o,opposite,c]):
            dropped['bad_line']+=1; continue
        if (market=='spreads' and abs(o['line']+opposite['line'])>1e-9) or (market=='totals' and o['line']!=opposite['line']):
            dropped['different_contracts']+=1; continue
        # These fields were observable in the paired opening quote itself.
        features={'opening_line':o['line'],'opening_positive_price':o['price'],
            'opening_negative_price':opposite['price'],'hours_to_kickoff':(kick-decision).total_seconds()/3600,
            'week':g['week'],'division_game':g['div_game'] or 0,
            'near_key_three':min(abs(abs(o['line'])-3),20),
            'near_key_seven':min(abs(abs(o['line'])-7),20)}
        for side,team in [('home',sample['home']),('away',sample['away'])]:
            recent=[h for h in history[team] if h[0]<decision][-8:]
            features[side+'_prior_games']=len(recent)
            for idx,name in [(1,'margin'),(2,'total')]:
                features[side+'_recent_'+name]=float(np.mean([v[idx] for v in recent])) if recent else 0.0
            fprior=[f for ready,f in pbp[team] if ready<decision][-8:]
            for key in PB_KEYS:
                vals=[f[key] for f in fprior if isinstance(f.get(key),(int,float)) and math.isfinite(f[key])]
                features[side+'_'+key]=float(np.mean(vals)) if vals else 0.0
                features[side+'_'+key+'_available']=int(bool(vals))
        y=o['line']-c['line'] if market=='spreads' else c['line']-o['line']
        out.append({'event_id':str(eid),'market':market,'season':g['season'],'week':g['week'],
            'home':sample['home'],'away':sample['away'],'decision_at':decision.isoformat(),
            'label_at':ct.isoformat(),'opening_line':o['line'],'closing_line':c['line'],
            'positive_price':o['price'],'negative_price':opposite['price'],
            'actual_margin':g['team_score']-g['opp_score'],'actual_total':g['team_score']+g['opp_score'],
            'y':y,'features':features})
    out.sort(key=lambda r:(r['decision_at'],r['event_id'],r['market']))
    return out,dict(dropped)

def time_folds(rows, folds=3):
    # Whole NFL weeks stay together; label availability is independently purged.
    weeks=sorted(set((r['season'],r['week']) for r in rows))
    chunks=np.array_split(np.arange(len(weeks)),folds+1)
    result=[]
    for chunk in chunks[1:]:
        test_weeks={weeks[i] for i in chunk}
        va=np.array([i for i,r in enumerate(rows) if (r['season'],r['week']) in test_weeks],dtype=int)
        if not len(va):continue
        cutoff=min(stamp(rows[i]['decision_at']) for i in va)-timedelta(days=7)
        first_week=min(test_weeks)
        tr=np.array([i for i,r in enumerate(rows) if (r['season'],r['week'])<first_week and stamp(r['label_at'])<cutoff],dtype=int)
        if len(tr)>=30 and len(va)>=15:result.append((tr,va))
    return result

class FrozenTimeCV:
    def __init__(self,splits):self.splits=splits
    def split(self,X,y=None,groups=None):yield from self.splits
    def get_n_splits(self,X=None,y=None,groups=None):return len(self.splits)

def cluster_interval(rows, values):
    grouped=collections.defaultdict(list)
    for r,v in zip(rows,values): grouped[(r['season'],r['week'])].append(v)
    if len(grouped)<8:return None
    blocks=list(grouped.values());rng=np.random.default_rng(SEED)
    sums=np.array([sum(b) for b in blocks]); counts=np.array([len(b) for b in blocks])
    samples=rng.integers(0,len(blocks),size=(1500,len(blocks)))
    means=sums[samples].sum(axis=1)/counts[samples].sum(axis=1)
    return [float(v) for v in np.quantile(means,[.025,.975])]

def evaluate(rows,pred):
    y=np.array([r['y'] for r in rows]);pred=np.asarray(pred)
    bets=[];clv=[];profits=[]
    for r,p in zip(rows,pred):
        if abs(p)<THRESHOLD: continue
        positive=p>0;price=r['positive_price'] if positive else r['negative_price']
        bets.append(r);clv.append(r['y']*(1 if positive else -1))
        profits.append(settlement(r['market'],positive,r['opening_line'],r['actual_margin'],r['actual_total'],price))
    path=np.cumsum(profits);high=np.maximum.accumulate(np.r_[0,path])
    return {'games':len(rows),'weeks':len(set((r['season'],r['week']) for r in rows)),
        'mae':float(mean_absolute_error(y,pred)),'no_move_mae':float(np.mean(abs(y))),
        'mae_gain_interval':cluster_interval(rows,abs(y)-abs(y-pred)),
        'paper_bets':len(bets),'mean_clv':float(np.mean(clv)) if clv else None,
        'clv_interval':cluster_interval(bets,clv),'roi':float(np.mean(profits)) if profits else None,
        'roi_interval':cluster_interval(bets,profits),'profit_units':float(sum(profits)),
        'max_drawdown_units':float(np.max(high-np.r_[0,path])) if profits else 0,
        'wins':sum(p>0 for p in profits),'losses':sum(p<0 for p in profits),'pushes':sum(p==0 for p in profits)}

def candidates():
    return {'no_move':DummyRegressor(strategy='constant',constant=0),
        'ridge':make_pipeline(StandardScaler(),Ridge(alpha=100)),
        'boosted_trees':HistGradientBoostingRegressor(max_iter=100,max_leaf_nodes=7,
            min_samples_leaf=35,l2_regularization=20,learning_rate=.04,early_stopping=False,random_state=SEED),
        'extra_trees':ExtraTreesRegressor(n_estimators=100,max_depth=4,min_samples_leaf=30,max_features=.7,n_jobs=1,random_state=SEED)}

def run(args):
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    data,dropped=build_dataset(args.db);names=sorted(data[0]['features']) if data else []
    if len(data)<200:raise ValueError('Not enough valid historical opening/closing pairs')
    code_hash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    run_id=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+code_hash[:8]
    run_dir=out/run_id;run_dir.mkdir()
    discipline=[];strict=getattr(args,'discipline','report')=='strict'
    report={'schema':VERSION,'run_id':run_id,'status':'running','created_at':datetime.now(timezone.utc).isoformat(),
      'authority':'research_only','production_changed':False,'untouched_holdout':False,
      'dataset_hash':digest(data),'code_hash':code_hash,'rows':len(data),'features':names,'dropped':dropped,
      'protocol':{'target':'opening-to-closing market movement','outer_seasons':[2023,2024,2025],
        'inner_validation':'expanding whole-week folds; seven-day label embargo',
        'selection':'minimum inner-fold MAE, including no-movement baseline',
        'data_to_feature_ratio':'research/model_discipline.py, checked per fold BEFORE any fit; '
          'refuse-and-report (no automatic PCA/Lasso compression -- see that module for why)',
        'abstention_points':THRESHOLD,'tpot_minutes_per_outer_fold':args.tpot_minutes,
        'total_tpot_budget_minutes':args.tpot_minutes*6,'seed':SEED},
      'limitations':['Previously opened seasons are development data, not an untouched holdout.',
        'Archived opening prices are indicative; access, limits, delay and fills are unverified.',
        'Prior play-by-play uses a conservative publication delay, but historical revision vintages are unavailable.',
        'Points of CLV are not dollars of edge. Positive historical ROI cannot authorize staking.',
        'The drift scan reports; it never withholds a fold or a model. The 2023 outer fold has one '
          'training season and so no season boundary to calibrate against; its verdicts are marked '
          'calibration_weak.',
        'No news, injury, kickoff weather or nfelo historical forecast is admitted without an availability timestamp.'],
      'markets':[],'drift_scans':[],'errors':[],'model_discipline':summarize([])}
    atomic_json(run_dir/'dataset.json',data)
    atomic_json(run_dir/'preregistered.json',report)
    def save():atomic_json(run_dir/'report.json',report);atomic_json(out/'latest.json',report)
    save()
    for market in ['spreads','totals']:
        results=[];combined=[];selected_preds=[]
        for season in [2023,2024,2025]:
            test=[r for r in data if r['market']==market and r['season']==season]
            if not test:continue
            outer_cutoff=min(stamp(r['decision_at']) for r in test)-timedelta(days=7)
            train=[r for r in data if r['market']==market and r['season']<season and stamp(r['label_at'])<outer_cutoff]
            cv=time_folds(train)
            if len(cv)<2:report['errors'].append(f'{market}/{season}: insufficient temporal training folds');continue
            X=np.array([[r['features'][k] for k in names] for r in train]);y=np.array([r['y'] for r in train])
            # Ratio check before anything is fit. The cluster key is (season, week) --
            # the same unit cluster_interval() bootstraps over below, so the ratio's
            # numerator cannot claim more independence than this file's own intervals do.
            wk=[(r['season'],r['week']) for r in train]
            record(discipline,check_fold(package='pilot',label=f'{market}/{season}/move/refit',
                target_type='continuous_regression',y=y,feature_count=len(names),clusters=wk),strict=strict)
            for fold_i,(tr,_va) in enumerate(cv):
                record(discipline,check_fold(package='pilot',label=f'{market}/{season}/move/inner-{fold_i}',
                    target_type='continuous_regression',y=y[tr],feature_count=len(names),
                    clusters=[wk[i] for i in tr]),strict=strict)
            Xt=np.array([[r['features'][k] for k in names] for r in test]);models=candidates();scores={};search_trials=[]
            for name,model in models.items():
                losses=[]
                for tr,va in cv:
                    fitted=clone(model).fit(X[tr],y[tr]);losses.append(mean_absolute_error(y[va],fitted.predict(X[va])))
                scores[name]=float(np.mean(losses))
            if args.tpot_minutes>0:
                try:
                    from tpot import TPOTRegressor
                    automl=TPOTRegressor(search_space='linear-light',cv=FrozenTimeCV(cv),
                      scorers=['neg_mean_absolute_error'],scorers_weights=[1],
                      validation_strategy='none',preprocessing=False,max_time_mins=args.tpot_minutes,
                      max_eval_time_mins=.3,population_size=8,initial_population_size=8,
                      n_jobs=1,random_state=SEED,verbose=0,memory_limit='2GB')
                    automl.fit(X,y)
                    fitted=automl.fitted_pipeline_
                    models['tpot']=fitted
                    losses=[mean_absolute_error(y[va],clone(fitted).fit(X[tr],y[tr]).predict(X[va])) for tr,va in cv]
                    scores['tpot']=float(np.mean(losses))
                    search_trials=[{'candidate':str(i),'pipeline':str(r.get('Instance',''))[:2000],
                        'inner_score':float(r['neg_mean_absolute_error']) if np.isfinite(r.get('neg_mean_absolute_error',np.nan)) else None}
                        for i,r in automl.evaluated_individuals.iterrows()]
                    atomic_json(run_dir/f'{market}-{season}-tpot-trials.json',search_trials)
                except Exception as e:report['errors'].append(f'{market}/{season} TPOT failed: {type(e).__name__}: {str(e)[:300]}')
            selected=min(scores,key=scores.get)  # frozen before any outer outcomes scored
            model=clone(models[selected]).fit(X,y);pred=model.predict(Xt)
            joblib.dump(model,run_dir/f'{market}-{season}.joblib')
            candidate_rows=[]
            for name,m in models.items():
                pp=clone(m).fit(X,y).predict(Xt)
                candidate_rows.append({'name':name,'inner_mae':scores[name],**evaluate(test,pp)})
            fold={'season':season,'train_games':len(train),'inner_folds':len(cv),'selected':selected,
                  'tpot_trials':len(search_trials),'candidates':candidate_rows,**evaluate(test,pred)}
            results.append(fold);combined+=test;selected_preds+=list(pred)
            atomic_json(run_dir/f'{market}-{season}-predictions.json',[{**{k:v for k,v in r.items() if k!='features'},
                'prediction':float(p),'selected_model':selected,'units_staked':0} for r,p in zip(test,pred)])
            print(f'{market} {season}: selected {selected}; {len(test)} games; TPOT trials {len(search_trials)}',flush=True)
            report['progress']=f'{market} {season} complete';save()
        if combined:
            report['markets'].append({'market':market,'folds':results,'pooled':evaluate(combined,selected_preds)})
            save()
    report['model_discipline']={**summarize(discipline),'folds':discipline}
    # Distributional-drift scan over exactly the outer windows fitted above:
    # has the population moved between the training seasons and the scoring
    # season by more than an NFL season boundary normally moves it? Reported
    # only -- see research/drift.py, which also explains why PSI's textbook
    # 0.1/0.25 thresholds are rejected at these fold sizes.
    for market in ['spreads','totals']:
        for season in [2023,2024,2025]:
            score_rows=[r for r in data if r['market']==market and r['season']==season]
            if not score_rows:continue
            outer_cutoff=min(stamp(r['decision_at']) for r in score_rows)-timedelta(days=7)
            train_rows=[r for r in data if r['market']==market and r['season']<season and stamp(r['label_at'])<outer_cutoff]
            try:
                report['drift_scans'].append(scan_lab_fold(train_rows,score_rows,names,market=market,
                    score_season=season,label=f'{market}/{season}',random_state=SEED))
            except Exception as e:
                report['errors'].append(f'{market}/{season} drift scan failed: {type(e).__name__}: {str(e)[:200]}')
    save()
    report['status']=('complete_with_errors' if report['errors'] else 'complete') if report['markets'] else 'failed'
    report['completed_at']=datetime.now(timezone.utc).isoformat();report['progress']='Finished; no model promoted'
    report['verdict']='Research complete. Review predictive skill, execution assumptions and forward evidence separately.'
    import importlib.metadata
    report['packages']={p:importlib.metadata.version(p) for p in ['scikit-learn','numpy','tpot'] if p!='tpot' or args.tpot_minutes>0}
    save();print(json.dumps({'run_id':run_id,'status':report['status'],'errors':report['errors']}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--output',required=True)
    p.add_argument('--tpot-minutes',type=float,default=0,help='Per market/outer-fold budget; total budget is six times this value')
    p.add_argument('--discipline',choices=['report','strict'],default='report',
        help='report (default): record every observation-to-feature verdict in the frozen report and keep going. '
             'strict: stop on the first under-powered fold.')
    args=p.parse_args()
    if not 0<=args.tpot_minutes<=10:p.error('--tpot-minutes must be between 0 and 10')
    run(args)
