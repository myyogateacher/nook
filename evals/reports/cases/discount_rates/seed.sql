-- Discount rates stored as a fraction (0.15 = 15 %); most orders have none.
DROP DATABASE IF EXISTS eval_discount_rates;
CREATE DATABASE eval_discount_rates;
CREATE TABLE eval_discount_rates.orders (
  order_id UInt64,
  ordered_at DateTime,
  list_price Decimal(12, 2) COMMENT 'Price before discount, USD',
  discount_rate Float64 COMMENT 'Fraction of list_price taken off: 0.15 means 15 %',
  coupon LowCardinality(String)
) ENGINE = MergeTree ORDER BY (ordered_at, order_id) COMMENT 'One row per order';
INSERT INTO eval_discount_rates.orders
SELECT number + 1, toDateTime('2026-09-01 00:00:00') + toIntervalSecond((number * 1789) % (30 * 86400)), toDecimal64(30 + (number * 41) % 170, 2),
  number % 4 = 0 ? [0.05, 0.1, 0.15, 0.2, 0.3][intDiv(number, 4) % 5 + 1] : 0,
  number % 4 = 0 ? ['SPRING', 'WELCOME', 'VIP', 'VIP', 'STAFF'][intDiv(number, 4) % 5 + 1] : ''
FROM numbers(3200);
