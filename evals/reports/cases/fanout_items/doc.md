# Shop sales, September 2026

## Tables

- `eval_fanout_items.orders`: one row per order: `order_id`, `ordered_at`, `channel` (web, app, store), and `order_total`, what the customer paid (USD).
- `eval_fanout_items.order_items`: one row per order line: `order_id`, `line_no`, `sku`, `qty`, `unit_price`. An order has one to four lines.

All orders in the tables were placed in September 2026.

## Metrics

- **Revenue**: the sum of `orders.order_total`. Each order counts once.
- **Orders**: the number of orders.
- **Average order value**: revenue divided by orders.
- **Units sold**: the sum of `order_items.qty`.
- **Revenue by channel**: revenue per `channel`, with each channel's units sold beside it.
