"""Tests for scripts/chat/screenshot_offers.py (SCREENSHOT-OFFERS).

SYNTHETIC FIXTURES ONLY. Every team, manager and player below is invented; no real chat
row, image or OCR line is in this file or read by it. OCR is faked with line lists except
in the one integration test, which renders a synthetic PNG and runs the real Vision script.

Run from the repo root:  python3 -m unittest discover -s scripts/chat -p 'test_*.py'
"""
import io, json, os, shutil, socket, sqlite3, subprocess, sys, tempfile, unittest
from contextlib import redirect_stdout
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screenshot_offers as so  # noqa: E402

LG = 9          # synthetic league id
SEASON = 2026
POSTED = '2026-09-20T15:00:00Z'
FAKE_NAMES = ['Alpha Squad', 'Beta Bombers', 'Gamma Rays', 'Marlo Venn', 'Tavi Ruskin', 'Deon Farrow',
              'Keaton Blythe', 'Jarvis Oake', 'Jarell Oake', 'Pip Owner', 'Quin Owner']


def ctx_fixture():
    c = so.Context()
    c.teams = {(LG, SEASON): {1: {'name': 'alpha squad', 'owner': 'pip owner'},
                              2: {'name': 'beta bombers', 'owner': 'quin owner'},
                              3: {'name': 'gamma rays', 'owner': ''}}}
    for pid, name, pos, nfl, espn in [(101, 'Marlo Venn', 'WR', 'min', 9001), (102, 'Tavi Ruskin', 'RB', 'atl', 9002),
                                      (103, 'Deon Farrow', 'QB', 'buf', 9003), (104, 'Keaton Blythe', 'TE', 'det', 9004),
                                      (105, 'Jarvis Oake', 'WR', 'kc', 9005), (106, 'Jarell Oake', 'RB', 'nyj', 9006),
                                      (107, 'Deon Farrow', 'WR', 'car', 9007)]:
        c.add_player(pid, name, pos, nfl, espn)
    c.pool = {(LG, SEASON): {101, 102, 103, 104, 105}}
    # before the trade: team 1 owns 101 and 103, team 2 owns 102 and 104
    c.owner_at = {(LG, SEASON): [('2026-09-18', {101: 1, 103: 1, 102: 2, 104: 2, 105: 3})]}
    c.me = {LG: 1}
    c.chat_roster = {(LG, 'Quin'): 2}
    return c.index()


def L(text, x, y, w=0.3, conf=0.99):
    return {'text': text, 'conf': conf, 'x': x, 'y': y, 'w': w, 'h': 0.03}


def column_screen(header_a='Alpha Squad receives', header_b='Beta Bombers receives', top=('Trade Proposal', 'Respond by Sep 22')):
    """Two-column ESPN-like layout: team A left, team B right."""
    lines = [L(t, 0.05, 0.05 + 0.05 * i) for i, t in enumerate(top)]
    lines += [L(header_a, 0.05, 0.3), L(header_b, 0.55, 0.3),
              L('Tavi Ruskin RB ATL', 0.05, 0.4), L('Marlo Venn WR MIN', 0.55, 0.4),
              L('Keaton Blythe TE DET', 0.05, 0.45), L('Deon Farrow QB BUF', 0.55, 0.45)]
    return lines


META = {'posted_at': POSTED, 'poster_name': 'ME', 'is_from_me': 1}


class Classify(unittest.TestCase):
    def test_kinds(self):
        cases = {
            'Trade Proposal\nRespond by Sep 22\nAccept\nDecline': 'offer',
            'Review Trade\nPropose Trade\nAdd a message': 'finalize',
            'Trade Accepted\nTrade processed': 'accepted',
            'Your trade was declined': 'declined',
            'Trade Analyzer\nFair Trade!': 'hypothetical',
            'Trade Block\nOn the block': 'block',
        }
        for text, kind in cases.items():
            with self.subTest(kind=kind):
                self.assertEqual(so.classify(text, 2, 2)[0], kind)

    def test_precedence_calculator_beats_accepted(self):
        self.assertEqual(so.classify('Trade Calculator\naccepted', 2, 0)[0], 'hypothetical')

    def test_not_a_trade(self):
        self.assertIsNone(so.classify('lol look at this\nsee you sunday', 0, 0)[0])
        self.assertIsNone(so.classify('pending', 0, 0)[0])       # no trade words, no players

    def test_structure_only_is_weak(self):
        kind, strength, _ = so.classify('Alpha Squad\nBeta Bombers\nreceives', 2, 2)
        self.assertEqual(kind, 'offer'); self.assertLess(strength, 1)


