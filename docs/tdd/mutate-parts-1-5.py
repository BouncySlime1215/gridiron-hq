#!/usr/bin/env python3
"""
Re-run of the Parts 1-5 mutations to the Part 6 evidence standard.

Every row records the LITERAL string replaced and the LITERAL string written
back, sha256(file)[0:16] before and after, and the test titles that failed.
A row whose two hashes match made no edit and its suite is not run: a stale
pattern that silently matches nothing is the failure mode this guards, because
its green suite reads exactly like a caught mutation.

Run from the repo root:  python3 docs/tdd/mutate-parts-1-5.py
"""
import hashlib, json, re, shutil, subprocess, sys, tempfile, os

ARCH = 'server/services/manager-archetypes.js'
BLUF = 'server/services/bluff-detector.js'
SYNC = 'server/services/league-chat-sync.js'
PYEX = 'scripts/chat/extract_league_chat.py'

JS_ARCH = ['test/archetype-as-of.test.js']
JS_CHAT = ['test/wiring-absent-states.test.js', 'test/chat-age.test.js',
           'test/league-chat-sync.test.js', 'test/chat-block-wiring.test.js']
PY_SUITE = ['scripts/chat/test_extract_league_chat.py']

LS_Q = """const [ls] = rows(`SELECT COUNT(*) AS n, MAX(computed_at) AS as_of FROM manager_archetypes
                     WHERE league_id = ? AND season = ? AND version = ?`,
  leagueId, season, MANAGER_ARCHETYPE_VERSION);"""

