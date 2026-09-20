#!/usr/bin/env python3
"""Mutation run for the league_season_teams absent-state guard, Part 8 standard.

Per row: the literal string replaced, the literal string written back,
sha256(file)[0:16] before and after, the suite it ran, and the test titles that
failed. A row whose hashes match makes no claim. Two controls.
"""
import hashlib, json, os, shutil, subprocess, sys, tempfile, re

ARCH = 'server/services/manager-archetypes.js'
SUITE = ['test/league-history-absent.test.js', 'test/archetype-as-of.test.js',
         'test/wiring-absent-states.test.js']

SPEC = [
 ('F1', "  const [hit] = rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,\n    LEAGUE_HISTORY_TABLE);",
        "  const hit = true;", 'caught'),
 ('F2', '  if (hit) return Object.freeze({ present: true, reason: null, source: LEAGUE_HISTORY_SOURCE });',
        '  if (!hit) return Object.freeze({ present: true, reason: null, source: LEAGUE_HISTORY_SOURCE });', 'caught'),
 ('F3', "      + 'read at all. This is \"we cannot look\", not \"this manager is unknown\".',",
        "      + 'read at all.',", 'caught'),
 ('F4', '  if (!state.present) return Object.freeze({ ...state, byRoster: new Map() });',
        '  if (false) return Object.freeze({ ...state, byRoster: new Map() });', 'caught'),
 ('F5', "  const identity_state = !history.present ? 'table_absent' : (identity ? 'present' : 'no_row');",
        "  const identity_state = identity ? 'present' : 'no_row';", 'caught'),
 ('F6', '  if (!leagueHistoryState().present) return out;', '  if (false) return out;', 'caught'),
 ('F7', '    identity_reason: history.present ? null : history.reason,',
        '    identity_reason: null,', 'caught'),
 ('F8', "  + 'and scripts/backfill-league-history.mjs, which creates the same table for boxes that '",
        "  + 'and a script, '", 'caught'),
 ('F9', "export const LEAGUE_HISTORY_SOURCE =\n  'server/migrations/064_league_history_tables.js (arrives with PR #47; not on main yet) '",
        "export const LEAGUE_HISTORY_SOURCE =\n  'somewhere '", 'caught'),
 ('CTRL-NOOP', 'const cachedLeagueHistoryPresence =', 'const x =', 'no edit expected'),
 ('CTRL-GREEN', '/**\n * Is the table there, right now.', '/**\n * Is the table present, right now.', 'survive expected'),
]

def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()[:16]

out = []
base = sha(ARCH)
print(f'unmutated {ARCH} -> {base}\nsuite: {" ".join(SUITE)}\n')
for mid, frm, to, expect in SPEC:
    bak = shutil.copy(ARCH, tempfile.mktemp())
    try:
        before = sha(ARCH); src = open(ARCH).read()
        if frm not in src:
            r = dict(id=mid, frm=frm, to=to, before=before, after=before,
                     result='NO EDIT — pattern absent, suite not run', titles=[], expect=expect)
        else:
            open(ARCH,'w').write(src.replace(frm, to, 1)); after = sha(ARCH)
            p = subprocess.run(['node','--test']+SUITE, capture_output=True, text=True)
            t = re.findall(r'^not ok \d+ - (.+)$', p.stdout, re.M)
            r = dict(id=mid, frm=frm, to=to, before=before, after=after,
                     result='SURVIVED' if p.returncode == 0 else f'caught, {len(t)}',
                     titles=t, expect=expect)
        out.append(r)
        print(f"{mid:11} {r['before']} -> {r['after']}  {r['result']}")
        for x in r['titles'][:5]: print(f"                FAILED: {x}")
    finally:
        shutil.copy(bak, ARCH); os.unlink(bak)
print(f'\nrestored -> {sha(ARCH)} (matches: {sha(ARCH) == base})')
json.dump(out, open('/tmp/claude-0/mp/f.json','w'), indent=1)