class IdMapping(unittest.TestCase):
    def setUp(self):
        self.c = ctx_fixture(); self.pool = self.c.pool[(LG, SEASON)]

    def test_exact_and_suffix(self):
        self.assertEqual(so.match_player(self.c, 'Marlo Venn Jr. WR', self.pool)[0], 101)

    def test_ocr_typo_is_fuzzy_matched_in_pool(self):
        m = so.match_player(self.c, 'Marlo Vcnn', self.pool)
        self.assertEqual(m[0], 101); self.assertLess(m[1], 1.0)

    def test_initial_abbreviation_unique_in_pool(self):
        # both Oakes start with J; only Jarvis (105) is rostered in this league
        self.assertEqual(so.match_player(self.c, 'J. Oake WR', self.pool)[0], 105)

    def test_same_name_disambiguated_by_pool_and_position(self):
        self.assertEqual(so.match_player(self.c, 'Deon Farrow', self.pool)[0], 103)
        m = so.match_player(self.c, 'Deon Farrow WR CAR', set())
        self.assertEqual(m[0], 107)

    def test_team_line_and_owner(self):
        self.assertEqual(so.match_team(self.c, 'Beta Bombers (3-1)', SEASON)[:3], (LG, SEASON, 2))
        self.assertEqual(so.match_team(self.c, 'Proposed by Beta Bomberz', SEASON)[2], 2)
        self.assertEqual(so.match_team(self.c, 'Quin Owner', SEASON)[2], 2)
        self.assertIsNone(so.match_team(self.c, 'Accept', SEASON))


