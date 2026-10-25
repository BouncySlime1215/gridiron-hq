# Gridiron Hq

Nick Matta's private project (GitHub BouncySlime1215). Repo https://github.com/BouncySlime1215/gridiron-hq (PUBLIC, no branch protection); live https://gridiron-hq.fly.dev; Express + node:sqlite + React on Fly. Fantasy platform ONLY. Cite file:line on origin/main **b3e7970** (#106, fetched 19:04Z; verify by `git ls-remote`; last measured-green 6e722719); DEPLOYED tree **c5ee3b54** (= #99; everything after is NOT deployed).

## AUTHORITY AS OF 18:58Z 2026-09-22
0. **BUDGET RULE (Nick 18:32:45Z 'two plans at max … get me to half of the week / the reset is monday at 9'; posted 18:47Z):** this plan lasts to **Fri 13:00Z**; 1.4% weekly/hour → **HARD CAP 25% of the 5-hour meter per window, pause at 20%**; five threads, one unit each, sequential merges, no parallel guards, no re-runs, fresh restart after each unit; coordinator: no broadcasts, one note per milestone, memory every 30 min; next lever = three threads, Nick told first [[gridiron-usage-priority-rule]].
0b. **FLEET FREEZE 18:37Z** (Nick 18:29:05Z "now" + screenshot: 5-hour 16% resets in 4h32m, weekly 5%, Fable 5%; ten minutes earlier 9%/3% → ~42%/h on the 5h window, lock in ~2 h): every thread finishes ONLY its in-flight merge, writes a handoff addendum, STOPS; no new units, no new guard runs; auditors quiet; five continuing threads restart fresh ONE AT A TIME after the ~18:45Z reading (restart briefs cancel old PR check-ins/subscriptions [[gridiron-guard-run-hygiene-lesson]]). One exception on Nick's 18:30:22Z word: research-only thread 'Licensed source for refs and coaches' (no data, no PR). Coordinator switch to opus 5.5 requested 18:40Z (Nick 18:30:35Z). Nick 18:31Z: meters were RESET ~18:00Z → 30 min of fleet = 5% of the WEEK, 24/7 impossible on Max 20x; options 1 BURST (recommended) / 2 STEADY / 3 PUSH THROUGH posted 18:42Z, AWAITING HIS PICK + 18:45Z reading [[gridiron-usage-priority-rule]] [[gridiron-threads-directory]].
1. **USAGE MONITORING IS PRIORITY #1** (Nick 18:16:07Z): ledger `/mnt/project-files/USAGE-LEDGER.md`, headline = both meters since the ~18:00Z reset (18:19Z 9%/3% → 18:29Z 16%/5%); usage line opens every post; five threads; skills load only with the `anthropic-skills:` prefix; no subagent for a single API call; opus 5.5 by settings, effort Low/High left as is [[gridiron-usage-priority-rule]].
2. **MERGE GATE v2 + FLEET CUT + RESTART FRESH** (Nick GO 18:05:09Z, 18:06:15Z "ok go"): CI green on the exact head + four-part self-check block (skill `anthropic-skills:gridiron-merge-gate-v2`) → owning thread squash-merges, merges serialised; Independent Auditor for statistical claims only; Evidence Auditor read-only; CONTINUING = Wiring map, Feature audit, Scheduler, Model evidence audit, UI; the rest land and pause; continuing threads restart as fresh sessions from their handoffs once PRs land; one deploy at the end on his word, brake question first [[gridiron-merge-gate-rule]] [[gridiron-restart-fresh-from-handoff-rule]] [[gridiron-threads-directory]].
3. **30-MIN UPDATE + REMOVE MLB** (Nick 17:24Z): trigger trig_011nZZwLvza1AqT2LfYuCFwp fires 18:58Z, +30 each fire; usage line first, then `Waiting on you`; MLB removal = Scheduler's #128, no table drops [[gridiron-30min-update-rule]].
- **FLY_API_TOKEN SET by Nick 18:35:28Z** (fm2_ format ok; if a deploy run fails auth, prepend `FlyV1 `). **Still owed by Nick:** brake on/off ('brake on' recommended); 18:45Z usage reading; BURST/STEADY/PUSH pick; nfldata DROPPED 18:50Z (officials + coaches/referee now from nflverse-data CC BY, credit line extended [[gridiron-nflverse-cc-by-attribution]]); delete Model.tsx + Edge.tsx?; usage screenshot ~19:20Z.
- Full authority text (verbatim, with message ids) [[gridiron-memory-detail-2026-09-22]]; earlier authority [[gridiron-authority-lessons-2026-09-22]] [[gridiron-authority-lessons-2026-09-22-part2]].

