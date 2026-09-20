# `server/routes/leagues.js`: the two-import merge conflict, and its resolution

Two separate bodies of work each add one import to the top of
`server/routes/leagues.js`, and neither branch contains the other. Whichever
merges second hits a conflict. This file exists so that the person who hits it
does not have to stop and work out whether it is safe.

Recorded here rather than only in the merge order because the file is this
thread's under the one-editor rule, so the record belongs beside the file.

## The two sides

- **The league-sync credential work.** `fetchEspn` stops reading
  `espn_s2`/`swid` off the `leagues` row and resolves through the shared
  credential resolver instead. It adds
  `import { requireCredentialsForLeague } from '../platform/espn-credentials.js';`
  and changes nineteen lines inside `fetchEspn`.
- **The league outlook route work.** A new `GET /api/leagues/:id/outlook`
  serves the Team Outlook panel. It adds
  `import { leagueOutlook } from '../services/league-outlook.js';`
  and twenty-three lines, all additions, and touches nothing else in the file.

Named as bodies of work rather than as pull request numbers on purpose. The
outlook commits are being folded into the outlook consumer's pull request, so
the numbers on either side of this conflict change at the fold; the work does
not.

## Why it conflicts

Neither stack contains the other. The outlook stack descends from `main` and
**not** from the credential resolver's branch, so git has no common ancestor in
which either import already exists, and both land at the same position in the
import block.

The outlook stack changes nothing else in this file — measured, not assumed:

```
$ git diff --numstat origin/main..803074d -- server/routes/leagues.js
(no output)
```

So the twenty-three lines on that side are this thread's three commits alone.
The credential side is `19 1` on the same measure. The two regions are far
apart in the file and git merges them without help; the import block is the
only collision.

## The resolution: keep both

```js
import { requireCredentialsForLeague } from '../platform/espn-credentials.js';
import { leagueOutlook } from '../services/league-outlook.js';
```

There is no judgement in it. The two imports are independent, neither shadows
the other, and the order between them does not matter. Anything beyond keeping
both lines is not this conflict and should come back to this thread.

## Verified, not assumed

Trial-merged in a throwaway worktree — `git merge` of the outlook route work's
head `6851a71` into the credential work's head `a2e7f97` — resolved by keeping
both lines, then checked. Every figure below is from **that merged tree**, not
from this branch, which is why the file count is higher than a check run here
reports: the merged tree carries both sides' added files.

- `node --check server/routes/leagues.js` — clean.
- The repository's own lint — clean, 902 JavaScript files on that merged tree.
- Both features still present and intact afterwards: `requireCredentialsForLeague`
  at `:139`, inside `fetchEspn`; the outlook route at `:449`.
- `git diff --name-only --diff-filter=U` after the merge listed
  `server/routes/leagues.js` and nothing else, so no other file conflicted.

The worktree was removed. Nothing was committed or pushed from it, and no
branch on either side was modified to produce this record.

## The five questions

- **Is it well built?** It is a record, not code. What makes it worth keeping
  is that it converts a red stop into two keystrokes.
- **Is it based on stats, or made up?** Measured. The conflict was produced by
  an actual `git merge`, not predicted from reading two diffs, and the empty
  `numstat` above is quoted from the command that produced it.
- **How do we know?** Because the resolution was applied and then checked with
  the repository's own tools, and both features were confirmed present at named
  line numbers rather than assumed to have survived.
- **Should this point anywhere else?** Yes — at the merge order, which is where
  somebody will be standing when they meet this. The same facts went there.
- **How does it unify?** One file, one editor, one recorded answer, so the two
  branches that touch it do not each invent their own.
