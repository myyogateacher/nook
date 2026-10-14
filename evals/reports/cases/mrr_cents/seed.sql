-- Subscriptions with MRR stored in cents; some cancelled before, on, or after the reporting day.
DROP DATABASE IF EXISTS eval_mrr_cents;
CREATE DATABASE eval_mrr_cents;
CREATE TABLE eval_mrr_cents.subscriptions (
  subscription_id UInt64,
  customer_id UInt64,
  plan LowCardinality(String),
  mrr_cents Int64 COMMENT 'Monthly recurring revenue in US cents',
  started_at DateTime,
  canceled_at Nullable(DateTime)
) ENGINE = MergeTree ORDER BY subscription_id COMMENT 'One row per subscription';
INSERT INTO eval_mrr_cents.subscriptions
SELECT number + 1, 5000 + number, ['starter','starter','pro','pro','team'][number % 5 + 1],
  [900, 900, 2900, 2900, 9900][number % 5 + 1] * (1 + number % 3),
  toDateTime('2026-01-01 00:00:00') + toIntervalSecond((number * 172801) % (300 * 86400)),
  number % 6 = 0 ? toDateTime('2026-06-01 00:00:00') + toIntervalSecond((number * 104729) % (183 * 86400)) : NULL
FROM numbers(1500);
