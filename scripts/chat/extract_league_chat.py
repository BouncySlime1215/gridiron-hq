#!/usr/bin/env python3
"""
Incremental iMessage extractor for the league-chat profile work.

Scope is fixed and narrow: the "Transfer league 2026" group chat and the 1:1 DM
threads with its nine members (from `participants` in the private DB). Nothing
else in ~/Library/Messages/chat.db is ever read. Nick: "no the chats to read are
with transfer league 2026 and all the people in that league."

Modes
  --full          rebuild `messages` from scratch (keeps `participants`)
  (default)       incremental: only rows with ROWID > MAX(msg_id) already stored
  --classify      after extracting, run the Jev classifier on unlabeled rows
  --rollup        recompute per-manager chat profile tables from the labels

Run it whenever the laptop is on (Nick, 2026-09-17: "have it backfill chats when
the laptop is on — and then rediagnose the new ones and add it to our database
of player profiles"). Safe to run every minute; it is idempotent.

Requires Full Disk Access for the terminal/Claude (already granted). Output DB
`data/derived/league_chat.sqlite` is gitignored and never leaves the machine
except message text sent to Jev under standard retention (Nick's choice).
"""
import argparse, os, sqlite3, subprocess, sys, time
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GROUP_NAME = 'Transfer league 2026'
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
# The league's clock. "Night" in the profile means midnight to 6am here, not in UTC.
LEAGUE_TZ = ZoneInfo('America/New_York')


def default_paths():
    """chat.db and the output DB; LEAGUE_CHAT_SRC / LEAGUE_CHAT_OUT point a smoke run at copies."""
    src = os.environ.get('LEAGUE_CHAT_SRC') or os.path.expanduser('~/Library/Messages/chat.db')
    out = os.environ.get('LEAGUE_CHAT_OUT') or os.path.join(ROOT, 'data', 'derived', 'league_chat.sqlite')
    return src, out


SRC, OUT = default_paths()


def apple_ts(ns):
    """chat.db dates are nanoseconds since 2001-01-01 UTC (older rows: seconds)."""
    if ns is None: return None
    v = ns / 1e9 if ns > 1e11 else ns
    return (APPLE_EPOCH + timedelta(seconds=v)).strftime('%Y-%m-%d %H:%M:%S')


def decode_attributed_body(blob):
    """
    Pull the plain string out of a typedstream `attributedBody`. Layout after the
    literal `NSString` marker: 0x01 0x94 0x84 0x01 0x2B then a length — one byte,
    or 0x81 followed by a little-endian uint16 — then that many UTF-8 bytes.
    """
    if not blob: return None
    i = blob.find(b'NSString')
    if i < 0: return None
    j = blob.find(b'+', i)
    if j < 0 or j + 1 >= len(blob): return None  # truncated: no length byte
    k = j + 1
    ln = blob[k]
    if ln == 0x81:
        ln = int.from_bytes(blob[k + 1:k + 3], 'little'); k += 3
    elif ln == 0x82:
        ln = int.from_bytes(blob[k + 1:k + 5], 'little'); k += 5
    else:
        k += 1
    try:
        return blob[k:k + ln].decode('utf-8', 'replace')
    except Exception:
        return None


def open_dbs():
    out = sqlite3.connect(OUT)
    out.execute("""CREATE TABLE IF NOT EXISTS messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT,
                   handle TEXT, name TEXT, is_from_me INTEGER, ts_utc TEXT, text TEXT,
                   is_tapback INTEGER, is_reply INTEGER)""")
    out.execute("CREATE UNIQUE INDEX IF NOT EXISTS messages_msg_id ON messages(msg_id)")
    out.execute("CREATE TABLE IF NOT EXISTS participants (handle TEXT PRIMARY KEY, name TEXT, dm_chat_id INTEGER)")
    out.execute("CREATE TABLE IF NOT EXISTS extract_runs (ran_at TEXT, mode TEXT, new_rows INTEGER, max_msg_id INTEGER)")
    if 'unknown_handle' not in [c[1] for c in out.execute("PRAGMA table_info(extract_runs)")]:
        out.execute("ALTER TABLE extract_runs ADD COLUMN unknown_handle INTEGER")
    src = sqlite3.connect(f'file:{SRC}?mode=ro', uri=True)
    return src, out


def scope(src, out):
    """chat.ROWIDs in scope: every chat row for the group + each member's DM chat."""
    group_ids = [r[0] for r in src.execute("SELECT ROWID FROM chat WHERE display_name = ?", (GROUP_NAME,))]
    parts = {h: (n, c) for h, n, c in out.execute("SELECT handle, name, dm_chat_id FROM participants")}
    dm_ids = {c: n for (n, c) in parts.values() if c}
    if not group_ids or not dm_ids:
        sys.exit('scope not found: group chat or participants missing — run the one-off setup first')
    return group_ids, dm_ids, parts


