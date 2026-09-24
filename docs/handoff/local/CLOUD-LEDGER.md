# CLOUD LEDGER: Nick's $250 cloud-session credit (claimed 9/23 ~8:50 PM ET: "use that tonight"; "track that 250, when it's gone come back to local")
The credit balance is NOT visible to the coordinator (get_usage shows plan windows and extraUsage only; extraUsage disabled, $0). So we track an ESTIMATE per remote agent from its reported tokens (Opus 5.5 ~$4/M input, $20/M output; a finished agent reports total tokens only, so estimate at a blended ~$8/M) and treat a remote agent failing with a credit/billing error as the hard signal that the credit is gone.
Rule: when the estimate passes ~$225, or any remote launch/agent fails on credit, stop remote launches and run the remaining units locally (build-unit-v3.js), paced by the weekly meter.

| launched (ET) | unit | remote agent | status | tokens | est $ |
|---|---|---|---|---|---|
| 9/23 8:48 PM | EA-01 LIVING on spine v2 | LOCAL (see note) | running | | |
| 9/23 8:48 PM | WR-1+WR-2 War Room UI | LOCAL (see note) | running | | |
| 9/23 8:48 PM | campaign producer | LOCAL (see note) | running | | |
| 9/23 8:48 PM | WR-3 + Coach UI control | LOCAL (see note) | running | | |
| 9/23 8:48 PM | BROKEN-01 number health | LOCAL (see note) | running | | |
| 9/23 8:48 PM | EVAL graders E1-E7 | LOCAL (see note) | running | | |
Running est total: $0 (updated as agents finish). Nick can check the real balance in his claude.ai billing page.

**CORRECTION 9/23 ~9:00 PM ET:** the 6 agents launched with isolation 'remote' are running LOCALLY (a local worktree WR-UI appeared at 8:48 PM; ListAgents lists them as local subagents; no claude/cloud-* branches). They use the WEEKLY budget, not the $250. $250 spent so far by us: $0. Real cloud path under investigation: RemoteTrigger routines (API body schema being looked up) or Nick starting claude.ai/code cloud sessions with prompts we hand him.

**Cloud routine probe (9/23 ~8:52 PM):** RemoteTrigger routines work mechanically (create with job_config.ccr.environment_id + session_request.events[0].payload{type:user,message}, then run). Schema learned. BUT the only valid environment on the account (env_013wv...) is a general assistant environment with NO repo: the run answered with a generic greeting. The old "GridIron HQ" repo environment (env_018JC...) no longer exists. BLOCKER: a cloud environment connected to BouncySlime1215/gridiron-hq must be created in claude.ai/code (UI only). Probe routine trig_01Qw9CyBHFj6YdQ4aJ78jKbL disabled. Cloud spend so far: 2 tiny probe runs.
| 9/23 ~9:05 PM | EA-02 engine daemon | CLOUD session https://claude.ai/code/session_01PT6KgXyso1nvFPTJWqbwkR | running | | |
| 9/23 ~9:05 PM | REASON-01 reasoning panels | CLOUD session https://claude.ai/code/session_01BFx4brPTwNWqgoU3so1JYX | running | | |

**CORRECTION 2 (9/23 ~9:15 PM, Nick noticed):** `claude --cloud` from the bundled CLI is logged into the OTHER Max account (the terminal account), so the 2 cloud sessions (EA-02, REASON-01) and the 2 probes bill THAT account's usage, not this one and not necessarily the $250. cloud-run.sh is now guarded (needs ALLOW_OTHER_ACCOUNT=1). Where the $250 credit lives is unknown to the coordinator. The RemoteTrigger routines path runs as THIS account (creator 9fd867a4) but has no repo environment yet.
| 09/23 09:16 PM | RL-19-3 | CLOUD (other acct) https://claude.ai/code/session_0167tv4zxUYaz6bRmPZtaMKB | running | | |
| 09/23 09:17 PM | FIX-HOLD-01 | CLOUD (other acct) https://claude.ai/code/session_014dPCtmRiBRwunYjwr5uLMZ | running | | |
| 09/23 09:17 PM | RL-16-1 | CLOUD (other acct) https://claude.ai/code/session_01HWm7H3AmeX9zQuNvhz7Bj5 | running | | |
| 09/23 09:18 PM | RL-17-3 | CLOUD (other acct) https://claude.ai/code/session_017WWZqxPevaYgPbTYZLT2LK | running | | |
| 09/23 09:19 PM | SERVE-LOG | CLOUD (other acct) https://claude.ai/code/session_01HQU1yabapzhxD66QhquNGN | running | | |
| 09/23 09:19 PM | CLONE-01b-b1 | CLOUD (other acct) https://claude.ai/code/session_01VQXrNoHmo243E5wLAa1Q3f | running | | |
| 09/23 09:20 PM | SELF-01a | CLOUD (other acct) https://claude.ai/code/session_01BqQpRrjXqGbnHW5JbxcB4L | running | | |
| 09/23 09:21 PM | RL-16-2 | CLOUD (other acct) https://claude.ai/code/session_01ReeEVR6HECBjaKAJV5BDFo | running | | |
