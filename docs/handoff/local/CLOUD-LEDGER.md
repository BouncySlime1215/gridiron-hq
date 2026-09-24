# CLOUD LEDGER: Nick's $250 cloud-session credit (claimed 9/23 ~8:50 PM ET: "use that tonight"; "track that 250, when it's gone come back to local")
The credit balance is NOT visible to the coordinator (get_usage shows plan windows and extraUsage only; extraUsage disabled, $0). So we track an ESTIMATE per remote agent from its reported tokens (Opus 5.5 ~$4/M input, $20/M output; a finished agent reports total tokens only, so estimate at a blended ~$8/M) and treat a remote agent failing with a credit/billing error as the hard signal that the credit is gone.
Rule: when the estimate passes ~$225, or any remote launch/agent fails on credit, stop remote launches and run the remaining units locally (build-unit-v3.js), paced by the weekly meter.

| launched (ET) | unit | remote agent | status | tokens | est $ |
|---|---|---|---|---|---|
| 9/23 8:48 PM | EA-01 LIVING on spine v2 | cloud | running | | |
| 9/23 8:48 PM | WR-1+WR-2 War Room UI | cloud | running | | |
| 9/23 8:48 PM | campaign producer | cloud | running | | |
| 9/23 8:48 PM | WR-3 + Coach UI control | cloud | running | | |
| 9/23 8:48 PM | BROKEN-01 number health | cloud | running | | |
| 9/23 8:48 PM | EVAL graders E1-E7 | cloud | running | | |
Running est total: $0 (updated as agents finish). Nick can check the real balance in his claude.ai billing page.
