"""Consumer parity for the shared cutoff-safe dataset foundations.

Codex plan section 10.3 asks for this module "with consumer parity tests" --
the point being that extracting shared logic is only safe if the extraction
provably produces what the existing labs produce. An extraction that silently
changes a publication time would move every training cutoff in the project at
once, and nothing would fail.

These build a small SQLite fixture rather than reading the developer's
database, so they run on a clean checkout (Codex correction C06).
"""
import collections
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'research'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import dataset as shared  # noqa: E402


def build_fixture(path):
    con = sqlite3.connect(path)
    con.execute('''CREATE TABLE game_lines (season INTEGER, week INTEGER, team TEXT, opponent TEXT,
        home INTEGER, spread REAL, total REAL, team_score INTEGER, opp_score INTEGER,
        gameday TEXT, rest_days INTEGER, div_game INTEGER, roof TEXT)''')
    con.execute('''CREATE TABLE nfl_team_week_features (season INTEGER, week INTEGER,
        team TEXT, features TEXT)''')
    rows = [
        # season, week, home, away, homeScore, awayScore, gameday, homeRest, awayRest
        (2024, 1, 'KC', 'BAL', 27, 20, '2024-09-05', 7, 7),
        (2024, 2, 'BAL', 'KC', 24, 21, '2024-09-12', 7, 7),
        (2024, 3, 'KC', 'SF', 17, 20, '2024-09-19', 7, 6),
    ]
    for season, week, home, away, hs, aws, day, hrest, arest in rows:
        con.execute('''INSERT INTO game_lines
            (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,rest_days,div_game,roof)
            VALUES (?,?,?,?,1,-3,44,?,?,?,?,0,'dome')''', (season, week, home, away, hs, aws, day, hrest))
        con.execute('''INSERT INTO game_lines
            (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,rest_days,div_game,roof)
            VALUES (?,?,?,?,0,3,44,?,?,?,?,0,'dome')''', (season, week, away, home, aws, hs, day, arest))
        con.execute('INSERT INTO nfl_team_week_features VALUES (?,?,?,?)',
                    (season, week, home, '{"net_epa_per_play": 0.05}'))
        con.execute('INSERT INTO nfl_team_week_features VALUES (?,?,?,?)',
                    (season, week, away, '{"net_epa_per_play": -0.02}'))
    con.commit()
    con.close()


class SharedChronologyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = str(Path(cls.tmp.name) / 'fixture.sqlite')
        build_fixture(cls.db)
        cls.setup = shared.shared_setup(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_publication_lag_matches_both_labs(self):
        """Three days after gameday, exactly as both labs already assume."""
        self.assertEqual(shared.RESULT_PUBLICATION_LAG, timedelta(days=3))
        history = self.setup['history']['KC']
        first = history[0][0]
        self.assertEqual(first, datetime(2024, 9, 8, tzinfo=timezone.utc),
                         'the 2024-09-05 result becomes knowable on 2024-09-08')

    def test_week_end_is_the_LAST_game_of_the_week(self):
        """A week's derived features cannot predate the week's final game."""
        week_end = self.setup['week_end']
        self.assertEqual(week_end[(2024, 1)], datetime(2024, 9, 8, tzinfo=timezone.utc))
        self.assertEqual(week_end[(2024, 3)], datetime(2024, 9, 22, tzinfo=timezone.utc))

    def test_history_before_is_STRICTLY_earlier(self):
        """A result publishable exactly at the cutoff is not available at it."""
        history = self.setup['history']
        at_publication = datetime(2024, 9, 8, tzinfo=timezone.utc)
        self.assertEqual(shared.history_before(history, 'KC', at_publication), [],
                         'strictly before means strictly before')
        a_moment_later = at_publication + timedelta(seconds=1)
        self.assertEqual(len(shared.history_before(history, 'KC', a_moment_later)), 1)

    def test_each_team_keeps_its_OWN_rest_days(self):
        """The home row's rest must not be assigned to the away team."""
        rest = self.setup['rest_by_team_week']
        self.assertEqual(rest[(2024, 3, 'KC')], 7)
        self.assertEqual(rest[(2024, 3, 'SF')], 6,
                         "SF's own rest, not the home team's")

    def test_features_before_returns_the_latest_legal_set(self):
        pbp = self.setup['pbp']
        late = datetime(2024, 9, 30, tzinfo=timezone.utc)
        self.assertIsNotNone(shared.features_before(pbp, 'KC', late))
        early = datetime(2024, 9, 6, tzinfo=timezone.utc)
        self.assertIsNone(shared.features_before(pbp, 'KC', early),
                          'nothing is publishable before the first week has finished')

    def test_a_week_with_no_known_publication_instant_is_DROPPED(self):
        """Never given a default. A feature with unknown availability leaks."""
        con = shared.read_only_connection(self.db)
        try:
            week_end = dict(self.setup['week_end'])
            week_end.pop((2024, 3))
            pbp = shared.load_team_week_features(con, week_end)
        finally:
            con.close()
        kc_weeks = len(pbp.get('KC', []))
        self.assertEqual(kc_weeks, 2, 'week 3 has no publication instant and is dropped, not defaulted')


class CutoffTests(unittest.TestCase):
    def test_fold_cutoff_is_a_week_before_the_earliest_decision(self):
        scored = [{'decision_at': '2024-10-10T17:00:00Z'},
                  {'decision_at': '2024-10-13T17:00:00Z'}]
        self.assertEqual(shared.fold_cutoff(scored),
                         datetime(2024, 10, 3, 17, 0, tzinfo=timezone.utc))

    def test_training_rows_need_BOTH_an_earlier_season_and_a_settled_label(self):
        """Applying only the season test is the common half-right mistake."""
        scored = [{'decision_at': '2024-10-10T17:00:00Z'}]
        rows = [
            # Earlier season, settled long before: legal.
            {'season': 2023, 'market': 'spreads', 'label_at': '2023-12-01T00:00:00Z'},
            # Earlier season, but its label settled AFTER the fold cutoff.
            {'season': 2023, 'market': 'spreads', 'label_at': '2024-10-09T00:00:00Z'},
            # Same season: never legal for this fold.
            {'season': 2024, 'market': 'spreads', 'label_at': '2024-01-01T00:00:00Z'},
        ]
        eligible = shared.eligible_training_rows(rows, scored, market='spreads', before_season=2024)
        self.assertEqual(len(eligible), 1)
        self.assertEqual(eligible[0]['label_at'], '2023-12-01T00:00:00Z')

    def test_a_row_with_no_settled_label_is_never_eligible(self):
        scored = [{'decision_at': '2024-10-10T17:00:00Z'}]
        rows = [{'season': 2023, 'market': 'spreads', 'label_at': None}]
        self.assertEqual(shared.eligible_training_rows(rows, scored, before_season=2024), [])


class PayoutParityTests(unittest.TestCase):
    def test_matches_the_worked_examples_in_the_plan(self):
        self.assertAlmostEqual(shared.american_profit(-110), 100 / 110)
        self.assertAlmostEqual(shared.american_profit(120), 1.2)
        self.assertAlmostEqual(shared.american_profit(100), 1.0)

    def test_a_price_inside_the_boundary_is_a_parsing_failure(self):
        for price in (0, 50, -50, 99, -99, None, 'x', float('nan')):
            self.assertIsNone(shared.american_profit(price), f'{price} is not a real American price')


class LabParityTests(unittest.TestCase):
    """The extraction must reproduce what the labs already compute."""

    def test_market_lab_and_tree_lab_agree_with_the_shared_chronology(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            db = str(Path(tmp.name) / 'parity.sqlite')
            build_fixture(db)
            setup = shared.shared_setup(db)

            # Recompute the labs' own inline chronology, exactly as both files
            # write it today, and require identical output.
            con = sqlite3.connect(Path(db).resolve().as_uri() + '?mode=ro', uri=True)
            con.row_factory = sqlite3.Row
            con.execute('BEGIN')
            games = [dict(x) for x in con.execute('''SELECT season,week,team,opponent,spread,total,
                team_score,opp_score,gameday,rest_days,div_game FROM game_lines
                WHERE home=1 AND season<=2025 ORDER BY season,week''')]
            history = collections.defaultdict(list)
            week_end = {}
            for g in games:
                d = shared.stamp(g['gameday'])
                if d is None or g['team_score'] is None or g['opp_score'] is None:
                    continue
                ready = d + timedelta(days=3)
                k = (g['season'], g['week'])
                week_end[k] = max(week_end.get(k, ready), ready)
                m = g['team_score'] - g['opp_score']
                total = g['team_score'] + g['opp_score']
                for team, margin in [(g['team'], m), (g['opponent'], -m)]:
                    history[team].append((ready, margin, total))
            for v in history.values():
                v.sort(key=lambda z: z[0])
            con.close()

            self.assertEqual(dict(week_end), dict(setup['week_end']),
                             'publication instants must be identical to the labs\' own')
            self.assertEqual({k: list(v) for k, v in history.items()},
                             {k: list(v) for k, v in setup['history'].items()},
                             'result history must be identical to the labs\' own')
        finally:
            tmp.cleanup()


if __name__ == '__main__':
    unittest.main()
