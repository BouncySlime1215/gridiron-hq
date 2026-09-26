---
name: gridiron-sharp-football-off-limits-2026-09-22
description: Sharp Football Analysis is off-limits as a data source — their terms of service prohibit reproducing, downloading, storing or transmitting site material, independent of the MemberPress paywall.
metadata:
  type: reference
---

Checked 2026-09-22. **Do not re-probe this site.** Two independent blocks.

**1. Their terms of service prohibit it.** Quoted verbatim from
`https://www.sharpfootballanalysis.com/terms-of-service/`:

> You may not create derivative works, distribute, download, modify, publicly
> display, publicly perform, reproduce, store, or transmit any material on our
> Website, except for: Files automatically cached by your web browser.

The only other carve-out is "Printing or downloading a reasonable number of
Website pages for personal, non-commercial use, or legitimate business purposes
related to your role as a client, investor, supplier, or vendor." Programmatic
ingestion is not that. **This is decisive on its own and does not depend on
cost.**

**2. It is paywalled anyway.** The REST API answers unauthenticated and
`robots.txt` disallows only `/go/*` affiliate links, so nothing technical
blocked it, but the content is not there: the one custom post type `play` /
`plays` is **betting picks** (prop bets with odds, 23 items total), not play
data, and betting is out of scope here. Every other non-core namespace is a
stock WordPress plugin, including **MemberPress** — the advanced box scores sit
behind a subscription, which "nothing paid, ever" forecloses.

**What was done and undone.** Five public requests were made before the terms
were read — that was the wrong order and the rule is now: **read the terms
before the first request, not after.** Nothing was retained: every cached page
and JSON response was deleted from scratch, which is what their storage clause
requires. No auth, firewall or code-snippet endpoints were touched; probing
another site's security is out of bounds regardless of any data rule.

**How to apply.** For any third-party site: read the terms first; if they
prohibit programmatic access, stop and log it rather than looking for a way
round. Quote the clause in the report rather than summarising it. Free to reach
is not the same as free to use.

**Footballguys is the likely same story** (subscription site) and was dropped
unprobed for that reason. Check its terms first if anyone revisits it.

Log the gap, do not work around it:
[[gridiron-missing-data-workaround-rule]].
