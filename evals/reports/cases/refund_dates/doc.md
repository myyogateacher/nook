# Net revenue, September 2026

Finance closes the books by the date money moves, not by the date of the order.

## Tables

- `eval_refund_dates.orders`: one row per order. `ordered_at` (UTC), `amount` in USD.
- `eval_refund_dates.refunds`: one row per refund. `refunded_at` (UTC), `refund_amount` in USD (positive), and the `order_id` it refunds.

## Rules

- The period is September 2026 (UTC): from 2026-09-01 00:00 up to, not including, 2026-10-01 00:00.
- **Refunds count on the refund date.** A refund issued in September reduces September's revenue even
  when its order was placed in August. A September order refunded in October does not reduce September.

## Metrics

- **Gross sales**: the sum of `amount` over orders placed in the period.
- **Refunds issued**: the sum of `refund_amount` over refunds whose `refunded_at` is in the period.
- **Net revenue**: gross sales minus refunds issued.
- **Refund count**: the number of refunds issued in the period.