class Parse(unittest.TestCase):
    def setUp(self):
        self.c = ctx_fixture()

    def test_columns_with_verbs_poster_is_receiver(self):
        lines = column_screen() + [L('Accept', 0.05, 0.9), L('Decline', 0.55, 0.9)]
        r = so.parse_screen(self.c, lines, META)       # Nick (team 1) received it: team 2 proposed
        self.assertEqual((r['kind'], r['league_id'], r['from_roster'], r['to_roster']), ('offer', LG, 2, 1))
        # 'X receives' lists: team 1 receives 102+104, so proposer 2 gives them
        self.assertEqual(sorted(r['give_ids']), [102, 104])
        self.assertEqual(sorted(r['get_ids']), [101, 103])
        self.assertEqual(r['status'], 'proposed')
        self.assertEqual(r['proposed_at'], POSTED); self.assertEqual(r['proposed_at_basis'], 'posted_at_upper_bound')
        self.assertGreaterEqual(r['confidence'], so.MIN_CONFIDENCE); self.assertEqual(r['needs_review'], 0)

    def test_vertical_sections_rosters_decide_sides(self):
        lines = [L('Review Trade', 0.05, 0.05), L('Propose Trade', 0.05, 0.1),
                 L('Alpha Squad', 0.05, 0.2), L('Marlo Venn', 0.05, 0.25), L('Deon Farrow', 0.05, 0.3),
                 L('Beta Bombers', 0.05, 0.4), L('Tavi Ruskin', 0.05, 0.45)]
        r = so.parse_screen(self.c, lines, META)      # finalize by Nick (team 1): he proposes
        self.assertEqual(r['kind'], 'finalize')
        self.assertEqual((r['from_roster'], r['to_roster']), (1, 2))
        self.assertEqual(sorted(r['give_ids']), [101, 103]); self.assertEqual(r['get_ids'], [102])
        self.assertTrue(r['sides_basis'].startswith('rosters'))

    def test_proposed_by_line_and_screen_date(self):
        lines = column_screen(top=('Trade Proposal', 'Proposed by Beta Bombers', 'Proposed Sep 18'))
        r = so.parse_screen(self.c, lines, {'posted_at': POSTED, 'poster_name': 'Someone', 'is_from_me': 0})
        self.assertEqual(r['from_roster'], 2)
        self.assertEqual(r['proposed_at'], '2026-09-18T12:00:00Z'); self.assertEqual(r['proposed_at_basis'], 'screen_date')

    def test_declined_with_unknown_proposer_needs_review(self):
        lines = column_screen(top=('Trade declined',))
        r = so.parse_screen(self.c, lines, {'posted_at': POSTED, 'poster_name': 'Someone', 'is_from_me': 0})
        self.assertEqual(r['kind'], 'declined'); self.assertEqual(r['needs_review'], 1)
        self.assertIn('proposer_unknown', r['review_reasons'])

    def test_hypothetical_never_needs_ledger(self):
        lines = column_screen(top=('Trade Analyzer', 'Fair Trade!'))
        r = so.parse_screen(self.c, lines, META)
        self.assertEqual(r['kind'], 'hypothetical'); self.assertEqual(r['review_reasons'], ['not_an_offer'])

    def test_garbled_screen_is_low_confidence(self):
        lines = [L('Trade Proposal', 0.05, 0.05), L('Alpha Squad', 0.05, 0.2), L('M@rl0 V', 0.05, 0.3, conf=0.3)]
        r = so.parse_screen(self.c, lines, META)
        self.assertEqual(r['needs_review'], 1); self.assertLess(r['confidence'], so.MIN_CONFIDENCE)

    def test_renamed_team_resolved_through_the_same_espn_member(self):
        # the manager of league 9 roster 1 also owns roster 4 in league 8, and the screen shows
        # the league-8 name (his league-9 team was renamed): it still resolves to league 9
        self.c.teams[(8, SEASON)] = {4: {'name': 'old alpha name', 'owner': ''}}
        self.c.member = {(LG, SEASON, 1): 'm-1', (8, SEASON, 4): 'm-1'}
        self.c.member_teams = {('m-1', SEASON): {LG: 1, 8: 4}}
        lines = column_screen(header_a='Old Alpha Name receives') + [L('Accept', 0.05, 0.9), L('Decline', 0.55, 0.9)]
        r = so.parse_screen(self.c, lines, META)
        self.assertEqual((r['league_id'], r['from_roster'], r['to_roster']), (LG, 2, 1))

    def test_background_players_below_the_buttons_are_ignored(self):
        lines = column_screen() + [L('Accept', 0.05, 0.6), L('Decline', 0.55, 0.6), L('Jarvis Oake WR KC', 0.5, 0.8)]
        r = so.parse_screen(self.c, lines, META)
        self.assertNotIn(105, r['give_ids'] + r['get_ids']); self.assertEqual(r['needs_review'], 0)

    def test_trade_for_comparison_is_hypothetical(self):
        lines = [L('Trade for', 0.03, 0.1), L('Alpha Squad', 0.3, 0.1), L('Trade with', 0.54, 0.1), L('Beta Bombers', 0.84, 0.1),
                 L('Marlo Venn', 0.13, 0.2), L('Tavi Ruskin', 0.63, 0.2)]
        self.assertEqual(so.parse_screen(self.c, lines, META)['kind'], 'hypothetical')

    def test_received_offer_without_side_headers_uses_rosters(self):
        lines = [L('Trade Review', 0.4, 0.1), L('Proposed by', 0.03, 0.18), L('Beta Bombers', 0.25, 0.18),
                 L('Respond by Sep 22 12:00 PM', 0.03, 0.2), L('Tavi Ruskin RB', 0.2, 0.3), L('Marlo Venn WR', 0.2, 0.4),
                 L('Decline Trade', 0.17, 0.94), L('Accept Trade', 0.65, 0.94)]
        r = so.parse_screen(self.c, lines, META)
        self.assertEqual((r['from_roster'], r['to_roster'], r['give_ids'], r['get_ids']), (2, 1, [102], [101]))
        self.assertTrue(r['sides_basis'].startswith('owner_direct'))

    def test_calculator_by_a_league_mate_reads_his_would_give_and_wants(self):
        # no ESPN team on a calculator: the explorer is the poster (Quin, roster 2), the other side whoever holds the rest
        lines = [L('Trade Calculator', 0.17, 0.1), L('Tavi Ruskin RB', 0.1, 0.3), L('Marlo Venn WR', 0.6, 0.3)]
        r = so.parse_screen(self.c, lines, {'posted_at': POSTED, 'poster_name': 'Quin', 'is_from_me': 0})
        self.assertEqual(r['kind'], 'hypothetical'); self.assertIsNone(r['status'])
        self.assertEqual((r['from_roster'], r['to_roster'], r['give_ids'], r['get_ids']), (2, 1, [102], [101]))
        self.assertIn('not_an_offer', r['review_reasons'])

    def test_non_trade_returns_none(self):
        self.assertIsNone(so.parse_screen(self.c, [L('game day!', 0.1, 0.1)], META))