SPEC = [
 # --- Part 1 -------------------------------------------------------------
 ('A1', ARCH, JS_ARCH, 'const [ls] = rows(`SELECT COUNT(*) AS n, MAX(computed_at)',
                       'const [ls] = rows(`SELECT COUNT(*) AS n, MIN(computed_at)', 'caught'),
 ('A2', ARCH, JS_ARCH, """      built: builtBlock(leagueId, season, ls, career, priced, stale,
        jevBy.get(t.espn_member_id) ?? { n: 0, as_of: null }),""",
                       '      built: undefined,', 'caught'),
 ('A3', ARCH, JS_ARCH, '  CAREER_LEAGUE, CAREER_SEASON, MANAGER_ARCHETYPE_VERSION);',
                       '  leagueId, season, MANAGER_ARCHETYPE_VERSION);', 'caught'),
 ('A4', ARCH, JS_ARCH, '    as_of: ls.as_of ?? null,',
                       '    as_of: ls.as_of ?? career.as_of ?? null,', 'caught'),
 ('A5', ARCH, JS_ARCH, "    reason: gaps.length ? gaps.join('; ') : null,",
                       '    reason: null,', 'caught'),
 ('A6', ARCH, JS_ARCH, LS_Q,
  LS_Q.replace('WHERE league_id = ? AND season = ? AND version = ?',
               'WHERE (league_id = ? OR 1=1) AND version = ?')
      .replace('  leagueId, season, MANAGER_ARCHETYPE_VERSION);',
               '  leagueId, MANAGER_ARCHETYPE_VERSION);'), 'caught'),
 ('A7', ARCH, JS_ARCH, '  if (jev) { out.jev_as_of = jev.as_of ?? null; out.jev_answers = jev.n; }',
                       '  if (jev) { out.jev_as_of = ls.as_of ?? null; out.jev_answers = jev.n; }', 'caught'),
 ('A8', ARCH, JS_ARCH, '        jevBy.get(t.espn_member_id) ?? { n: 0, as_of: null }),',
                       '        [...jevBy.values()][0] ?? { n: 0, as_of: null }),', 'caught'),
 ('A9', ARCH, JS_ARCH, '    built_by: ARCHETYPE_BUILDER,', '    built_by: null,', 'caught'),
 ('A10', ARCH, JS_ARCH,
  """  const { ls, career, priced, stale } = builtStamps(leagueId, season);
  const jevBy = new Map(""",
  """  const { career, priced, stale } = builtStamps(leagueId, season);
  const [ls] = rows(`SELECT COUNT(*) AS n, MIN(computed_at) AS as_of FROM manager_archetypes
                     WHERE league_id = ? AND season = ? AND version = ?`,
  leagueId, season, MANAGER_ARCHETYPE_VERSION);
  const jevBy = new Map(""", 'caught'),
 # --- Part 2 -------------------------------------------------------------
 ('B1', ARCH, JS_ARCH, '  leagueId, season, MANAGER_ARCHETYPE_VERSION, ...PRICED_SOURCES);',
                       '  CAREER_LEAGUE, CAREER_SEASON, MANAGER_ARCHETYPE_VERSION, ...PRICED_SOURCES);', 'caught'),
 ('B2', ARCH, JS_ARCH, '    priced_as_of: priced.as_of ?? null,',
                       '    priced_as_of: priced.as_of ?? ls.as_of ?? null,', 'caught'),
 ('B3', ARCH, JS_ARCH, "export const PRICED_SOURCES = Object.freeze(['draft', 'outcome']);",
                       "export const PRICED_SOURCES = Object.freeze(['draft']);", 'caught'),
 ('B4', ARCH, JS_ARCH, 'WHERE league_id = ? AND season = ? AND version = ? AND source IN (',
                       'WHERE (league_id = ? OR 1=1) AND (season = ? OR 1=1) AND version = ? AND source IN (', 'caught'),
 ('B5', ARCH, JS_ARCH, '  if (ls.n && !priced.n) {', '  if (false && !priced.n) {', 'caught'),
 # --- Part 4 (same file) -------------------------------------------------
 ('D1', ARCH, JS_ARCH, '    stale_version_rows: stale.n,', '    stale_version_rows: 0,', 'caught'),
 ('D2', ARCH, JS_ARCH, '  if (!ls.n && stale.n) {', '  if (false && stale.n) {', 'caught'),
 ('D3', ARCH, JS_ARCH, "      + `${stale.n} row${stale.n === 1 ? '' : 's'} from ${stale.versions ?? 'an earlier version'} `",
                       "      + `${stale.n} row${stale.n === 1 ? '' : 's'} from an earlier build `", 'caught'),
 ('D4', ARCH, JS_ARCH, '                        WHERE league_id = ? AND season = ? AND version <> ?`,',
                       '                        WHERE league_id = ? AND season = ? AND (version <> ? OR 1=1)`,', 'caught'),
 # --- Part 3 -------------------------------------------------------------
 ('C1', ARCH, JS_CHAT, "export const RUN_SHEET_ONLY_METRICS = Object.freeze(['capital_hhi']);",
                       'export const RUN_SHEET_ONLY_METRICS = Object.freeze([]);', 'caught'),
 ('C2', ARCH, JS_CHAT, "export const RUN_SHEET_ONLY_METRICS = Object.freeze(['capital_hhi']);",
                       "export const RUN_SHEET_ONLY_METRICS = Object.freeze(['capital_hhi', 'homer_top_team_share']);", 'caught'),
 ('C3', ARCH, JS_CHAT, "  'The archetype build replays every league-season and the Jev pass calls a paid gateway per manager, '",
                       "  'The archetype build replays every league-season and the Jev pass runs, '", 'caught'),
 ('C4', BLUF, JS_CHAT, '    return { byManager: new Map(), events: [], available: false, reason: NO_CORPUS_REASON() };',
                       '    return { byManager: new Map(), events: [], available: false };', 'caught'),
 ('C5', BLUF, JS_CHAT, '  `No chat corpus at ${chatDbPath()}. It is extracted from Apple Messages on Nick\'s Mac and cannot be `',
                       '  `No chat corpus. It is extracted from Apple Messages on Nick\'s Mac and cannot be `', 'caught'),
 ('C6', BLUF, JS_CHAT, '  + \'produced on this machine, so this is "not on this machine", not "nobody has said anything".\';',
                       "  + 'read right now.';", 'caught'),
 ('C7', SYNC, JS_CHAT, '    path: chatDbPath(),\n    corpus: stats,', '    corpus: stats,', 'caught'),
 ('C8', SYNC, JS_CHAT, "      note: `Nothing at ${where}.${carried}${source} The corpus is extracted from Apple Messages on the Mac `",
                       "      note: `Nothing at ${where}.${carried}${source} The corpus is unavailable `", 'caught'),
 # --- Part 5 -------------------------------------------------------------
 ('E1', SYNC, JS_CHAT, "db.prepare('SELECT MAX(ts_utc) AS m FROM messages')",
                       "db.prepare('SELECT MAX(sent_at) AS m FROM messages')", 'caught'),
 ('E2', SYNC, JS_CHAT, '    out.newest_message_error = `messages.ts_utc is not readable on this corpus: ${String(e?.message ?? e)}`;',
                       '    out.newest_message_error = undefined;', 'caught'),
 ('E3', SYNC, JS_CHAT, "    out.newest_message = isoStamp(db.prepare('SELECT MAX(ts_utc) AS m FROM messages').get()?.m);",
                       "    out.newest_message = db.prepare('SELECT MAX(ts_utc) AS m FROM messages').get()?.m ?? null;", 'caught'),
 ('E4', SYNC, JS_CHAT, '    out.computed_at = isoStamp(r?.c);', '    out.computed_at = null;', 'caught'),
 ('E5', SYNC, JS_CHAT, "    ? `pulled on this machine ${isoStamp(pull.finished_at)}`\n    : (age || hasData ? 'uploaded, not pulled here' : null);",
                       "    ? `pulled on this machine ${isoStamp(pull.finished_at)}`\n    : null;", 'caught'),
 ('E6', SYNC, JS_CHAT, 'SUPERSEDED-BY-PART-6-M1', '', 'superseded'),
 ('E7', SYNC, JS_CHAT, 'export const STATE_MAPPING = Object.freeze({\n  file_not_on_this_machine:',
                       'export const STATE_MAPPING = Object.freeze({\n  removed_by_mutation: 1,\n  x_file_not_on_this_machine:', 'caught'),
 ('E8', PYEX, PY_SUITE, "    return (APPLE_EPOCH + timedelta(seconds=v)).strftime(ISO)",
                        "    return (APPLE_EPOCH + timedelta(seconds=v)).strftime('%Y-%m-%d %H:%M:%S')", 'caught'),
 ('E9', PYEX, PY_SUITE, '    normalise_stamps(out)', '    pass  # normalise_stamps(out)', 'caught'),
 ('E10', PYEX, PY_SUITE, "f\"WHERE {col} IS NOT NULL AND {col} NOT LIKE '%T%' AND length({col}) = 19\")",
                         'f"WHERE {col} IS NOT NULL")', 'caught'),
 ('E11', PYEX, PY_SUITE, "        return (datetime.fromisoformat(ts_utc.replace('T', ' ').rstrip('Z'))",
                         '        return (datetime.fromisoformat(ts_utc)', 'caught'),
 # --- Controls -----------------------------------------------------------
 ('CTRL-NOOP', ARCH, JS_ARCH, 'out.rolled_up_at = isoStamp(',
                              'out.rolled_up_at = null;', 'no edit expected'),
 ('CTRL-GREEN', ARCH, JS_ARCH, 'export const ARCHETYPE_BUILDER =',
                               'export const ARCHETYPE_BUILDER = // control: comment-only\n',
                               'survive expected'),
]

