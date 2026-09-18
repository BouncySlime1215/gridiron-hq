"""Tests for scripts/chat/extract_league_chat.py, the league-chat extractor.

The refresh loop (scripts/refresh-live-data.mjs) runs the extractor every 15 minutes,
and its tables feed manager_signals and the negotiation-profile prompts. Until now it
had no tests. Every test here builds a synthetic chat.db and output DB in a temp dir;
no real message is read. stdlib unittest, like research/ (pytest is not installed in
the python3 the loop spawns).

Run from the repo root:  python3 -m unittest discover -s scripts/chat -p 'test_*.py'
"""
import os, sqlite3, subprocess, sys, tempfile, unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_league_chat as elc  # noqa: E402

GROUP = 'Transfer league 2026'


def make_chat_db(path):
    db = sqlite3.connect(path)
    db.executescript(f"""
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, handle_id INTEGER, is_from_me INTEGER,
        date INTEGER, text TEXT, attributedBody BLOB, associated_message_type INTEGER, thread_originator_guid TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO chat VALUES (1, '{GROUP}'), (2, NULL);
      INSERT INTO handle VALUES (1, '+15550000001'), (2, 'alice@example.com');
    """)
    db.commit()
    return db


def add_msg(db, rowid, handle_id, chat_id, text, from_me=0):
    db.execute("INSERT INTO message VALUES (?,?,?,?,?,NULL,0,NULL)",
               (rowid, handle_id, from_me, 700000000 * 10**9, text))
    db.execute("INSERT INTO chat_message_join VALUES (?,?)", (chat_id, rowid))
    db.commit()


MESSAGES_DDL = """CREATE TABLE IF NOT EXISTS messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT,
  handle TEXT, name TEXT, is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER)"""
SIGNALS_DDL = """CREATE TABLE IF NOT EXISTS jev_chat_signals (msg_id INTEGER, name TEXT, chat_kind TEXT,
  mentioned_player TEXT, question TEXT, probability REAL, evaluated_at TEXT)"""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src_path = os.path.join(self.tmp.name, 'chat.db')
        self.out_path = os.path.join(self.tmp.name, 'league_chat.sqlite')
        self.src = make_chat_db(self.src_path)
        patch = mock.patch.multiple(elc, SRC=self.src_path, OUT=self.out_path)
        patch.start(); self.addCleanup(patch.stop)
        quiet = mock.patch('builtins.print')
        self.printed = quiet.start(); self.addCleanup(quiet.stop)
        with sqlite3.connect(self.out_path) as out:
            out.execute("CREATE TABLE participants (handle TEXT PRIMARY KEY, name TEXT, dm_chat_id INTEGER)")
            out.execute("INSERT INTO participants VALUES ('+15550000001', 'Alice', 2)")

    def tearDown(self):
        self.src.close(); self.tmp.cleanup()

    def stored(self):
        with sqlite3.connect(self.out_path) as out:
            return out.execute("SELECT msg_id, name FROM messages ORDER BY msg_id").fetchall()

    def printed_text(self):
        return ' '.join(' '.join(map(str, c.args)) for c in self.printed.call_args_list)


class TestExtract(Base):
    def test_rowid_resume_is_idempotent(self):
        add_msg(self.src, 10, 1, 1, 'a')
        elc.extract(); elc.extract()
        self.assertEqual(self.stored(), [(10, 'Alice')])

    def test_a_renamed_group_exits_nonzero(self):
        self.src.execute("UPDATE chat SET display_name = 'Transfer league 2026 (old)' WHERE ROWID = 1")
        self.src.commit()
        with self.assertRaises(SystemExit):
            elc.extract()

    def test_group_message_from_an_unknown_handle_is_kept_and_reported(self):
        add_msg(self.src, 10, 1, 1, 'from phone')
        add_msg(self.src, 11, 2, 1, 'same person, new handle')
        add_msg(self.src, 12, 1, 1, 'from phone again')
        elc.extract()
        self.assertEqual(self.stored(), [(10, 'Alice'), (11, None), (12, 'Alice')],
                         'the unknown-handle row is stored unnamed, not dropped below the resume watermark')
        self.assertIn('1 from a handle not in participants', self.printed_text())

    def test_an_unnamed_row_is_named_once_its_handle_is_added(self):
        add_msg(self.src, 10, 1, 1, 'from phone')
        add_msg(self.src, 11, 2, 1, 'same person, new handle')
        elc.extract()
        with sqlite3.connect(self.out_path) as out:
            out.execute("INSERT INTO participants VALUES ('alice@example.com', 'Alice', 2)")
        self.assertEqual(elc.extract(), 0)
        self.assertEqual(self.stored(), [(10, 'Alice'), (11, 'Alice')])

    def test_env_overrides_the_database_paths(self):
        with mock.patch.dict(os.environ, {'LEAGUE_CHAT_SRC': '/tmp/a.db', 'LEAGUE_CHAT_OUT': '/tmp/b.sqlite'}):
            src, out = elc.default_paths()
        self.assertEqual((src, out), ('/tmp/a.db', '/tmp/b.sqlite'))