# ----------------------------------------------------------------------------- pipeline fixtures

def make_chat_db(path, images):
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, is_from_me INTEGER, date INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT, is_sticker INTEGER);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      INSERT INTO chat VALUES (1, 'Transfer league 2026'), (2, NULL), (3, 'Some other chat');
    """)
    for i, (chat, path_, mime, from_me) in enumerate(images, 1):
        db.execute('INSERT INTO message VALUES (?,?,?,?)', (i, 1, from_me, 780000000 * 10**9))
        db.execute('INSERT INTO chat_message_join VALUES (?,?)', (chat, i))
        db.execute('INSERT INTO attachment VALUES (?,?,?,?,0)', (i, f'guid-{i}', path_, mime))
        db.execute('INSERT INTO message_attachment_join VALUES (?,?)', (i, i))
    db.commit(); db.close()


def make_app_db(path):
    db = sqlite3.connect(path)
    db.executescript(f"""
      CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, position TEXT, team_id INTEGER, espn_id INTEGER, fantasy_relevant INTEGER);
      CREATE TABLE nfl_teams (id INTEGER PRIMARY KEY, abbr TEXT);
      CREATE TABLE league_season_teams (league_id INTEGER, season INTEGER, roster_id INTEGER, team_name TEXT, owner_name TEXT);
      CREATE TABLE leagues (id INTEGER PRIMARY KEY, my_team_id INTEGER);
      CREATE TABLE league_member_identity (league_id INTEGER, roster_id INTEGER, chat_name TEXT);
      CREATE TABLE league_roster_snapshots (league_id INTEGER, season INTEGER, first_seen_at TEXT, team_id INTEGER,
        espn_player_id INTEGER, on_roster INTEGER);
      INSERT INTO nfl_teams VALUES (1, 'MIN'), (2, 'ATL'), (3, 'BUF'), (4, 'DET');
      INSERT INTO players VALUES (101, 'Marlo Venn', 'WR', 1, 9001, 1), (102, 'Tavi Ruskin', 'RB', 2, 9002, 1),
        (103, 'Deon Farrow', 'QB', 3, 9003, 1), (104, 'Keaton Blythe', 'TE', 4, 9004, 1);
      INSERT INTO league_season_teams VALUES ({LG}, {SEASON}, 1, 'Alpha Squad', 'Pip Owner'),
        ({LG}, {SEASON}, 2, 'Beta Bombers', 'Quin Owner');
      INSERT INTO leagues VALUES ({LG}, 1);
      INSERT INTO league_member_identity VALUES ({LG}, 2, 'Quin');
      INSERT INTO league_roster_snapshots VALUES ({LG}, {SEASON}, '2026-09-18T00:00:00Z', 1, 9001, 1),
        ({LG}, {SEASON}, '2026-09-18T00:00:00Z', 1, 9003, 1), ({LG}, {SEASON}, '2026-09-18T00:00:00Z', 2, 9002, 1),
        ({LG}, {SEASON}, '2026-09-18T00:00:00Z', 2, 9004, 1);
    """)
    db.commit(); db.close()


def make_out_db(path, legacy=False):
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE participants (handle TEXT PRIMARY KEY, name TEXT, dm_chat_id INTEGER);
      INSERT INTO participants VALUES ('h1', 'Quin', 2);
      CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
        is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    """)
    if legacy:
        db.executescript("""
          CREATE TABLE screenshot_trades (msg_id INTEGER PRIMARY KEY, poster TEXT, posted_at TEXT, league_hint TEXT,
            side_a_team TEXT, side_a_players TEXT, side_b_team TEXT, side_b_players TEXT, status TEXT,
            confidence REAL, notes TEXT, matched_tx_id TEXT, match TEXT);
          INSERT INTO screenshot_trades (msg_id, status, confidence) VALUES (500, 'legacy', 0.9), (501, 'legacy', 0.8);
        """)
    db.commit(); db.close()


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); d = self.tmp.name
        self.img, self.meme = os.path.join(d, 'offer.png'), os.path.join(d, 'meme.png')
        for f in (self.img, self.meme):
            with open(f, 'wb') as fh: fh.write(b'not really an image')
        self.addCleanup(self.tmp.cleanup)
        self.src, self.out, self.app = (os.path.join(d, n) for n in ('chat.db', 'league_chat.sqlite', 'data.sqlite'))
        make_chat_db(self.src, [(1, self.img, 'image/png', 1), (2, self.meme, 'image/png', 0),
                                (1, os.path.join(d, 'gone.heic'), 'image/heic', 0),
                                (3, self.img, 'image/png', 0),              # out of scope chat: never read
                                (1, os.path.join(d, 'clip.mov'), 'video/quicktime', 0)])
        make_app_db(self.app); make_out_db(self.out, legacy=True)
        self.calls = []

    def fake_ocr(self, paths):
        self.calls.extend(paths)
        res = {}
        for p in paths:
            lines = column_screen() + [L('Accept', 0.05, 0.9), L('Decline', 0.55, 0.9)] if p == self.img \
                else [L('see you sunday', 0.1, 0.1)]
            res[p] = {'path': p, 'ok': True, 'lines': lines}
        return res

    def run_once(self):
        return so.run(self.src, self.out, self.app, ocr=self.fake_ocr, log=lambda *_: None)

    def test_counts_scope_and_rows(self):
        c = self.run_once()
        self.assertEqual(c['images_read'], 2)                 # the offer + the meme; chat 3 never read
        self.assertEqual((c['missing_file'], c['not_image']), (1, 1))
        self.assertEqual((c['trade_screens'], c['by_kind']['offer'], c['high_confidence']), (1, 1, 1))
        self.assertEqual(c['by_league'], {str(LG): 1})
        db = sqlite3.connect(self.out)
        row = db.execute("SELECT kind, league_id, from_roster, to_roster, give_ids, get_ids, needs_review, attachment_guid "
                         "FROM screenshot_trades WHERE source = 'ocr'").fetchone()
        self.assertEqual(row[:4], ('offer', LG, 2, 1))
        self.assertEqual(sorted(json.loads(row[4])), [102, 104]); self.assertEqual(row[6], 0); self.assertEqual(row[7], 'guid-1')

    def test_idempotent_each_image_read_once(self):
        self.run_once(); first = list(self.calls)
        c2 = self.run_once()
        self.assertEqual(first.count(self.img), 1)
        self.assertEqual(c2['images_seen'], 0); self.assertEqual(self.calls, first)
        db = sqlite3.connect(self.out)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM screenshot_ocr_done').fetchone()[0], 4)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM screenshot_trades WHERE source = 'ocr'").fetchone()[0], 1)

    def test_legacy_rows_kept_on_rebuild(self):
        self.run_once()
        db = sqlite3.connect(self.out)
        self.assertEqual(db.execute("SELECT COUNT(*), MIN(source) FROM screenshot_trades WHERE msg_id IN (500, 501)").fetchone(),
                         (2, 'rnd_manual'))
        so.ensure_schema(db)   # twice is a no-op
        self.assertEqual(db.execute("SELECT COUNT(*) FROM screenshot_trades").fetchone()[0], 3)

    def test_reparse_uses_stored_ocr_only(self):
        self.run_once(); self.calls.clear()
        self.assertEqual(so.reparse(self.out, self.app), 1)
        self.assertEqual(self.calls, [])

    def test_chat_db_opened_read_only(self):
        before = open(self.src, 'rb').read()
        self.run_once()
        self.assertEqual(open(self.src, 'rb').read(), before)


