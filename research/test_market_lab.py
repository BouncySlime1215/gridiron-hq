import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from market_lab import time_folds, stamp, settlement, evaluate, build_dataset

def _build_quarantine_fixture(path):
    """A tiny fixture exercising every silent-drop path build_dataset used to
    have before it started counting them: one clean game/feature pair that
    should survive, one game missing its final score, and one team-week
    feature row with unparseable JSON."""
    con = sqlite3.connect(path)
    con.execute('''CREATE TABLE game_lines (season INTEGER, week INTEGER, team TEXT,
        opponent TEXT, home INTEGER, spread REAL, total REAL, team_score INTEGER,
        opp_score INTEGER, gameday TEXT, rest_days INTEGER, div_game INTEGER)''')
    con.execute('''CREATE TABLE nfl_team_week_features (season INTEGER, week INTEGER,
        team TEXT, features TEXT)''')
    con.execute('''CREATE TABLE nfl_odds_archive (eid TEXT, season INTEGER, week INTEGER,
        home TEXT, away TEXT, commence_time TEXT, market TEXT, side TEXT, phase TEXT,
        line REAL, price REAL, book_updated_at TEXT, source TEXT, book TEXT)''')
    # A clean, complete game (week 1) -- should NOT be quarantined.
    con.execute('''INSERT INTO game_lines VALUES
        (2024,1,'KC','BAL',1,-3,44,27,20,'2024-09-05',7,0)''')
    con.execute('''INSERT INTO game_lines VALUES
        (2024,1,'BAL','KC',0,3,44,20,27,'2024-09-05',7,0)''')
    con.execute("INSERT INTO nfl_team_week_features VALUES (2024,1,'KC','{\"net_epa_per_play\": 0.05}')")
    # A game with no final score (week 2) -- must be quarantined, not dropped silently.
    con.execute('''INSERT INTO game_lines VALUES
        (2024,2,'KC','SF',1,-1,44,NULL,NULL,'2024-09-12',7,0)''')
    con.execute('''INSERT INTO game_lines VALUES
        (2024,2,'SF','KC',0,1,44,NULL,NULL,'2024-09-12',7,0)''')
    # A team-week feature row whose JSON does not parse -- must be quarantined too.
    con.execute("INSERT INTO nfl_team_week_features VALUES (2024,1,'BAL','not-json')")
    con.commit()
    con.close()

class MarketLabTests(unittest.TestCase):
    def test_build_dataset_quarantines_bad_games_and_features_instead_of_silently_dropping_them(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            db = str(Path(tmp.name) / 'quarantine.sqlite')
            _build_quarantine_fixture(db)
            _, dropped = build_dataset(db)
            self.assertEqual(dropped.get('game_missing_gameday_or_score'), 1,
                'the scoreless week-2 game must be counted, not vanish with no trace')
            self.assertEqual(dropped.get('feature_unparseable_json'), 1,
                "BAL's unparseable feature row must be counted, not vanish with no trace")
        finally:
            tmp.cleanup()

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
