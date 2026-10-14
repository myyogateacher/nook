-- Purchase events from a webhook that delivers some events two or three times (same event_id).
DROP DATABASE IF EXISTS eval_dup_deliveries;
CREATE DATABASE eval_dup_deliveries;
CREATE TABLE eval_dup_deliveries.purchase_events (
  event_id String,
  received_at DateTime,
  purchased_at DateTime,
  amount Decimal(12, 2),
  product LowCardinality(String)
) ENGINE = MergeTree PARTITION BY toYYYYMM(received_at) ORDER BY (received_at, event_id) COMMENT 'Raw webhook deliveries, at least once';
INSERT INTO eval_dup_deliveries.purchase_events
SELECT concat('evt_', toString(e)), purchased + toIntervalSecond(d * 45), purchased, toDecimal64(10 + (e * 29) % 90, 2), ['ebook','course','course','coaching'][e % 4 + 1]
FROM (
  SELECT number AS e, toDateTime('2026-09-01 00:00:00') + toIntervalSecond((number * 911) % (30 * 86400)) AS purchased, arrayJoin(range(multiIf(number % 9 = 0, 3, number % 4 = 0, 2, 1))) AS d
  FROM numbers(2600)
);
