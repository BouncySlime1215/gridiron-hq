"""Tests for scripts/chat/extract_league_chat.py, the league-chat extractor.

The refresh loop (scripts/refresh-live-data.mjs) runs the extractor every 15 minutes,
and its tables feed manager_signals and the negotiation-profile prompts. Until now it
had no tests. Every test here builds a synthetic chat.db and output DB in a temp dir;
no real message is read. stdlib unittest, like research/ (pytest is not installed in
the python3 the loop spawns).

Run from the repo root:  python3 -m unittest discover -s scripts/chat -p 'test_*.py'
"""
import json, os, sqlite3, subprocess, sys, tempfile, unittest
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


DONE_DDL = """CREATE TABLE IF NOT EXISTS jev_chat_done (msg_id INTEGER PRIMARY KEY, evaluated_at TEXT,
  input_tokens INTEGER, ok INTEGER, error TEXT)"""
TONE_ERROR = 'Question "tone" did not select a highest-probability option.'


DONE_DDL_WITH_ATTEMPTS = """CREATE TABLE IF NOT EXISTS jev_chat_done (msg_id INTEGER PRIMARY KEY,
  evaluated_at TEXT, input_tokens INTEGER, ok INTEGER, error TEXT, attempts INTEGER NOT NULL DEFAULT 0)"""