class TestClassify(Base):
    def test_a_failed_classifier_run_is_reported_as_a_failure(self):
        fail = subprocess.CompletedProcess(args=[], returncode=1, stdout='', stderr='Error: gateway 503')
        with mock.patch('subprocess.run', return_value=fail):
            self.assertEqual(elc.classify(), 1)

    def test_main_exits_nonzero_after_the_rollup_when_classify_fails(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        with mock.patch.object(elc, 'classify', return_value=1), \
             mock.patch.object(elc, 'rollup') as rollup, \
             mock.patch.object(sys, 'argv', ['extract_league_chat.py', '--classify', '--rollup']):
            with self.assertRaises(SystemExit) as stop:
                elc.main()
        self.assertNotEqual(stop.exception.code, 0)
        rollup.assert_called_once()

    def test_classify_runs_for_an_unlabeled_backlog_even_with_no_new_rows(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        elc.extract()          # stored, never classified
        with mock.patch.object(elc, 'classify', return_value=0) as classify, \
             mock.patch.object(sys, 'argv', ['extract_league_chat.py', '--classify']):
            elc.main()         # no new rows this time
        classify.assert_called_once()

    def test_no_backlog_and_no_new_rows_skips_the_classifier(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        elc.extract()
        with sqlite3.connect(self.out_path) as out:
            out.execute("CREATE TABLE jev_chat_done (msg_id INTEGER PRIMARY KEY, evaluated_at TEXT, input_tokens INTEGER, ok INTEGER, error TEXT)")
            out.execute("INSERT INTO jev_chat_done VALUES (10, 'x', 1, 1, NULL)")
        with mock.patch.object(elc, 'classify', return_value=0) as classify, \
             mock.patch.object(sys, 'argv', ['extract_league_chat.py', '--classify']):
            elc.main()
        classify.assert_not_called()


class TestRollup(Base):
    def rollup_night_share(self, ts_utc):
        with sqlite3.connect(self.out_path) as out:
            out.execute("DROP TABLE IF EXISTS messages"); out.execute(MESSAGES_DDL); out.execute(SIGNALS_DDL)
            out.execute("INSERT INTO messages VALUES (1,'group',?,'h','Alice',0,?,'hello',0,0)", (GROUP, ts_utc))
        elc.rollup()
        with sqlite3.connect(self.out_path) as out:
            return out.execute("SELECT night_share FROM manager_chat_profile WHERE name='Alice'").fetchone()[0]

    def test_night_is_midnight_to_5am_eastern_across_daylight_saving(self):
        for ts_utc, want, local in [
            ('2026-09-18 01:00:00', 0.0, '21:00 EDT, evening'),
            ('2026-09-18 04:00:00', 1.0, '00:00 EDT'),
            ('2026-09-18 06:00:00', 1.0, '02:00 EDT'),
            ('2026-09-18 10:00:00', 0.0, '06:00 EDT'),
            ('2026-01-15 05:00:00', 1.0, '00:00 EST'),
            ('2026-01-15 07:00:00', 1.0, '02:00 EST'),
            ('2026-01-15 10:30:00', 1.0, '05:30 EST (hours 0-5 are night)'),
            ('2026-01-15 11:00:00', 0.0, '06:00 EST'),
        ]:
            with self.subTest(local=local):
                self.assertEqual(self.rollup_night_share(ts_utc), want, local)

    def test_unnamed_rows_are_left_out_of_every_profile(self):
        with sqlite3.connect(self.out_path) as out:
            out.execute(MESSAGES_DDL); out.execute(SIGNALS_DDL)
            out.execute("INSERT INTO messages VALUES (1,'group',?,'h','Alice',0,'2026-09-18 16:00:00','hi',0,0)", (GROUP,))
            out.execute("INSERT INTO messages VALUES (2,'group',?,'x',NULL,0,'2026-09-18 16:01:00','who dis',0,0)", (GROUP,))
        elc.rollup()
        with sqlite3.connect(self.out_path) as out:
            names = [r[0] for r in out.execute("SELECT name FROM manager_chat_profile")]
        self.assertEqual(names, ['Alice'])


class TestDecodeAttributedBody(unittest.TestCase):
    HEAD = (b'\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject'
            b'\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+')

    def test_one_byte_and_two_byte_length_prefixes(self):
        for text in ['hi', 'x' * 127, 'y' * 128, 'z' * 300, 'emoji \U0001F3C8 ok']:
            raw = text.encode('utf-8')
            ln = bytes([len(raw)]) if len(raw) < 0x80 else b'\x81' + len(raw).to_bytes(2, 'little')
            with self.subTest(n=len(raw)):
                self.assertEqual(elc.decode_attributed_body(self.HEAD + ln + raw + b'\x86\x84'), text)

    def test_a_truncated_blob_does_not_raise(self):
        self.assertIsNone(elc.decode_attributed_body(b'NSString\x01\x94\x84\x01+'))
        self.assertIsNone(elc.decode_attributed_body(None))


if __name__ == '__main__':
    unittest.main(verbosity=2)
