# API traffic, September 2026

## Table

- `eval_top_routes.requests`: one row per API request: `ts` (UTC), `route`, HTTP `status`, `duration_ms`.

## Rules

- Health checks are not traffic: leave out the routes `healthz` and `readyz` everywhere.
- **Served traffic** is requests that did not fail on the server: `status < 500`.

## Metrics

- **Traffic by route**: served requests per route, largest first. The route with the most served requests is the **top route**.
- **Server error rate**: requests with `status >= 500` divided by all requests (health checks left out), as a percentage.
