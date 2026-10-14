-- API requests: health checks dominate raw traffic, and one route has many server errors.
DROP DATABASE IF EXISTS eval_top_routes;
CREATE DATABASE eval_top_routes;
CREATE TABLE eval_top_routes.requests (
  ts DateTime,
  route LowCardinality(String),
  status UInt16,
  duration_ms UInt32
) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (route, ts) COMMENT 'One row per API request';
INSERT INTO eval_top_routes.requests
SELECT toDateTime('2026-09-01 00:00:00') + toIntervalSecond((number * 613) % (30 * 86400)),
  multiIf(number % 20 < 7, 'healthz', number % 20 < 8, 'readyz', number % 20 < 12, 'digest', number % 20 < 15, 'search', number % 20 < 18, 'notes', 'login'),
  multiIf(number % 20 >= 12 AND number % 20 < 15 AND number % 7 = 0, 503, number % 20 >= 8 AND number % 20 < 12 AND number % 41 = 0, 500, number % 19 = 0, 404, 200),
  20 + (number * 13) % 400
FROM numbers(20000);
INSERT INTO eval_top_routes.requests
SELECT toDateTime('2026-09-12 03:00:00') + toIntervalSecond(number), 'search', 502, 30000 FROM numbers(1500);
