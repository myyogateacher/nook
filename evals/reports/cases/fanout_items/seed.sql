-- Orders with 1–4 line items each: joining items to orders repeats each order's total once per item.
DROP DATABASE IF EXISTS eval_fanout_items;
CREATE DATABASE eval_fanout_items;
CREATE TABLE eval_fanout_items.orders (
  order_id UInt64,
  ordered_at DateTime,
  channel LowCardinality(String),
  order_total Decimal(12, 2) COMMENT 'What the customer paid for the order, USD'
) ENGINE = MergeTree ORDER BY (ordered_at, order_id) COMMENT 'One row per order';
CREATE TABLE eval_fanout_items.order_items (
  order_id UInt64,
  line_no UInt8,
  sku LowCardinality(String),
  qty UInt32,
  unit_price Decimal(12, 2)
) ENGINE = MergeTree ORDER BY (order_id, line_no) COMMENT 'One row per order line';
INSERT INTO eval_fanout_items.order_items
SELECT o + 1, l + 1, ['tea','mug','kettle','filter','honey'][(o + l) % 5 + 1], 1 + (o * 3 + l) % 3, toDecimal64(4 + ((o + l * 7) % 30), 2) + toDecimal64(0.5, 2)
FROM (SELECT number AS o, arrayJoin(range(1 + number % 4)) AS l FROM numbers(1800));
INSERT INTO eval_fanout_items.orders
SELECT order_id, toDateTime('2026-09-01 00:00:00') + toIntervalSecond((order_id * 1451) % (30 * 86400)), ['web','web','app','store'][order_id % 4 + 1], sum(qty * unit_price)
FROM eval_fanout_items.order_items GROUP BY order_id;
