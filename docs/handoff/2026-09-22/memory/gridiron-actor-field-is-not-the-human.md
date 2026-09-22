---
name: gridiron-actor-field-is-not-the-human
description: Every GitHub call from a Gridiron HQ thread authenticates as BouncySlime1215, so a webhook's actor field cannot tell Nick apart from a Claude session — I read it as Nick and told him in his own thread that he was doing something he was not.
metadata:
  type: feedback
  modified: 2026-09-20T13:38:00.000Z
---

## The mistake

Six `pull_request.ready_for_review` events arrived on my PRs (#56, #59, #61,
#63, #52, #49) at 13:31:07-13:31:25Z on 2026-09-20, each with
`"actor":"BouncySlime1215"`. I concluded Nick was at the terminal driving the
release sequence, **told the coordinator so, and opened a reply to Nick with
"You're marking the fix stack ready"**.

He was not. **The release-train thread marked all six**, on the coordinator's
word, between 13:30:50Z and 13:31:30Z. Every push and API call from these
threads authenticates as **BouncySlime1215** — which is also why the committer
address on the night's commits is his — so **the actor field cannot distinguish
Nick from a Claude session**. The coordinator caught it before it reached him
at the project level; I had already put it in his thread and corrected it there
with a struck-through edit.

## Why it is the same failure as the one before it

Twenty minutes earlier I wrote up [[gridiron-verify-the-authorization-itself]]
against myself, for taking a relayed "go" on trust. This is that shape one
layer out: **the actor field is a producer, and I read it as evidence about the
consumer** — the human. The project's own standing rule already says *verify
the consumer, not the producer*, and I applied it all night to code and not to
a claim about a person.

## Rules

- **A webhook actor, a committer address and a token identity name an account,
  never a person.** In this project they are all Nick's account and tell you
  nothing about who acted.
- **To learn whether Nick did something, read Nick's own messages** — the
  timeline, `fetch_messages`, a `<cited author="user">` entry — or ask the
  coordinator, who knows what it ordered.
- **Never tell a person what they did.** Describe the state ("the six are
  marked ready"), not the agent, unless the agent is established. State is
  checkable; attribution from an actor field is not.
- Timing that "matches to the second" is a reason to suspect a sibling session,
  not to believe a human.

Related: [[gridiron-failure-modes]] · [[verify-the-consumer-not-the-producer]]
