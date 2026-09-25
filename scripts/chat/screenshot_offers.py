#!/usr/bin/env python3
"""
SCREENSHOT-OFFERS: read ESPN trade screenshots posted in the league chat, on this Mac only.

Scope is the extractor's own scope and nothing wider: image attachments in the league
group chat and in Nick's 1:1 DMs with the people in `participants` (the league-mates).
Nothing else in ~/Library/Messages/chat.db is read, and chat.db is opened read-only.

Per image, once (idempotent on the attachment guid, table `screenshot_ocr_done`):
  1. OCR with Apple's Vision framework (scripts/chat/ocr_images.swift), run under
     sandbox-exec with the network denied whenever sandbox-exec exists.
  2. classify the screen: offer | finalize | accepted | declined | hypothetical | block,
     or not a trade screen at all;
  3. parse the two teams and the players on each side, map teams to (league_id, roster_id)
     and players to players.id / espn_id with fuzzy matching, and score the parse;
  4. write the parse to `screenshot_trades` (confidence below MIN_CONFIDENCE => needs_review).

PRIVACY. Nothing here opens a socket or calls a model: the OCR is on-device, the parse is
string matching against the local app DB (opened read-only). OCR text is stored only in the
gitignored chat DB (`screenshot_ocr_done.ocr_json`, for a human to review a needs_review row)
and is never printed: every line this script prints is a count. The OCR text is never put
in `messages`, so the Jev classifier (the one networked step of extract_league_chat.py)
never sees it.

The ledger half (trade_outcomes rows with source 'observed_screenshot') is
scripts/chat/feed_screenshot_offers.mjs, which goes through server/services/trade-outcomes.js.
"""
import argparse, difflib, hashlib, json, os, re, shutil, sqlite3, subprocess, sys, unicodedata
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OCR_SWIFT = os.path.join(HERE, 'ocr_images.swift')
GROUP_NAME = 'Transfer league 2026'
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
ISO = '%Y-%m-%dT%H:%M:%SZ'

# A parse at or above this confidence may feed the ledger; below it the row is needs_review.
MIN_CONFIDENCE = 0.70
KINDS = ('offer', 'finalize', 'accepted', 'declined', 'hypothetical', 'block')
LEDGER_KINDS = ('offer', 'finalize', 'accepted', 'declined')
IMAGE_EXT = ('.png', '.jpg', '.jpeg', '.heic', '.heif', '.webp', '.tif', '.tiff')
OCR_BATCH = 16
# Network denied for the OCR child. `(allow default)` keeps file reads (the images, Vision's
# models) working; `(deny network*)` refuses every socket, local or remote.
SANDBOX_PROFILE = '(version 1)(allow default)(deny network*)'
SANDBOX_EXEC = '/usr/bin/sandbox-exec'


def apple_ts(ns):
    if ns is None: return None
    v = ns / 1e9 if ns > 1e11 else ns
    return (APPLE_EPOCH + timedelta(seconds=v)).strftime(ISO)


def now_iso():
    return datetime.now(timezone.utc).strftime(ISO)


def season_of(ts):
    """NFL season a UTC stamp falls in: March onward is that year's season, Jan-Feb the previous one."""
    d = datetime.strptime(ts[:10], '%Y-%m-%d')
    return d.year if d.month >= 3 else d.year - 1


# ----------------------------------------------------------------------------- schema

OCR_DONE_DDL = """CREATE TABLE IF NOT EXISTS screenshot_ocr_done (
  attachment_guid TEXT PRIMARY KEY, msg_id INTEGER, chat_kind TEXT, poster TEXT, posted_at TEXT,
  state TEXT NOT NULL,            -- ok | missing_file | ocr_error | not_image
  n_lines INTEGER, ocr_confidence REAL, ocr_json TEXT, kind TEXT, is_trade INTEGER,
  engine TEXT, read_at TEXT NOT NULL)"""

TRADES_COLUMNS = [
    ('id', 'INTEGER PRIMARY KEY AUTOINCREMENT'), ('msg_id', 'INTEGER'), ('poster', 'TEXT'), ('posted_at', 'TEXT'),
    ('league_hint', 'TEXT'), ('side_a_team', 'TEXT'), ('side_a_players', 'TEXT'), ('side_b_team', 'TEXT'),
    ('side_b_players', 'TEXT'), ('status', 'TEXT'), ('confidence', 'REAL'), ('notes', 'TEXT'),
    ('matched_tx_id', 'TEXT'), ('match', 'TEXT'),
    # SCREENSHOT-OFFERS columns (ids only)
    ('source', 'TEXT'), ('attachment_guid', 'TEXT'), ('kind', 'TEXT'), ('league_id', 'INTEGER'),
    ('season', 'INTEGER'), ('from_roster', 'INTEGER'), ('to_roster', 'INTEGER'), ('give_ids', 'TEXT'),
    ('get_ids', 'TEXT'), ('proposed_at', 'TEXT'), ('proposed_at_basis', 'TEXT'), ('ocr_confidence', 'REAL'),
    ('needs_review', 'INTEGER'), ('review_reasons', 'TEXT'), ('ledger_state', 'TEXT'), ('ledger_id', 'INTEGER'),
    ('parsed_at', 'TEXT'),
]


