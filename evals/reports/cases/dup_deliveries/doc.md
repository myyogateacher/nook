# Purchases, September 2026

## Table

- `eval_dup_deliveries.purchase_events`: raw webhook deliveries of purchase events. The webhook delivers **at least once**: the same purchase can arrive two or three times with the same `event_id` and a later `received_at`.

## Rules

- One purchase is one `event_id`. Deduplicate by `event_id` before counting or summing (for example `LIMIT 1 BY event_id`, or `GROUP BY event_id` with `any()`).
- Use `purchased_at`, not `received_at`, for dates. All purchases happened in September 2026.

## Metrics

- **Purchases**: distinct purchases.
- **Revenue** (USD): the sum of `amount` over distinct purchases.
- **Revenue by product**: revenue per `product`.
- **Daily purchases**: purchases per day of `purchased_at`.