def extract(full=False):
    src, out = open_dbs()
    group_ids, dm_ids, parts = scope(src, out)
    handle_name = {h: n for h, (n, _) in parts.items()}
    # handle.ROWID -> handle id string (phone/email) -> name
    hid_to_handle = {r[0]: r[1] for r in src.execute("SELECT ROWID, id FROM handle")}
    since = 0 if full else (out.execute("SELECT COALESCE(MAX(msg_id),0) FROM messages").fetchone()[0] or 0)
    if full: out.execute("DELETE FROM messages")
    # A group row stored unnamed (its handle was not in participants yet) gets its name
    # as soon as the handle is added; the resume watermark means it is never re-read.
    out.execute("""UPDATE messages SET name = (SELECT p.name FROM participants p WHERE p.handle = messages.handle)
                   WHERE name IS NULL AND is_from_me = 0 AND handle IN (SELECT handle FROM participants)""")
    chat_ids = list(group_ids) + list(dm_ids.keys())
    q = f"""
      SELECT m.ROWID, cmj.chat_id, m.handle_id, m.is_from_me, m.date, m.text, m.attributedBody,
             m.associated_message_type, m.thread_originator_guid
      FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id IN ({','.join('?' * len(chat_ids))}) AND m.ROWID > ?
      ORDER BY m.ROWID"""
    new = 0; unknown = 0; max_id = since
    for rowid, chat_id, hid, from_me, date, text, body, assoc, thread in src.execute(q, chat_ids + [since]):
        txt = text if text else decode_attributed_body(body)
        if txt is not None: txt = txt.replace('￼', '￼')  # keep placeholder as-is; classifier filters it
        is_group = chat_id in group_ids
        handle = hid_to_handle.get(hid)
        if from_me:
            name = 'ME'
        elif is_group:
            # A member texting from a new number or Apple ID. Stored unnamed rather than
            # skipped: skipping put the row below the resume watermark for good. Unnamed
            # rows are never classified or profiled until the handle is in participants.
            name = handle_name.get(handle)
            if name is None: unknown += 1
        else:
            name = dm_ids[chat_id]
        out.execute("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (rowid, 'group' if is_group else 'dm', GROUP_NAME if is_group else dm_ids[chat_id],
                     handle, name, 1 if from_me else 0, apple_ts(date), txt,
                     1 if (assoc or 0) >= 2000 else 0, 1 if thread else 0))
        new += 1; max_id = max(max_id, rowid)
    out.execute("INSERT INTO extract_runs (ran_at, mode, new_rows, max_msg_id, unknown_handle) VALUES (?,?,?,?,?)",
                (datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S'), 'full' if full else 'incremental', new, max_id, unknown))
    out.commit(); src.close(); out.close()
    note = (f', {unknown} from a handle not in participants (stored unnamed until the handle is added)'
            if unknown else '')
    print(f'extract: {new} new message(s), max msg_id {max_id}{note}')
    return new


def unlabeled_backlog():
    """Named, non-empty rows the classifier has not evaluated yet."""
    out = sqlite3.connect(OUT)
    try:
        done = out.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jev_chat_done'").fetchone()
        return out.execute(f"""SELECT COUNT(*) FROM messages m
            {'LEFT JOIN jev_chat_done d ON d.msg_id = m.msg_id' if done else ''}
            WHERE {'d.msg_id IS NULL AND' if done else ''} m.name IS NOT NULL
              AND m.text IS NOT NULL AND trim(replace(m.text, char(65532), '')) <> ''""").fetchone()[0]
    finally:
        out.close()


def classify():
    """Label unlabeled rows with the existing Jev classifier (standard retention, Nick's choice)."""
    env = dict(os.environ)
    for f in ('.env', '.env.local'):
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            for line in open(p):
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1); env.setdefault(k, v.strip().strip('"'))
    r = subprocess.run(['npx', 'tsx', 'scripts/news-line/jev_league_chat.mts'], cwd=ROOT, env=env,
                       capture_output=True, text=True, timeout=3600)
    tail = [l for l in (r.stdout + r.stderr).splitlines() if l.strip()][-2:]
    status = '' if r.returncode == 0 else f'FAILED (exit {r.returncode}) '
    print('classify:', status + (' | '.join(tail) if tail else f'exit {r.returncode}'))
    return r.returncode


def league_hour(ts_utc):
    """Hour on the league's clock for a stored UTC stamp ('T' or space separated), or None."""
    try:
        return datetime.fromisoformat(ts_utc).replace(tzinfo=timezone.utc).astimezone(LEAGUE_TZ).hour
    except (TypeError, ValueError):
        return None


def rollup():
    """
    Per-manager chat profile from the Jev labels. Two tables, rebuilt each run:
      manager_chat_profile — one row per person (volume, tone mix, confidence, trade posture)
      manager_player_sentiment — (person, player) ledger with mean sentiment, n, first/last date
    These are the chat half of Phase 4b; the transaction half joins on `name`.
    """
    out = sqlite3.connect(OUT)
    # ts_utc is UTC; night_share is midnight-6am on the league's clock, DST included.
    # strftime('%H', ts_utc) alone scored 8pm-2am Eastern as "night".
    out.create_function('league_hour', 1, league_hour, deterministic=True)
    out.executescript("""
      DROP TABLE IF EXISTS manager_chat_profile;
      CREATE TABLE manager_chat_profile AS
      WITH base AS (
        SELECT m.msg_id, m.name, m.chat_kind, m.ts_utc, m.is_tapback,
               league_hour(m.ts_utc) AS hr
        FROM messages m WHERE m.name IS NOT NULL
          AND m.text IS NOT NULL AND trim(replace(m.text, char(65532), '')) <> ''
      ),
      sig AS (SELECT msg_id, question, probability FROM jev_chat_signals)
      SELECT b.name,
             COUNT(*)                                                       AS msgs,
             SUM(b.chat_kind = 'group')                                     AS group_msgs,
             SUM(b.is_tapback)                                              AS tapbacks,
             ROUND(AVG(b.hr BETWEEN 0 AND 5), 3)                            AS night_share,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'topic.trade_talk')), 3)      AS p_trade_talk,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'topic.trash_talk')), 3)      AS p_trash_talk,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'topic.non_fantasy')), 3)     AS p_non_fantasy,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'confidence.mean')), 3)       AS confidence_mean,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'tone.competitive')), 3)      AS p_competitive,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'tone.friendly')), 3)         AS p_friendly,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'tone.defensive')), 3)        AS p_defensive,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'open_to_trade')), 3)         AS p_open_to_trade,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'reacting_to_loss')), 3)      AS p_reacting_to_loss,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'own_roster.complaining')), 3) AS p_own_complaining,
             ROUND(AVG((SELECT probability FROM sig WHERE sig.msg_id = b.msg_id AND question = 'own_roster.untouchable')), 3) AS p_own_untouchable,
             MIN(b.ts_utc) AS first_msg, MAX(b.ts_utc) AS last_msg,
             datetime('now') AS computed_at
      FROM base b GROUP BY b.name;

      DROP TABLE IF EXISTS manager_player_sentiment;
      CREATE TABLE manager_player_sentiment AS
      SELECT s.name, s.mentioned_player AS player,
             COUNT(*) AS n,
             ROUND(AVG(s.probability), 3) AS sentiment_mean,      -- 0..4 scale: 2 = neutral
             ROUND(AVG(CASE WHEN s.probability >= 3 THEN 1.0 ELSE 0 END), 3) AS share_positive,
             ROUND(AVG(CASE WHEN s.probability <= 1 THEN 1.0 ELSE 0 END), 3) AS share_negative,
             MIN(m.ts_utc) AS first_mention, MAX(m.ts_utc) AS last_mention,
             datetime('now') AS computed_at
      FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
      WHERE s.question = 'player_sentiment.mean' AND s.mentioned_player IS NOT NULL
      GROUP BY s.name, s.mentioned_player;
    """)
    n1 = out.execute("SELECT COUNT(*) FROM manager_chat_profile").fetchone()[0]
    n2 = out.execute("SELECT COUNT(*) FROM manager_player_sentiment").fetchone()[0]
    out.commit(); out.close()
    print(f'rollup: {n1} manager profiles, {n2} (manager, player) sentiment rows')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--classify', action='store_true')
    ap.add_argument('--rollup', action='store_true')
    a = ap.parse_args()
    new = extract(full=a.full)
    failed = 0
    # Also when earlier rows are still unlabeled: classify used to run only on new rows,
    # so a run that failed left its rows unlabeled until someone happened to text.
    if a.classify and (new or a.full or unlabeled_backlog()):
        failed = classify()
    if a.rollup: rollup()
    # The rollup still runs on what is labeled; the loop must still see the failure.
    if failed: sys.exit(f'classify failed (exit {failed})')


if __name__ == '__main__':
    main()
