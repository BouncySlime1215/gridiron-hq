---
name: gridiron-kaggle-open-access-2026-09-22
description: Kaggle notebook source and competition listings are readable unauthenticated via two endpoints; the six Big Data Bowl competition ids.
metadata:
  type: reference
---

Measured 2026-09-22. Kaggle's **competition data files** still need Nick's
account plus identity verification (401, CC BY-NC 4.0), but **notebook source
and notebook listings are fully open with no credentials**:

- `GET https://www.kaggle.com/api/v1/kernels/pull?user_name=<U>&kernel_slug=<S>`
  returns the whole notebook as JSON. `blob.source` is the .ipynb; parse and
  join `cells[].source`. Verified on 10 different winners.
- `POST https://www.kaggle.com/api/i/kernels.KernelsService/ListKernels`
  with body
  `{"kernelFilterCriteria":{"search":"<text>","listRequest":{"competitionId":<id>,"pageSize":100,"sortBy":"VOTE_COUNT"}}}`
  lists notebooks. `search` sits on `kernelFilterCriteria`, NOT inside
  `listRequest` — putting it in `listRequest` is silently ignored and you get
  the global top-voted list (Kaggle Learn exercises) with `totalCount: 0`.
  `totalCount` is always 0; ignore it and read `kernels[]`.

`competitions.CompetitionService/GetCompetition` is 403 and the documented
`/api/v1/kernels/list` is 401 — only the two above work.

Competition ids (from `kernels[].dataSources[].reference.sourceId`):

    nfl-big-data-bowl-2020            15696
    nfl-big-data-bowl-2021            22805
    nfl-big-data-bowl-2022            30573
    nfl-big-data-bowl-2023            38992
    nfl-big-data-bowl-2024            60305
    nfl-big-data-bowl-2025            84175
    nfl-big-data-bowl-2026-analytics  114250
    nfl-big-data-bowl-2026-prediction 114239

Transport note: python `urllib` gets 403 through the container proxy; `curl`
and Node `fetch` work. Use Node fetch.

Still blocked on Nick: accepting the competition rules for BDB 2025 and 2026,
which is the only free source of routes-run ground truth
([[gridiron-missing-data-log-2026-09-22]]).

Related: [[gridiron-data-techniques-rd-standing-2026-09-22]].
