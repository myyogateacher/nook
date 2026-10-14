-- Orders from August to September 2026; about one in eleven refunded 3–24 days later, so some August
-- orders are refunded in September and some September orders in October.
DROP DATABASE IF EXISTS eval_refund_dates;
CREATE DATABASE eval_refund_dates;
CREATE TABLE eval_refund_dates.orders (
  order_id UInt64,
  ordered_at DateTime,
  amount Decimal(12, 2) COMMENT 'Order total in USD'
) ENGINE = MergeTree ORDER BY (ordered_at, order_id) COMMENT 'One row per order';
CREATE TABLE eval_refund_dates.refunds (
  refund_id UInt64,
  order_id UInt64,
  refunded_at DateTime,
  refund_amount Decimal(12, 2) COMMENT 'Refunded USD, positive'
) ENGINE = MergeTree ORDER BY (refunded_at, refund_id) COMMENT 'One row per refund';
INSERT INTO eval_refund_dates.orders
SELECT number + 1, toDateTime('2026-08-01 00:00:00') + toIntervalSecond((number * 2671) % (61 * 86400)), toDecimal64(15 + (number * 53) % 240, 2) + toDecimal64(0.5, 2)
FROM numbers(2400);
INSERT INTO eval_refund_dates.refunds
SELECT o.order_id * 10, o.order_id, o.ordered_at + toIntervalDay(3 + o.order_id % 22), o.amount * (o.order_id % 3 = 0 ? 1 : 0.5)
FROM eval_refund_dates.orders AS o WHERE o.order_id % 11 = 0;