def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:16]

def run_suite(files, py):
    if py:
        r = subprocess.run([sys.executable] + files, capture_output=True, text=True)
        titles = re.findall(r'^(FAIL|ERROR): (\S+)', r.stderr, re.M)
        return r.returncode == 0, [t[1] for t in titles]
    r = subprocess.run(['node', '--test'] + files, capture_output=True, text=True)
    titles = re.findall(r'^not ok \d+ - (.+)$', r.stdout, re.M)
    return r.returncode == 0, titles

out = []
for mid, path, suite, frm, to, expect in SPEC:
    backup = shutil.copy(path, tempfile.mktemp())
    try:
        before = sha(path)
        src = open(path).read()
        if frm not in src:
            out.append(dict(id=mid, file=path, frm=frm, to=to, before=before, after=before,
                            result='NO EDIT — pattern absent, suite not run', titles=[], expect=expect))
            continue
        open(path, 'w').write(src.replace(frm, to, 1))
        after = sha(path)
        if after == before:
            out.append(dict(id=mid, file=path, frm=frm, to=to, before=before, after=after,
                            result='HASH UNCHANGED — edit was a no-op', titles=[], expect=expect))
            continue
        green, titles = run_suite(suite, path.endswith('.py'))
        out.append(dict(id=mid, file=path, frm=frm, to=to, before=before, after=after,
                        result='SURVIVED' if green else f'caught, {len(titles)}',
                        titles=titles, expect=expect))
    finally:
        shutil.copy(backup, path); os.unlink(backup)

for f in {ARCH, BLUF, SYNC, PYEX}:
    print(f'restored {f} -> {sha(f)}', file=sys.stderr)
json.dump(out, open('/tmp/claude-0/mp/rows.json', 'w'), indent=1)
for r in out:
    print(f"{r['id']:11} {r['before']} -> {r['after']}  {r['result']}")
    for t in r['titles'][:6]: print(f"                FAILED: {t}")
