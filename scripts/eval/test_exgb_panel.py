"""Tests for scripts/eval/exgb_panel.py on a synthetic database (stdlib + numpy only).

Run: python3 -m unittest scripts/eval/test_exgb_panel.py
"""
import os
import sqlite3
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exgb_panel as P  # noqa: E402

S = 2030


def make_db(path):
    con = sqlite3.connect(path)
    con.executescript("""
      CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, position TEXT, espn_id INTEGER, gsis_id TEXT);
      CREATE TABLE player_week_usage (player_id INTEGER, season INTEGER, week INTEGER, team TEXT, opponent TEXT,
        position TEXT, attempts REAL, carries REAL, targets REAL, receptions REAL, target_share REAL,
        air_yards_share REAL, wopr REAL, receiving_air_yards REAL, passing_air_yards REAL, passing_yards REAL,
        rushing_yards REAL, receiving_yards REAL, passing_tds REAL, rushing_tds REAL, receiving_tds REAL,
        interceptions REAL, fumbles_lost REAL);
      CREATE TABLE player_week_snaps (player_id INTEGER, season INTEGER, week INTEGER, offense_snaps REAL, offense_pct REAL);
      CREATE TABLE nfl_player_week_features (season INTEGER, week INTEGER, player_id TEXT, player_name TEXT,
        team TEXT, opponent TEXT, position TEXT, features TEXT);
      CREATE TABLE nfl_ffopportunity_weekly (season INTEGER, week INTEGER, player_gsis_id TEXT,
        expected_fantasy_points REAL);
      CREATE TABLE game_lines (season INTEGER, week INTEGER, team TEXT, opponent TEXT, home INTEGER,
        spread REAL, total REAL, gameday TEXT, gametime TEXT);
      CREATE TABLE nfl_odds_archive (season INTEGER, home TEXT, away TEXT, commence_time TEXT, book TEXT,
        market TEXT, side TEXT, phase TEXT, line REAL, book_updated_at TEXT);
      CREATE TABLE nfl_injuries (season INTEGER, week INTEGER, gsis_id TEXT, report_status TEXT, practice_status TEXT);
    """)
    con.executemany('INSERT INTO players VALUES (?,?,?,?,?)', [
        (1, 'wr', 'WR', 101, 'G1'), (2, 'rb', 'RB', 102, 'G2'), (3, 'te', 'TE', 103, 'G3')])
    for w in range(1, 7):
        day = f'{S}-09-{7 * w:02d}' if 7 * w <= 30 else f'{S}-10-{7 * w - 30:02d}'
        con.execute('INSERT INTO game_lines VALUES (?,?,?,?,?,?,?,?,?)', (S, w, 'AAA', 'BBB', 1, -3.0, 44.0, day, '13:00'))
        con.execute('INSERT INTO game_lines VALUES (?,?,?,?,?,?,?,?,?)', (S, w, 'BBB', 'AAA', 0, 3.0, 44.0, day, '13:00'))
        # opening line: home -2.5, total 46, posted days before; week 5's is stamped AFTER kickoff
        stamp = f'{day}T20:00' if w == 5 else f'{S}-08-01T10:00'
        con.execute('INSERT INTO nfl_odds_archive VALUES (?,?,?,?,?,?,?,?,?,?)',
                    (S, 'AAA', 'BBB', f'{day}T17:00:00Z', 'bk', 'spreads', 'home', 'open', -2.5, stamp))
        con.execute('INSERT INTO nfl_odds_archive VALUES (?,?,?,?,?,?,?,?,?,?)',
                    (S, 'AAA', 'BBB', f'{day}T17:00:00Z', 'bk', 'totals', 'over', 'open', 46.0, stamp))
        for pid, pos, team, opp in ((1, 'WR', 'AAA', 'BBB'), (2, 'RB', 'AAA', 'BBB'), (3, 'TE', 'BBB', 'AAA')):
            if pid == 2 and w == 4:
                continue  # the RB sits out week 4: a DNP row scoring 0
            con.execute('INSERT INTO player_week_usage (player_id, season, week, team, opponent, position, targets, '
                        'receptions, receiving_yards, receiving_tds, carries, rushing_yards, target_share) '
                        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (pid, S, w, team, opp, pos, 5 + w, 3 + w, 10.0 * w, 1 if w % 2 else 0, 2 * pid, 5.0 * pid,
                         0.1 * w))
            con.execute('INSERT INTO player_week_snaps VALUES (?,?,?,?,?)', (pid, S, w, 40, 0.5 + 0.05 * w))
            con.execute('INSERT INTO nfl_player_week_features VALUES (?,?,?,?,?,?,?,?)',
                        (S, w, f'G{pid}', 'x', team, opp, pos, '{"red_zone_targets": %d, "red_zone_carries": 1}' % w))
            con.execute('INSERT INTO nfl_ffopportunity_weekly VALUES (?,?,?,?)', (S, w, f'G{pid}', 7.0 + w))
    con.execute("INSERT INTO nfl_injuries VALUES (?,?,?,?,?)",
                (S, 4, 'G2', 'Out', 'Did Not Participate In Practice'))
    con.commit()
    con.close()


class PanelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, 'fixture.sqlite')
        make_db(cls.db)
        con = P.open_db(cls.db)
        cls.t = P.load_tables(con, S, S)
        con.close()
        cls.panel = P.build_panel(cls.t, [S])
        cls.names = list(cls.panel['feature_names'])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def row(self, pid, week):
        m = self.panel['meta']
        i = int(np.where((m[:, 0] == pid) & (m[:, 3] == week))[0][0])
        return i, dict(zip(self.names, self.panel['X'][i]))

    def test_ppr_formula(self):
        u = {'passing_yards': 250, 'passing_tds': 2, 'interceptions': 1, 'rushing_yards': 20, 'receiving_yards': 0,
             'rushing_tds': 1, 'receiving_tds': 0, 'receptions': 0, 'fumbles_lost': 1}
        self.assertAlmostEqual(P.ppr_points(u), 10 + 8 - 2 + 2 + 6 - 2)

    def test_lags_use_only_earlier_weeks(self):
        i, f = self.row(1, 3)
        wk2 = P.ppr_points({'receptions': 5, 'receiving_yards': 20, 'receiving_tds': 0, 'rushing_yards': 5})
        wk1 = P.ppr_points({'receptions': 4, 'receiving_yards': 10, 'receiving_tds': 1, 'rushing_yards': 5})
        self.assertAlmostEqual(f['lag1_ppr'], wk2)
        self.assertAlmostEqual(f['trail3_ppr'], (wk1 + wk2) / 2)
        self.assertAlmostEqual(f['lag1_xfp'], 9.0)
        self.assertEqual(f['week'], 3)

    def test_a_missed_game_is_a_zero_point_row(self):
        i, f = self.row(2, 4)
        self.assertEqual(self.panel['played'][i], 0)
        self.assertEqual(self.panel['y'][i], 0.0)
        self.assertEqual(f['inj_status'], 3.0)
        _, f5 = self.row(2, 5)
        self.assertEqual(f5['missed_last_team_game'], 1.0)

    def test_opening_line_after_kickoff_is_not_used(self):
        _, f3 = self.row(1, 3)
        self.assertEqual(f3['line_src'], 0.0)
        self.assertAlmostEqual(f3['team_spread'], -2.5)
        self.assertAlmostEqual(f3['team_implied'], 46 / 2 + 2.5 / 2)
        _, f5 = self.row(1, 5)
        self.assertEqual(f5['line_src'], 1.0, 'week 5 open line was stamped after kickoff: schedule fallback')
        self.assertAlmostEqual(f5['team_spread'], -3.0)

    def test_leakage_check_passes_on_the_real_builder(self):
        r = P.leakage_check(self.t, [S], self.panel, n=12, n_weeks=6)
        self.assertEqual(r['rows_with_changed_features'], 0)
        self.assertGreater(r['played_rows_checked'], 0)
        self.assertEqual(r['played_rows_with_changed_target'], r['played_rows_checked'])

    def test_leakage_check_catches_a_same_game_feature(self):
        real = P.build_panel

        def leaky(t, seasons):
            p = real(t, seasons)
            p['X'][:, list(p['feature_names']).index('lag1_ppr')] = p['y']  # same-game points as a "lag"
            return p
        P.build_panel = leaky
        try:
            r = P.leakage_check(self.t, [S], leaky(self.t, [S]), n=12, n_weeks=6)
        finally:
            P.build_panel = real
        self.assertGreater(r['rows_with_changed_features'], 0)

    def test_refuses_the_live_database(self):
        with self.assertRaises(SystemExit):
            P.open_db(P.LIVE_DB)


if __name__ == '__main__':
    unittest.main()