def ensure_schema(out):
    """screenshot_ocr_done, and screenshot_trades with an id key and the id columns.

    The R&D table was keyed on msg_id, which cannot hold two screenshots in one message.
    It is rebuilt once with an `id` key; its 19 hand-read rows are copied through
    unchanged (source 'rnd_manual') and are never fed to the ledger.
    """
    out.execute(OCR_DONE_DDL)
    cols = {r[1]: r for r in out.execute("PRAGMA table_info(screenshot_trades)")}
    ddl = 'CREATE TABLE screenshot_trades (' + ', '.join(f'{c} {t}' for c, t in TRADES_COLUMNS) + ')'
    if not cols:
        out.execute(ddl)
    elif 'id' not in cols:
        out.execute('ALTER TABLE screenshot_trades RENAME TO screenshot_trades_rnd')
        out.execute(ddl)
        old = [c for c in cols if c in dict(TRADES_COLUMNS)]
        out.execute(f"INSERT INTO screenshot_trades ({', '.join(old)}, source) "
                    f"SELECT {', '.join(old)}, 'rnd_manual' FROM screenshot_trades_rnd")
        out.execute('DROP TABLE screenshot_trades_rnd')
    else:
        for c, t in TRADES_COLUMNS:
            if c not in cols: out.execute(f'ALTER TABLE screenshot_trades ADD COLUMN {c} {t}')
    out.execute("CREATE UNIQUE INDEX IF NOT EXISTS screenshot_trades_guid ON screenshot_trades(attachment_guid) "
                "WHERE attachment_guid IS NOT NULL")
    out.commit()


# ----------------------------------------------------------------------------- text helpers

SUFFIX = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}
POSITIONS = {'qb', 'rb', 'wr', 'te', 'k', 'dst', 'def', 'd/st', 'flex'}
INJURY = {'q', 'o', 'd', 'ir', 'p', 'sspd', 'pup', 'out', 'questionable', 'doubtful'}


