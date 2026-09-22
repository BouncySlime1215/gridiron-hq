# An accept-list entry that has outlived its reason

RED `19b5bdd` · GREEN `31c2a52` · baseline `0377e1f` · map `dec9e60`
`test/wiring-map-stale-accept-entries.test.js`, 7 cases.

## How this was found

Not by inspection. CI on PR #108 went red with 11 blocking findings while
`npm run check:wiring` on the same commit exited 0 locally. Two facts explain
the gap and both matter on their own:

1. **`check:wiring` is not inside `npm run check`.** `package.json` defines
   `check` as `typecheck && lint && test && build && start:smoke`. The wiring
   gate is a separate CI step (`.github/workflows/ci.yml:69`). The pre-push
   guard runs `npm run check`, so it has never once run this gate. Two clean
   guard runs on `1ac9d618` said nothing about it.
2. **CI runs the merge commit, not the head.** GitHub Actions checks out
   `merge(branch, base)` on a `pull_request` event. The branch's merge-base was
   `654ff93`; main had moved to `1a13614` carrying #91 and #89.

Reproduced exactly by building that merge in a worktree: exit 1, the same 11.

## Are the 11 mine?

No, and that was checked rather than assumed. All four modules and the table
were verified on `origin/main` **alone**, with this branch out of the picture:

| subject | on main alone |
| --- | --- |
| `roster-risk.js` | imported by nothing |
| `trend-watch.js` | imported by nothing |
| `week-postmortem.js` | imported by nothing |
| `position-liquidity.js` | imported only by `test/pick-reasoning.test.js` |
| `league_draft_picks` | no `INSERT` outside a test |

The gate itself does not exist on main — `scripts/wiring-map.mjs` is absent
there and `check:wiring` is not in main's `package.json`. So these 11 are main's
state, surfaced for the first time by a gate arriving on top of it. That is the
case `GRANDFATHERED`'s own comment describes: *"a gate that is red the moment it
arrives gets switched off."* They are baselined in `annotations.json` with an
owner and a retirement condition each, and every one stays a finding in the map.

## The defect this unit closes

Baselining 11 entries makes the list 23 feeds and 50 modules long. The file
already knew what happens next, under `_PERMANENT_ORPHAN_REASONS._why`:

> If the condition is met and the module is still listed, that is a defect in
> this file, not in the module.

Nothing checked it. The gate reported one half — an entry naming a file that is
not in the tree — and nothing at all about the half that actually happens: the
module gets wired, the finding the entry silenced leaves the run, and the entry
stays behind reading as a live decision nobody has revisited.

`staleOrphanEntries` answers both from the run's own findings:

```js
if (!exists(entry)) { out.push({ entry, why: 'names a file that is not in this tree' }); continue; }
if (!silences(entry)) out.push({ entry, why: 'the module is wired now — this entry silences nothing' });
```

**The retirement condition is exact, not a heuristic.** "Does anything import it
now" was the obvious version and it is wrong: a module can gain an importer and
still reach no surface, which is `module-reaches-no-surface` — a different rule
in the same family, still correctly silenced by the same entry. Asking whether
any orphan-family finding still names the entry gets both cases right.

Measured before it was written, on the pre-merge tree: 46 entries, 1 file gone,
**0 silencing nothing**. Zero false positives; every present entry is earning
its line today.

Report, never gate, and never un-silence — the posture the file-not-in-tree half
already had. Turning the finding back on in the same run would fail the build
for a module that is now correctly wired.

## The five questions

- **Well built?** One pure exported function, two conditions, called once from
  the gate. It replaced an inline expression that answered half the question.
- **Stats or made up?** Measured. 46 entries scanned on the real tree before the
  code was written; 1 stale by the old rule, 0 additional by the new one.
- **How do we know?** The 11 were verified on `origin/main` by direct grep, not
  taken from the gate that reports them. The CI failure was reproduced locally
  by reconstructing the merge commit, and the gate now exits 0 on it.
- **Pointed anywhere else on the platform?** Yes, twice. Any gate whose baseline
  is taken at a merge-base goes red when the base moves — this will recur on
  every long branch. And `npm run check` not covering `check:wiring` means the
  pre-push guard is blind to a gate CI enforces; anything added to `ci.yml` and
  not to `check` has the same hole.
- **How does it unify?** Same shape as the three reachability defects on this
  branch: a list written for one moment, consulted at another, with nothing
  measuring the distance between them. `boot:` and `CLOSE_HOPS` froze a constant
  past the question it answered; this froze a decision past the tree it was
  about.