class TestClassifierFailures(Base):
    """
    The classifier marks a message it could not label with jev_chat_done.ok = 0 and
    still exits 0, so the loop logged the run as ok and the rows were never seen
    again (18 such rows on 2026-09-17, all the same deterministic schema error).
    Every run says how many there are, loudly, and ends with one machine-readable
    status line the refresh loop turns into sync_log. A failed row is also re-sent
    while it is under MAX_CLASSIFY_ATTEMPTS (review-fixes-2, finding 3: a gateway
    outage used to park every row it touched for good); only a row that exhausts
    its attempts is given up, and that is said separately.
    """

    def status(self):
        lines = [c.args[0] for c in self.printed.call_args_list
                 if c.args and str(c.args[0]).startswith('league_chat_status ')]
        self.assertEqual(len(lines), 1, 'exactly one status line per run')
        return json.loads(lines[0][len('league_chat_status '):])

    def run_main(self, *flags):
        with mock.patch.object(sys, 'argv', ['extract_league_chat.py', *flags]):
            elc.main()

    def test_failures_in_this_run_are_reported_loudly(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        add_msg(self.src, 11, 1, 1, 'lol')

        def classifier_that_fails_two():
            with sqlite3.connect(self.out_path) as out:
                out.execute(DONE_DDL)
                out.execute("INSERT INTO jev_chat_done VALUES (10, 't', 0, 0, ?)", (TONE_ERROR,))
                out.execute("INSERT INTO jev_chat_done VALUES (11, 't', 0, 0, ?)", (TONE_ERROR,))
            return 0  # the real classifier exits 0 after failing rows

        with mock.patch.object(elc, 'classify', side_effect=classifier_that_fails_two):
            self.run_main('--classify')
        text = self.printed_text()
        self.assertIn('WARNING 2 message(s) failed classification this run', text)
        self.assertIn(TONE_ERROR, text)
        s = self.status()
        self.assertEqual(s['failed_this_run'], 2)
        self.assertEqual(s['failed_outstanding'], 2)
        self.assertEqual(s['failed_retryable'], 2)
        self.assertEqual(s['failed_errors'], {TONE_ERROR: 2})
        self.assertEqual(s['extract_new'], 2)
        self.assertEqual(s['classify'], {'ran': True, 'exit': 0})

    def test_a_failure_with_attempts_left_is_backlog_and_is_re_sent(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        elc.extract()
        with sqlite3.connect(self.out_path) as out:
            out.execute(DONE_DDL_WITH_ATTEMPTS)
            out.execute("INSERT INTO jev_chat_done VALUES (10, 't', 0, 0, ?, 1)", (TONE_ERROR,))
        self.assertEqual(elc.unlabeled_backlog(), 1)
        with mock.patch.object(elc, 'classify', return_value=0) as classify:
            self.run_main('--classify')
        classify.assert_called_once()  # the row is re-sent while it has attempts left
        s = self.status()
        self.assertEqual(s['failed_outstanding'], 1)
        self.assertEqual(s['failed_retryable'], 1)
        self.assertEqual(s['failed_given_up'], 0)

    def test_a_row_that_exhausted_its_attempts_is_not_re_sent_but_is_reported_every_run(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        elc.extract()
        with sqlite3.connect(self.out_path) as out:
            out.execute(DONE_DDL_WITH_ATTEMPTS)
            out.execute("INSERT INTO jev_chat_done VALUES (10, 't', 0, 0, ?, ?)",
                        (TONE_ERROR, elc.MAX_CLASSIFY_ATTEMPTS))
        self.assertEqual(elc.unlabeled_backlog(), 0)
        with mock.patch.object(elc, 'classify', return_value=0) as classify:
            self.run_main('--classify')
        classify.assert_not_called()  # no paid retry once the attempts are spent
        s = self.status()
        self.assertEqual(s['failed_this_run'], 0)
        self.assertEqual(s['failed_outstanding'], 1)
        self.assertEqual(s['failed_given_up'], 1)
        self.assertEqual(s['classify'], {'ran': False, 'exit': None})
        text = self.printed_text()
        self.assertIn('given up', text)
        self.assertIn(TONE_ERROR, text)

    def test_a_pre_attempts_table_is_read_as_one_attempt_used(self):
        # The live table predates the attempts column: those 18 rows get their retries.
        add_msg(self.src, 10, 1, 1, 'trade?')
        elc.extract()
        with sqlite3.connect(self.out_path) as out:
            out.execute(DONE_DDL)
            out.execute("INSERT INTO jev_chat_done VALUES (10, 't', 0, 0, ?)", (TONE_ERROR,))
        self.assertEqual(elc.unlabeled_backlog(), 1)

    def test_python_and_the_classifier_agree_on_the_attempt_limit(self):
        mts = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(elc.__file__))),
                           'news-line', 'jev_league_chat.mts')
        with open(mts) as fh:
            source = fh.read()
        self.assertIn(f'MAX_ATTEMPTS = {elc.MAX_CLASSIFY_ATTEMPTS}', source)

    def test_a_clean_run_still_prints_the_status_line(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        self.run_main()
        s = self.status()
        self.assertEqual((s['extract_new'], s['failed_this_run'], s['failed_outstanding']), (1, 0, 0))
        self.assertNotIn('WARNING', self.printed_text())

    def test_the_status_line_is_printed_before_a_failing_exit(self):
        add_msg(self.src, 10, 1, 1, 'trade?')
        with mock.patch.object(elc, 'classify', return_value=1), \
             mock.patch.object(sys, 'argv', ['extract_league_chat.py', '--classify']):
            with self.assertRaises(SystemExit):
                elc.main()
        self.assertEqual(self.status()['classify'], {'ran': True, 'exit': 1})


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
            ('2025-08-16T06:54:14', 1.0, 'stored with a T separator, 02:54 EDT'),
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


class IsoStamps(unittest.TestCase):
    """Every stamp this script writes is ISO 8601 UTC.

    The manager card puts the chat corpus's as_of next to the transactions'
    and the archetype build's, and both of those are new Date().toISOString().
    SQLite's 'YYYY-MM-DD HH:MM:SS' does not compare or sort against ISO: 'T'
    is 0x54 and a space is 0x20, so any ISO row wins over every legacy row
    whatever its date.
    """

    ISO = '%Y-%m-%dT%H:%M:%SZ'

    def test_message_timestamps_are_iso(self):
        # 2026-09-19T14:03:22Z as nanoseconds since the Apple epoch.
        from datetime import datetime, timezone
        target = datetime(2026, 9, 19, 14, 3, 22, tzinfo=timezone.utc)
        ns = int((target - elc.APPLE_EPOCH).total_seconds() * 1e9)
        self.assertEqual(elc.apple_ts(ns), '2026-09-19T14:03:22Z')
        self.assertIsNone(elc.apple_ts(None))

    def test_run_stamp_is_iso(self):
        from datetime import datetime
        datetime.strptime(elc.now_iso(), self.ISO)  # raises if it is not

    def test_league_hour_reads_both_formats(self):
        # A corpus mid-migration holds either, and fromisoformat only accepts a
        # 'Z' suffix from Python 3.11 while the Mac running this may be older.
        self.assertEqual(elc.league_hour('2026-09-19T06:30:00Z'),
                         elc.league_hour('2026-09-19 06:30:00'))

    def _corpus(self, path, stamp):
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE messages (msg_id INTEGER, ts_utc TEXT)')
        db.execute('CREATE TABLE extract_runs (ran_at TEXT)')
        db.execute('INSERT INTO messages VALUES (1, ?)', (stamp,))
        db.execute('INSERT INTO extract_runs VALUES (?)', (stamp,))
        db.commit()
        return db

    def test_normalise_brings_a_legacy_corpus_up_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            db = self._corpus(os.path.join(d, 'c.sqlite'), '2026-09-19 14:03:22')
            elc.normalise_stamps(db)
            self.assertEqual(db.execute('SELECT ts_utc FROM messages').fetchone()[0],
                             '2026-09-19T14:03:22Z')
            self.assertEqual(db.execute('SELECT ran_at FROM extract_runs').fetchone()[0],
                             '2026-09-19T14:03:22Z')
            # Twice must be the same as once, or a second pull corrupts the file.
            elc.normalise_stamps(db)
            self.assertEqual(db.execute('SELECT ts_utc FROM messages').fetchone()[0],
                             '2026-09-19T14:03:22Z')
            db.close()

    def test_normalise_leaves_an_already_iso_corpus_alone(self):
        with tempfile.TemporaryDirectory() as d:
            db = self._corpus(os.path.join(d, 'c.sqlite'), '2026-09-19T14:03:22Z')
            elc.normalise_stamps(db)
            self.assertEqual(db.execute('SELECT ts_utc FROM messages').fetchone()[0],
                             '2026-09-19T14:03:22Z')
            db.close()

    def test_the_extract_run_normalises_before_it_inserts(self):
        # normalise_stamps() being correct is not the same as it being called.
        # If the run skips it, a corpus pulled before this change ends up
        # holding both formats and MAX(ts_utc) returns the newest ISO row
        # rather than the newest row.
        import extract_league_chat as m
        with tempfile.TemporaryDirectory() as d:
            out_path = os.path.join(d, 'league_chat.sqlite')
            src_path = os.path.join(d, 'chat.db')
            src = make_chat_db(src_path)
            with mock.patch.multiple(m, SRC=src_path, OUT=out_path), mock.patch('builtins.print'):
                with sqlite3.connect(out_path) as out:
                    out.execute('CREATE TABLE participants (handle TEXT PRIMARY KEY, name TEXT, dm_chat_id INTEGER)')
                    out.execute("INSERT INTO participants VALUES ('+15550000001', 'Alice', 2)")
                    out.execute('CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, '
                                'handle TEXT, name TEXT, is_from_me INTEGER, ts_utc TEXT, text TEXT, '
                                'is_tapback INTEGER, is_reply INTEGER)')
                    # A legacy row from a pull made before this change.
                    out.execute("INSERT INTO messages (msg_id, ts_utc) VALUES (1, '2026-09-19 14:03:22')")
                add_msg(src, 10, 1, 1, 'new one')
                m.extract()
                with sqlite3.connect(out_path) as out:
                    legacy = out.execute('SELECT ts_utc FROM messages WHERE msg_id = 1').fetchone()[0]
            src.close()
        self.assertEqual(legacy, '2026-09-19T14:03:22Z',
                         'the run inserted new ISO rows beside an un-normalised legacy row')

    def test_league_hour_works_where_fromisoformat_rejects_a_z_suffix(self):
        # Python before 3.11 raises on a trailing 'Z', and the Mac that runs
        # this script may be older than the box these tests run on.
        from datetime import datetime as real_datetime

        class Pre311(real_datetime):
            @classmethod
            def fromisoformat(cls, value):
                if value.endswith('Z'):
                    raise ValueError(f'Invalid isoformat string: {value!r}')
                return real_datetime.fromisoformat(value)

        with mock.patch.object(elc, 'datetime', Pre311):
            self.assertEqual(elc.league_hour('2026-09-19T06:30:00Z'), elc.league_hour('2026-09-19 06:30:00'))

    def test_normalise_survives_a_corpus_without_the_rollup_tables(self):
        # manager_chat_profile and manager_player_sentiment only exist after a
        # rollup has run; a first pull must not fail on their absence.
        with tempfile.TemporaryDirectory() as d:
            db = self._corpus(os.path.join(d, 'c.sqlite'), '2026-09-19 14:03:22')
            elc.normalise_stamps(db)  # must not raise
            db.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
