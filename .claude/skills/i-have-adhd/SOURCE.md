# Source

Vendored verbatim from https://github.com/ayghri/i-have-adhd
(`skills/i-have-adhd/SKILL.md`), MIT licensed — upstream licence kept as
`LICENSE.upstream`. Cloned 2026-09-19.

Vendored rather than installed from the marketplace so that every session
picks it up: cloud sessions do not share the Mac's `~/.claude`, and an
uninstalled marketplace skill silently does nothing.

The rules are also restated in the repository's root `CLAUDE.md`, because
`CLAUDE.md` is loaded automatically and this skill is not — its frontmatter
carries `disable-model-invocation: true`, so on its own it only fires when
someone types `/i-have-adhd`.

To update: re-clone upstream and diff. Do not edit this copy in place.
