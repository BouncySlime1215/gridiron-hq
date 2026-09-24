"""BROKEN-Q mutation sweep. Run from repo root: python3 docs/tdd/2026-09-24-broken-q-news-stamps/mutants.py
Each mutant edits one file, runs test/news-stamps.test.js, restores the file.
'killed' = the file fails; 'survived' = it passes; 'not applied' = the search text is absent."""
import pathlib, subprocess, os

MUTANTS = [
    ('M1 store: revision overwrites ingested_at again (unit)', 'server/news/store.js',
     'const ingestedAt = stamps && existing ? existing.ingested_at', 'const ingestedAt = false ? existing.ingested_at'),
    ('M2 store: revision never stamps edited_at (unit)', 'server/news/store.js',
     'const editedAt = stamps && contentChanged ? normalized.ingested_at : null;', 'const editedAt = null;'),
    ('M3 store: resend stamps edited_at (unit)', 'server/news/store.js',
     'const editedAt = stamps && contentChanged ? normalized.ingested_at : null;', 'const editedAt = stamps ? normalized.ingested_at : null;'),
    ('M4 as-of: edited_at dropped from the knowledge clock (unit)', 'server/news/stamps.js',
     'COALESCE(${p}edited_at, ${p}ingested_at, ${p}created_at)', 'COALESCE(${p}ingested_at, ${p}created_at)'),
    ('M5 as-of: no created_at fallback (unit)', 'server/news/stamps.js',
     'COALESCE(${p}edited_at, ${p}ingested_at, ${p}created_at)', 'COALESCE(${p}edited_at, ${p}ingested_at)'),
    ('M6 as-of: TEXT compare instead of julianday (unit)', 'server/news/stamps.js',
     'return `julianday(COALESCE(${p}edited_at, ${p}ingested_at, ${p}created_at)) <= julianday(?)`;',
     'return `COALESCE(${p}edited_at, ${p}ingested_at, ${p}created_at) <= ?`;'),
    ('M7 flag: unset ignores preview (unit)', 'server/news/stamps.js',
     'return { on: preview, preview };', 'return { on: false, preview };'),
    ('M8 call site: player-state keeps the old clause', 'server/services/nfl-player-state.js',
     "const knownAt = newsStampsFlag().on ? newsKnownAtSql('n') : 'n.ingested_at<=?';", "const knownAt = 'n.ingested_at<=?';"),
    ('M9 call site: expert council keeps the old clause', 'server/services/nfl-expert-council.js',
     "const knownAt = newsStampsFlag().on ? newsKnownAtSql() : 'ingested_at<=?';", "const knownAt = 'ingested_at<=?';"),
    ('M10 call site: ESPN insert passes NULL', 'server/routes/espn.js',
     'JSON.stringify(entities), publishedAt, insertIngestedAt());', 'JSON.stringify(entities), publishedAt, null);'),
    ('M11 call site: manual POST passes NULL', 'server/routes/news.js',
     'fantasy_impact ?? null, importance, source ?? null, insertIngestedAt());', 'fantasy_impact ?? null, importance, source ?? null, null);'),
    ('M12 call site: flag-off ignored, ESPN always stamps', 'server/routes/espn.js',
     'JSON.stringify(entities), publishedAt, insertIngestedAt());', 'JSON.stringify(entities), publishedAt, new Date().toISOString());'),
    # Controls.
    ('C1 designed survivor: preview reason wording (no test reads it)', 'server/news/stamps.js',
     "default off until checked on the local DB'", "default off until checked'"),
    ('C2 designed not-applied: text absent', 'server/news/stamps.js', 'THIS TEXT IS NOT IN THE FILE', 'x'),
]

env = dict(os.environ, SCHEDULER_DISABLED='1', NODE_OPTIONS='--import ./test/offline-guard.mjs')
for label, path, find, repl in MUTANTS:
    p = pathlib.Path(path); src = p.read_text()
    if find not in src:
        print(f'{label}: not applied'); continue
    p.write_text(src.replace(find, repl, 1))
    try:
        r = subprocess.run(['node', '--experimental-test-module-mocks', '--test', 'test/news-stamps.test.js'],
                           env=env, capture_output=True, text=True)
    finally:
        p.write_text(src)
    print(f"{label}: {'killed' if r.returncode else 'survived'}")
