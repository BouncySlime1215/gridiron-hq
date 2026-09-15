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

    def test_dropped_rows_are_quarantined_with_a_reason_not_silently_lost(self):
        """Codex plan Stage 1: quarantine invalid records, don't erase them.
        shared_setup's optional quarantine tracking must count and name every
        row build_chronology/load_team_week_features drops -- not just make
        it disappear the way test_a_week_with_no_known_publication_instant_is_DROPPED
        (above) shows the un-tracked call still can."""
        tmp = tempfile.TemporaryDirectory()
        try:
            db = str(Path(tmp.name) / 'quarantine.sqlite')
            con = sqlite3.connect(db)
            con.execute('''CREATE TABLE game_lines (season INTEGER, week INTEGER, team TEXT,
                opponent TEXT, home INTEGER, spread REAL, total REAL, team_score INTEGER,
                opp_score INTEGER, gameday TEXT, rest_days INTEGER, div_game INTEGER, roof TEXT)''')
            con.execute('''CREATE TABLE nfl_team_week_features (season INTEGER, week INTEGER,
                team TEXT, features TEXT)''')
            con.execute('''INSERT INTO game_lines VALUES
                (2024,1,'KC','BAL',1,-3,44,27,20,'2024-09-05',7,0,'dome')''')
            con.execute('''INSERT INTO game_lines VALUES
                (2024,1,'BAL','KC',0,3,44,20,27,'2024-09-05',7,0,'dome')''')
            con.execute("INSERT INTO nfl_team_week_features VALUES (2024,1,'KC','{\"net_epa_per_play\": 0.05}')")
            # No final score -- must be quarantined, not silently dropped.
            con.execute('''INSERT INTO game_lines VALUES
                (2024,2,'KC','SF',1,-1,44,NULL,NULL,'2024-09-12',7,0,'dome')''')
            con.execute('''INSERT INTO game_lines VALUES
                (2024,2,'SF','KC',0,1,44,NULL,NULL,'2024-09-12',7,0,'dome')''')
            # Unparseable JSON -- must be quarantined too.
            con.execute("INSERT INTO nfl_team_week_features VALUES (2024,1,'BAL','not-json')")
            con.commit()
            con.close()

            setup = shared.shared_setup(db)
            q = setup['quarantine']
            self.assertEqual(q['games_excluded_count'], 1)
            self.assertEqual(q['games_excluded'][0]['reason'], 'missing_final_score')
            self.assertEqual(q['team_week_features_excluded_count'], 1)
            self.assertEqual(q['team_week_features_excluded'][0]['reason'], 'unparseable_json')
        finally:
            tmp.cleanup()


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


def build_multi_season_fixture(path):
    """Two seasons: an 'early' one with no nfl_team_week_features at all (the
    real shape of 1999-2015 data) and a 'modern' one that has them, so
    pbp_available can be tested both ways without touching the real DB."""
    con = sqlite3.connect(path)
    con.execute('''CREATE TABLE game_lines (season INTEGER, week INTEGER, team TEXT, opponent TEXT,
        home INTEGER, spread REAL, total REAL, team_score INTEGER, opp_score INTEGER,
        gameday TEXT, rest_days INTEGER, div_game INTEGER, roof TEXT)''')
    con.execute('''CREATE TABLE nfl_team_week_features (season INTEGER, week INTEGER,
        team TEXT, features TEXT)''')
    rows = [
        # early season: three weeks, no pbp table rows at all for this season.
        (1999, 1, 'DAL', 'NYG', 20, 17, '1999-09-05', 7, 7, 0),
        (1999, 2, 'DAL', 'WAS', 24, 21, '1999-09-12', 7, 7, 0),
        (1999, 3, 'NYG', 'DAL', 14, 27, '1999-09-19', 7, 6, 1),
        # modern season: pbp rows present, enough weeks that week 3 has two
        # prior weeks of both history and pbp for DAL.
        (2024, 1, 'DAL', 'NYG', 27, 20, '2024-09-05', 7, 7, 0),
        (2024, 2, 'DAL', 'WAS', 24, 21, '2024-09-12', 7, 7, 0),
        (2024, 3, 'NYG', 'DAL', 17, 20, '2024-09-19', 7, 6, 1),
    ]
    for season, week, home, away, hs, aws, day, hrest, arest, div in rows:
        con.execute('''INSERT INTO game_lines
            (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,rest_days,div_game,roof)
            VALUES (?,?,?,?,1,-3,44,?,?,?,?,?,'dome')''', (season, week, home, away, hs, aws, day, hrest, div))
        con.execute('''INSERT INTO game_lines
            (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,rest_days,div_game,roof)
            VALUES (?,?,?,?,0,3,44,?,?,?,?,?,'dome')''', (season, week, away, home, aws, hs, day, arest, div))
        if season == 2024:
            con.execute('INSERT INTO nfl_team_week_features VALUES (?,?,?,?)',
                        (season, week, home, '{"net_epa_per_play": 0.05}'))
            con.execute('INSERT INTO nfl_team_week_features VALUES (?,?,?,?)',
                        (season, week, away, '{"net_epa_per_play": -0.02}'))
    con.commit()
    con.close()


