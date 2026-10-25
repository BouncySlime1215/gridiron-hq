---
name: preserve-a-patch-as-a-parentless-commit
description: /mnt/project-files can become unreadable from any container with df showing nothing wrong, so work living only there must be moved into git — a parentless commit holds a file byte-for-byte and can never be merged by accident.
metadata:
  type: feedback
  modified: 2026-09-22T01:02:37.301Z
---

**The hazard.** `/mnt/project-files` is intermittently unreadable from *any*
container: the mount is present, `df` is unchanged (1.0P, 0 used), and every read
returns an I/O error. Observed 2026-09-20 going from a clean full-file read to
total failure in 116 seconds. **`df` cannot distinguish a working backend from a
dead one here — only a read can.** Nothing fails visibly until something needs the
file.

**Why it matters:** threads park real work there — patch files, evidence tables,
dispatch lists — and other threads hold a sha256 of it. When the backend goes, the
work is gone and the hash is worthless.

**How to apply.** Anything that exists only on that mount goes into git. For a
file that must not join any branch's history, use a parentless commit:

```sh
blob=$(git hash-object -w FILE)
tree=$(printf '100644 blob %s\tFILE\n' "$blob" | git mktree)
commit=$(git commit-tree "$tree" -m "chore: preserve FILE")
git branch -f <thread>/…-mailbox-hold "$commit"
git push -u origin <thread>/…-mailbox-hold
```

Then **verify the round-trip out of the pushed object**, not the local file:
`git show <commit>:FILE | sha256sum` must equal the hash others hold. It costs one
command, keeps the file byte-identical so a published sha256 stays valid, and the
commit has no parent so it merges into nothing and pollutes no diff. Put the
recovery command in the commit message.

Done 2026-09-20 for the jev follow-on mailbox: `060017c` on
`claude/project-thread-3xqh5l-mailbox-hold`, 31,716 bytes, sha256 `433313e94cf6…`
confirmed out of the remote object.

**Do not** put such a file on a branch that has, or will have, a pull request —
see [[gridiron-github-freeze-2026-09-20]]. A no-PR branch push notifies nobody.
Related: [[gridiron-held-branches-2026-09-20]].
