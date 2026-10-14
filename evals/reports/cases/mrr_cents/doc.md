# MRR at the end of September 2026

## Table

- `eval_mrr_cents.subscriptions`: one row per subscription: `plan`, `mrr_cents`, `started_at`, and `canceled_at` (NULL while it runs).

`mrr_cents` is in **US cents**. Every money figure in the report is in **US dollars**.

## Rules

- A subscription is **active on 2026-09-30** when it started before 2026-10-01 00:00 UTC and was not cancelled by then: `canceled_at` is NULL or on/after 2026-10-01 00:00.

## Metrics

- **MRR** (USD): the sum of `mrr_cents` / 100 over subscriptions active on 2026-09-30.
- **Active subscriptions**: how many subscriptions are active on 2026-09-30.
- **MRR by plan** (USD): MRR per `plan`.