class Privacy(unittest.TestCase):
    """The pipeline never opens a socket, prints only counts, and writes only the local chat DB."""

    def test_no_network_no_text_out_no_stray_files(self):
        p = Pipeline('test_counts_scope_and_rows'); p.setUp()
        try:
            attempts = []

            def refuse(*a, **k):
                attempts.append(a); raise AssertionError('network use attempted')
            before = set(os.listdir(p.tmp.name))
            buf = io.StringIO()
            with mock.patch.object(socket, 'socket', refuse), mock.patch.object(socket, 'create_connection', refuse), \
                    mock.patch.object(socket, 'getaddrinfo', refuse), redirect_stdout(buf):
                c = so.run(p.src, p.out, p.app, ocr=p.fake_ocr)
                print(json.dumps(so.summary(p.out)))
            self.assertEqual(attempts, [])
            self.assertEqual(c['trade_screens'], 1)
            printed = buf.getvalue()
            for name in FAKE_NAMES + ['Respond by', 'Accept', 'see you sunday']:
                self.assertNotIn(name, printed)
            after = set(os.listdir(p.tmp.name))
            self.assertTrue(after - before <= {'league_chat.sqlite-journal', 'league_chat.sqlite-wal', 'league_chat.sqlite-shm'},
                            after - before)
        finally:
            p.doCleanups()

    def test_ocr_child_runs_with_network_denied(self):
        with mock.patch.object(so.subprocess, 'run') as r, mock.patch.object(so.os.path, 'exists', return_value=True):
            r.return_value = mock.Mock(returncode=0, stdout='{"results": []}')
            so.vision_runner('/bin/ocr')(['a.png'])
            cmd = r.call_args[0][0]
        self.assertEqual(cmd[:3], [so.SANDBOX_EXEC, '-p', so.SANDBOX_PROFILE])
        self.assertIn('(deny network*)', so.SANDBOX_PROFILE)

    @unittest.skipUnless(os.path.exists(so.SANDBOX_EXEC), 'sandbox-exec not on this machine')
    def test_sandbox_profile_really_blocks_sockets(self):
        srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen(1)
        port = srv.getsockname()[1]
        try:
            code = f"import socket; socket.create_connection(('127.0.0.1', {port}), timeout=2)"
            r = subprocess.run([so.SANDBOX_EXEC, '-p', so.SANDBOX_PROFILE, sys.executable, '-c', code],
                               capture_output=True, text=True, timeout=30)
            self.assertNotEqual(r.returncode, 0)
            self.assertRegex(r.stderr, r'PermissionError|Operation not permitted')
        finally:
            srv.close()


