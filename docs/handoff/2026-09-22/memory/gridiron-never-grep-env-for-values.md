---
name: gridiron-never-grep-env-for-values
description: Never grep an environment for a value — list names only. A presence check turned into a credential disclosure on 2026-09-22; this is the third exposure incident on this project.
metadata:
  type: feedback
---

**Rule: never run a command that can print an environment variable's VALUE.**
CLAUDE.md already says *"Read a value's presence, never its content, into a log
or a message"* — this file is the concrete form of it, because the rule is easy
to agree with and easy to break by reflex.

**Do this** to check presence:

```
env | cut -d= -f1 | grep -i gridiron        # names only
[ -n "${SOME_VAR:-}" ] && echo "SOME_VAR: set"
```

**Never this:**

```
env | grep -i gridiron       # prints NAME=VALUE
echo "$SOME_VAR"
printenv SOME_VAR
env | grep -i 'db_path'      # a broad -i pattern matches values too
```

**Incident, 2026-09-22 ~08:22Z, model-evidence-audit thread.** Looking for a
database path, the thread ran `env | grep -i 'GRIDIRON\|DB_PATH'` and printed
two live credentials into its session transcript: **`GRIDIRON_FLY_TOKEN`** and
**`GRIDIRON_ANTHROPIC_API_KEY`** (names recorded here; values are not written
anywhere). No network call used either value, nothing reached disk or the repo,
and the push made just before it scanned clean for secret-shaped strings — the
exposure is to the transcript, which CLAUDE.md counts as burned.

**Escalated to Nick as threat-level-10** (his own list names "secret changes,
security incidents"). Rotation is his word; no session may rotate on its own.
Recommendation given: Fly token first, as it is deploy-capable against the live
app, then the Anthropic key, then confirm both.

**The pattern is the finding, not the slip.** This is the **third** exposure
incident across **three credentials** on this project, and **zero rotations have
ever been confirmed** ([[gridiron-open-risks]]). An unrotated exposure does not
decay, so these accumulate: every earlier exposed credential is still live
unless someone has rotated it. **Any session that learns a rotation has happened
should record it in [[gridiron-open-risks]] immediately**, because the missing
half of this loop is the confirmation, not the detection.

**Why the reflex is dangerous specifically.** The intent was a presence check on
an unrelated variable, and a broad `-i` pattern turned it into a disclosure.
`grep` over `env` output cannot distinguish "does this name exist" from "show me
the secret" — the output format is `NAME=VALUE` either way. So the fix is not
"grep more carefully", it is **never grep env output at all**; strip to names
first with `cut -d= -f1`.