## Live app / deploy / dangers
main b3e7970 (#106; 33 merged today incl. #55 #62 #130 #133; #90/#121 union unverified — first suspect if main goes red; tip from `git ls-remote`, never a merge report); **DEPLOY BUTTON ON MAIN (#127, workflow_dispatch) — NOBODY PRESSES IT until Nick decides the brake question and says deploy (token SET 18:35Z);** GitHub writes working again 18:24Z (read PR state before writing, ten minutes between refusals); live = c5ee3b54 on Fly, scheduler brake OFF since 17:08Z, rollback = previous image on his word; NEVER delete `/data/data.sqlite.pre-migration-*.bak`; 3 key exposures, 0 rotations. Detail [[gridiron-memory-detail-2026-09-22-live-app]] [[gridiron-pr-board-2026-09-22]] [[gridiron-open-risks]] [[gridiron-deploy-step-2026-09-22]].

## State files
Latest [[gridiron-state-1300-2026-09-22]] (19:15Z); index [[gridiron-state-index-2026-09-22]] (1280-1300 in part46).

## Standing rules (one line each; text in [[gridiron-memory-detail-2026-09-22-standing-rules]])
- Five questions, one list [[gridiron-five-questions-rule]]
- Cite RED/GREEN as #N + subject + sha [[gridiron-evidence-citation-rule]]
- Local gate = `npm run check`, wiring included [[gridiron-local-gate-includes-wiring-rule]]
- Verify once [[gridiron-verify-once-and-model-by-weight]]
- Waiting-on-you line [[gridiron-waiting-on-you-line-rule]]
- Chat reserved for his word or milestones [[gridiron-chat-reserved-for-his-word-or-milestone]]
- Always answer ready-for-review [[gridiron-always-answer-ready-for-review]]
- Plan order and items 1-25 [[gridiron-go-plan-2026-09-22]] [[gridiron-plan-items-1-25-verbatim-part1]]
- Missing data workaround [[gridiron-missing-data-workaround-rule]]
- Nothing paid; licence check first [[gridiron-licence-before-measurement-rule]] [[gridiron-nflverse-cc-by-attribution]]
- One editor per file [[gridiron-file-allocation]]
- Name the table and the writer function [[gridiron-name-the-table-rule]]
- Two-copy production read [[gridiron-production-read-two-copy-rule]]
- Contradiction test [[gridiron-contradiction-test-rule]] [[gridiron-bespoke-tool-cross-check-rule]]
- Predicate injection [[gridiron-predicate-injection-test-rule]]
- Gate evidence before Nick [[gridiron-gate-evidence-before-nick-rule]]
- R&D updates for Nick [[gridiron-rnd-updates-for-nick-rule]]
- Optional sources never trigger staleness [[gridiron-optional-sources-never-trigger]]
- Auditor charter [[gridiron-auditor-charter-0714-2026-09-22]]
- Merge-gate skill map [[gridiron-merge-gate-self-audit-skill]]
- Lessons: [[gridiron-rebase-before-merge-lesson]] [[gridiron-merge-burst-cancels-main-run-lesson]] [[gridiron-add-add-squash-conflict-lesson]] [[gridiron-rerun-red-after-assertion-change-lesson]] [[gridiron-db-local-name-false-finding-lesson]] [[gridiron-skill-prefix-lesson]] [[gridiron-skill-registry-snapshot-lesson]] [[gridiron-no-subagent-for-single-api-call-lesson]] [[gridiron-handoff-carries-owed-pr-bodies-lesson]] [[gridiron-guard-run-hygiene-lesson]] [[gridiron-gate-pr-merge-main-first-lesson]] [[gridiron-rebase-moves-evidence-shas-lesson]] [[gridiron-github-list-merged-caveat]]