@unittest.skipUnless(shutil.which('swiftc') and shutil.which('swift'), 'Swift not on this machine')
class VisionIntegration(unittest.TestCase):
    """Real on-device OCR of a SYNTHETIC rendered image, in the sandbox, then the real parse."""

    def test_render_ocr_parse(self):
        with tempfile.TemporaryDirectory() as d:
            png = os.path.join(d, 'fx.png')
            r = subprocess.run(['swift', os.path.join(so.HERE, 'fixtures', 'render_fixture.swift'), png,
                                'Trade Proposal', 'Respond by Sep 22', 'L|Alpha Squad receives|Beta Bombers receives',
                                'L|Tavi Ruskin RB|Marlo Venn WR', 'L|Keaton Blythe TE|Deon Farrow QB', 'L|Accept|Decline'],
                               capture_output=True, text=True, timeout=300)
            self.assertEqual(r.returncode, 0, r.stderr[-500:])
            heic = os.path.join(d, 'fx.heic')
            subprocess.run(['sips', '-s', 'format', 'heic', png, '--out', heic], capture_output=True, timeout=60)
            binp = so.ocr_binary(os.path.join(d, 'bin'))
            res = so.vision_runner(binp)([png, heic] if os.path.exists(heic) else [png])
            for path, out in res.items():
                self.assertTrue(out['ok'], path)
                rec = so.parse_screen(ctx_fixture(), out['lines'], META)
                self.assertEqual((rec['kind'], rec['from_roster'], rec['to_roster']), ('offer', 2, 1))
                self.assertEqual(sorted(rec['give_ids']), [102, 104])


if __name__ == '__main__':
    unittest.main()