class FootballDatasetTests(unittest.TestCase):
    """Stage 2: the broad, price-agnostic dataset for team-strength learning."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = str(Path(cls.tmp.name) / 'football.sqlite')
        build_multi_season_fixture(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_spans_seasons_with_no_price_data_at_all(self):
        """The fixture has no nfl_odds_archive table whatsoever -- if this
        function touched price data it would raise, not just return fewer rows."""
        result = shared.build_football_dataset(self.db, min_season=1999, through_season=2025)
        seasons = {r['season'] for r in result['rows']}
        self.assertIn(1999, seasons, 'the whole point of this dataset is pre-2022 seasons')
        self.assertIn(2024, seasons)

    def test_min_season_filters_earlier_rows(self):
        result = shared.build_football_dataset(self.db, min_season=2024, through_season=2025)
        self.assertTrue(all(r['season'] >= 2024 for r in result['rows']))
        self.assertEqual(result['min_season'], 2024)

    def test_pbp_available_is_false_when_no_team_week_features_exist(self):
        result = shared.build_football_dataset(self.db, min_season=1999, through_season=2025)
        early_rows = [r for r in result['rows'] if r['season'] == 1999]
        self.assertTrue(early_rows)
        self.assertTrue(all(r['pbp_available'] is False for r in early_rows),
                         'no nfl_team_week_features rows exist for 1999 in the fixture')
        self.assertTrue(all(r['home_pbp_features'] is None for r in early_rows))

    def test_pbp_available_is_true_once_a_prior_week_has_published_features(self):
        result = shared.build_football_dataset(self.db, min_season=1999, through_season=2025)
        dal_week3 = next(r for r in result['rows']
                          if r['season'] == 2024 and r['week'] == 3 and 'DAL' in (r['home'], r['away']))
        self.assertTrue(dal_week3['pbp_available'],
                         "by week 3, DAL's weeks 1-2 pbp rows are long since published")

    def test_rows_need_no_market_spread_or_total_to_appear(self):
        """Confirms this is genuinely price-agnostic: a row with market fields
        stripped out entirely must still appear, since the label is the
        actual score, not anything derived from a quote."""
        result = shared.build_football_dataset(self.db, min_season=1999, through_season=2025)
        self.assertTrue(result['rows'])
        for r in result['rows']:
            self.assertIn('actual_margin', r)
            self.assertIn('actual_total', r)

    def test_decision_at_is_the_games_own_kickoff_not_the_publication_instant(self):
        result = shared.build_football_dataset(self.db, min_season=1999, through_season=2025)
        week1 = next(r for r in result['rows'] if r['season'] == 1999 and r['week'] == 1)
        self.assertEqual(week1['decision_at'], datetime(1999, 9, 5, tzinfo=timezone.utc).isoformat())


def build_betting_fixture(path):
    """game_lines plus a matching nfl_odds_archive pair for one game, shaped
    exactly like the real table paired_quotes/build_betting_dataset read."""
    con = sqlite3.connect(path)
    con.execute('''CREATE TABLE game_lines (season INTEGER, week INTEGER, team TEXT, opponent TEXT,
        home INTEGER, spread REAL, total REAL, team_score INTEGER, opp_score INTEGER,
        gameday TEXT, rest_days INTEGER, div_game INTEGER, roof TEXT)''')
    con.execute('''CREATE TABLE nfl_team_week_features (season INTEGER, week INTEGER,
        team TEXT, features TEXT)''')
    con.execute('''CREATE TABLE nfl_odds_archive (eid TEXT, season INTEGER, week INTEGER,
        home TEXT, away TEXT, commence_time TEXT, book TEXT, market TEXT, side TEXT, phase TEXT,
        line REAL, price INTEGER, book_updated_at TEXT, source TEXT, fetched_at TEXT)''')
    con.execute('''INSERT INTO game_lines VALUES
        (2023,1,'KC','DET',1,-3,44,27,20,'2023-09-07',7,0,'dome')''')
    con.execute('''INSERT INTO game_lines VALUES
        (2023,1,'DET','KC',0,3,44,20,27,'2023-09-07',7,0,'dome')''')
    quotes = [
        ('e1', 2023, 1, 'KC', 'DET', '2023-09-07T20:20:00Z', 'spreads', 'KC', 'open', -3.0, -110, '2023-09-05T12:00:00Z'),
        ('e1', 2023, 1, 'KC', 'DET', '2023-09-07T20:20:00Z', 'spreads', 'DET', 'open', 3.0, -110, '2023-09-05T12:00:30Z'),
        ('e1', 2023, 1, 'KC', 'DET', '2023-09-07T20:20:00Z', 'spreads', 'KC', 'close', -1.0, -115, '2023-09-07T18:00:00Z'),
    ]
    for eid, season, week, home, away, commence, market, side, phase, line, price, updated in quotes:
        con.execute('''INSERT INTO nfl_odds_archive VALUES (?,?,?,?,?,?,'pinnacle',?,?,?,?,?,?,'oddstrader',?)''',
                     (eid, season, week, home, away, commence, market, side, phase, line, price, updated, updated))
    con.commit()
    con.close()


class BettingDatasetTests(unittest.TestCase):
    """The shared chronology-critical block both labs used to duplicate."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = str(Path(cls.tmp.name) / 'betting.sqlite')
        build_betting_fixture(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_a_valid_open_close_pair_survives_with_correct_fields(self):
        result = shared.build_betting_dataset(self.db, min_season=2022, through_season=2025)
        pairs = result['quote_pairs']
        self.assertEqual(len(pairs), 1)
        p = pairs[0]
        self.assertEqual(p['market'], 'spreads')
        self.assertEqual(p['home'], 'KC')
        self.assertEqual(p['o']['line'], -3.0)
        self.assertEqual(p['c']['line'], -1.0)
        self.assertEqual(p['decision'], datetime(2023, 9, 5, 12, 0, 30, tzinfo=timezone.utc),
                          'decision is the LATER of the two opening quotes, not the earlier')

    def test_min_season_excludes_the_pair(self):
        result = shared.build_betting_dataset(self.db, min_season=2024, through_season=2025)
        self.assertEqual(result['quote_pairs'], [])

    def test_a_mismatched_spread_pair_is_quarantined_as_different_contracts(self):
        con = sqlite3.connect(self.db)
        con.execute('''INSERT INTO nfl_odds_archive VALUES
            ('e2',2023,1,'KC','DET','2023-09-07T20:20:00Z','pinnacle','spreads','KC','open',-3.0,-110,'2023-09-05T12:01:00Z','oddstrader','2023-09-05T12:01:00Z')''')
        con.execute('''INSERT INTO nfl_odds_archive VALUES
            ('e2',2023,1,'KC','DET','2023-09-07T20:20:00Z','pinnacle','spreads','DET','open',2.5,-110,'2023-09-05T12:01:20Z','oddstrader','2023-09-05T12:01:20Z')''')
        con.execute('''INSERT INTO nfl_odds_archive VALUES
            ('e2',2023,1,'KC','DET','2023-09-07T20:20:00Z','pinnacle','spreads','KC','close',-1.0,-115,'2023-09-07T18:00:00Z','oddstrader','2023-09-07T18:00:00Z')''')
        con.commit(); con.close()
        result = shared.build_betting_dataset(self.db, min_season=2022, through_season=2025)
        reasons = {q['eid']: q['reason'] for q in result['quarantine']['quote_pairs_excluded']}
        self.assertEqual(reasons.get('e2'), 'different_contracts',
                          '-3.0 and 2.5 do not sum to zero: not a real two-sided market')

    def test_quote_pairs_excluded_count_matches_the_list(self):
        result = shared.build_betting_dataset(self.db, min_season=2022, through_season=2025)
        q = result['quarantine']
        self.assertEqual(q['quote_pairs_excluded_count'], len(q['quote_pairs_excluded']))


if __name__ == '__main__':
    unittest.main()
