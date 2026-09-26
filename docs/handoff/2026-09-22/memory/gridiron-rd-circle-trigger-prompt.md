---
name: gridiron-rd-circle-trigger-prompt
description: The R&D circling trigger — deleted for the 05:46Z hold, RE-ARMED 07:13Z as trig_01TmmVb3SUDjmL1ytumBjCMV on Nick's resume order; prompt kept here.
metadata:
  type: project
---

Trigger `trig_01BQGcPUGSh3DBnr8us3cFhX`, name "R&D circle — explore, package,
hand off", cron `14 * * * *`, persistent session
`session_01MZWAai2grAYofLf1AFcQTf` (Data & techniques R&D thread).

**RE-ARMED 2026-09-22 07:13Z** as `trig_01TmmVb3SUDjmL1ytumBjCMV`, cron
`13 * * * *`, same session, on Nick's 07:07:59Z resume order. The prompt was
recreated with three additions learned during the hold: name the file every
number came from, use package-prefixed filenames in the flat shared
`/mnt/project-files`, and the 01:04 push rule stands.

**Was deleted 2026-09-22 ~05:50Z.** Nick's stop order gave usage at 91% as the
reason and said "no more checks"; a trigger whose only purpose is to make this
session work every hour spends exactly what he asked to stop spending. Deleting
is reversible; the prompt is preserved verbatim below. That hold ended at
07:10Z — see [[gridiron-rd-stop-snapshot-2026-09-22-0546z]].

Prompt, verbatim:

> Keep circling on the standing R&D mandate: explore, find, package, hand off, explore again.
>
> Pick up where you left off. One concrete unit per firing:
> 1. Either chase a new free data source, or a technique/ML/statistical/charting idea, or go deeper on a lead already open. Prefer whichever has the best ratio of value to cost right now. Do not re-survey what you have already surveyed.
> 2. Verify everything by actually running it — reachability, row counts, join keys, null rates. No claims from memory, no claims from a page's own prose.
> 3. If it is worth pursuing, clean the data in scratch and produce the package: cleaned file, where it goes in the repo (table, service, wiring point with file:line), how to build the item, and the honest weaknesses. Copy the package to /mnt/project-files.
> 4. Hand the package to the coordinator session (session_01VrUbZ4FowbGMEmwWifU8K3) by claude-code-remote send_message, then immediately start the next unit. Do not wait to see what happens to a handoff.
> 5. Reply in-thread only when there is a real result, a blocker, or something only Nick can do. Otherwise refresh the status checklist and keep going.
>
> Hard rules that do not move: nothing paid, ever — a free API key is fine to ask Nick for, a subscription or paid dataset is logged as missing data instead. Nothing committed, nothing pushed, no PRs, no deploys. One editor per server file: new files are fine to prototype in scratch, edits to existing files are the coordinator's routing call, not yours.
>
> Open leads: Sharp Football advanced box scores (WordPress site, has a /wp-json REST API worth probing); Footballguys team game logs; the Kaggle notebook-source endpoints (kernels/pull and kernels/scriptcontent) which expose every Big Data Bowl winner's actual code for free — six years of methods nobody here has read yet.
