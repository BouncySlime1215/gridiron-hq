# ARCHITECTURE.md, generated so it cannot drift (plan item 40)

RED `c772cf6a` · GREEN follows · `test/architecture-map.test.js`, 14 cases.

## RED

`node --test test/architecture-map.test.js` failed with
`ERR_MODULE_NOT_FOUND: Cannot find module scripts/architecture-map.mjs`: the generator did not exist.

## GREEN

`scripts/architecture-map.mjs` writes `docs/ARCHITECTURE.md` from three inputs:

1. `plans-schema.js` (`SECTIONS`, `OPTIONAL_SECTIONS`, `SOURCE_IDS`), read live;
2. `docs/architecture/registry.json`, the hand-kept half: one producer per section, per source id and per core
   number, each a `file#symbol` that must exist;
3. a scan of `server/` and `scripts/` (tests excluded) for `GRIDIRON_*` names, classified switch / setting / secret
   by name. Names only; no value is read.

What the tests hold:

- the committed page equals the generator's output on today's tree (the drift gate CI runs via `npm test`);
- the registry covers `SECTIONS` and `SOURCE_IDS` exactly: a missing section, a stale source, a renamed symbol or a
  deleted file each fail with the name of what broke;
- `resolveRef` accepts exported functions, consts and re-exports, and refuses a symbol that only appears in a comment;
- the flag scan skips tests, lists every reader file, and marks files that also read preview mode;
- the page carries flag names and never `NAME=value`.

`node --test test/architecture-map.test.js`: 14 pass, 0 fail.
