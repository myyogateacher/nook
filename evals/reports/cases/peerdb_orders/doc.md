# September 2026 order revenue

The orders table is replicated from the production Postgres by PeerDB into ClickHouse.

## Tables

- `eval_peerdb_orders.orders`: one row per order **version**. PeerDB writes a new row on every update
  (`_peerdb_version` grows) and marks deletes with `_peerdb_is_deleted = 1` instead of removing rows.

## Rules

- The table is a ReplacingMergeTree: always read it with `FINAL`, so each order counts once at its latest version.
- Deleted orders (`_peerdb_is_deleted = 1`) never count.
- Revenue counts orders whose `status` is `paid` or `shipped`. Cancelled and pending orders are not revenue.
- The reporting period is September 2026: `created_at` from 2026-09-01 00:00 to 2026-09-30 23:59:59 (UTC).

## Metrics

- **Net revenue** (USD): the sum of `amount` over revenue orders in the period.
- **Revenue orders**: the number of revenue orders in the period.
- **Average order value** (USD): net revenue divided by revenue orders.
- **Revenue by status**: net revenue split between `paid` and `shipped`.
