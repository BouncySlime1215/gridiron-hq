import unittest
from datetime import datetime, timedelta, timezone
from market_lab import time_folds, stamp, settlement, evaluate

class MarketLabTests(unittest.TestCase):
    def test_prices_sides_and_pushes(self):
        self.assertAlmostEqual(settlement('spreads',True,-3,7,40,-110),100/110)
        self.assertEqual(settlement('spreads',False,-3,7,40,120),-1)
        self.assertEqual(settlement('spreads',True,-3,3,40,-110),0)
        self.assertAlmostEqual(settlement('totals',False,44,7,40,-120),100/120)
        self.assertEqual(settlement('totals',True,44,7,44,-110),0)
        self.assertIsNone(settlement('spreads',True,-3,7,40,None))
    def test_fold_label_purge_and_week_groups(self):
        start=datetime(2022,8,1,tzinfo=timezone.utc);rows=[]
        for week in range(1,41):
            for game in range(8):
                decision=start+timedelta(weeks=week,minutes=game)
                rows.append({'season':2022,'week':week,'decision_at':decision.isoformat(),
                    'label_at':(decision+timedelta(days=6)).isoformat()})
        folds=time_folds(rows)
        self.assertGreaterEqual(len(folds),2)
        for train,test in folds:
            cutoff=min(stamp(rows[i]['decision_at']) for i in test)-timedelta(days=7)
            self.assertTrue(all(stamp(rows[i]['label_at'])<cutoff for i in train))
            self.assertFalse({rows[i]['week'] for i in train}&{rows[i]['week'] for i in test})
    def test_zero_prediction_abstains(self):
        rows=[{'season':2024,'week':i+1,'y':1} for i in range(12)]
        score=evaluate(rows,[0]*12)
        self.assertEqual(score['paper_bets'],0)
        self.assertIsNone(score['roi'])
        self.assertIsNone(score['clv_interval'])

if __name__=='__main__':unittest.main()
