# API response times, September 2026

## Table

- `eval_latency_spread.requests`: one row per API request: `ts` (UTC), `route`, and `duration_ms`.

## Rules

- Health checks are not traffic: leave the route `healthz` out everywhere.

## Metrics

- **How response times spread**: the distribution of `duration_ms` over every request (not an average per route), so the slow tail is visible.
- **p95 response time**: the 95th percentile of `duration_ms` (exact).
- **Requests**: the number of requests.
