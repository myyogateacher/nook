-- API request durations; health checks are fast and frequent and must be left out.
DROP DATABASE IF EXISTS eval_latency_spread;
CREATE DATABASE eval_latency_spread;
CREATE TABLE eval_latency_spread.requests (
  ts DateTime,
  route LowCardinality(String),
  duration_ms UInt32
) ENGINE = MergeTree ORDER BY (route, ts) COMMENT 'One row per API request';
INSERT INTO eval_latency_spread.requests
SELECT toDateTime('2026-09-01 00:00:00') + toIntervalSecond(number * 977 % (30 * 86400)),
  ['search', 'notes', 'digest'][number % 3 + 1],
  40 + (number * 7919) % 360 + if(number % 50 = 0, 1500, 0)
FROM numbers(900);
INSERT INTO eval_latency_spread.requests
SELECT toDateTime('2026-09-01 00:00:00') + toIntervalSecond(number * 60), 'healthz', 1 + number % 3
FROM numbers(3000);