def norm(s):
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(ch for ch in s if not unicodedata.combining(ch)).lower()
    s = s.replace('d/st', 'dst').replace('&', ' and ')
    s = re.sub(r"[’'`]", '', s)
    s = re.sub(r'[^a-z0-9 ]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def name_key(s):
    toks = [t for t in norm(s).split() if t not in SUFFIX]
    return ' '.join(toks)


def ratio(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio() if a and b else 0.0


# ----------------------------------------------------------------------------- league context

class Context:
    """Everything the parse maps onto, read once from the app DB (read-only).

    teams:    (league_id, season) -> {roster_id: {'name': key, 'owner': key}}
    players:  id -> {'key', 'first', 'last', 'pos', 'nfl', 'espn_id', 'relevant'}
    pool:     (league_id, season) -> set of player ids seen on any roster there
    owner_at: (league_id, season) -> [(stamp, {player_id: roster_id})] oldest first
    me:       league_id -> Nick's roster id;  chat_roster: (league_id, chat name) -> roster id
    """

    def __init__(self):
        self.teams, self.players, self.pool, self.owner_at = {}, {}, {}, {}
        self.me, self.chat_roster, self.by_key, self.by_last = {}, {}, {}, {}
        self.nfl_abbr = {}
        # one ESPN member's teams across leagues: a manager renames a team, and the name a
        # screenshot shows can be the one his team in ANOTHER league still has
        self.member, self.member_teams = {}, {}

    def index(self):
        self.by_key, self.by_last = {}, {}
        for pid, p in self.players.items():
            self.by_key.setdefault(p['key'], []).append(pid)
            if p['last']: self.by_last.setdefault(p['last'], []).append(pid)
        return self

    @classmethod
    def load(cls, app_db_path):
        ctx = cls()
        db = sqlite3.connect(f'file:{app_db_path}?mode=ro', uri=True)
        try:
            have = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'nfl_teams' in have:
                ctx.nfl_abbr = {r[0]: (r[1] or '').lower() for r in db.execute('SELECT id, abbr FROM nfl_teams')}
            for pid, name, pos, team_id, espn_id, rel in db.execute(
                    "SELECT id, name, position, team_id, espn_id, fantasy_relevant FROM players "
                    "WHERE position IN ('QB','RB','WR','TE','K','DEF') AND name IS NOT NULL"):
                ctx.add_player(pid, name, pos, ctx.nfl_abbr.get(team_id), espn_id, rel)
            lst_cols = {r[1] for r in db.execute('PRAGMA table_info(league_season_teams)')}
            member_col = 'espn_member_id' if 'espn_member_id' in lst_cols else 'NULL'
            for lid, season, rid, tname, owner, member in db.execute(
                    f'SELECT league_id, season, roster_id, team_name, owner_name, {member_col} FROM league_season_teams'):
                ctx.teams.setdefault((lid, season), {})[rid] = {'name': name_key(tname), 'owner': name_key(owner)}
                if member: ctx.member_teams.setdefault((member, season), {})[lid] = rid; ctx.member[(lid, season, rid)] = member
            for lid, mine in db.execute('SELECT id, my_team_id FROM leagues'):
                if mine is not None: ctx.me[lid] = int(mine)
            if 'league_member_identity' in have:
                for lid, rid, chat_name in db.execute(
                        'SELECT league_id, roster_id, chat_name FROM league_member_identity WHERE chat_name IS NOT NULL'):
                    ctx.chat_roster[(lid, chat_name)] = rid
            espn_to_pid = {p['espn_id']: pid for pid, p in ctx.players.items() if p['espn_id'] is not None}
            snaps = {}
            if 'league_roster_history' in have:
                for lid, season, captured, team, ids in db.execute(
                        'SELECT league_id, season, captured_at, team_id, player_ids_json FROM league_roster_history'):
                    for e in json.loads(ids or '[]'):
                        pid = espn_to_pid.get(int(e)) if str(e).lstrip('-').isdigit() else None
                        if pid is not None: snaps.setdefault((lid, season, captured[:10]), {})[pid] = team
            if 'league_roster_snapshots' in have:
                for lid, season, stamp, team, espn in db.execute(
                        'SELECT league_id, season, first_seen_at, team_id, espn_player_id FROM league_roster_snapshots '
                        'WHERE on_roster = 1 OR on_roster IS NULL'):
                    pid = espn_to_pid.get(espn)
                    if pid is not None: snaps.setdefault((lid, season, (stamp or '')[:10]), {})[pid] = team
            for (lid, season, day), owners in snaps.items():
                ctx.owner_at.setdefault((lid, season), []).append((day, owners))
                ctx.pool.setdefault((lid, season), set()).update(owners)
            for v in ctx.owner_at.values(): v.sort(key=lambda x: x[0])
        finally:
            db.close()
        return ctx.index()

    def add_player(self, pid, name, pos, nfl, espn_id, relevant=1):
        key = name_key(name)
        toks = key.split()
        self.players[pid] = {'key': key, 'first': toks[0] if toks else '', 'last': toks[-1] if toks else '',
                             'pos': (pos or '').lower().replace('def', 'dst'), 'nfl': (nfl or '').lower(),
                             'espn_id': espn_id, 'relevant': relevant or 0}

    def owners(self, league_season, at):
        """{player_id: roster_id} from the latest roster record on or before `at` (else the earliest)."""
        hist = self.owner_at.get(league_season) or []
        if not hist: return {}, 'no_rosters'
        day = (at or '')[:10]
        before = [h for h in hist if h[0] <= day]
        if before:
            merged = {}
            for _, o in before[-3:]: merged.update(o)   # a few records back, latest wins
            return merged, 'as_of'
        return dict(hist[0][1]), 'earliest_after'


# ----------------------------------------------------------------------------- classification

def _any(pats, text):
    return [p for p in pats if re.search(p, text)]


HYPO = [r'trade analy[sz]', r'trade calculator', r'trade evaluator', r'fair trade', r'analy[sz]e (?:this )?trade',
        r'keeptradecut', r'\bktc\b', r'fantasy ?calc', r'\bflock', r'fantasypros', r'value difference',
        r'who wins', r'trade grade', r'win[- ]win', r'trade value chart', r'value adjustment',
        # ESPN's "Trade for <team> | Trade <verb> <team>" two-column comparison: a what-if, never sent
        r'(?m)^\s*trade for\s*$']
BLOCK = [r'trade block', r'trading block', r'on the block']
DECLINED = [r'\bdeclined\b', r'\brejected\b']
ACCEPTED = [r'\baccepted\b', r'trade processed', r'\bprocessed\b', r'trade (?:is )?complete', r'review period',
            r'\bvetoed\b', r'\bexecuted\b', r'league office']
FINALIZE = [r'propose trade', r'send (?:trade )?(?:proposal|offer)', r'\bfinali[sz]e', r'review (?:trade|proposal)',
            r'confirm (?:trade|proposal)', r'submit (?:trade|proposal|offer)', r'add a (?:note|message)',
            r'include a (?:note|message)']
# 'pending' or 'expires' alone is not an offer: a bet slip and a roster page say both.
OFFER = [r'respond by', r'trade proposal', r'trade review', r'trade offer', r'proposed by', r'accept trade',
         r'decline trade', r'counter ?offer', r'offer a counter', r'wants to trade', r'proposal from']
TRADEISH = [r'\btrade', r'\bpropos', r'\breceives?\b', r'\bsends?\b']


def classify(text, n_players, n_teams):
    """-> (kind or None, strength 0..1, hits). Order is the precedence: a calculator that shows
    'accepted' is still hypothetical; a declined screen shows the words of a proposal too."""
    t = text.lower()
    tradeish = bool(_any(TRADEISH, t))
    if _any(HYPO, t) and (tradeish or n_players >= 2):
        return 'hypothetical', 1.0, _any(HYPO, t)
    for kind, pats in (('declined', DECLINED), ('accepted', ACCEPTED), ('finalize', FINALIZE), ('offer', OFFER)):
        hits = _any(pats, t)
        if hits and (tradeish or n_players >= 2):
            return kind, 1.0, hits
    if _any(BLOCK, t):
        return 'block', 1.0, _any(BLOCK, t)
    # Structure alone: two teams and players on the screen, no telling word. Weak, never ledger-grade on its own.
    if n_teams >= 2 and n_players >= 2 and tradeish:
        return 'offer', 0.4, ['structure']
    return None, 0.0, []


# ----------------------------------------------------------------------------- matching

VERB_RECV = re.compile(r'\b(receives?|gets?|acquires?|will receive|incoming|you receive|you get)\b')
VERB_SEND = re.compile(r'\b(sends?|gives?|trades? away|trading away|outgoing|you send|you give|you trade)\b')
RECORD = re.compile(r'\(?\b\d{1,2}-\d{1,2}(?:-\d{1,2})?\b\)?')


def team_candidates(ctx, season):
    return {k: v for k, v in ctx.teams.items() if k[1] == season} or ctx.teams


def match_team_all(ctx, line, season):
    """Every (league_id, season, roster_id, score) this OCR line could name, best first.

    All of them, not the best one: a manager who uses one team name in two leagues makes
    the line ambiguous until the other team on the screen says which league it is."""
    raw = norm(RECORD.sub(' ', line))
    stripped = VERB_RECV.sub(' ', VERB_SEND.sub(' ', raw))
    stripped = re.sub(r'^\s*(?:proposed by|proposal from|offer from|trade from|from|to)\s+', ' ', stripped)
    s = re.sub(r'\s+', ' ', stripped).strip()
    if len(s) < 3: return []
    found = {}
    for (lid, sea), rosters in team_candidates(ctx, season).items():
        for rid, t in rosters.items():
            for label, weight in ((t['name'], 1.0), (t['owner'], 0.9)):
                if not label or len(label) < 3: continue
                if label == s: sc = 1.0
                elif len(label) >= 5 and re.search(r'\b' + re.escape(label) + r'\b', s): sc = 0.95
                else: sc = ratio(s, label)
                sc = round(sc * weight, 3)
                if sc >= 0.85 and sc > found.get((lid, sea, rid), 0): found[(lid, sea, rid)] = sc
    for (lid, sea, rid), sc in list(found.items()):
        member = ctx.member.get((lid, sea, rid))
        for olid, orid in ctx.member_teams.get((member, sea), {}).items() if member else ():
            alias = round(sc * 0.98, 3)
            if alias > found.get((olid, sea, orid), 0): found[(olid, sea, orid)] = alias
    return sorted(((k[0], k[1], k[2], v) for k, v in found.items()), key=lambda m: -m[3])


def match_team(ctx, line, season, league=None):
    """Best (league_id, season, roster_id, score) for one OCR line (within `league` if given), or None."""
    for m in match_team_all(ctx, line, season):
        if league is None or m[:2] == league: return m
    return None


def match_player(ctx, line, pool, next_line=''):
    """Best (player_id, score) for one OCR line, or None. `pool` is the league's rostered ids."""
    key = name_key(line)
    toks = [t for t in key.split() if t not in POSITIONS and t not in INJURY]
    if len(toks) < 2 and not (len(toks) == 1 and toks[0].endswith('dst')):
        return None
    ctx_toks = set(name_key(line + ' ' + (next_line or '')).split())
    cands = []  # (score, pid)

    def add(pids, base):
        for pid in pids:
            p = ctx.players[pid]
            sc = base * (1.0 if pid in pool else 0.8)
            if p['pos'] in ctx_toks: sc += 0.03
            if p['nfl'] and p['nfl'] in ctx_toks: sc += 0.03
            cands.append((min(sc, 1.0), pid))

    for n in (4, 3, 2, 1):
        for i in range(0, max(0, len(toks) - n + 1)):
            k = ' '.join(toks[i:i + n])
            if k in ctx.by_key: add(ctx.by_key[k], 1.0 if n >= 2 else 0.9)
        if cands: break
    if not cands and len(toks) >= 2:
        # "J. Jefferson": initial plus last name, unique within the league pool
        for i in range(len(toks) - 1):
            if len(toks[i]) == 1 and toks[i + 1] in ctx.by_last:
                hits = [pid for pid in ctx.by_last[toks[i + 1]] if ctx.players[pid]['first'][:1] == toks[i]]
                in_pool = [pid for pid in hits if pid in pool]
                if len(in_pool) == 1: add(in_pool, 0.88)
                elif len(hits) == 1: add(hits, 0.8)
    if not cands and len(toks) >= 2:
        # OCR slips ("Jefferscn"): fuzzy, but only against the league pool, and only close ones
        for n in (3, 2):
            for i in range(0, max(0, len(toks) - n + 1)):
                k = ' '.join(toks[i:i + n])
                for pid in pool:
                    r = ratio(k, ctx.players[pid]['key'])
                    if r >= 0.88: cands.append((round(r * 0.95, 3), pid))
            if cands: break
    if not cands: return None
    cands.sort(key=lambda c: (-c[0], -ctx.players[c[1]]['relevant']))
    if len(cands) > 1 and cands[0][0] - cands[1][0] < 0.02 and cands[0][1] != cands[1][1]:
        return (cands[0][1], round(cands[0][0] * 0.7, 3))   # a tie is a guess: scored as one
    return (cands[0][1], round(cands[0][0], 3))


MONTHS = {m: i for i, m in enumerate(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 1)}
DATE_RE = re.compile(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b')


def screen_date(text, posted_at, anchor):
    """First 'Mon DD' after `anchor` (a regex) in the text, as ISO noon UTC in the posting year; or None."""
    m = re.search(anchor + r'[^\n]{0,20}?' + DATE_RE.pattern, text.lower())
    if not m: return None
    mon, day = MONTHS[m.group(m.lastindex - 1)[:3]], int(m.group(m.lastindex))
    year = int(posted_at[:4])
    try:
        d = datetime(year, mon, day, 12, tzinfo=timezone.utc)
    except ValueError:
        return None
    if d > datetime.strptime(posted_at, ISO).replace(tzinfo=timezone.utc) + timedelta(days=10):
        d = d.replace(year=year - 1)
    return d.strftime(ISO)


# ----------------------------------------------------------------------------- the parse

TERMINATOR = re.compile(r'^(?:send a (?:trade )?message|add a (?:note|message)|propose(?: trade)?|cancel(?: trade)?'
                        r'|accept(?: trade)?|decline(?: trade)?|counter(?: trade)?)$')
OWNER_RECEIVES = re.compile(r'(?m)^\s*(?:accept|decline|counter)(?: trade)?\s*$|respond by')
OWNER_PROPOSED = re.compile(r'cancel (?:trade|proposal|offer)|withdraw|awaiting (?:their )?response')


def rows_of(lines, tol=0.012):
    """OCR lines grouped into visual rows (same y), left to right: 'Proposed by' and the team
    beside it are two OCR lines but one sentence."""
    rows = []
    for l in sorted(lines, key=lambda l: (l['y'], l['x'])):
        if rows and abs(rows[-1][0] - l['y']) <= tol: rows[-1][1].append(l)
        else: rows.append([l['y'], [l]])
    return [' '.join(x['text'] for x in sorted(r[1], key=lambda x: x['x'])) for r in rows]


def pick_league(ctx, lines, by_league, season):
    """The (league, season) the screen is in: most distinct teams named, then most players on its rosters."""
    if not by_league: return None
    top = max(len(v) for v in by_league.values())
    tied = [k for k, v in by_league.items() if len(v) == top]
    if len(tied) == 1: return tied[0]
    def votes(k):
        pool = ctx.pool.get(k, set())
        n = 0
        for l in lines:
            m = match_player(ctx, l['text'], pool)
            if m and m[0] in pool and m[1] >= 0.9: n += 1
        return n
    return max(tied, key=lambda k: (votes(k), sum(max(sc for _, sc in v) for v in by_league[k].values())))


def parse_screen(ctx, lines, meta):
    """
    lines: OCR lines [{'text','conf','x','y','w','h'}] (top-left origin, 0..1).
    meta:  {'posted_at', 'poster_name', 'is_from_me'}.
    -> None when this is not a trade screen, else a dict of ids, kind, confidence and review reasons.
    """
    text = '\n'.join(l['text'] for l in lines)
    row_text = '\n'.join(rows_of(lines))
    low = row_text.lower()
    season = season_of(meta['posted_at'])
    reasons = []

    # teams first: a team line is never read as a player (team names pun on players)
    by_league = {}
    for i, l in enumerate(lines):
        for lid, sea, rid, sc in match_team_all(ctx, l['text'], season):
            by_league.setdefault((lid, sea), {}).setdefault(rid, []).append((i, sc))
    league = pick_league(ctx, lines, by_league, season)
    rosters = by_league.get(league, {}) if league else {}
    team_lines = {i for v in rosters.values() for i, _ in v}

    if league:
        pool = ctx.pool.get(league, set())
    else:
        pool = set().union(*[v for k, v in ctx.pool.items() if k[1] == season]) if ctx.pool else set()
    players_all = []
    for i, l in enumerate(lines):
        if i in team_lines: continue
        nxt = lines[i + 1]['text'] if i + 1 < len(lines) else ''
        m = match_player(ctx, l['text'], pool, nxt)
        if m: players_all.append((i, m[0], m[1]))
    if not league and players_all:
        votes = {}
        for _, pid, _ in players_all:
            for k, v in ctx.pool.items():
                if k[1] == season and pid in v: votes[k] = votes.get(k, 0) + 1
        if votes:
            league = max(votes, key=votes.get)
            reasons.append('league_from_players')

    kind, strength, _hits = classify(text + '\n' + row_text, len(players_all), len(rosters))
    if kind is None:
        return None
    rec = {'kind': kind, 'league_id': league[0] if league else None, 'season': league[1] if league else season,
           'from_roster': None, 'to_roster': None, 'give_ids': [], 'get_ids': [], 'status': None,
           'proposed_at': None, 'proposed_at_basis': None,
           'ocr_confidence': round(sum(l.get('conf', 0) for l in lines) / len(lines), 3) if lines else 0.0}
    if kind in ('hypothetical', 'block'):
        rec.update(confidence=round(0.5 * strength + 0.5 * min(1, len(players_all) / 2), 3), needs_review=0,
                   review_reasons=['not_an_offer'])
        return rec

    # headers: a roster's exact-name lines; a line that only CONTAINS the name (a subtitle) is a header
    # only when the roster has no exact line at all
    headers = {}
    for rid, v in rosters.items():
        strong = [i for i, sc in v if sc >= 0.97]
        headers[rid] = strong or [i for i, _ in v]
    ranked = sorted(headers, key=lambda r: (-int(any(sc >= 0.97 for _, sc in rosters[r])), -len(headers[r]), min(headers[r])))
    two = ranked[:2]
    if len(ranked) > 2: reasons.append('more_than_two_teams')

    # the trade card: from the first header (or the top) to the first button line after it
    start = min((i for r in two for i in headers[r]), default=-1)
    end = next((i for i in range(start + 1, len(lines)) if TERMINATOR.match(norm(lines[i]['text']))), len(lines))
    players = [p for p in players_all if start < p[0] < end]

    poster_roster = None
    if league:
        poster_roster = ctx.me.get(league[0]) if meta.get('is_from_me') else ctx.chat_roster.get((league[0], meta.get('poster_name')))
    owner_receives = bool(OWNER_RECEIVES.search(low))
    owner_proposed = kind == 'finalize' or bool(OWNER_PROPOSED.search(low))

    proposer = None
    m = re.search(r'(?:proposed by|proposal from|offer from|trade from)\s+([^\n]+)', low)
    if m and league:
        t = match_team(ctx, m.group(1), season, league)
        if t: proposer = t[2]; rec['proposer_basis'] = 'screen'

    a = two[0] if two else None
    b = two[1] if len(two) > 1 else None
    if b is None and poster_roster is not None and poster_roster != a and (owner_receives or owner_proposed):
        if a is None and proposer is not None and proposer != poster_roster: a = proposer
        if a is not None:
            b = poster_roster; reasons.append('team_from_poster')
    if a is None: reasons.append('teams_not_found')
    elif b is None: reasons.append('one_team_found')

    sides, listing, basis = {}, None, None
    owners, obasis = ({}, None)
    if league:
        at = meta['posted_at'] if kind != 'accepted' else \
            (datetime.strptime(meta['posted_at'], ISO) - timedelta(days=3)).strftime(ISO)
        owners, obasis = ctx.owners(league, at)
    header_lines = sorted((i, r) for r in (a, b) if r in headers for i in headers[r])
    if a is not None and b is not None and len({r for _, r in header_lines}) == 2:
        la = [lines[i] for i in headers[a]]; lb = [lines[i] for i in headers[b]]
        pair = next(((x, y) for x in la for y in lb if abs(x['y'] - y['y']) < 0.03 and abs(x['x'] - y['x']) > 0.2), None)
        side_verb = {}
        for r in (a, b):
            around = ' '.join(lines[j]['text'] for i in headers[r] for j in (i, i + 1) if j < len(lines)).lower()
            if VERB_RECV.search(around): side_verb[r] = 'receives'
            elif VERB_SEND.search(around): side_verb[r] = 'sends'
        for i, pid, sc in players:
            if pair:
                cx = lines[i]['x'] + lines[i]['w'] / 2
                ca = pair[0]['x'] + pair[0]['w'] / 2; cb = pair[1]['x'] + pair[1]['w'] / 2
                rid = a if abs(cx - ca) <= abs(cx - cb) else b
            else:
                above = [r for j, r in header_lines if j < i]
                if not above: continue
                rid = above[-1]
            sides.setdefault(rid, []).append((pid, sc))
        # the rosters' reading: share of players listed under the team that held them
        own = tot = 0
        for rid, lst in sides.items():
            for pid, _ in lst:
                if pid in owners:
                    tot += 1; own += 1 if owners[pid] == rid else 0
        by_rosters = None
        if tot:
            agree = own / tot
            rec['roster_agreement'] = round(agree, 2)
            by_rosters = 'sends' if agree >= 0.75 else 'receives' if agree <= 0.25 else None
        verbs = set(side_verb.values())
        if len(verbs) == 1 and len(side_verb) == 2:
            listing, basis = verbs.pop(), 'verb'
            # rosters read as of the post (or the first capture after it) can be stale, so they only
            # overrule nothing; a flat contradiction from rosters read AS OF the post is sent to review
            if by_rosters and by_rosters != listing and obasis == 'as_of' and tot >= 2:
                reasons.append('verb_rosters_disagree'); listing = None
        elif by_rosters:
            listing, basis = by_rosters, f'rosters_{obasis}'
        else:
            reasons.append('rosters_disagree' if tot else 'no_roster_evidence')
    elif a is not None and b is not None:
        # no header per side (a received offer shows only 'Proposed by'): each player goes to the side
        # whose roster holds him, so the listing is 'sends' by construction
        for i, pid, sc in players:
            if owners.get(pid) in (a, b): sides.setdefault(owners[pid], []).append((pid, sc))
        if sides: listing, basis = 'sends', f'owner_direct_{obasis}'
    if basis: rec['sides_basis'] = basis

    a_list = [p for p, _ in sides.get(a, [])]
    b_list = [p for p, _ in sides.get(b, [])]
    a_sends = a_list if listing == 'sends' else b_list if listing == 'receives' else []
    b_sends = b_list if listing == 'sends' else a_list if listing == 'receives' else []

    # who proposed
    if proposer is None and a is not None and b is not None and poster_roster in (a, b) and owner_receives != owner_proposed:
        proposer = poster_roster if owner_proposed else (b if poster_roster == a else a)
        rec['proposer_basis'] = 'poster_' + ('proposer' if owner_proposed else 'receiver')
    if proposer is None and a is not None and b is not None:
        m2 = re.search(r'([^\n]+?)\s+(?:has\s+)?(?:accepted|declined|rejected)\s+your', low)
        t = match_team(ctx, m2.group(1), season, league) if m2 and league else None
        if t and t[2] in (a, b):
            proposer = b if t[2] == a else a; rec['proposer_basis'] = 'screen'
    if proposer is not None and proposer not in (a, b): proposer = None
    if proposer is None: reasons.append('proposer_unknown')

    if proposer is not None:
        rec['from_roster'], rec['to_roster'] = proposer, (b if proposer == a else a)
        rec['give_ids'] = a_sends if proposer == a else b_sends
        rec['get_ids'] = b_sends if proposer == a else a_sends
    elif a is not None and b is not None:
        rec['from_roster'], rec['to_roster'] = a, b          # unordered: needs_review says so
        rec['give_ids'], rec['get_ids'] = a_sends, b_sends
    rec['status'] = {'offer': 'proposed', 'finalize': 'proposed', 'accepted': 'accepted', 'declined': 'declined'}[kind]

    d = screen_date(text, meta['posted_at'], r'(?:proposed|sent|offered)')
    if d: rec['proposed_at'], rec['proposed_at_basis'] = d, 'screen_date'
    elif kind in ('offer', 'finalize'):
        rec['proposed_at'], rec['proposed_at_basis'] = meta['posted_at'], 'posted_at_upper_bound'
    else:
        rec['proposed_at_basis'] = 'unknown'
        reasons.append('no_proposal_time')

    # confidence: additive, each missing part named in review_reasons
    conf = 0.20 * strength
    if a is not None and b is not None: conf += 0.20
    elif a is not None: conf += 0.05
    matched = [sc for lst in sides.values() for _, sc in lst]
    if a_sends and b_sends: conf += 0.25 * (sum(matched) / len(matched))
    elif a_sends or b_sends: conf += 0.08; reasons.append('one_side_empty')
    else: reasons.append('no_players_on_sides')
    if listing: conf += 0.15
    else: reasons.append('sides_unknown')
    if proposer is not None: conf += 0.10
    if league and matched and all(p in ctx.pool.get(league, set()) for lst in sides.values() for p, _ in lst): conf += 0.10
    elif league and matched: reasons.append('player_not_on_league_rosters')
    unassigned = len(players) - sum(len(v) for v in sides.values())
    if unassigned > 0: conf -= 0.05 * unassigned; reasons.append('unassigned_players')
    if rec['ocr_confidence'] < 0.5: conf -= 0.1; reasons.append('low_ocr_confidence')
    if strength < 1: reasons.append('no_trade_words')
    rec['confidence'] = round(max(0.0, min(1.0, conf)), 3)
    rec['needs_review'] = 1 if (rec['confidence'] < MIN_CONFIDENCE or proposer is None or not listing
                                or strength < 1) else 0
    rec['review_reasons'] = sorted(set(reasons))
    return rec


# ----------------------------------------------------------------------------- OCR runner

def ocr_binary(cache_dir):
    """Compile ocr_images.swift once per source hash with the system swiftc. None if Swift is absent."""
    swiftc = shutil.which('swiftc')
    if not swiftc: return None
    with open(OCR_SWIFT, 'rb') as fh:
        h = hashlib.sha256(fh.read()).hexdigest()[:12]
    os.makedirs(cache_dir, exist_ok=True)
    binp = os.path.join(cache_dir, f'ocr_images-{h}')
    if not os.path.exists(binp):
        r = subprocess.run([swiftc, '-O', OCR_SWIFT, '-o', binp], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f'swiftc failed (exit {r.returncode}); Vision OCR unavailable')
    return binp


def vision_runner(binp):
    def run(paths):
        cmd = [binp, *paths]
        if os.path.exists(SANDBOX_EXEC): cmd = [SANDBOX_EXEC, '-p', SANDBOX_PROFILE, *cmd]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f'OCR child failed (exit {r.returncode})')
        return {x['path']: x for x in json.loads(r.stdout)['results']}
    return run


# ----------------------------------------------------------------------------- the run

def scope_ids(src, out):
    group = [r[0] for r in src.execute('SELECT ROWID FROM chat WHERE display_name = ?', (GROUP_NAME,))]
    dms = [r[0] for r in out.execute('SELECT dm_chat_id FROM participants WHERE dm_chat_id IS NOT NULL')]
    return group, dms


def pending_images(src, out, group, dms):
    ids = group + dms
    if not ids: return []
    q = f"""SELECT a.guid, a.filename, a.mime_type, m.ROWID, cmj.chat_id, m.is_from_me, m.date
            FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN message_attachment_join maj ON maj.message_id = m.ROWID
            JOIN attachment a ON a.ROWID = maj.attachment_id
            WHERE cmj.chat_id IN ({','.join('?' * len(ids))}) AND COALESCE(a.is_sticker, 0) = 0
            ORDER BY m.ROWID"""
    done = {r[0] for r in out.execute('SELECT attachment_guid FROM screenshot_ocr_done')}
    names = dict(out.execute('SELECT msg_id, name FROM messages')) if out.execute(
        "SELECT 1 FROM sqlite_master WHERE name='messages'").fetchone() else {}
    dm_name = {c: n for n, c in out.execute('SELECT name, dm_chat_id FROM participants')}
    res = []
    for guid, fn, mime, rowid, chat, from_me, date in src.execute(q, ids):
        if guid in done: continue
        ext = os.path.splitext(fn or '')[1].lower()
        is_img = (mime or '').startswith('image/') and mime != 'image/gif' or ext in IMAGE_EXT
        kind = 'group' if chat in group else 'dm'
        poster = 'ME' if from_me else (names.get(rowid) if kind == 'group' else dm_name.get(chat))
        res.append({'guid': guid, 'path': os.path.expanduser(fn) if fn else None, 'is_image': is_img,
                    'msg_id': rowid, 'chat_kind': kind, 'is_from_me': from_me, 'poster': poster,
                    'posted_at': apple_ts(date)})
    return res


def run(src_path, out_path, app_db_path, ocr=None, limit=None, log=print):
    """OCR every unread in-scope image once, parse it, store it. Returns counts only."""
    src = sqlite3.connect(f'file:{src_path}?mode=ro', uri=True)
    out = sqlite3.connect(out_path)
    try:
        ensure_schema(out)
        group, dms = scope_ids(src, out)
        todo = pending_images(src, out, group, dms)
        legacy = {r[0] for r in out.execute("SELECT msg_id FROM screenshot_trades WHERE source = 'rnd_manual'")}
        if limit: todo = todo[:limit]
        ctx = Context.load(app_db_path)
        if ocr is None:
            binp = ocr_binary(os.path.join(os.path.dirname(os.path.abspath(out_path)), 'bin'))
            if binp is None: raise RuntimeError('swiftc not found; Vision OCR unavailable')
            ocr = vision_runner(binp)
        c = {'images_seen': len(todo), 'images_read': 0, 'group': 0, 'dm': 0, 'previously_read_by_rnd': 0,
             'missing_file': 0, 'not_image': 0, 'ocr_error': 0, 'trade_screens': 0,
             'by_kind': {k: 0 for k in KINDS}, 'high_confidence': 0, 'needs_review': 0, 'by_league': {}}
        now = now_iso()
        imgs = []
        for it in todo:
            state = None
            if not it['is_image']: state = 'not_image'
            elif not it['path'] or not os.path.exists(it['path']): state = 'missing_file'
            if state:
                c[state] += 1
                out.execute('INSERT OR IGNORE INTO screenshot_ocr_done (attachment_guid, msg_id, chat_kind, poster, '
                            'posted_at, state, read_at) VALUES (?,?,?,?,?,?,?)',
                            (it['guid'], it['msg_id'], it['chat_kind'], it['poster'], it['posted_at'], state, now))
            else:
                imgs.append(it)
        out.commit()
        for k in range(0, len(imgs), OCR_BATCH):
            batch = imgs[k:k + OCR_BATCH]
            results = ocr([it['path'] for it in batch])
            for it in batch:
                r = results.get(it['path']) or {'ok': False, 'error': 'no result'}
                if not r.get('ok'):
                    c['ocr_error'] += 1
                    out.execute('INSERT OR IGNORE INTO screenshot_ocr_done (attachment_guid, msg_id, chat_kind, poster, '
                                'posted_at, state, engine, read_at) VALUES (?,?,?,?,?,?,?,?)',
                                (it['guid'], it['msg_id'], it['chat_kind'], it['poster'], it['posted_at'],
                                 'ocr_error', 'vision', now))
                    continue
                lines = r.get('lines') or []
                c['images_read'] += 1; c[it['chat_kind']] += 1
                if it['msg_id'] in legacy: c['previously_read_by_rnd'] += 1
                rec = parse_screen(ctx, lines, {'posted_at': it['posted_at'], 'poster_name': it['poster'],
                                                 'is_from_me': it['is_from_me']}) if lines else None
                ocr_conf = round(sum(l.get('conf', 0) for l in lines) / len(lines), 3) if lines else None
                out.execute('INSERT OR IGNORE INTO screenshot_ocr_done (attachment_guid, msg_id, chat_kind, poster, '
                            'posted_at, state, n_lines, ocr_confidence, ocr_json, kind, is_trade, engine, read_at) '
                            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            (it['guid'], it['msg_id'], it['chat_kind'], it['poster'], it['posted_at'], 'ok',
                             len(lines), ocr_conf, json.dumps(lines), rec['kind'] if rec else None,
                             1 if rec else 0, 'vision', now))
                if rec:
                    store_trade(out, it, rec, now)
                    c['trade_screens'] += 1; c['by_kind'][rec['kind']] += 1
                    if rec['kind'] in LEDGER_KINDS:
                        if rec['needs_review']: c['needs_review'] += 1
                        else:
                            c['high_confidence'] += 1
                            lk = str(rec['league_id'])
                            c['by_league'][lk] = c['by_league'].get(lk, 0) + 1
            out.commit()
            log(f'screenshot_offers: {min(k + OCR_BATCH, len(imgs))}/{len(imgs)} images read')
        return c
    finally:
        src.close(); out.close()


def store_trade(out, it, rec, now):
    out.execute("""INSERT OR REPLACE INTO screenshot_trades
        (msg_id, poster, posted_at, status, confidence, source, attachment_guid, kind, league_id, season,
         from_roster, to_roster, give_ids, get_ids, proposed_at, proposed_at_basis, ocr_confidence,
         needs_review, review_reasons, notes, parsed_at)
        VALUES (?,?,?,?,?, 'ocr', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (it['msg_id'], it['poster'], it['posted_at'], rec.get('status'), rec['confidence'], it['guid'],
                 rec['kind'], rec['league_id'], rec['season'], rec['from_roster'], rec['to_roster'],
                 json.dumps(rec['give_ids']), json.dumps(rec['get_ids']), rec['proposed_at'],
                 rec['proposed_at_basis'], rec['ocr_confidence'], rec['needs_review'],
                 json.dumps(rec['review_reasons']),
                 json.dumps({k: rec[k] for k in ('sides_basis', 'proposer_basis', 'roster_agreement') if k in rec}) or None, now))


def reparse(out_path, app_db_path):
    """Re-run the parse over stored OCR (no OCR, no chat.db): for a parser change. Counts only."""
    out = sqlite3.connect(out_path)
    try:
        ensure_schema(out)
        ctx = Context.load(app_db_path)
        n = 0
        for guid, msg_id, poster, posted, kind_, lines_json in out.execute(
                "SELECT attachment_guid, msg_id, poster, posted_at, chat_kind, ocr_json FROM screenshot_ocr_done "
                "WHERE state = 'ok'").fetchall():
            lines = json.loads(lines_json or '[]')
            rec = parse_screen(ctx, lines, {'posted_at': posted, 'poster_name': poster, 'is_from_me': poster == 'ME'}) if lines else None
            out.execute('UPDATE screenshot_ocr_done SET kind = ?, is_trade = ? WHERE attachment_guid = ?',
                        (rec['kind'] if rec else None, 1 if rec else 0, guid))
            if rec:
                prev = out.execute('SELECT ledger_state, ledger_id FROM screenshot_trades WHERE attachment_guid = ?', (guid,)).fetchone()
                store_trade(out, {'msg_id': msg_id, 'poster': poster, 'posted_at': posted, 'guid': guid}, rec, now_iso())
                if prev and prev[0]:
                    out.execute('UPDATE screenshot_trades SET ledger_state = ?, ledger_id = ? WHERE attachment_guid = ?',
                                (prev[0], prev[1], guid))
                n += 1
            else:
                out.execute("DELETE FROM screenshot_trades WHERE attachment_guid = ? AND ledger_id IS NULL", (guid,))
        out.commit()
        return n
    finally:
        out.close()


def summary(out_path):
    """Counts only, from what is stored (all runs)."""
    out = sqlite3.connect(f'file:{out_path}?mode=ro', uri=True)
    try:
        q = lambda s: out.execute(s).fetchall()
        return {
            'images_by_state': dict(q("SELECT chat_kind || ':' || state, COUNT(*) FROM screenshot_ocr_done GROUP BY 1")),
            'trade_screens_by_kind': dict(q("SELECT kind, COUNT(*) FROM screenshot_trades WHERE source = 'ocr' GROUP BY 1")),
            'ledger_kinds_high_confidence': q(f"SELECT COUNT(*) FROM screenshot_trades WHERE source = 'ocr' AND needs_review = 0 "
                                              f"AND kind IN {LEDGER_KINDS}")[0][0],
            'ledger_kinds_needs_review': q(f"SELECT COUNT(*) FROM screenshot_trades WHERE source = 'ocr' AND needs_review = 1 "
                                           f"AND kind IN {LEDGER_KINDS}")[0][0],
            'high_confidence_by_league': dict(q(f"SELECT COALESCE(league_id, 'none'), COUNT(*) FROM screenshot_trades "
                                                f"WHERE source = 'ocr' AND needs_review = 0 AND kind IN {LEDGER_KINDS} GROUP BY 1")),
        }
    finally:
        out.close()


def default_app_db():
    return os.environ.get('GRIDIRON_DB_PATH') or os.path.join(ROOT, 'server', 'data.sqlite')


def main(argv=None):
    ap = argparse.ArgumentParser(description='OCR league-chat trade screenshots on this Mac (counts-only output).')
    ap.add_argument('--app-db', default=None, help='app DB, opened read-only (default: $GRIDIRON_DB_PATH or server/data.sqlite)')
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--reparse', action='store_true', help='re-run the parse over stored OCR only')
    a = ap.parse_args(argv)
    sys.path.insert(0, HERE)
    import extract_league_chat as elc
    src, out = elc.default_paths()
    app = a.app_db or default_app_db()
    if a.reparse:
        print('screenshot_offers_reparse ' + json.dumps({'reparsed_trade_rows': reparse(out, app)}))
    else:
        print('screenshot_offers_status ' + json.dumps(run(src, out, app, limit=a.limit)))
    print('screenshot_offers_totals ' + json.dumps(summary(out)))


if __name__ == '__main__':
    main()
