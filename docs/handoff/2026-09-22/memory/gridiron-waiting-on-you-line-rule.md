---
name: gridiron-waiting-on-you-line-rule
description: Standing rule (Nick 16:23:11Z) — every coordinator post to Nick opens with a 'Waiting on you:' line
metadata:
  type: feedback
  modified: 2026-09-22T16:25:30.184Z
---
**Why:** Nick 16:23:11Z, message id cmsg_01YAsw8AnFv4ioRMQw8dfPmT9Ew6TGiS4ZnGZHoQHgXwH6, verbatim: 'monitor waiting on u for me always'. He wants to be able to glance at any coordinator message and know immediately whether the ball is in his court, without reading the whole update.

**How to apply:** every coordinator post to Nick opens with a line reading exactly `Waiting on you: <nothing | the exact item>` — either the literal word "nothing" or the specific decision/action that needs his word (e.g. "Waiting on you: merge #95 y/n"). The 30-minute check (trig_014tYBA5uqmgAE81Ffj72BXY) posts to Nick whenever that line's value changes from the last post (nothing → something, or the item changes), not on a fixed timer alone.

**17:00Z update:** the 30-minute check is now send_later trigger trig_016cw1uZrkMtLJu6RyfNNBAf (next fire 17:27Z); trig_014tYBA5uqmgAE81Ffj72BXY no longer exists.
